# Adversarial review: design-signin-sync.md, sections B (JWT renewal) and D (cross-device job pickup)

Reviewer: Opus sub-agent, 26 Nov 2026. Scope: B, D, and the Summary / E / Risks rows that touch them. Owner decisions are taken as fixed
(stateless renewal, optional `auth:ep` with absent = 0, 7-day tokens renewed under about 5 days left, 30-day hard cap from code entry,
v8 = renew + epoch + claim + collected + hello v:8, job keys in a hidden Drive file, tutor pickup in phase 2).
Checked against working tree at `12e7617`: `n8n/tools/build.js`, `n8n/tools/src/auth-*.js`, `job7-*.js|lua`, `job-ack.lua`,
`job-result-reply.js`, `job-status-reply.js`, `job-cancel.lua`, `n8n/runbook-owner.md`, `tests/lib/fake-n8n.js`, `index.html` (jobs engine
`onStatus` / `onUnknown` / `onFailed` / `fetchApplyAck` / `elect` / `hello` / `load`, `studio.findForJob` / `applyJobResult`, token code).
Read-only review: nothing was run against n8n, Upstash or Drive. Line numbers are from the current working tree (they moved since `9c34e80`).

Severity: **blocker** = do not build as written; **must-fix** = change the design before PR-S8 / PR-B / PR-D; **nice** = worth doing, not gating.

---

## B. Sliding renewal

### B1. must-fix: the `STH_EXTRA_ORIGIN` rewrite will not reach `Renew Endpoint`
The design says the renew webhook is "picked up by the `STH_EXTRA_ORIGIN` rewrite because it carries the same origin string". It is not:
the rewrite runs at the END OF `buildV7` (`build.js:1338-1345`), and `buildV8(v7)` would add the node afterwards. The rewrite also asserts
`if (n !== 4) throw`. Result on the custom-domain day (planned in CLAUDE.md): v8 is rebuilt with `STH_EXTRA_ORIGIN`, the four old webhooks
get the new origin, `Renew Endpoint` keeps only `https://jay-leigh.github.io`, every renewal from the new origin fails CORS (the browser sees
a network error, the client schedules "try later"), and every user hits the gate 7 days after their last code entry. Silent.
**Fix:** move the origin rewrite out of `buildV7` into a final step `applyExtraOrigin(wf, expected)` called on the LAST bundle built
(v7 keeps `expected = 4`, v8 `expected = 5`). Add `run-renew.js` e2e: built with `STH_EXTRA_ORIGIN`, preflight to `student-tools-renew` from
the extra origin returns its `Access-Control-Allow-Origin`.

### B2. must-fix: renewal is gated on the jobs engine `hello`, which does not run for some users
`renewIfDue` requires `serverHas(8)`. `service.server.v` is only set by `jobs.hello()` (`index.html` `hello()`), which returns early unless
`jobs.available`; `available` is true only when IndexedDB works and `sth_flag_jobs !== '0'` (`load()`, `enabled()`). So: (a) the design's
"Storage blocked: renewal still works in memory" is false (no IndexedDB -> no hello -> `serverHas(8)` false -> never renews); (b) the owner's
`sth_flag_jobs='0'` switch (CLAUDE.md: "the server hello and `sth_flag_jobs='0'` are the switches") silently turns off renewal too.
**Fix:** decouple. Either `hello()` runs whenever signed in (independent of `available`; the status call with `jobs: []` touches no IndexedDB),
or `renewIfDue` gates only on `syncReleased()` and learns v8 from the renew endpoint itself (404 / network error on first try -> no v8, back
off 6 h). Prefer the first; add a suite-12 case "IndexedDB blocked + jobs flag 0 -> still renews".

