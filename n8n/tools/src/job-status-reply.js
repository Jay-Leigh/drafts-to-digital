// Background jobs: answer to `status` (one entry per job, same order). Never writes. A job that is still `running`
// long after its deadline is reported as `lost` (derived here): the client then sends attempt + 1.
// Unknown job, wrong key and expired record all look the same: state "unknown".
const RETRY_MS = { 'STH-JOB-429': 20000, 'STH-AI-429': 60000, 'STH-AI-500': 20000, 'STH-AI-503': 20000, 'STH-AI-504': 20000, 'STH-SRV-500': 20000, 'STH-STU-409': 60000, 'STH-STU-422': 0, 'STH-JOB-504': 0 };
const CODE_RE = /^STH-[A-Z]{2,10}-\d{3}$/;
const plan = $('Job - Plan').first().json;
const now = plan.now;
const rows = $input.all().map((i) => i.json);
if (rows.length !== plan.jobs.length || rows.some((r) => !r || !Array.isArray(r.result))) {
  return [{ json: { ok: false, error: { code: 'STH-SRV-503', retryable: true, retryAfterMs: 20000 } } }];
}
function errOut(code, e) {
  const o = { code, retryable: Object.prototype.hasOwnProperty.call(RETRY_MS, code) };
  o.retryAfterMs = o.retryable ? RETRY_MS[code] : 0;
  if (e && typeof e.reason === 'string' && /^[a-z0-9_]{1,40}$/.test(e.reason)) o.reason = e.reason;
  if (e && Number.isInteger(e.maxTokens)) o.maxTokens = e.maxTokens;
  return o;
}
function stored(raw) {
  let e = null;
  try { e = JSON.parse(raw); } catch (x) { e = null; }
  return errOut(e && typeof e.code === 'string' && CODE_RE.test(e.code) ? e.code : 'STH-SRV-500', e);
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const jobs = plan.jobs.map((j, i) => {
  const [kh, st, a, d, e, rb, c] = rows[i].result;
  if (!kh || kh !== j.kh) return { id: j.id, state: 'unknown', attempt: 0, error: null, ageMs: 0, resultBytes: 0 };
  let state = String(st);
  let error = null;
  if (state === 'running' && now > num(d) + plan.graceS * 1000) {
    state = 'lost';
    error = errOut('STH-JOB-504');
  } else if (state === 'failed' || state === 'rejected') {
    error = stored(e);
  }
  return { id: j.id, state, attempt: num(a), error, ageMs: Math.max(0, now - num(c)), resultBytes: state === 'succeeded' ? num(rb) : 0 };
});
return [{ json: { ok: true, jobsEnabled: plan.jobsEnabled, modes: plan.modes, now, jobs } }];
