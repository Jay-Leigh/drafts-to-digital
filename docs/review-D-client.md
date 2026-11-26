# Adversarial review: D client (cross-device job pickup)

Reviewer: Opus sub-agent, 26 Nov 2026. Scope: `git diff 885e3ea..HEAD -- index.html` restricted to pickup / jobs (commit `c43665b`: `pickup`, `pickupIo`,
`pickupParse` / `pickupCleanEntry` / `pickupCleanCtx` / `pickupMerge` / `pickupPrune` / `pickupSerialize`, `jobs.claimApply`, `jobs.onCollected`, `jobs.onUnknown`,
`jobs.ackBatch`, `handlers.pickup`, `handlers.group.collected`, `studio.markPickedUp`, the C1 merge change for `pickedUp`), read against `docs/design-signin-sync.md` D,
`docs/review-signin-sync-BD.md` D1-D10 and `docs/review-v8-server.md`. Tests: `tests/suites/18-job-pickup.js`, `tests/suites/14-server-v8.js`, plus the real server
Lua / reply scripts (`n8n/tools/src/job-claim*.{lua,js}`, `job8-ack.lua`, `job-cancel.lua`). Nothing live was touched.

Severity: **blocker** = do not release; **must-fix** = fix before release; **nice** = worth doing, not gating.

## What was run

| Run | Result |
|---|---|
| `cd tests && node suites/18-job-pickup.js` | 17 / 17 passed |
| Scratch probe P2 (outside the repo): own listed job dropped locally, then a scan | the device that STARTED the job re-adopts it as a `foreign` record (`state: submitted`, badge 1) |
| Scratch probe P3: listed job the server never admitted (record absent, never seen running) | `done`, `doneElsewhere: true`, aid `generating` + `pickedUp`; file entry still `open`; nobody has it |
| Scratch probe P4: Drive list answering 500 while one job is polled | about 6 list calls a minute with no kicks (designed: 1), one more per focus / visibility event; no backoff |

## Findings

### M1. must-fix (lost paid result): Cancel on a FOREIGN row after the job succeeded destroys the answer for the origin
`rowHtml` shows Cancel for every active record, foreign included. `jobs.cancel(id)` on a foreign record calls the server `cancel` (foreign records carry
`lastCreateAt`), and the real `job-cancel.lua` returns the unchanged state for a finished job (`succeeded`). `cancel` then sets `ackDue = true`, `ackBatch`
acks (with the foreign nonce if a claim was tried, else none), and `job8-ack.lua` turns the `succeeded` record into `collected` and DELETES the answer.
Scenario: A starts slides; B shows "Picked up from your other device"; the answer is ready; the student taps Cancel on B (meaning "not here"). The paid answer
is deleted. A polls, sees `collected`, calls `studio.markPickedUp` ("Collected on your other device. It shows up here after the next sync") and three days
later the aid fails with `STUDIO_PICKUP_LOST`; for a tool run the group stays `pickedUp` forever (see M3). Nobody ever applied it.
Why the suite misses it: the fake `cancel` in `tests/lib/fake-n8n.js` marks ANY job cancelled and answers without a top-level `state`, unlike
`job-cancel-reply.js` (`{ok, state, jobs}`, a finished job keeps its state), so `d.state` is `undefined` and `ackDue` is never set.
**Fix:** in `jobs.cancel`, for `r.foreign`: never set `ackDue`; send the server `cancel` only when the record is `submitted` / `running` (a cross-device cancel
of running work, as the test expects); for `succeeded` just `pickup.abandon(r)` (entry marked `cancelled`, lease left to expire, origin collects). Make the fake
`cancel` match the real script (`running`/`rejected` -> `cancelled`, others unchanged, top-level `state`) and add the row "B cancels after succeeded: A still
applies it, server ends `collected` by A's nonce".

### M2. must-fix (false "collected" for a job nobody has; P3): `onUnknown` for a listed job treats every `unknown` as collected elsewhere
`onUnknown` with `cur.pub` goes straight to `onCollected` after the 45 s grace, even when the server never admitted the job (Job Start answers `accepted`
before admission; D10) or never showed it running (`sawServer` false). No device can have collected a job that was never admitted, and while
`now - lastCreateAt < 72 h` a collected job still answers `collected` (the record lives 72 h after collection, and collection is after `lastCreateAt`).
Scenario (probe P3): admission fails silently; A shows "Collected on your other device", the entry is marked `done` by A itself, the aid waits 3 days and
fails; a one-request tool run is stuck as M3. The v7 path (resend the same attempt, capped by `JOBS_CREATE_TRIES`) was the right answer here.
**Fix:** in `onUnknown`: `if (cur.pub && (cur.sawServer || Date.now() - (cur.lastCreateAt || 0) >= PICKUP_TTL_MS - 3600e3)) -> no resend` (D1 holds: the only
re-run after a possible collection is a user "Try again"); `pub && !sawServer` inside the window falls through to today's never-admitted path. For the
`sawServer` case do not claim "collected on your other device" unless the pickup file says so: read `pickupIo.cache` (or one `mutate(() => false)`), and
only when the entry is `done` call `onCollected`; otherwise `expire(cur)` with a neutral text ("This result is no longer on the server. Try again to make it.").