### B3. must-fix: "the 1-hour floor bounds each chain to 24 renewals a day" is false
`too_early` tests the PRESENTED token's `iat`. A token older than 1 h stays valid until its own `exp`, so it can be replayed to
`/webhook/student-tools-renew` any number of times; every call is `ok` and costs one n8n execution and one Upstash command. One leaked or
one buggy client (a loop on `visibilitychange`) can burn the Upstash daily/monthly command budget and take sign-in, jobs and quota down with
it. The "Replay" bullet ("gains nothing") is right about privileges and wrong about cost. (Status polling already has a similar cost vector,
so this is not new in kind, but the design must not claim a bound it does not have.)
**Fix:** correct the Threat model text. Add a GLOBAL (not per-session, so within the stateless decision) breaker in the same Upstash call:
`Renew Read Epoch` becomes one `EVAL` that does `INCR auth:rn:<yyyymmddhh>` (EXPIRE 7200) and `GET auth:ep`, returning both;
`renew-evaluate.js` answers `unavailable` (STH-AUTH-503, retry 30 min) above `RENEW_MAX_PER_HOUR` (for example 2000). Still one command
round trip. Client: hard floor of one renew attempt per 30 min per browser, persisted next to the token.

### B4. must-fix: a renew answer can overwrite a newer sign-in from another tab
`renewIfDue` "re-reads `sth_token` (adopt the newer exp)" BEFORE the POST only. Scenario: tab A starts a renewal of chain X (auth_time day 0);
meanwhile tab B shows the gate (token ended in B's memory) and the user enters the code -> chain Y (auth_time today) saved; A's answer
arrives and `saveToken` writes chain X back. The user now sits on the older chain and meets the 30-day gate up to 30 days early; if X was
`ep`-revoked mid-flight the user is pushed onto a dead chain.
**Fix:** after the POST, inside the same lock, re-read `sth_token` and save only if the stored token's `sid` equals the renewed one AND its
`exp` is earlier than the new `exp`; otherwise drop the answer and adopt the stored token. `signIn` takes the same Web Lock `sth-auth-renew`
(blocking, not `ifAvailable`). Fallback without Web Locks (old Safari): the post-check alone is enough.

### B5. must-fix: the legal promise "7 days without opening the app" is not what the client does
Renewal fires only when `exp - now < 5 d`, i.e. the token is older than 2 days. A student who signs in on Monday, uses the app Monday and
Tuesday, and next opens it the following Monday evening (6.5 days after Tuesday) is asked for the code: the last token is still the Monday one.
The real rule is "7 days after the last renewal, and a renewal only happens on a visit at least 2 days after the previous one", so the
gap that logs you out can be as short as 5 days. The E bullet and the gate copy would be inaccurate.
**Fix (pick one, owner's 5-day decision allows the second only if wording changes):** (a) renew when `now - iat > 24 h` (`exp - now < 6 d`);
then "after about 6 to 7 days without opening the app" is true; load stays at most one renewal per active browser per day; or (b) keep 5 days
and change the E bullet to "after 5 to 7 days without opening the app". (a) is recommended; the 1-hour server floor is unchanged.

### B6. must-fix: rotating the code with the OLD command keeps every chain alive for 30 days
The runbook tells the owner to rotate with `SET auth:code` in four places (`runbook-owner.md:30-33`, step 3 `:68`, section 15 `:292`, key table
`:298`). After v8, a plain `SET auth:code` no longer bumps anything: stolen and legitimate chains keep renewing to `auth_time + 30 d`, and terms
151 ("changing the access code") becomes untrue. Risk 12 rates this Medium; the mitigation (one combined command in a new section 23) does
not remove the old instructions.
**Fix:** PR-S8 rewrites every `SET auth:code` mention in the runbook to the combined `EVAL ... SET auth:code ... INCR auth:ep` and marks
plain `SET auth:code` as "do not use from v8". Optional, if the owner accepts one more server-only key (no personal data, nothing in the
token): `Renew Read Epoch`'s `EVAL` compares `redis.sha1hex(GET auth:code)` with `auth:code_h` and on a difference sets it and `INCR auth:ep`,
so any code change ends renewals even when the owner forgets. This does not have the offline brute-force problem the design rejected,
because the hash never leaves Redis.

### B7. must-fix: `auth:ep` normalisation must be one function, and deletion must be named as dangerous
- `Auth Evaluate` maps non-numeric/absent to `'0'`; `Renew Evaluate` compares `String(ep) !== String(stored ?? '0')`. A stored value such as
  `" 1"` or `"abc"` (hand-typed in the Upstash console) makes sign-in mint `ep:'0'` while renew compares against `'abc'`: every renewal is
  `revoked` forever, no error report. **Fix:** one `normEp(v)` in a shared lib (`src/auth.lib.js`, required by both `auth-evaluate.js` and
  `renew-evaluate.js` like `job.lib.js`): integer string `^[0-9]{1,9}$` or absent -> number; anything else -> `unavailable` + error report.
  Token side: `ep` must be an integer, else `bad`.
- Deleting `auth:ep` (a purge, an Upstash eviction policy, a restore) resets it to 0 and RE-ENABLES chains revoked by the first bump that
  still hold an unexpired token (up to 7 days), while every legitimate `ep:1` chain is refused. **Fix:** runbook: "never DEL `auth:ep`;
  only INCR"; check the Upstash database has eviction OFF (a key with no TTL is an eviction candidate under allkeys-*); add it to the
  runbook section 16 key table with "never expires, never delete".

### B8. must-fix: `tests/lib/fake-n8n.js` epoch means something else
In the fake, `epoch` is checked on EVERY request (`fake-n8n.js:62,72`: a bump refuses every token at once). In the design, `auth:ep` only
stops renewals; existing tokens live to their `exp`. Suite `12-auth-renew.js` "epoch bump -> 441 -> gate when the token ends" would pass for
the wrong reason (the fake gates immediately) or fail confusingly. **Fix:** split the fake into `secretGen` (today's semantics: instant
logout, = rotating `STH JWT`) and `renewEpoch` (only the renew route reads it); the renew route answers the same codes as `renew-evaluate.js`
by requiring that file (as the job fake reuses server libs, if it does; otherwise copy its table into the fake with a test that both agree).

### B9. must-fix: claims validation in `renew-prepare.js` must be strict, version-aware
Forging is impossible without the secret (n8n verifies HS256 signature and `exp` first), so this is defence in depth against our own bugs and
hand-made runbook tokens (runbook 8.6 forges `{"sub":"sth","exp":...}` with the real secret). Rules, all -> `bad` (STH-INPUT-400):
`sub === 'sth'`; `iat`, `exp` integers; `exp - iat <= 7 d + 60 s`; `iat <= now + 300`; `v === 1` -> no `auth_time`/`ep` allowed
(`auth_time = iat`, `ep = 0`); `v === 2` -> `auth_time` integer, `auth_time <= iat`, `now - auth_time < 30 d`, `ep` integer, `sid` string
36 chars; any other `v` -> `bad`. The current `claims.auth_time ?? claims.iat` silently RESETS the 30-day cap for any v2 token that lost
`auth_time` (for example a future sign-in path that forgets it); refuse instead. Add these rows to `t-auth.js`.

### B10. must-fix (threat model text): the token is readable by every page on `https://jay-leigh.github.io`
GitHub Pages serves the user site (`jay-leigh.github.io` repo, verified in Search Console per CLAUDE.md) and every project page under ONE
origin. `sth_token` is in `localStorage` of that origin, so any script on any other page there (another repo, a third-party widget, an XSS
anywhere on the origin) reads it. Today that is 7 days of access; with renewal it is 30 days and invisible to the owner. CORS
`allowedOrigins` does not help (the thief renews from curl; runbook 8.8 already says the origin setting does not block curl).
**Fix:** add to the Threat model and Risk 3: "same-origin pages are inside the trust boundary until the custom domain"; owner task: keep
other pages on `jay-leigh.github.io` free of third-party scripts; the custom-domain plan (CLAUDE.md) removes this. Optional `lineage`
stays rejected by the owner; that is fine, but the doc should state this as the residual risk.

### B11. nice
- **Algorithm confusion:** the design relies on n8n verifying with the credential's algorithm. Add to `run-renew.js` e2e: `alg:none`, HS512
  with the same secret, and an RS256 header -> 403 on `student-tools-renew` and on `sth-job`. Also a token whose `exp` is in the past by 1 s
  (clock tolerance 0) and one with `nbf` in the future.
- **Every renew branch ends in a Respond node:** `Renew Sign JWT` with `onError: continueRegularOutput` -> `Renew Shape Token` -> `Renew Token
  Ok?` (If) -> OK or `Renew Respond Refused` (`unavailable`), like `Auth Token Ok?`. A response-node webhook that never reaches a Respond
  node hangs until timeout. Both Respond nodes set `Cache-Control: no-store` (check that `respondNode()` in `build.js` can carry headers).
- **`at0` should not be stored separately:** derive `auth_time`/`sid` from the token payload on load (`tokenClaims(t)`); a stored `at0` can
  drift from the token and is one more thing a rolled-back client must parse. `sth_token` stays `{t, exp}` (old cached pages keep working:
  `loadStoredToken` reads only `t`/`exp`).
- **After a successful renew** call `jobs.resumeAuth()` and close the gate if it is open for an expired-token cause.
- Wording: "2 Upstash commands per renewal (GET plus nothing else)" is 1 (2 with B3).
- Never put the token in error reports: the renew `fetch` must not pass through `webhookRequest`'s reporter with headers; add a suite check
  that `handle-error-report` payloads never match `/eyJ[A-Za-z0-9_-]+\./`.

### B: statements checked and found correct
- Sign-in today: `{sub:'sth', sid=jti, ac:'sth', v:1, jti, iat, exp}`, 7 d, `exp` written by hand (`auth-build-claims.js`); `EVAL_AUTH`
  returns `{GET auth:code, count}` (`build.js:26-27`); adding a third `GET auth:ep` element is safe (a missing key is `false`, not `nil`,
  so the Lua table does not truncate).
- No `ep`/`auth:ep` exists on the server today; revocation is secret rotation; `auth:code` rotation does not end tokens (runbook 0, 15).
- n8n JWT webhooks check signature and `exp` only; `jwtPayload` is visible to the workflow; jobs are not bound to `sid`.
- Stateless renew cannot extend an expired token (n8n rejects it before the workflow), cannot outlive `auth_time + 30 d` (cap from a signed
  claim), cannot survive secret rotation, and after `INCR auth:ep` a racing renewal mints at most one more token of at most 7 days.
- Fail-closed on Redis error (`unavailable`), and server-time-only decisions; client skew from `now` is sound.
- Not reusing `auth:ok:<ip>` for renew is correct (school NAT lock-out avoided); no per-IP key is needed.
- `200 + ok:false` for refusals keeps the CORS header; n8n's own 401/403 CORS behaviour is genuinely unverified (runbook 8.1 shows CORS on
  a Respond node 401; the code comment is about the JWT check) and the client plan to handle both is right.
- Rollback: v2 tokens verify on v7 (extra claims ignored); v7 sign-in mints v1 tokens which a later v8 renews with `ep 0` (refused once the
  owner has bumped, which is the safe direction). The E notice correctly scopes `auth:ep` as "no personal data".
- Rejecting a code hash in the token is correct (offline brute force of a weak shared code).

---

## D. Cross-device job pickup

### D1. must-fix (closest to a blocker): `unknown` after the `collected` record expires still re-runs and re-bills
`onUnknown` with `sawServer` calls `onFailed(..., lost=true)` which re-sends as attempt+1 (`index.html` `onUnknown` / `onFailed`). The design
fixes this only while the `collected` record exists (72 h after ack). Local active records live up to `JOBS_RUNNING_MAX_MS` = 8 days and
`JOBS_KEEP_MS` 7 days. Scenario: phone starts a quiz, is put in a drawer; laptop collects (record -> `collected`, 72 h); phone opens on day 4:
status `unknown` (record expired) -> resend attempt 2 -> `job7-admit.lua` finds no record -> admitted -> Gemini billed again -> result applied
on the phone into an aid that is already ready (studio: no-op; tool group: History written twice). Same path if Redis loses keys.
**Fix (client, no new server data):** in `onUnknown`, when `serverHas(8)` and the record was ever published to `sth-jobs-v1.json`
(`rec.pub = true`, set when the entry is written), never resend: call `expire(cur)` (existing "expired" UI with a user "Try again" button,
which is a deliberate new run). Keep today's resend only for never-published records. Same rule for a FOREIGN record (it has no inputs anyway).

### D2. must-fix: a v8 client must handle `collected` (and `claim` 409) before it is released, in `onStatus`
`onStatus` maps any unrecognised state to `onUnknown` -> resend. The design says v8 clients treat `collected` as done; make it explicit in the
design: a new `else if (state === 'collected')` branch -> `update(x => x.state = 'done'; x.doneElsewhere = true)`, `deleteInputs`, no ack, no
apply. Note the safety net that is already there and should be written down: `job7-admit.lua` answers `duplicate` for a record in state
`collected` (only `failed`/`lost`/`rejected` may be re-admitted), so even a cached v7 page cannot re-run a collected job while the record lives.

### D3. must-fix: the `claim` loser gives up too early; a dead winner loses the result
Design: "The loser marks its local record `done` (seen elsewhere) and deletes its inputs. Device 1 seeing `collected` or `STH-JOB-409` does
the same." Scenario: laptop claims (lease 10 min), its tab is closed before apply/ack; phone got 409 and marked done; nobody ever polls the
job again; the result (paid) is lost until it expires at 72 h. The 10-minute lease expiry is pointless if every other party has stopped.
**Fix:** 409 -> local state `claimedElsewhere` (inputs kept, poll status at 5 min); only `collected` (or the file entry `done`) ends it.
After the lease (`cla + 10 min`) a status `succeeded` lets it claim again with its own nonce.

### D4. must-fix: server Lua details for `claim` / `ack`
- `ack` must not overwrite `c`: `c` is the creation time (`HSETNX c` in `job7-admit.lua:18`) that `job-status-reply.js` reports as `ageMs`.
  Use `HSET st collected co <now>`, `HDEL cl cla x`, `DEL jobr`, `EXPIRE 259200`.
- `ack` marks `collected` ONLY when `st == 'succeeded'`; `failed` / `rejected` / `cancelled` keep today's `DEL` (`job-ack.lua`); `running`
  stays 0. Otherwise an ack after a failure would make the origin see `collected` and silently drop a retryable failure.
- `ack` carries the nonce for claimed jobs (`{id, key, nonce}`): if `cl` is set and differs -> return 3 (`not yours`), leave the record. The
  client then knows its lease was taken over (idempotent apply covers the damage).
- Lease renewal: `claim` with the SAME nonce refreshes `cla`, so a slow apply (slides/infographic artifact upload on mobile) can extend.
- `claim` returns `mode` (as `job-result-reply.js` does with `h[3]`); `KEY_RE` for nonce; absent record, wrong key and expired record all
  answer the same `STH-JOB-404` (no existence oracle; ids are 128-bit `jobsRandom(16)`, keys 256-bit, so enumeration is not practical).
- v8 `result` must honour a live claim: if `cl` is set and `now - cla < 10 min` -> `STH-JOB-409`. Otherwise a cached v7 page (or a
  v8 page that fell back) bypasses the claim with `result` + `ack` and double-applies.
Node / file names: `src/job8-read-request.js` (adds `claim`, nonce, `SERVER_V = 8`), `src/job-claim.lua`, `src/job-claim-reply.js`,
`src/job8-ack.lua` (replaces `job-ack.lua` in v8), `src/job8-result-reply.js` or a claim check in the `result` pipeline. `t-jobs.js` rows
for each bullet.

### D5. must-fix: apply to the wrong aid / group (apply-context injection)
`studio.applyJobResult(itemId, data)` -> `findForJob(itemId)` matches on `id` only and applies to any non-ready item. A stale or
hand-edited entry whose `ctx.itemId` names an existing pending/failed aid of ANOTHER tool writes a quiz into a mind-map item; for groups,
`ctx.groupId` equal to an existing local group overwrites `out:<gid>:0`. Also, an aid the user deleted on device 1 while the job ran is
recreated on device 2 from `ctx` (pending items are not in the sync file, the tombstone is).
**Fix:** for a foreign job, device 2 creates the pending item only if (1) no item with that id exists, or the existing one has
`jobId === entry.id`; (2) `ctx.tool` maps to `entry.mode` (`studio_<tool>`) and the claim answer's `mode` equals `entry.mode`; (3) the id is
not in the studio tombstones; otherwise drop the entry (state `cancelled`). Same for groups: `groupId` absent locally or bound to this job.
Origin side: deleting an aid / cancelling a run cancels the job on the server AND marks the entry `cancelled`.

### D6. must-fix: validate and bound `sth-jobs-v1.json` before use
Read through a whitelist builder, never `Object.assign`/spread of parsed objects (a `__proto__` key from `JSON.parse` becomes an own key;
`Object.assign(target, ctx)` would then re-prototype the target, and any deep-merge helper would pollute). Rules: file size from Drive
metadata <= 256 KB before download; `v === 1`; at most 50 entries; `id` `^j_[A-Za-z0-9_-]{22}$`, `key` `^[A-Za-z0-9_-]{43}$`, `mode` in
`JOBS_MODES`, `kind` in `studio|tool`, `state` in the enum, times finite and within `now +- 8 d`; `label` <= 120 chars; `ctx` per kind with
typed fields only (`itemId` matching the studio id format, `tool` in the tool list, `sourceIds`/`sourceNames` <= `STUDIO_MAX_SOURCES_V7`,
each <= 200 chars, `options` re-validated by the same function the Studio form uses). Invalid entry -> skipped and left as is (an older or
newer client may own it); unknown higher `v` -> do not write the file at all. (Labels and hrefs in the tray are already escaped in `rowHtml`,
checked.)

### D7. must-fix: the file is a hint; the server is the truth; merge per id
Two devices read-modify-write one Drive file (origin adds `open`, the other writes `done`), and Drive media PATCH has no compare-and-swap
here. Lost updates are certain over time. Write in the design: (1) every write = read, merge per id with a monotonic state order
`open < done | cancelled` and max `doneAt`, write; under the C(1) Web Lock `sth-drive-sync` and the single sync chain; (2) no decision that
can bill or apply ever depends on the file alone: apply needs a won `claim`, "done" needs `collected`/409-then-collected; (3) the origin
defers the write until a fresh sync token exists (A has no token until the first gesture) and retries it, instead of "written when the job
reaches `submitted`" once.

### D8. must-fix: rollback / v7 server answers to `claim`
`serverHas(8)` comes from the last hello (30 min cadence). After the owner rolls back to v7, `claim` gets `STH-INPUT-400`; in today's
`fetchApplyAck` an error payload ends in `finalFail` -> the paid result is dropped. **Fix:** `STH-INPUT-400` on `claim` -> `hello()` now,
own jobs fall back to v7 `result` + `ack`, foreign records go passive (no `result` fallback for foreign jobs: without the claim lock two
devices would both apply). Add the rollback row to the design's Rollback text (B has one, D has none).

### D9. must-fix (doc correctness): "the key is useless without an app token" overstates it
There is one shared access code (`sub:'sth'` for everyone), so every student has an app token. Whoever can read the user's appData file
(a shared computer still connected to sync, or any script on the shared `jay-leigh.github.io` origin that obtains a GIS token silently for
this client with `prompt:''`, see B10) can collect that user's results with their own app token. The conclusion (accept, advise against
shared computers) can stay; the reasoning must say this. appData isolation itself is correct: it is per Cloud project, not readable by other
apps' clients or from the Drive UI; note that any other OAuth client created later in project `drafts-to-digital` would share it.

