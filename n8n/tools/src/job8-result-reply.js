// Background jobs: answer to `result` (kept for cached v7 pages). Only the holder of the key gets the stored answer, which is exactly what the
// synchronous request would have returned. Missing, wrong key, not succeeded, expired or already collected = STH-JOB-404. v8: an answer somebody
// holds a LIVE claim on (the lease of `claim`) is refused with STH-JOB-409 (reason claimed), so `result` + `ack` can never bypass a claim.
const plan = $('Job - Plan').first().json;
const rows = $input.all().map((i) => i.json);
if (rows.length !== 2 || rows.some((r) => !r || r.result === undefined)) {
  return [{ json: { ok: false, error: { code: 'STH-SRV-503', retryable: true, retryAfterMs: 20000 } } }];
}
const notFound = [{ json: { ok: false, error: { code: 'STH-JOB-404' } } }];
const h = rows[0].result;
const raw = rows[1].result;
if (!Array.isArray(h) || !h[0] || h[0] !== plan.jobs[0].kh || h[1] !== 'succeeded' || typeof raw !== 'string') return notFound;
const cla = Number(h[5]);
if (h[4] && plan.now - (Number.isFinite(cla) ? cla : 0) < plan.claimLeaseMs) return [{ json: { ok: false, error: { code: 'STH-JOB-409', retryable: false, reason: 'claimed' } } }];
let result;
try { result = JSON.parse(raw); } catch (e) { return notFound; }
return [{ json: { ok: true, id: plan.jobs[0].id, mode: h[3], result } }];