### M3. must-fix (no way out for tool runs): `handlers.group.collected` leaves a run "collected" forever with no Try again
For studio, `STUDIO_PICKUP_WAIT_MS` turns a `pickedUp` aid that never arrives into `failed` with Try again. For a one-request tool run the group is set
`done` / `handled` / `pickedUp` / `outcome: 'ok'`, inputs are dropped, and `toolDescribeGroup` shows "Collected on your other device. It shows up in History
after the next sync" with Dismiss only. If the History entry never arrives (M1, M2, the other device has sync off or no token: M4), the student has no signal
and no retry, and the files are gone from this device.
**Fix:** keep `gin:<gid>:0` (do not `groupDropInputs`) until `h_<gid>` is in History; add a `pickedUpAt` and in `advanceNow` (or `toolSyncNote`) turn a
`pickedUp` group older than `STUDIO_PICKUP_WAIT_MS` without `h_<gid>` into `failed` with the same "did not reach this one, Try again" text and the retry
action; drop the inputs once the History entry is there.

### M4. must-fix (result stranded on the collecting device): a device claims foreign jobs with no Drive token
Scanning needs a fresh sync token (`pickup.active`), but `claimApply` for a foreign record does not: once added, B polls and claims with only the app token.
Scenario: B (iPhone Safari, token only after a gesture) took the entry yesterday; today B is opened, the token is gone, B claims, applies and acks. The aid
lives only on B until the next tap on B; A is told "collected on your other device", waits 3 days and fails (M3 for tool runs). A "Try again" on A bills again.
**Fix:** in `jobs.claimApply`, `if (foreign && !(hasFreshSyncToken() && syncKnownUser)) { cur.nextPollAt = now + 60 s; return; }` (no claim: the origin
keeps the right to collect). Optionally in `pickup.applyAndAck` call `scheduleDrivePush()` right after a successful apply so A's `autoPull('collected')`
at 0 s / 10 s finds it.

### M5. must-fix (double-billing window): `pub` is set only AFTER the Drive write succeeded and the round was not "skipped"
`pickup.round` writes the entry, then marks `x.pub = true` in a second step. `mutateNow` returns `{ skipped: 'signed-out' }` when the sync token changes
during the write (an hourly GIS renewal is enough), and `round` then returns without setting `pub`; a crash or tab close between the write and the
`jobs.update` does the same. The entry is in the file (with the key) but the record is not `pub`, so D1's guard does not apply: if B collects and A next
polls after the `collected` record expired (A was in a drawer for 4 days with no sync token, so `pickupDue` never re-ran), `onUnknown` -> `sawServer` ->
`onFailed(lost)` -> resend -> billed twice.
**Fix:** set `pub = true` BEFORE the write (in `round`, `jobs.update(id, x => { x.pub = true; })` for every `w.entry`, then mutate); keep `pickupDue` until the
write is confirmed. A `pub` record whose entry was never written only loses the resend, which M2 restores for the never-admitted case.

### M6. must-fix (P2): the device that started a job re-adopts it as `foreign` after its own record is dropped
`pickup.take` decides "mine" only from `jobs.recs`. `drop(id)` runs on tray Dismiss and on "Try again" (`retry` -> `drop` then `handlers.retry`) of a finished record, and after
`JOBS_KEEP_MS`; if the end mark (`pickupMark`) was not written yet (no fresh token, which is normal on Safari) it is lost with the
record, the entry stays `open` with its key, and the next scan adds the device's own job back as a foreign record (probe P2: `foreign: true`, tray badge 1,
"Picked up from your other device. Working on it" on the device that started it, for up to 72 h of 5-minute polls; on every other device as well). If the
dropped record was `applied` with `ackDue` still set, the re-adopted record claims and applies the same answer again (idempotent here, but it is a second apply).
**Fix:** (a) in `jobs.drop`, when the record is `pub && !pickupEnded`, keep a small tombstone `pk:<id>` `{ mark, expiresAt }` in the job store (no key) that
`pickup.round` writes as a mark and `take` treats as "mine"; or simply refuse to `drop` such a record and set `dismissed` instead until `pickupEnded`.
(b) in `take`, also skip ids present in the store (`jobs.store.getItem('job:' + id)`), see N1.

