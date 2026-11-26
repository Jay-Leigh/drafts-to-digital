# Final adversarial review: v8 server bundle (renew, auth epoch, claim / collected)

Reviewer: Opus sub-agent, 26 Nov 2026. Scope: `n8n/sth-workflow-v8-bundle.json` against `n8n/sth-workflow-v7-bundle.json`, `n8n/tools/build.js`
(`buildV8`, `applyExtraOrigin`), `n8n/tools/src/auth.lib.js`, `auth8-*`, `renew8-*`, `job8-*`, `job-claim.lua`, `job-claim-reply.js`, `job8-ack.lua`,
runbook step 23 and the rotate command (steps 0, 3, 15, 16, 23). Baseline commit `885e3ea`. Read against `docs/design-signin-sync.md` B / D and
`docs/review-signin-sync-BD.md`. Nothing was run against n8n cloud, Upstash or Drive; no secrets were used.

Severity: **blocker** = do not import; **must-fix** = fix (or decide) before the owner imports; **nice** = worth doing, not gating.

## What was run (offline, all green)

| Run | Result |
|---|---|
| `STH_OUT_DIR=<tmp> node build.js` | v7 and v8 rebuilt byte-identical to the committed files |
| `node validate.js` | 11252 checks, 0 failures (14 new nodes, 9 changed by parameters, 188 byte-identical; `Job - Result Read` differs by its note only) |
| `tests/t-auth.js`, `tests/t-v8.js`, `tests/t-v7.js`, `tests/t-jobs.js` (Redis 7 on 6391) | 215 / 114 / 354 / 278 passed, 0 failed |
| `e2e/run-renew.js` on local n8n 2.29.7 with the v8 test copy | 71 passed, 0 failed (alg `none`, HS384/HS512 with the same secret, RS256 header, other secret, expired by 1 s, `nbf` in the future, empty signature, cap, epoch, breaker, fail closed, alarms, CORS, claim / 409 / ack / collected) |
| `e2e/run-renew.js extra` on the `STH_EXTRA_ORIGIN=https://school.example.org` build | 13 passed, 0 failed (all five webhooks answer both origins, a third is refused) |
| Own probes: `renewPrepare` / `renewDecide` boundaries, `curl` against the local renew webhook | see "Verified correct" |

## Findings

### M1. must-fix (legal timing): importing v8 before the notice takes effect changes live behaviour that the current privacy text describes
The plan (design E, `docs/progress-2026-11-26.md`: "Opus review -> fixes -> owner imports v8") is to import v8 before the notice is published
(27 Nov) and long before it takes effect (11 Dec), on the grounds that "the client is dark". Two parts of v8 are NOT dark:
1. `Job - Ack` (`job8-ack.lua`) now keeps `sth:job:<id>` (kh, mode, attempt, times, `co`) for 72 h after collection instead of deleting it. The live
   (v7) client acks every collected answer, so from the import every collected job leaves this record. `privacy.html:219` and `:528` say the record is
   "Deleted when the answer is collected" / "Deleted when your browser has collected the answer". Design E itself lists this row (526) as needing the notice.
2. `/webhook/student-tools-renew` is live for anyone holding a token: with `curl` a token can be extended to 30 days. `privacy.html:310` / `:445`
   ("valid for 7 days", "using the app does not extend it") and the terms' "changing the access code" row describe the v7 rule. Also two new Upstash
   keys (`auth:ep`, `auth:rn:<yyyymmddhh>`, no personal data) are missing from the server key table next to `auth:code` / `auth:fail` / `auth:ok` (`privacy.html:501-515`).

