// Background jobs: answer to `result`. Only the holder of the key gets the stored answer, which is exactly what the
// synchronous request would have returned. Everything else (missing, wrong key, not succeeded, expired) is STH-JOB-404.
const plan = $('Job - Plan').first().json;
const rows = $input.all().map((i) => i.json);
if (rows.length !== 2 || rows.some((r) => !r || r.result === undefined)) {
  return [{ json: { ok: false, error: { code: 'STH-SRV-503', retryable: true, retryAfterMs: 20000 } } }];
}
const notFound = [{ json: { ok: false, error: { code: 'STH-JOB-404' } } }];
const h = rows[0].result;
const raw = rows[1].result;
if (!Array.isArray(h) || !h[0] || h[0] !== plan.jobs[0].kh || h[1] !== 'succeeded' || typeof raw !== 'string') return notFound;
let result;
try { result = JSON.parse(raw); } catch (e) { return notFound; }
return [{ json: { ok: true, id: plan.jobs[0].id, mode: h[3], result } }];
