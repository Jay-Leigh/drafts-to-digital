# Design: stay connected, stay signed in, sync more, cross-device pickup

Status: DESIGN ONLY (no code). Author: architect sub-agent, 26 Nov 2026. Baseline: commit `9c34e80` (origin/main after PR #43).
Line numbers below are for `index.html` at `9c34e80` (`git show 9c34e80:index.html`). The working tree had an uncommitted History-filter change
by another session at the time of writing (about +93 lines around History); re-locate by function name, not by number.

## Summary (one page)

1. **A (Google, client only, no notice).** On the first tap/click of a visit, and on the first tap after the sync token ages out (1 h), call
   `state.driveSyncClient.requestAccessToken({ prompt: '', login_hint: <stored email> })` synchronously inside the gesture. Track the sync
   token's expiry (today it is not tracked at all). Share one in-flight request between gesture, button and export; let Docs export reuse the
   sync token (it already holds `drive.file`). One automatic try per visit; on block/close/refusal fall back to today's "Re-connect Google".
   Real GIS behaviour: with `prompt: ''` the token model still opens a popup that closes itself (a visible flash, a tab switch on iOS). NOT
   verified on real Safari/iOS: a device test is a release gate.
2. **B (app JWT renewal, server v8 + client).** New JWT-protected webhook `/webhook/student-tools-renew`. Claims gain `auth_time` (carried),
   `ep` (epoch) and `v:2`; `sid` becomes the chain id. New token `exp = min(now+7d, auth_time+30d)`. Refuse after 30 days, when `ep` differs
   from Upstash `auth:ep`, or when the token is under 1 h old. **Finding: there is no `ep` claim or revocation epoch on the real server today**
   (only in the test fake `tests/lib/fake-n8n.js:43,62,73`); revocation is "rotate the JWT secret" (runbook 13, 15). B adds `auth:ep`
   (optional key, absent = 0) so that rotating the access code also stops renewals. Stateless (no per-session keys) by default.
3. **C(1) (client only, no notice).** Auto-pull on tab return and every 5 min while visible and connected; cheap `version` check before
   download; one sync at a time (in-tab chain + Web Lock across tabs); write back only when the merge changed something. **Fix two existing
   bugs first:** `pushToDrive` overwrites `kbItems`/`tutorChats` with this device's copy (data loss across devices) and union merges resurrect
   deletions. Use a local three-way base (ids + times of the last synced file) instead of new synced tombstones, so no new data kind ships.
4. **C(2) (gated, notice).** History "documents" sync like study aids: summary in a new `history` field of the sync file, body in a hidden
   file `sth-history-<id>.json`, deleted ids (31 days), expiry from the entry's own `timestamp` (same on every device).
5. **D (gated, notice, small server change).** A separate hidden file `sth-jobs-v1.json` lists open jobs (id, key, mode, label, the context
   to place the result). First kinds: single study aids and one-request J4 runs (template, reviewer, short transcribe). Not tutor, not big
   runs, not multi-batch groups in phase 1. Exactly-once needs a server `claim` op and a `collected` state after `ack`; without them the
   origin device sees `unknown` after another device collected and re-runs the job (double billing): `index.html:5805-5816`, `5818-5829`.
6. **E.** A and C(1) ship now. B, C(2), D need privacy/terms edits and the 14-day notice; they hide behind one release-date constant
   (pattern of `STUDIO_V7_RELEASE_MS`, `index.html:11443`) and `serverHas(8)`. One owner import (v8 = renew + epoch + claim + hello v:8).
   PR sequence: A, C1, Notice, v8 server, B client, C2, D, Release. Opus review: B (auth), D (jobs), A (OAuth UX). Draft notice in E.

---

## A. Stay connected to Google (client only)

### What exists (verified)
- Two token clients: export `state.googleTokenClient` (scope `drive.file`, `CONFIG.googleScopes` `index.html:4008`, init `8596-8605`) and sync
  `state.driveSyncClient` (`SYNC_SCOPE` = appdata + drive.file + profile + email, `8969`; init `8982-8993`). Both `include_granted_scopes: false`.
- Export token: expiry tracked (`storeGoogleToken` `8644-8647`, `hasFreshGoogleToken` `8649`); `ensureGoogleToken` `8812-8838` shares one
  in-flight promise, re-calls `requestAccessToken` after 2 s to bring the window forward, 3-minute timeout.
- Sync token: `onDriveSyncToken` `9000-9010` stores `resp.access_token` only; **`expires_in` is ignored**, so the app learns of expiry only by a
  401: `handleDriveTokenError` `9205-9210` (status 401 only) sets `updateSyncUI('expired')` = "Re-connect Google" (`9528-9546`).
  `runInitialSync` treats 401 and 403 as expiry (`9467-9471`); `pushToDrive` tests the message text for "401"/"403" (`9510`), not `status`.
- On load, a stored user (`sth_sync_user`) is shown as 'expired' (`initAfterAuth` `17607-17615`); tokens are memory-only (never stored).
- `driveFetchUserInfo` returns `{name, email, picture}` (`9308-9314`), so the email for `login_hint` is in `sth_sync_user`.
- No call passes `prompt` or `login_hint` today (grep). `signOutSync` `9034-9061` revokes both tokens and removes `sth_sync_user`; no other
  tab is told (`tabSync` handlers are kb/tutor/history/studio/jobs only, `17618`).

### GIS behaviour (from Google's documented token model; NOT verified on real devices here)
- Token model = popup only; there is no silent iframe flow (the old `gapi.auth2` immediate mode is gone). With `prompt: ''` and an existing
  grant, the popup opens and closes by itself (visible flash; on iOS Safari it is a new tab that closes and returns).
- Popup blockers: `requestAccessToken` must run synchronously in the gesture handler (no `await` before it). A keypress counts as a gesture in
  Chrome; Safari is stricter about which events grant activation.
- Third-party cookies / ITP: the popup is first-party on accounts.google.com, so 3P-cookie blocking does not stop it; but if the user is
  signed out of Google in that browser the popup shows the account sign-in (a visible window), and if consent was revoked it shows consent.
- `login_hint` (GIS option name; the old `hint` is deprecated) selects the account; the user can still pick another one.
- `prompt: 'none'` would return `interaction_required` instead of ever showing UI. Owner chose `''`; `'none'` is the fallback if the device
  test shows unwanted windows.

### Design
- New state: `state.driveSyncTokenExpiresAt` set from `expires_in` (minus 60 s) in `onDriveSyncToken`; `hasFreshSyncToken()`.
- New flag `syncAuto` (memory only, so no new browser key): true when `sth_sync_user` exists and this visit has not already failed an
  automatic try. Set false by sign-out, by an automatic try that ends in `popup_failed_to_open`, `popup_closed`, `access_denied`, or an account
  mismatch.
- **Gesture hook:** one capture-phase `pointerup` + `keydown` listener on `document`, installed after unlock (never on the gate):
  - Fires only if `syncAuto && !hasFreshSyncToken() && !syncTokenInflight && document.visibilityState === 'visible'`.
  - Skips taps on the sync button and on export buttons (they request themselves), and `keydown` inside editable fields (a popup would
    dismiss the mobile keyboard mid-typing). The gesture's own action still runs.
  - Calls `requestAccessToken({ prompt: '', login_hint: email })` synchronously.
- **One request at a time:** a single `syncTokenInflight` shared by the gesture hook, `triggerSyncSignIn` (`9012-9024`) and a new
  `ensureSyncToken()`. `ensureGoogleToken` first returns the sync token when fresh (it includes `drive.file`), so a connected user never gets a
  second export popup. A second `requestAccessToken` on the same client while one is open is not sent (GIS has one callback per client).
- **Account check:** after the token arrives, `driveFetchUserInfo`; if `email` differs from the stored one, do NOT call `runInitialSync`
  (it would merge another account's file into this device): drop the token, `syncAuto = false`, toast "This is a different Google account
  (x). Sign out of sync first to switch." Today `onDriveSyncToken` merges whatever account came back.
- **401 from background work** (pull, push, artifact fetch): mark the token stale (`driveSyncTokenExpiresAt = 0`) and show a quiet status
  ("Paused - tap anywhere to resume"), not "Re-connect Google", while `syncAuto` is true. The next gesture refreshes. Only a failed automatic
  try switches to the existing 'expired' UI and button. Fix `pushToDrive` to test `err.status` like `runInitialSync`.
- **Multi-tab:** each tab holds its own token in memory. Optional (recommend yes): after a token arrives, post it on a dedicated
  `BroadcastChannel('sth-gtoken')` (memory to memory, same origin; never the localStorage fallback that `tabSync.post` uses, `5327-5331`) so
  other tabs skip their own popup. Tokens still never leave the browser.
- **Sign-out:** `signOutSync` also posts `{type:'gsignout'}` (new tabSync type) so other tabs drop their token and set `syncAuto = false`;
  today another tab keeps using the revoked token and would then pop a consent window on its next automatic try.
- **What the user sees:** connected with a fresh token: nothing. First tap: a popup flash (Google's), then "Synced - hh:mm". Blocked or
  closed: one toast (existing `showGoogleAuthToast`, `8626-8634`) and the existing "Re-connect Google" button; no more automatic tries this visit.
- **Privacy:** no new data, no new key, same scopes, token in memory only. No notice needed. Optional wording in the next privacy update:
  "While sync is connected, the app asks Google for a new access token when you first tap in a visit."

### Tests (tests/)
- `lib/fake-google.js` `initTokenClient` (`8-18`): record `opts` (prompt, login_hint), add modes `blocked` (error_callback
  `popup_failed_to_open`), `closed`, `otherAccount`, token `expires_in` override.
- Suite `12-google-reconnect.js`: first tap requests with `prompt:''` and the stored email; none before unlock; none on keydown in a textarea;
  one request for a double tap; export reuses the sync token (no second client request); blocked -> 'expired' UI and no second try;
  other account -> no merge (Drive file untouched); token past expiry + tap -> one new request; sign-out in tab A -> tab B stops.
- Manual device test (owner or tester): Chrome Android, iOS Safari, desktop Safari, Firefox with strict tracking protection.

---

## B. Stay signed in to the app: sliding renewal (high risk: auth)

### What exists (verified)
- Sign-in branch built in `n8n/tools/build.js:222-307`: `Auth Endpoint` (path `student-tools-auth`, no auth, `allowedOrigins`
  `https://jay-leigh.github.io`) -> `Auth Prepare` (`src/auth-prepare.js`: code, IP = last X-Forwarded-For hop) -> `Auth Redis Attempt`
  (`EVAL_AUTH` `build.js:26-27`: INCR `auth:fail:<ip>` + GET `auth:code`) -> `Auth Evaluate` (`src/auth-evaluate.js`, constant-time compare,
  10 per 10 min) -> `Auth Clear Attempts` -> `Auth Issue Cap` (`auth:ok:<ip>`, 20/h, `src/auth-issue-check.js`) -> `Auth Build Claims`
  (`src/auth-build-claims.js`: `{sub:'sth', sid=jti, ac:'sth', v:1, jti, iat, exp}`, TTL 7 d, exp written by hand because the n8n 2.29 JWT node
  does not set it) -> `Auth Sign JWT` -> `Auth Shape Token` -> `Auth Respond OK` `{token, expiresAt}`.
- All other paths are n8n Webhook nodes with JWT Auth (`build.js:187-204`, job webhooks `710-719`): n8n checks signature and `exp` only
  (runbook 8.5, 8.6: 403 `jwt malformed` / `jwt expired`). Claims are visible to the workflow as `$json.jwtPayload` (`src/quota7-prep.js:8`,
  `src/tutor-persona.js:8-9`).
- **No revocation epoch exists on the server.** No `ep`, no `auth:ep` anywhere in `n8n/tools/src`, `build.js` or the runbook. Revocation =
  edit the `STH JWT` secret (runbook 13, 15). Rotating `auth:code` does not end tokens (runbook 0, 15). Terms 151 relies on "changing the
  access code" to limit access; with renewal that would no longer end a session unless renewal is tied to the code (see `ep` below).
- Client: `TOKEN_KEY 'sth_token'` (`4014`), `tokenExpiry` reads `exp` (`4043-4050`), `tokenUsable` (60 s margin, `4052-4054`),
  `loadStoredToken` (`4056-4063`), `saveToken` (`4065-4068`), `authHeaders` (`4071-4073`), `signIn` (`4077-4127`), gate `requireSignIn`
  (`17527-17547`, adopts a token another tab stored), `webhookRequest` 401/403 -> gate once (`8094-8170`). Comment `8138-8140` says n8n's own
  401/403 carry no CORS header (so the browser sees a network error); runbook 0 says they do carry it. **Inconsistent; unverified which is
  true on the live Cloud Run.** The renewal client must handle both (status 401/403, or network error + `authEndpointReachable`).
- Legal text: privacy 310 ("valid for 7 days"), 445 ("using the app does not extend it"), 562 (`sth_token` end time 7 days), 506-515
  (Upstash `auth:*` rows).

### Server (n8n v8 = v7 + this; build in `buildV8(v7)`, the existing pattern)
New nodes (names fixed for the runbook):
| Node | Type | Does |
|---|---|---|
| `Renew Endpoint` | Webhook, POST `student-tools-renew`, JWT Auth (`STH JWT`), responseMode responseNode, `allowedOrigins` ORIGIN | n8n rejects bad/expired tokens before anything runs. Picked up by the `STH_EXTRA_ORIGIN` rewrite (`build.js:1339-1344`) because it carries the same origin string. |
| `Renew Prepare` | Code (`src/renew-prepare.js`) | Reads `jwtPayload` only (body ignored except `{v:1}`). `sub==='sth'`, numeric `iat`/`exp`; `auth_time = claims.auth_time ?? claims.iat` (v1 tokens); `ep = claims.ep ?? 0`; `sid = claims.sid` (v1: = jti). Outcome `bad` if malformed. |
| `Renew Read Epoch` | HTTP (Upstash) `["GET","auth:ep"]` | One command. `onError: continueRegularOutput`. |
| `Renew Evaluate` | Code (`src/renew-evaluate.js`) | Server time only. Rules in order: Redis failed -> `unavailable`; `String(ep) !== String(stored ?? '0')` -> `revoked`; `now - auth_time >= 30d - 1h` -> `max_age`; `now - iat < 3600` -> `too_early`; else `ok` with new claims. |
| `Renew Outcome` | Switch | ok / too_early / max_age / revoked / unavailable / bad |
| `Renew Sign JWT`, `Renew Shape Token` | JWT node + Code | Same as the auth pair; separate nodes because `Auth Shape Token` reads `$('Auth Build Claims')` (`build.js:276-277`). |
| `Renew Respond OK` | Respond 200 | `{ok:true, token, expiresAt, authExpiresAt, now}` |
| `Renew Respond Refused` | Respond 200 | `{ok:false, error:{code, retryable, reason}}` (200 + `ok:false`, as the job endpoints do, so the CORS header is always present). |

New claims (every token from sign-in or renewal): `{sub:'sth', sid, ac:'sth', v:2, jti, iat, exp, auth_time, ep}`.
- `sid`: chain id, set at code entry, carried unchanged through renewals (today `sid === jti`; v1 tokens keep that, harmless).
- `jti`: new per token. `auth_time`: seconds when the access code was last entered, never changed by renewal. `ep`: value of `auth:ep` at issue.
- `exp = min(now + 7d, auth_time + 30d)` (renewal); sign-in unchanged (7 d).

Changed nodes (sign-in):
- `Auth Redis Attempt`: `EVAL_AUTH` also returns `GET auth:ep` as a third element (same round trip).
- `Auth Evaluate`: passes `ep` through (non-numeric/absent -> '0').
- `Auth Build Claims`: adds `v:2, auth_time: iat, ep`.
- `Job - Read Request`: `SERVER_V = 8` (`src/job7-read-request.js:9`) so the client can gate on `serverHas(8)` (`index.html:5060`).

Error codes (`STH-AUTH-*`, `reason` field):
| Code | reason | Retryable | Client does |
|---|---|---|---|
| `STH-AUTH-425` | `too_early` | no | keep token; next check in 6 h |
| `STH-AUTH-440` | `max_age` | no | keep token until it ends; from 3 days before `authExpiresAt` show "You will be asked for the access code on <date>" |
| `STH-AUTH-441` | `revoked` | no | same as 440 (the token lives out its own `exp`, at most 7 days) |
| `STH-AUTH-503` | `unavailable` | yes, 30 min | keep token, try later (fail closed: no Redis, no renewal) |
| `STH-INPUT-400` | `token` | no | treat as 441 |
| n8n 401/403 | (token invalid/expired) | no | existing gate (`requireSignIn`) on the next real request |

Owner key: `auth:ep` (optional; absent = 0). Runbook gets one command that rotates the code AND stops renewals atomically:
`EVAL "redis.call('SET','auth:code',ARGV[1]) return redis.call('INCR','auth:ep')" 0 NEW-CODE`. Instant logout of everyone stays "rotate the
JWT secret". Rejected alternative: a hash of the code in the token (anyone holding a token could brute-force a weak code offline, which would
defeat the 30-day cap).

### Threat model
- **Stolen token:** today usable up to 7 d. With renewal a thief can renew too (stateless) -> up to `auth_time + 30 d`, or until the owner
  bumps `auth:ep` (then at most 7 d more) or rotates the secret (immediately). Worst case grows from 7 to 30 days: this is the accepted cost.
- **Optional hardening (decide in the Opus review): lineage.** Store `auth:sid:<sid>` = latest jti (TTL 30 d). Renew only from the latest
  (or the previous one within 10 min, for lost answers and racing tabs); a fork (older jti) sets the chain to `revoked` -> both thief and
  victim stop renewing, the victim re-enters the code. Costs one key per signed-in browser for 30 days, which links one browser's renewals
  together (new server-side record; privacy table row). Recommended default: stateless (no per-browser server record).
- **Replay:** a renewal request is idempotent in effect (it mints another token of the same chain, same cap); replaying it gains nothing the
  token itself does not already give. TLS only; no body secrets.
- **Renewal storms:** client asks only when < 5 d remain (token older than 2 d), plus jitter (0-10 min) and the server `too_early` floor
  (1 h). After the v8 import every client older than 2 d renews once on its next open: at most one request per active browser. 2 Upstash
  commands per renewal (GET plus nothing else). No load test needed for B.
- **Rate limits:** do NOT reuse `auth:ok:<ip>` (20/h per IP, runbook 8.11): a school NAT renewing on a Monday morning would lock out code
  sign-ins. The JWT check plus the 1-hour floor bound each chain to 24 renewals a day without any per-IP counter (no new IP-keyed data).
- **Clock skew:** cap and floor use server time only. Client decides "due" with `skew = server.now - Date.now()` from the last renew answer or
  job `hello` (`now` in `src/job7-read-request.js:71`).
- **What a renewal carries:** `Authorization: Bearer <current token>`, body `{"v":1}`. Never the code. Answer `Cache-Control: no-store`.
- **CORS:** same `allowedOrigins`; preflight must allow `authorization` (runbook 8.8 pattern; add 23.x test).
- **n8n JWT node:** behaviour of clock tolerance/`nbf` not verified; verify on the local n8n 2.29.7 harness (`n8n/tools/e2e`).

### Client
- `authToken = { t, exp, at0, sid }` (`at0` = `auth_time` or `iat` in ms). `tokenExpiry` unchanged; new `tokenClaims(t)`.
- `loadStoredToken`/`saveToken`: also keep `at0`; stored value stays one JSON under `sth_token` (no new key).
- `renewIfDue(reason)`: only when `serverHas(8) && syncReleased()` (release constant, section E), `tokenUsable`, `exp - now' < 5 d`,
  `now' - iat > 1 h`, `at0 + 30 d - now' > 1 h`. Runs under `navigator.locks.request('sth-auth-renew', {ifAvailable:true})`; inside, re-read
  `sth_token` (another tab may have renewed: adopt the newer `exp`). POST via a small `fetch` (not `webhookRequest`, which would open the gate
  on 401), 20 s timeout, no retries; failures schedule the next try (30 min, 6 h). Triggers: after `startApp`, `visibilitychange` visible,
  `online`, and a 6 h timer while open.
- `authHeaders`: unchanged. 401/403 handling in `webhookRequest`: unchanged (the gate is still the answer to a dead token).
- Gate (`requireSignIn`): subtitle by cause: expired normally (existing text) vs 30-day cap ("For your security the app asks for the access
  code every 30 days"). Show a quiet service-status note from 3 days before the cap.
- Storage blocked: renewal still works in memory for the visit (`saveToken` already tolerates storage failure, `4065-4068`).
- **Rollback:** server v8 -> v7: hello says 7, client stops renewing; v2 tokens still verify on v7 (n8n checks signature/exp only; extra claims
  ignored); everyone falls back to the 7-day rule. Client rolled back, server v8: old client never renews; tokens end after 7 d as today.
  `auth:ep` is ignored by v7. No state to clean up (stateless).

### Tests
- `n8n/tools/tests/t-auth.js` (new, harness like `t-other.js`): `renew-evaluate` table (v1 token, v2 token, cap edge -1 h, epoch mismatch,
  absent `auth:ep`, Redis error, too early); `auth-build-claims` carries `auth_time`, `ep`, `v:2`.
- `n8n/tools/e2e/run-renew.js` on the local n8n: real JWT node accepts the renewed token on `/webhook/sth-job`; expired token -> 403 on renew;
  preflight CORS; `allowedOrigins` rewrite with `STH_EXTRA_ORIGIN`.
- Browser suite `12-auth-renew.js` (fake-n8n gets a renew route; its `epoch` already exists): renews when due, not when fresh; one renewal for
  two tabs; cap -> gate with the 30-day text; epoch bump -> 441 -> gate when the token ends; server v7 -> no renew calls; storage blocked;
  network failure -> retry later, no gate. Plus the `07-legal` storage-key check (no new key).

---

## C. Sync more

### C(1) Auto-pull (client only)

Existing machinery (verified): `runInitialSync` `9380-9476` (read, merge kb/chats/docs/studio, persist, write always); `pushToDrive`
`9479-9519` (debounced 3 s by `scheduleDrivePush` `9521-9525`; guard `state.driveSyncing`); `studio.syncRound` `14247-14259` (own chain);
`tabSync` `5311-5336`; KB/tutor local removed maps `knowledge_bay_removed` / `tutor_chats_removed` (`6414-6433`, `9763-9785`, 300 kept).

Existing defects that auto-pull would make visible (fix in the same PR):
1. `pushToDrive` writes `kbItems: kbItemsForDriveSync(kb.cache), tutorChats: tutor.chats` (`9501`): this device's lists overwrite the file.
   Only docs and studio are merged before writing (`9496-9499`). Two active devices lose each other's new items. Fix: push = read, merge
   (same functions as initial sync), write.
2. Union merges (`mergeKbItems` `9331-9364`, `mergeTutorChats` `9366-9377`) bring deleted items back from the file. Fix without new synced
   data: a **three-way base** kept locally (in the existing `sth_knowledge_bay` / `sth_tutor` stores, key `sync_base`: `{id: updatedAt}` of
   the last file this device wrote or read). Rules: in base, missing remotely, unchanged locally since base -> deleted elsewhere, delete here;
   locally deleted (removed map) -> do not take the remote copy; edited locally after base and deleted remotely -> keep (edit wins).
3. `runInitialSync` does not take `state.driveSyncing`, so it can overlap a push. Fix: one `syncChain` for initial/pull/push.

Design:
- `pullFromDrive({reason})`: needs a fresh sync token (no popup from a timer; a stale token waits for the A gesture hook).
  1. Under Web Lock `sth-drive-sync` (`ifAvailable`; other tabs skip and later get `tabSync` posts).
  2. `GET files/<id>?fields=version` (one small call). Same `version` as last seen by this device -> stop.
  3. Read, three-way merge kb/chats, `mergeSyncedDocs`, `studio.syncRound`, persist, `tabSync.post` per changed store, re-render.
  4. Write back only if the merged content differs from the remote (per-id `updatedAt` comparison, not string equality); after a write store
     the returned `version` (`PATCH ...&fields=id,version`) so this device does not pull its own write.
- Triggers: `visibilitychange` visible (if last pull > 60 s ago), `online`, a 5-minute timer while visible and connected (+-20 % jitter);
  never while hidden. Push stays debounced; a push that finds a newer `version` merges first (defect 1 fix).
- Loops: a pull never schedules a push (persist without `save`, as `runInitialSync` already does `9431-9443`); studio already avoids it
  (`saveProgress(id, true)` `13782-13785`). Converges: identical content produces no write, so no new `version`.
- Cost: ~1 metadata call per 5 min per open tab with a token; full download only after another device wrote.
- No new synced field, no new browser key (the base lives inside existing IndexedDB stores): no notice. Note for E: the C(2) PR can add
  synced kb/chat deleted ids if the base proves insufficient.
- Tests (`01-gate-sync` extension or `13-sync-pull.js`): pull on return; no download when `version` unchanged; no write when nothing changed;
  device A deletes, B pulls -> gone on B and stays gone; B edits while A deletes -> kept; push from B does not drop A's new item; two tabs ->
  one pull.

### C(2) History sync (gated, notice)

What exists: store `sth_cache/history` key `entries` (`4388-4389`), entry `{id, mode, resultText, fileNames, wordCount, preview, timestamp}`
(`saveToHistory` `4454-4475`); ids `h_<time>_<rand>` or `h_<groupId>` for background runs (`8441`); expiry 30 d from `timestamp`
(`purgeExpiredHistory` `4488-4498`); markers `kbSaved:<groupId>` in the same store (`8226-8229`); delete/clear `4500-4516`.

Design (same shape as study aids, which is tested and already in the privacy text):
- Sync file field `history`: `{v:1, items:[{id, mode, fileNames, wordCount, preview, timestamp, driveFileId, bytes}], deleted:[{id, at}]}`.
  Unknown higher `v` -> leave the field untouched (as `studioSyncRead` does, `13617-13619`).
- Body: hidden appData file `sth-history-<id>.json` `{v:1, id, mode, resultText}`, uploaded once (entries never change), fetched when the
  entry is opened on another device (like `studio.fetchArtifact`). Max 2 MB per body (larger: kept on this device only, summary marked
  `localOnly`); max 200 summaries.
- Merge by id; tombstones win over items with `timestamp <= at`. Tombstone TTL 31 days (an entry cannot outlive 30 d anyway).
- Expiry: computed from the entry's own `timestamp` on every device, so all devices agree; any device that prunes an expired entry deletes its
  Drive file (404 = done) and drops the summary. Clear documents -> tombstones for every id.
- `kbSaved:` markers stay local (they only guard against adding a transcription to Knowledge Bay twice on one device). Cross-device
  duplicates are avoided by D's claim, and by giving the auto-saved transcription a deterministic KB id `kb_t_<groupId>` (today `generateId()`,
  `8235`) so the KB merge dedups by id.
- The uncommitted History-filter work (study aids shown in History, read live from Study Studio) is compatible: only "documents" entries are
  synced by this field; study aids keep their own field.
- Privacy implications: reviewer feedback, templates and transcriptions of handwritten work now also sit in the user's Drive appData (same
  protection as KB, which already holds the transcription text). Summaries include file names and the first 160 characters. Signing out of
  sync does not delete them (as today for all Drive data). Needs the notice and privacy rows (E).
- Tests (`14-history-sync.js`): entry made on A appears on B, opens (body fetched); delete on A removes on B; expiry identical on both; 3 MB
  entry stays local; unknown `v` preserved; gate off before the release date (no `history` field written).

---

## D. Cross-device pickup of background jobs (gated, notice)

What exists (verified): job id `j_` + 22 chars, key 43 chars, created in the browser (`prepare` `5707-5711`, `src/job7-read-request.js:40-41`);
server stores only `kh` (SHA-256 of the key, `src/job7-plan.js:1-2`); `result` is read-only (`src/job-result-reply.js`), `ack` deletes
record and answer (`src/job-ack.lua:1-4`); jobs are NOT bound to the JWT `sid` (any valid token + id + key works), so another device can
collect with no server change. Records: `sth_jobs` IndexedDB, leader tab polls (`elect` `5572-5581`), handlers `studio`, `group`, `tutor`
(`6348-6380`). Wrong key = `unknown`/`STH-JOB-404`.

The hazard: after device 2 acks, device 1's `status` says `unknown`; `onUnknown` (`5805-5816`) with `sawServer` calls `onFailed(lost)`
(`5818-5829`), which re-sends the stored request as attempt+1: the job runs and is billed again and the result is applied twice. Exactly-once
therefore needs either a server signal or device 1 checking the pickup file before any resend.

### Server change (recommended, ships inside the same v8 import as B)
- `ack` keeps a contentless record: `DEL sth:jobr:<id>`, `HSET sth:job:<id> st collected c <now>`, `EXPIRE 72h` (instead of `DEL` both).
  Status then answers `state:'collected'`; v8 clients treat it as "done elsewhere" (never a resend).
- New op `claim` (one job): `{v:1, op:'claim', jobs:[{id, key, nonce}]}` with nonce 43 chars. Lua: wrong key -> `STH-JOB-404`; not
  succeeded -> current state; no claim, same nonce, or claim older than 10 min and not acked -> set `cl=nonce, cla=now` and return the result;
  else `{ok:false, error:{code:'STH-JOB-409', reason:'claimed'}}`. v8 clients use `claim` instead of `result` for every job (own and foreign).
  Old `result` stays for cached v7 pages.
- Without this change (fallback D-0): device 1 must read `sth-jobs-v1.json` before any resend after `unknown`, and holds the job if it has no
  Google token; idempotent apply (below) limits damage but double billing remains possible. Not recommended.

### What is synced: hidden appData file `sth-jobs-v1.json` (separate from the big sync file: small, written often)
`{v:1, jobs:[{id, key, mode, kind, label, createdAt, expiresAt, state:'open'|'done'|'cancelled', doneAt, ctx}]}`
- `expiresAt = createdAt + deadline + 72h` (server keeps answers 72 h after finish, runbook 16); entries pruned after that or 24 h after
  `done`. Max 50 entries.
- Written by the origin when a job reaches `submitted` (the server knows it), updated on done/cancel/retry-under-new-id (`retryNow` /
  `rebind`, `5950-5975`, `6355`). Never written while `preparing`/`submitting` (the inputs exist only on device 1).
- `ctx` by kind (phase 1):
  - `studio` (single aid): `{itemId, tool, title, language, topic, sourceIds, sourceNames, options, showSources, createdAt}` so device 2 can
    create the pending item that `studio.applyJobResult` (`14799-14808`) needs (pending items are not in the sync file: `syncField` takes
    ready items only, `14360-14362`). Big-run groups (`kind:'mr'`) excluded.
  - `tool` group with `n === 1` (template, reviewer, transcribe of one batch): `{groupId, mode, fileNames, srcNames, pages, batch}`; device 2
    applies the member into its own `out:<gid>:0` and runs `toolFinish` (`8428-8463`), which writes History `h_<gid>` (synced by C(2)).
    Multi-batch groups are excluded in phase 1: members can be collected on different devices and `toolFinish` needs every part on one device.
  - `tutor`: excluded in phase 1 (chats merge whole-chat last-writer-wins, `9366-9377`; a reply applied on device 2 while device 1 keeps
    chatting can be lost). Phase 2 after per-message merge.
- Who applies: whoever wins `claim`. The nonce is saved in the local job record before the call, so a crash and retry re-claims with the
  same nonce. The winner applies, then `ack`s, then marks the entry `done`. The loser marks its local record `done` (seen elsewhere) and
  deletes its inputs. Device 1 seeing `collected` or `STH-JOB-409` does the same.
- Idempotent apply as a second line: studio item id, History `h_<gid>`, KB `kb_t_<gid>` are deterministic; artifact upload checks by name
  first (`driveListSyncFile(token, studioFileName(id))`, already used in `deleteFiles` `14319-14325`) so two devices never leave two files.
- Polling: device 2's leader polls foreign open jobs at 60 s (visible only), batched with its own (max 10 per call, `MAX_BATCH`).
- Security: the key is a bearer secret for one answer, for at most 72 h, and is useless without an app token. appData files cannot be shared
  from the Drive UI and are readable only through this OAuth client with the user's Google token; anyone who has that token can already read
  the KB and chats in the same folder, so the keys add little. A shared computer left connected to sync would collect results: the existing
  advice (do not use a shared computer, sign out of sync) covers it. Keys are never sent to the server except as today (POST bodies).
- Tests: `n8n/tools/tests/t-jobs.js` (claim/collected Lua with a fake Redis); browser `15-job-pickup.js` with two pages on one fake Drive and
  one fake n8n: studio job started on A, A closed, B collects and shows the aid; both open -> exactly one apply, one ack, no resend on A;
  claim lease expiry; template run collected on B lands in B's History and, with C(2), on A; expired entry pruned; gate off before release.

---

## E. Sequencing and legal

### Needs notice?
| Item | New data / new text? | Notice |
|---|---|---|
| A | No (same scopes, token in memory) | No |
| C(1) | No (three-way base in existing IndexedDB stores) | No |
| B | Yes: privacy 310, 445, 562 say 7 days and "not extended"; new Upstash key `auth:ep` (no personal data); terms 151 (code change) | Yes |
| C(2) | Yes: new data kind in Drive (History), new `history` field and hidden files; privacy 212/258/297/563/572 | Yes |
| D | Yes: job keys in Drive; privacy 300 ("another device ... cannot be collected"), 566-567 ("none of this is synced"), 526 (`sth:job` kept after collection) | Yes |

Gate: one constant `SYNC2_RELEASE_MS = Date.UTC(2026, 11, 11)` (11 December 2026 if the notice goes up on 27 November; owner sets the
real dates, at least 14 days apart) and `const syncReleased = () => Date.now() >= SYNC2_RELEASE_MS;` beside `STUDIO_V7_RELEASE_MS`. B and D
also need `serverHas(8)`. Before the date the code ships dark (tests prove no renew call, no `history` field, no `sth-jobs-v1.json`).

### Draft "Upcoming changes" bullets (privacy and terms box `#upcoming`, as in commit `dc44db6`)
**Upcoming changes, effective 11 December 2026 (announced 27 November 2026)**
- Staying signed in: your sign-in token will be renewed automatically while you use the app, so you only need the access code again after 30
  days, or after 7 days without opening the app. The app sends only the token to renew it, never the code. If the access code is changed,
  renewals stop and you will be asked for the new code within 7 days.
- History sync: if you connect Google sync, your History (transcriptions, templates and reviews from the last 30 days) will also be kept in
  hidden files in your own Google Drive, so you can open them on your other devices. Entries still expire 30 days after they were made, on
  every device, and deleting one removes it everywhere the next time each device syncs.
- Picking up background results on another device: if you connect Google sync, the app will keep a short list of your unfinished background
  requests (their random id and key, a label and where the result belongs) in a hidden file in your own Google Drive, so another device
  signed in to the same Google account can collect the answer. The list is cleared once the answer is collected, and after 72 hours at most.
  The server keeps a short note that an answer was collected (no content) for up to 72 hours.
- On 11 December 2026 you will be asked once to accept the updated Terms and Privacy Policy. Until then the text below applies.
- No new Google permissions, no analytics, no ads, and your information is still not sold or used to train AI.

(Optional, no notice needed, can go in the same box as information: "Sync now refreshes by itself when you come back to the app and every few
minutes, and the app reconnects to Google on your first tap instead of asking you to press Re-connect.")

### PR sequence (branch `claude/dazzling-turing-arvv2i`, one draft PR each)
1. **PR-A** stay connected (client). Tests suite 12. Opus design review (OAuth UX) before build; Sonnet test pass. Real-device check.
2. **PR-C1** auto-pull + push-merge fix + three-way base + single sync chain (client). Tests suite 13 + `01-gate-sync`.
3. **PR-N** notice box in privacy/terms + in-app banner (pattern `dc44db6`), legal:brief draft. Starts the 14 days.
4. **PR-S8** n8n v8 bundle (renew branch, `auth:ep`, claims v2, `SERVER_V 8`, `claim` op, `collected` ack), harness + local e2e, runbook
   section 23. Opus adversarial review (auth + jobs). Owner imports v8 when no job is running (any day before release; the client is dark).
5. **PR-B** client renewal (gated). Suite 12-auth-renew.
6. **PR-C2** History sync (gated). Suite 14.
7. **PR-D** job pickup (gated, phase 1 kinds). Opus review of the claim/apply flow. Suite 15.
8. **PR-R** release day: privacy/terms text, `TERMS_VERSION` to the release date, remove the notice. Single Sonnet test pass (journeys + legal
   vs code), full suite before merge.

### Owner tasks
- Import v8 (runbook 23: back up, import, select `STH JWT` on `Renew Endpoint` and `Renew Sign JWT` too, settings 6/6b, publish, curl tests:
  renew with a fresh token -> 425; with a token older than 1 h -> new token, `exp-iat <= 604800`, `auth_time` unchanged; `INCR auth:ep` ->
  441; expired -> 403; preflight).
- Learn the new code-rotation command (`EVAL ... SET auth:code ... INCR auth:ep`). Nothing must be created in Upstash.
- No load test for B. For D, no new load (claim = one Lua call replacing `result`).
- Device test of A on iOS Safari and Android Chrome before PR-A merges.
- Publish the notice on the PR-N merge day; set the two dates.

## Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| 1 | GIS popup flash on every first tap annoys users or is blocked on iOS | High | Medium | one automatic try per visit; skip editable keydown; device test; switch to `prompt:'none'` if needed |
| 2 | Wrong Google account chosen -> another account's data merged | Low | High | email check before `runInitialSync` |
| 3 | Stolen app token lives 30 d instead of 7 d | Medium | Medium | cap, `auth:ep`, secret rotation; optional lineage |
| 4 | Renewal reuses the sign-in IP counter and locks out school networks | n/a (avoided) | High | no per-IP counter on renew |
| 5 | Auto-pull resurrects deleted items / ping-pong writes | Medium | Medium | three-way base, write only on change, version check |
| 6 | Existing push overwrites other devices' KB/chats | Exists today | High | push merges first (PR-C1) |
| 7 | Job collected on device 2 re-run on device 1 (double billing) | High without server change | High | `collected` state + `claim` op in v8 |
| 8 | Split multi-batch group across devices | Medium | Medium | phase 1 only `n === 1` groups |
| 9 | Sync file grows with History | Medium | Low | bodies in per-entry files, 2 MB cap, 200 items |
| 10 | n8n 401/403 CORS behaviour unknown (runbook vs code comment) | Unknown | Low | client handles both; verify on live once |
| 11 | Concurrent uncommitted History UI work conflicts with C(2) | Medium | Low | build C(2) after it merges |
| 12 | Owner forgets the epoch when rotating the code | Medium | Medium | one combined command in the runbook; terms 151 wording |

## Open questions for the owner
1. A: accept a brief Google window on the first tap of each visit (and after an hour)? If not: `prompt:'none'` (never shows a window, but
   fails when Google needs the user) or reconnect only on taps that need Drive.
2. A: may tabs share the Google token with each other in memory (fewer popups)?
3. B: stateless renewal (recommended) or lineage tracking (detects a cloned token, but stores one server record per signed-in browser for 30
   days)?
4. B: is a new optional Upstash key `auth:ep` acceptable (needed: the server has no revocation epoch today)?
5. C(2): History sync always on with sync, or a separate switch?
6. D: is a small server change in the v8 import acceptable (strongly recommended for exactly-once)? Tutor pickup in phase 2 only?
7. E: notice and release dates (draft: announced 27 Nov, effective 11 Dec 2026)? Release B, C(2), D together on one date?

## Not verified here
- Real GIS popup behaviour with `prompt:''` on iOS/macOS Safari, Firefox strict mode, Chrome Android; whether a keypress grants activation in
  Safari for this flow.
- n8n 2.29.7 JWT node clock tolerance, and whether its 401/403 answers carry CORS on the live Cloud Run.
- Drive v3 `version` field increments on every media PATCH (documented; test with the fake Drive and once live).
- Nothing was run against live systems; no tests were run for this document.
