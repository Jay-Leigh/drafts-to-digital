// Background jobs, step 1: the ONLY place with job settings, and the validation of the small envelope.
// Input: "Job - Pick Envelope" ({env: {v, op, job, jobs}}; the big request body never reaches this node).
// Never throws: bad input becomes a fixed STH-INPUT-400 answer. Ids and keys travel in POST bodies only.
//
// Kill switch 1 (re-publish): set JOBS_ENABLED to false. New creates are then refused with STH-JOB-503
// (clients send the request synchronously); jobs already running still finish and can be collected.
// Kill switch 2 (instant, no import): in Upstash `SET cfg:jobs_max_running 0` (0 = off, 1..12 = total cap).
const JOBS_ENABLED = true;
const SERVER_V = 8; // the app turns the v7 features on when the hello answer says v >= 7, and renewal / claim / collected when v >= 8
// Every mode: deadlineS must stay <= 600 until runs longer than 10 minutes are proven on the real stack.
// bulk: true = bulk work. A bulk job is governed ONLY by the bulk cap (2 together) and the total cap, never by its mode's own cap, so a
// long map-reduce run or a J4 batch cannot hold another user's single study aid. The `cap` of a mode applies to non-bulk jobs only
// (the J4 modes and studio_digest are always bulk, so their `cap` is not used). A Studio mode runs as bulk when the job envelope says
// bulk: true (map-reduce parts and the reduce run); the tutor never does.
const JOB_MODES = {
  tutor: { deadlineS: 420, cap: 3 },
  studio_mindmap: { deadlineS: 600, cap: 1 },
  studio_flashcards: { deadlineS: 420, cap: 1 },
  studio_quiz: { deadlineS: 420, cap: 1 },
  studio_infographic: { deadlineS: 420, cap: 1 },
  studio_slides: { deadlineS: 420, cap: 1 },
  studio_digest: { deadlineS: 420, cap: 2, bulk: true },
  transcribe: { deadlineS: 600, cap: 2, bulk: true },
  template: { deadlineS: 600, cap: 1, bulk: true },
  reviewer: { deadlineS: 600, cap: 1, bulk: true },
};
const JOB_CAP_TOTAL = 4; // all modes together (override: Upstash key cfg:jobs_max_running)
const JOB_CAP_BULK = 2; // bulk jobs together
const JOB_RESERVE = 2; // slots the bulk jobs may never take (interactive work: tutor, single study aids)
const CLAIM_LEASE_S = 600; // v8: a claim of a finished answer holds 10 minutes (the same nonce renews it); then another device may claim
const COLLECTED_TTL_S = 259200; // v8: after `ack` a finished job leaves a contentless `collected` record for 72 h (so an origin device never re-runs it)
const CAPS = { maxSources: 15, tools: ['mindmap', 'flashcards', 'quiz', 'infographic', 'slides', 'digest'], maxParts: 16, partMaxTokens: 200000, reduceMaxTokens: 300000, jobCap: JOB_CAP_TOTAL, bulkCap: JOB_CAP_BULK, reserve: JOB_RESERVE, claimLeaseS: CLAIM_LEASE_S };
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
const cfg = { graceS: GRACE_S, resultTtlS: RESULT_TTL_S, rejectTtlS: REJECT_TTL_S, resultMaxBytes: RESULT_MAX_BYTES, capTotal: JOB_CAP_TOTAL, capBulk: JOB_CAP_BULK, reserve: JOB_RESERVE, claimLeaseMs: CLAIM_LEASE_S * 1000, collectedTtlS: COLLECTED_TTL_S, modes };
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
  const bulk = allowed && (m.bulk === true || (job.bulk === true && /^studio_/.test(job.mode)));
  return [{ json: { route: allowed ? 'create' : 'reject', op: 'create', id: job.id, key: job.key, attempt: att, mode: job.mode, deadlineS: m.deadlineS, cap: m.cap, bulk, cfg, now } }];
}

// status / result / ack / cancel / budget / claim (Job Endpoint)
if (env.v !== 1 || !['status', 'result', 'ack', 'cancel', 'budget', 'claim'].includes(env.op) || !Array.isArray(env.jobs) || env.jobs.length > MAX_BATCH) return bad();
const list = env.jobs;
if (env.op === 'budget') {
  if (list.length !== 0) return bad();
  return [{ json: { route: 'budget', op: 'budget', key: '', cfg, now } }]; // one Redis read, see "Job - Budget Read"
}
if (list.length === 0) {
  if (env.op !== 'status') return bad();
  return reply({ ok: true, jobsEnabled: JOBS_ENABLED, modes, v: SERVER_V, caps: CAPS, now }); // hello: no Redis
}
if ((env.op === 'result' || env.op === 'claim') && list.length !== 1) return bad();
for (const j of list) {
  if (!j || typeof j !== 'object' || typeof j.id !== 'string' || !ID_RE.test(j.id) || typeof j.key !== 'string' || !KEY_RE.test(j.key)) return bad();
  // v8 nonce (43 characters like a key): required by `claim`, optional on `ack` (it must then match the claim), ignored by the other ops
  const hasNonce = j.nonce !== undefined && j.nonce !== null;
  if (env.op === 'claim' && !(typeof j.nonce === 'string' && KEY_RE.test(j.nonce))) return bad();
  if (env.op === 'ack' && hasNonce && !(typeof j.nonce === 'string' && KEY_RE.test(j.nonce))) return bad();
}
return list.map((j, idx) => ({ json: { route: env.op, op: env.op, id: j.id, key: j.key, nonce: env.op === 'claim' || env.op === 'ack' ? (typeof j.nonce === 'string' ? j.nonce : '') : '', idx, n: list.length, cfg, jobsEnabled: JOBS_ENABLED, modes, now } }));
