// Background jobs, step 1: the ONLY place with job settings, and the validation of the small envelope.
// Input: "Job - Pick Envelope" ({env: {v, op, job, jobs}}; the big request body never reaches this node).
// Never throws: bad input becomes a fixed STH-INPUT-400 answer. Ids and keys travel in POST bodies only.
//
// Kill switch 1 (re-publish): set JOBS_ENABLED to false. New creates are then refused with STH-JOB-503
// (clients send the request synchronously); jobs already running still finish and can be collected.
// Kill switch 2 (instant, no import): in Upstash `SET cfg:jobs_max_running 0` (0 = off, 1..12 = total cap).
const JOBS_ENABLED = true;
// Every mode: deadlineS must stay <= 600 until runs longer than 10 minutes are proven on the real stack.
const JOB_MODES = { tutor: { deadlineS: 420, cap: 3 }, studio_mindmap: { deadlineS: 600, cap: 1 } };
const JOB_CAP_TOTAL = 4; // all modes together (override: Upstash key cfg:jobs_max_running)
const GRACE_S = 60; // a running job is reported lost this long after its deadline
const RESULT_TTL_S = 259200; // 72 h: records and results are kept this long, or until the app collects them
const REJECT_TTL_S = 3600; // refused (rejected) and cancelled records
const RESULT_MAX_BYTES = 524288; // larger results are not stored (STH-JOB-413)
const MAX_BATCH = 10;

const fromStart = $('Job Start Endpoint').isExecuted;
const now = Date.now();
const env = ($input.first().json || {}).env || {};
const ID_RE = /^j_[A-Za-z0-9_-]{22}$/;
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const MODE_RE = /^[a-z][a-z0-9_]{0,24}$/;
const modes = Object.keys(JOB_MODES);
const cfg = { graceS: GRACE_S, resultTtlS: RESULT_TTL_S, rejectTtlS: REJECT_TTL_S, resultMaxBytes: RESULT_MAX_BYTES, capTotal: JOB_CAP_TOTAL, modes };
const reply = (r) => [{ json: { route: 'reply', reply: r, key: '', now } }];
const bad = () => reply({ ok: false, error: { code: 'STH-INPUT-400' } });

if (fromStart) {
  // op "create" (Job Start Endpoint). The answer was already sent; the run only continues if admitted.
  let job = env.job;
  if (typeof job === 'string') {
    try { job = JSON.parse(job); } catch (e) { job = null; }
  }
  const att = job && job.attempt;
  if (!job || typeof job !== 'object' || job.v !== 1 || job.op !== 'create' || typeof job.id !== 'string' || !ID_RE.test(job.id) || typeof job.key !== 'string' || !KEY_RE.test(job.key) || !Number.isInteger(att) || att < 1 || att > 3 || typeof job.mode !== 'string' || !MODE_RE.test(job.mode)) return bad();
  const allowed = JOBS_ENABLED && Object.prototype.hasOwnProperty.call(JOB_MODES, job.mode);
  const m = allowed ? JOB_MODES[job.mode] : { deadlineS: 0, cap: 0 };
  return [{ json: { route: allowed ? 'create' : 'reject', op: 'create', id: job.id, key: job.key, attempt: att, mode: job.mode, deadlineS: m.deadlineS, cap: m.cap, cfg, now } }];
}

// status / result / ack / cancel (Job Endpoint)
if (env.v !== 1 || !['status', 'result', 'ack', 'cancel'].includes(env.op) || !Array.isArray(env.jobs) || env.jobs.length > MAX_BATCH) return bad();
const list = env.jobs;
if (list.length === 0) {
  if (env.op !== 'status') return bad();
  return reply({ ok: true, jobsEnabled: JOBS_ENABLED, modes, now }); // hello: no Redis
}
if (env.op === 'result' && list.length !== 1) return bad();
for (const j of list) {
  if (!j || typeof j !== 'object' || typeof j.id !== 'string' || !ID_RE.test(j.id) || typeof j.key !== 'string' || !KEY_RE.test(j.key)) return bad();
}
return list.map((j, idx) => ({ json: { route: env.op, op: env.op, id: j.id, key: j.key, idx, n: list.length, cfg, jobsEnabled: JOBS_ENABLED, modes, now } }));