### D10. nice
- `expiresAt` must move with retries: `lastCreateAt + deadlineS + grace + 72 h` on every (re)send (busy waits and lost-resends happen
  after `createdAt + deadline`); otherwise the entry is pruned while the server still holds the answer.
- Foreign records: poll + claim only. Never `create`, `cancel` (unless the user presses Cancel on that row, then also mark the entry),
  `ack` a non-succeeded state, or retry. Foreign `unknown` / `rejected` / `failed` -> passive until `expiresAt` (Job Start answers
  `accepted` before admission, so `unknown` right after `submitted` is normal).
- Per-job apply lock: `navigator.locks.request('sth-job-apply-' + id)` around claim -> apply -> ack. `elect(true)` (steal) does not stop
  the old leader's in-flight `fetchApplyAck`, and without Web Locks every tab is leader (`elect` sets `leader = true`), so two tabs of
  one device can both apply with the same stored nonce.
- Artifact upload "check by name first" is list-then-create, not atomic: on read, keep the newest `sth-studio-<id>.json` and delete extras.
- Orphans: an origin that is never reopened leaves its inputs in IndexedDB until the existing orphan sweep (`sth_jobs_orphans`); a foreign
  device that collected should write `done` so the origin's next open deletes inputs without polling.
- Billing: claim itself costs no Gemini call; with D1-D4 the only re-run path is an explicit user "Try again". Say so in Risk 7.

