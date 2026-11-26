// Background jobs (v8): answer to `claim` (one job). The script returns {unknown} | {state, <state>} | {claimed} | {ok, <mode>, <raw answer>}.
//   unknown (no record, wrong key, expired) -> STH-JOB-404 (one answer for all three: no existence oracle)
//   state   -> {ok:true, id, state}: the job is not finished (running / failed / rejected / cancelled) or already `collected` elsewhere; no answer
//   claimed -> STH-JOB-409 reason claimed: another nonce holds a live claim (the lease is 10 minutes; the same nonce renews it)
//   ok      -> {ok:true, id, mode, result}: exactly what `result` returned, the caller now holds the claim
const plan = $('Job - Plan').first().json;
const rows = $input.all().map((i) => i.json);
if (rows.length !== 1 || !rows[0] || !Array.isArray(rows[0].result) || typeof rows[0].result[0] !== 'string') {
  return [{ json: { ok: false, error: { code: 'STH-SRV-503', retryable: true, retryAfterMs: 20000 } } }];
}
const r = rows[0].result;
const notFound = [{ json: { ok: false, error: { code: 'STH-JOB-404' } } }];
if (r[0] === 'unknown') return notFound;
if (r[0] === 'claimed') return [{ json: { ok: false, error: { code: 'STH-JOB-409', retryable: false, reason: 'claimed' } } }];
if (r[0] === 'state') return [{ json: { ok: true, id: plan.jobs[0].id, state: /^[a-z]{1,16}$/.test(String(r[1])) ? String(r[1]) : 'unknown' } }];
if (r[0] !== 'ok' || typeof r[2] !== 'string') return [{ json: { ok: false, error: { code: 'STH-SRV-503', retryable: true, retryAfterMs: 20000 } } }];
let result;
try { result = JSON.parse(r[2]); } catch (e) { return notFound; }
return [{ json: { ok: true, id: plan.jobs[0].id, mode: r[1], result } }];