Failing scenario: owner imports on 27 Nov; between 27 Nov and 11 Dec every collected background answer leaves a 72-hour record that the published
policy says does not exist; the 14-day rule for future changes (CLAUDE.md) is broken for that window.
**Fix (pick one):** (a) recommended, simplest, the v7 precedent: import v8 ON the release day (11 Dec, no job running), after the notice has run;
the B / D clients gate on `serverHas(8)` and the release date anyway, and the owner curl tests of step 23 run that day. Add one line to runbook
step 23: "Import on the release date of the notice, not before." (b) If an early import is wanted: a server date gate, `const PICKUP_FROM_MS =
Date.UTC(2026, 11, 11)` in `job8-read-request.js`, `collectedTtlS: now >= PICKUP_FROM_MS ? 259200 : 0`, and in `job8-ack.lua` treat `ARGV[4] == '0'`
as the v7 `DEL`; `renewDecide` answers `unavailable` before the same date; plus `t-v8` / `t-auth` rows. (a) needs no code.

### M2. must-fix (owner command): the rotate command touches keys that are not declared in KEYS, and bumps the epoch AFTER setting the code
Runbook steps 3 / 23 (`runbook-owner.md:69`, `:754`):
`EVAL "redis.call('SET','auth:code',ARGV[1]) return redis.call('INCR','auth:ep')" 0 "NEW-CODE"`.
- `numkeys 0` with hard-coded key names: Redis requires every key a script touches to be passed in KEYS (enforced in cluster mode; Upstash's own
  rule for its databases was not verifiable here). Every workflow script in v8 does declare its keys; this owner command is the only one that does not.
- Order: Lua scripts are not rolled back on error. If `auth:ep` ever holds a non-integer (the hand-typed case the alarms exist for), `SET` succeeds,
  `INCR` fails: the code is changed but the epoch is not bumped, and the owner sees only an error line.
**Fix:** everywhere the runbook shows it (lines 34, 69, 73, 294, 300, 747, 754), use
`EVAL "local e=redis.call('INCR',KEYS[2]) redis.call('SET',KEYS[1],ARGV[1]) return e" 2 auth:code auth:ep "NEW-CODE"`
(INCR first: on a bad `auth:ep` nothing changes and the error is visible). Try it once in the Upstash console on the release day (it answers the new epoch).