## Nice

- **N1. `jobs.add` overwrites a stored record.** `take` checks only memory; a tab whose `reload` lagged behind `tabSync` (a leader steal on `pageshow` right after
  another tab published) can `add(recFor(e))` over the real record in IndexedDB (own record with inputs, or a foreign one with its nonce). Fix: `pickup.take`
  adds under `withStoreLock('jobs')` only when `job:<id>` is absent.
- **N2. No backoff when Drive fails (P4).** `lastScan` moves only after a good round, and `tick` calls `pickup.step()` every pass, `again` re-kicks after 300 ms:
  with Drive answering 403 / 429 / 5xx it is about 6 list calls a minute with one job polling, plus one per focus event. Fix: in `pickup.step` set
  `this.lastScan = now` (or `failUntil = now + 60 s, doubling to 15 min`) in the `catch`, and skip `due` work until then.
- **N3. The apply heartbeat can hold a lease forever.** `applyAndAck` / own `claimApply` renew the claim every `lease / 2` until the apply promise settles; an
  apply that never settles (a hung IndexedDB / `studio.ensureInit`) keeps the other device on 409 indefinitely. Cap the beat (stop after 3 renewals) and race
  the apply against a timeout (`lease * 2`). Each beat also downloads the whole answer again (claim returns it): fine for now, note it.