### D: statements checked and found correct
- Job id `j_` + 22 chars (`jobsRandom(16)`, 128 bits) and 43-char key made in the browser; server stores only `kh` (`job7-plan.js`);
  `result` is read-only; v7 `ack` deletes both keys (`job-ack.lua:4`); jobs are not bound to the JWT; wrong key = `unknown` / STH-JOB-404.
- The double-billing hazard is real and exactly as described: `onUnknown` with `sawServer` -> `onFailed(lost)` -> attempt+1 resend.
- `job7-admit.lua` refuses re-admission of any state other than `failed`/`lost` (att+1) and `rejected` (same att), so the `collected`
  record does block a resend server-side while it exists.
- Phase-1 exclusions (tutor, big runs, multi-batch groups) are the right cut; `applyJobResult` is idempotent for an already-ready item.
- Claim nonce saved before the call lets a crashed claimant re-claim; status/claim never leak the existence of a job to a wrong key.
- Polling foreign jobs inside the existing `MAX_BATCH` 10 and the leader tab keeps load flat; claim replaces `result` one for one.

---

## Summary / E / Risks rows touching B and D
- Summary 2 and Threat model: replace the 24-a-day bound (B3); add the same-origin residual risk (B10).
- E notice bullet 1: fix "7 days without opening" (B5) and make "if the access code is changed" true (B6).
- E notice bullet 3: "cleared once collected, and after 72 hours at most" is fine for the file; the server note also keeps `kh`, mode,
  attempt and times (no content): say "a short technical note (no content)".
- Risks: add "B1 origin rewrite", "Upstash budget via renew replay" (B3), "`auth:ep` deleted or evicted" (B7); Risk 7 mitigation must list
  D1 (no resend after `unknown` for published jobs), not only the server change.
- PR-S8 owner curl tests: add `GET auth:ep` absent -> renew `ok`; set to `abc` -> `unavailable` (B7); `claim` twice with two nonces -> 409;
  `ack` -> status `collected`, `ageMs` unchanged (D4).

## Verdict
- **B: GO-WITH-CHANGES.** The stateless design is sound inside the owner's decisions; nothing lets a renewal extend an expired, re-keyed or
  capped session. Fix B1-B9 (B1, B2 and B4 are functional bugs; B3, B5, B6, B10 are claims the docs or legal text would get wrong) before
  PR-S8 / PR-B.
- **D: GO-WITH-CHANGES.** `claim` + `collected` is the right shape, but exactly-once does not hold as written: D1 (resend after the
  `collected` record expires), D3 (loser gives up), D4 (ack semantics), D5/D6 (apply-context validation) and D8 (rollback) must be in the
  design before PR-S8 freezes the Lua and before PR-D.