### N1. nice: the global breaker can be tripped by any one token holder, and does not bound the Upstash command count
`Renew Read Epoch` INCRs `auth:rn:<hour>` on EVERY request with a valid signature (before the claims are judged), and `renewDecide` answers
`busy` above 2000 for everyone. Scenario: a student with a token (the code is shared) runs `while true; curl .../student-tools-renew` at 0.6 req/s:
every other user's renewal that hour is `STH-AUTH-503 busy`. Sign-in is NOT affected (separate keys `auth:fail` / `auth:ok`, checked). Sustained
for 5+ days it pushes users back to "code every 7 days", i.e. v7 behaviour, nothing worse. The INCR still runs above 2000, so each request still
costs one Upstash command: the breaker limits minted tokens, not cost (the job `status` op already allows 10 commands per request, so renew is not
the worst amplifier; B3's "Upstash budget" concern is unchanged, not fixed). Also `EXPIRE` is set only when `n == 1`; a hand-created
`auth:rn:<hour>` without TTL would hold the breaker shut forever.
**Fix (owner decision, needs a privacy row):** a per-chain sub-limit in the same EVAL, `INCR auth:rs:<sid>` EX 3600, over 6 -> `busy` for that chain
only, and count the global key only for requests under the sub-limit (a short-lived record of a random chain id, 1 h). Cheap part without a decision:
`if redis.call('TTL',KEYS[1]) < 0 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end`. Runbook "Limits" should say the breaker protects minting,
not the Upstash budget.

### N2. nice: an ack whose claim lease expired is refused forever, so a collected answer can stay stored up to 72 h
`job8-ack.lua:6` returns 3 whenever `cl` is set and differs from the caller's nonce, even after the 10-minute lease. Scenario: v8 device A claims
(nonce A) and dies before ack; a cached v7 page (no nonce) later fetches `result` (allowed: the lease expired), applies, acks with `''` -> 3;
the v7 client ignores the body and marks the ack done; the answer text stays in `sth:jobr:<id>` until the 72-hour TTL although it was collected.
**Fix:** read `cla` too and block only a LIVE foreign claim: `HMGET ... 'kh','st','cl','cla'`, `if c[3] and c[3]~='' and c[3]~=ARGV[2] and
tonumber(ARGV[3])-(tonumber(c[4]) or 0) < tonumber(ARGV[5]) then return 3 end`, pass `claimLeaseMs` as ARGV[5]; add the t-v8 row.

### N3. nice: the alarms fire once per request and share the 50-a-day error mail cap
With a bad `auth:ep`, every renewal and every correct-code sign-in throws in `Renew Alarm` / `Auth Alarm`. A busy morning sends the first 50 and
then exhausts the shared `err:<yyyymmdd>` counter, so client error reports (other faults) are dropped for the rest of the day. Mail content is safe
(checked: `format-workflow-error.js` sends workflow name, node name, execution id and the fixed message; no token, no code, no payload; executions
are not saved). **Fix:** alarm at most once an hour (for example `SET auth:alarm 1 NX EX 3600` in the same EVAL, alarm only when it was set), or
accept and say so in step 23.

### N4. nice: a forgotten credential on `Renew Sign JWT` fails silently
If the owner does not select `STH JWT` on `Renew Sign JWT`, every renewal answers `STH-AUTH-503 unavailable` (`Renew Shape Token` fallback) with
no alarm; clients keep their tokens and retry, and users meet the 7-day gate without anyone noticing. Same pattern as v7 `Auth Sign JWT` (there a
sign-in answers 500, which is visible). **Fix:** make 23.5 (a forged token older than 1 h renews `ok:true`) mandatory in the import procedure, or set
`alarm: 'sign_failed'` in `renew8-shape-token.js` and route it to `Renew Alarm`.

### N5. nice: stale text
- `docs/design-signin-sync.md:176` still claims "the 1-hour floor bounds each chain to 24 renewals a day" and `:173` "2 Upstash commands per
  renewal"; the review (B3, B11) asked for corrections. Runbook step 23 is correct; the design doc is not.
- Runbook 23.6 restores the epoch with `SET auth:ep 0`, which rule 2 forbids; it is safe only while no client renews (now) and while nobody signs in
  during that minute (a sign-in then carries `ep:1` and can never be renewed after the restore). Say "only before the release date" next to it.
- `claim` answers the raw stored state: a job past its deadline is reported `running` (only `status` derives `lost`), a record without `st`
  becomes `"null"`. PR-D must take state decisions from `status`, not from `claim`; say so in the D design.

### N6. nice: live client against `collected` (no regression, worth knowing for PR-D)
The live v7 client sends any unknown state to `onUnknown` -> `onFailed(lost)` -> resend. On v8 a `collected` record answers the resend `duplicate`
(no Gemini call, no bill), and the client resends again until `maxAttempts`, each time re-uploading the request body. On v7 the same situation
(record deleted) re-ran and re-billed, so v8 is strictly better. PR-D's `collected` branch (review D2) ends it.

### N7. nice: n8n's own 401 / 403 carry CORS on 2.29.7 (resolves a design open point locally)
`curl` against the local renew webhook with `Origin: https://jay-leigh.github.io`: no token -> 401, `Bearer garbage` -> 403 `jwt malformed`, both
with `Access-Control-Allow-Origin`. So the browser can read them; the `index.html` comment that says otherwise is wrong for 2.29.7 (Cloud Run is the
same n8n, but check once with 23.4 plus `-H "Origin: ..."`). The 403 body echoes the jsonwebtoken message (`jwt expired`, `invalid signature`,
`invalid algorithm`): built into n8n, same on every JWT webhook since v1, harmless.

## Review must-fixes that belong to the server: implemented? (checked in the real code)

| Item | Status | Where |
|---|---|---|
| B1 origin rewrite reaches `Renew Endpoint` | Done. `applyExtraOrigin` runs last on each shipped bundle (v8 expects 5, v7 4, else the build throws); e2e `extra` ran green | `build.js:1346-1354`, `:1453-1454` |
| B3 global breaker in the same EVAL, `unavailable`-style refusal, 30 min retry | Done (`busy` -> `STH-AUTH-503`, retryable, 1800000 ms); limits in N1 | `build.js:1378-1386`, `auth.lib.js:97-104` |
| B6 every plain `SET auth:code` replaced in the runbook | Done (lines 34, 69, 73, 294, 300, 747, 754); command shape see M2. Optional `auth:code_h` auto-bump not built (it was optional) | `runbook-owner.md` |
| B7 one `normEp`; invalid stored epoch -> `unavailable` + alarm; token `ep` integer; never DEL, eviction off, key table row | Done. `"01"` reads as 1 (harmless); `" 1"`, `"1.0"`, `"-1"`, `""`, 10 digits -> unavailable | `auth.lib.js:20-24`, `auth8-evaluate.js:22-23`, `renew8-alarm.js`, `auth8-alarm.js`, runbook 16 / 23 |
| B8 fake splits `secretGen` / `renewEpoch`, uses the real library | Done | `tests/lib/fake-n8n.js:9,48-53` |
| B9 strict, version-aware claims | Done, every rule: `sub`, integer `iat`/`exp`, `exp - iat <= 7 d + 60`, `iat <= now + 300`, v1 must not carry `auth_time`/`ep`, v2 must carry integer `auth_time <= iat` within 30 d, `exp <= auth_time + 30 d + 60`, integer `ep` 0..999999999, 36-char `sid`; any other `v` (or none: the runbook 8.6 forge) refused | `auth.lib.js:45-75` |
| B11 algorithm confusion, every path to a Respond node, `no-store`, sign failure handled | Done (e2e ran; `validate.js` walks every Renew path) | `run-renew.js:63-70`, `validate.js` |
| D2 server safety net: a `collected` record refuses re-admission | Holds (`job7-admit.lua:5`, unchanged: only `failed`/`lost`/`rejected` re-admit) | |
| D4 ack keeps `c`, writes `co`; `collected` only from `succeeded`; failed/rejected/cancelled DEL; running 0; nonce mismatch -> 3; claim same nonce renews lease; claim returns mode; nonce `KEY_RE`; one 404 for absent / wrong key / expired; `result` honours a live claim (409) | Done, all bullets | `job8-ack.lua`, `job-claim.lua`, `job-claim-reply.js`, `job8-read-request.js:75-83`, `job8-result-reply.js:13-14` |
| D8 v7 answers `claim` with `STH-INPUT-400` | Holds (v7 `Job - Read Request` op list has no `claim`); the fallback is client work | |

## Verified correct (tried to break, could not)
- **Forgery / alg confusion / tampering:** n8n verifies with `algorithms: [credential algorithm]` (`Webhook/utils.js`, jsonwebtoken), so `none`,
  HS384/HS512, RS256 headers, other secrets, empty signatures, 2-part tokens all 403 before the workflow (e2e). `jwtPayload` is n8n's verified
  payload, a separate key from the body / query, so a client cannot inject claims. A `__proto__`-shaped payload is refused (`token`).
- **Boundaries (server time only, probed):** iat 1 h - 1 s ago -> `too_early`, exactly 1 h -> `ok`; `auth_time` 30 d - 1 h ago -> `max_age`, 30 d -
  1 h + 1 s -> `ok` with a 3601 s token (exp = `auth_time` + 30 d, never more); 30 d - 1 s -> `max_age`; 30 d exactly -> `token` (and n8n already
  rejects the token as expired, clock tolerance 0, e2e "expired one second ago"); 25 d -> `ok` with exp at the cap (5 d). `iat` 301 s in the future
  -> `token`. `ep` float / negative / string / 1e10 / missing on v2 -> `token`.
- **v1 tokens:** renew with `auth_time = iat`, `ep = 0`, so the 30 days do not restart; refused (`revoked`) once the owner has bumped; a v1 token that
  carries `auth_time`/`ep` is refused.
- **Replay:** a replayed renewal only mints another token of the same chain with the same cap; it cannot extend an expired, capped, re-keyed or
  revoked chain. Cost of replay: N1.
- **Epoch race:** the renew EVAL reads `auth:ep` atomically; an `INCR` during a renewal lets at most that one renewal through (one more token of at
  most 7 days). The sign-in EVAL reads code and epoch in one call, and the corrected rotate command (M2) writes both atomically, so a sign-in sees
  either (old code, old epoch) or (new code, new epoch).
- **Fail closed:** no Upstash answer, an error object, a short array or a non-number counter -> `unavailable`; sign-in with an invalid epoch ->
  503 (and never mints epoch 0). `Auth Build Claims` refuses to build claims for an invalid epoch (unreachable after `Auth Evaluate`, defence in depth).
- **No leaks in answers:** refusals carry only `code`, `retryable`, `retryAfterMs`, `reason`; success carries only the new token and times;
  `Cache-Control: no-store` on both; the access code never appears. Alarm mails carry fixed text (N3). `saveDataErrorExecution` / `saveDataSuccessExecution` stay `none`.
- **CORS:** `Renew Endpoint` has the same `allowedOrigins`; preflight allows `authorization`; a foreign origin gets no ACAO; refusals are 200 so the
  header is always present; 401 / 403 carry it too on 2.29.7 (N7).
- **Breaker accounting:** atomic INCR, 2-hour expiry on first use, 2000 passes and 2001 is `busy`; checked before claims, so it counts bad tokens too
  (intended: it bounds minting, see N1). It cannot affect sign-in.
- **Claim / ack (Lua, atomic, every key through KEYS):** wrong key and absent record are one 404; double claim with two nonces -> one `ok`, one 409;
  same nonce re-claims and refreshes the lease; a lease older than 10 min is taken over; claim of `collected` answers the state, no content;
  claim of `running` / `failed` / `rejected` / `cancelled` answers the state; claim writes only `cl` / `cla` and never extends the TTL; ack on
  `succeeded` -> `collected`, `co` written, `c` kept (so `ageMs` is unchanged), `cl` / `cla` / `x` / `rb` dropped, answer deleted, 72 h TTL; ack on
  `collected` -> 1; failed / rejected / cancelled -> DEL as v7; running -> 0. Nonces pass `Job - Hash Key` untouched (crypto node adds `kh`).
  Upstash slot rules: every workflow script declares its keys; v7 already runs multi-key scripts on this database.
- **`result` vs claim:** `result` refuses a live claim (409) and serves after the lease, so a cached v7 page cannot bypass a live claim.
- **v7 clients against v8:** sign-in answer shape unchanged (`{token, expiresAt}`), the client reads only `exp`; no server node reads claims other
  than the presence of `jwtPayload`; hello `v: 8` passes `serverHas(7)`; the extra `caps.claimLeaseS` is ignored; ack answers are not parsed by the
  v7 client; no live client claims, so `result` never 409s until PR-D ships.
- **Rollback v8 -> v7 (runbook 23):** correct as written. v2 tokens verify on v7; renew answers 404; hello says 7; a `collected` record is still
  `duplicate` for v7 admit; extra hash fields (`cl`, `cla`, `co`) are ignored by v7 scripts; v7 `ack` deletes any non-running record, including
  `collected` (harmless); v1 tokens minted on v7 renew under a later v8 with epoch 0.
- **The 188 byte-identical nodes:** `Job - Pick Envelope`, `Job - Hash Key`, `Job - Route Op` (no fallback output, `claim` is output 8),
  `Job - Status Reply` (passes `collected` through with `resultBytes` 0), `Job - Cancel` (returns `collected` unchanged), `Job - Admit`
  (`duplicate`), `Job - Store Outcome` (only acts on `running`), quota / tutor (only test `jwtPayload` presence), the error workflow (fixed fields
  only). No bad interaction found.
- **Upstash commands:** sign-in still one EVAL; renewal one EVAL; claim one EVAL (replaces the 2-command `result` pipeline); ack unchanged.

## Verdict: GO-WITH-CHANGES
Nothing in v8 lets anyone extend, forge or outlive a session beyond the owner's design, and the claim / ack Lua is atomic and correct. Before the
owner imports: **M1** (import on the release day of the notice, or add the server date gate) and **M2** (rotate command with KEYS, INCR first,
runbook only). N1-N7 are optional; N4's "run 23.5 with a forged token on import day" is a free safety step worth adding to the procedure.