- **N4. Sign-out keeps other accounts' keys.** `pickup.onSignOut` expires foreign records but leaves `key`, `nonce` and `pk.ctx` in IndexedDB for `JOBS_KEEP_MS`
  (7 days); a busy record keeps applying after sign-out. Blank `key` / `nonce` / `pk` in `expireForeign`, `abandon` and foreign `onCollected`, and drop busy
  foreign records when they settle after sign-out. Own records with `pickupDue` that were never listed are published into the NEXT account's file after a
  switch (sign out, sign in as another account): clear `pickupDue` in `onSignOut` (same as C1's existing rule that local data carries over, but the key is new).
- **N5. Deleting a generating aid can resurrect it.** `studio.remove` writes a tombstone only for `ready` or `pickedUp` aids. If B already claimed the job, B
  makes the aid and sync brings it back to A. Write the tombstone also when the aid's job record is `pub`.
- **N6. `drop` result without ack.** `applyStudio` returns `'drop'` when a ready aid of that id came by sync (no `jobId`); `abandon` does not ack, so the answer
  stays on the server under B's lease and then until 72 h. When the existing item is `ready` with the same id, ack instead of abandon.
- **N7. Clock skew.** All pickup times use `Date.now()`; a device whose clock is days ahead prunes open entries from the shared file for everyone and expires its
  foreign records at once. Use the server offset `renew.noteServerTime` already records (one `pickupNow()` helper).
- **N8. Artifact adoption keeps the first file.** `driveListSyncFile(...) || upload` is list-then-create; two devices uploading at once leave two
  `sth-studio-<id>.json`. On read keep the newest and delete the extras (review D10).
- **N9. Focus events reset waits.** `jobs.kick` sets `nextPollAt = now` for `succeeded`, which skips the 409 waits (`PICKUP_CLAIM_WAIT_S`) and the
  "lease + 30 s" wait after a failed foreign apply, so three focus events can end a foreign record `failed` within a minute. Respect `claimTries` /
  `applyTries` in `kick`.
- **N10. Privacy wording.** "dropped at most 72 hours after the request was made": a resend (busy, lost) moves `expiresAt`; unknown-version entries are kept up
  to 8 days. Say "72 hours after it was last sent".

## Review must-fixes D1-D10: implemented? (checked in the code)

| Item | Status |
|---|---|
| D1 no resend after `unknown` for listed jobs | Done (`onUnknown`, `cur.pub`); over-broad, see M2; window before `pub`, see M5 |
| D2 `collected` branch, no ack, no apply | Done (`onStatus` -> `onCollected`); `job7-admit.lua` refuses re-admission of `collected` |
| D3 loser keeps watching, takes over after the lease | Done (409 -> `claimTries`, waits 20/60/120/300 s, `state: 'collected'` ends it); suite "winner dies" |
| D4 nonce in claim and ack, lease renewal, mode in claim answer | Done (`claimBody`, `ackBatch` nonce, heartbeat; mode checked for foreign) |
| D5 apply-context checks | Done: tool/mode pairing, claim `mode`, tombstones, `found.jobId === j.id`, `jobs.groups.has(groupId)`, History `removed`; resurrection N5 |
| D6 validate and bound the file | Done: size from metadata and blob (256 KB), `v`, 50 entries, id / key / group regexes, enum states, times within 8 d, label via `studioClean`, ctx typed copies (same sanitiser as the sync file), entries in a `Map`, never spread from parsed data |
| D7 merge per id, lock, server is truth | Done: Web Lock `sth-drive-jobs`, version re-check before write, finished beats open, extra files merged and deleted; apply only on a won claim |
| D8 rollback | Done: `INPUT-400` -> `claimOffUntil` + `hello`, own jobs fall back to `result` + ack, foreign go passive (10 min) |
| D9 doc wording | not client code (design / privacy) |
| D10 expiresAt moves with resends, foreign never creates / retries, apply lock, orphans | Mostly: `pickupDue` on every `submitted`, `navigator.locks` `sth-job-apply-<id>`; foreign Cancel does more than mark (M1); artifact dedupe N8 |

## Verified correct (tried to break, could not)
- **Exactly one apply across devices**: every apply rests on a won `claim`; two devices racing -> one `ok`, one 409; the 409 side keeps polling and ends on
  `collected`; a dead winner's lease expires and the other side claims (suite rows 2, 3). The claim nonce is saved (`jobs.update`) before the call, so a crash
  re-claims with the same nonce.
- **No new resend paths for foreign records**: `kind: 'pickup'`, `maxAttempts: 1`, `send` throws, `retry` / "Try again now" hidden, `pickup.onStatus` never calls
  `onFailed` / `onUnknown`; `failed` / `rejected` / `unknown` are passive until `expiresAt`.
- **Multiple tabs**: pickup runs only in the jobs leader (`jobs.canWork`); file writes under a cross-tab Web Lock; per-job apply lock with `ifAvailable`; the
  file cache is per tab and invalidated by Drive `version`.
- **Hostile file**: oversize skipped before download; `__proto__` / `constructor` keys never reach an object (Map + field-by-field copies; unknown-version
  entries are JSON-cloned, capped at 10 x 2000 chars and only re-serialised); every string that reaches the DOM is escaped (`rowHtml`, `toolDescribeGroup`,
  History `fileNames` via `escapeHtml`) or set with `textContent`; a newer `v` is never written and pickup stops (`pickup.future`).
- **Other Google account**: a token of another account is refused before it is stored (`google_account_mismatch`); `mutateNow` aborts when the token changes
  mid-round; sign-out clears the cache and expires foreign records.
- **Key exposure**: the key is in the Drive file (removed when the entry ends), POST bodies to the job webhook, and the job store only; not in localStorage,
  URLs, `tabSync` messages (`'jobs'` only), console (codes only) or the studio item / History / sync file (suite row 13 checks storage, DOM, logs, reports, URLs).
- **C1 / C2 interplay**: a `pickedUp` aid is replaced by the synced ready copy (one item, same id); History ids are `h_<gid>` on both devices, so a result that
  arrives by pickup and by History sync is one entry; `applyTool` returns early when `h_<gid>` is there and respects History deletions; the KB "(transcribed)"
  item is guarded per device by `kbSaved:<gid>` and by name.
- **Ineligible kinds**: tutor, big runs (`studio` MR groups), multi-batch tool runs and the digest step are never listed (`pickup.eligible`; suite row 8).
- **Rollback**: v7 answers `claim` with `STH-INPUT-400`; own answers are kept (`result` + ack), foreign go passive; a v7 `collected`-shaped record is still
  `duplicate` for admission.
- **Polling cost**: foreign records ride in the existing 10-per-call status batches; scans need a visible leader tab and a fresh token; an unchanged file costs one
  list call (version cache), no download.

## Verdict: GO-WITH-CHANGES
The claim / collected design is implemented faithfully and the cross-device exactly-once core (claim race, lease takeover, no resend for foreign records,
rollback) holds. Before release fix **M1** (foreign Cancel deletes a paid answer; also align the fake `cancel` with the real script so the suite can see it),
**M2** and **M3** (a false "collected" with no way back, worst for tool runs), **M4** (claim only with a Drive token), **M5** (set `pub` before the write) and
**M6** (own jobs re-adopted as foreign). All six are small, local changes in `jobs.cancel`, `jobs.onUnknown`, `handlers.group.collected` / `toolDescribeGroup`,
`jobs.claimApply`, `pickup.round` and `jobs.drop` / `pickup.take`; add a suite row for each.
