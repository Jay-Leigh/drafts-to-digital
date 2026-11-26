// Background jobs, step 3: builds the Redis call for the operation. Input: all items from "Job - Hash Key"
// (the key itself is dropped here; only its SHA-256 hash `kh` goes on). Output: ONE item.
const items = $input.all().map((i) => i.json);
const f = items[0] || {};
const route = f.route;
const now = f.now;
const cfg = f.cfg || {};
const execId = String($execution.id);
const day = new Date(now).toISOString().slice(0, 10).replace(/-/g, '');
const jk = (id) => 'sth:job:' + id;
const rk = (id) => 'sth:jobr:' + id;

if (route === 'reply') return [{ json: { route, reply: f.reply, now } }];

if (route === 'create') {
  // KEYS: job, execution map, daily counts, total-cap override, this mode's running set, the bulk running set, every other mode's running set (total cap)
  const others = (cfg.modes || []).filter((m) => m !== f.mode);
  const keys = [jk(f.id), 'sth:jobx:' + execId, 'sth:jobs:n:' + day, 'cfg:jobs_max_running', 'sth:jobs:run:' + f.mode, 'sth:jobs:run:bulk', ...others.map((m) => 'sth:jobs:run:' + m)];
  const d = now + f.deadlineS * 1000;
  const argv = [f.kh, f.mode, f.attempt, now, d, cfg.resultTtlS, f.cap, cfg.capTotal, cfg.graceS * 1000, execId, f.id, f.deadlineS + 3600, cfg.rejectTtlS, f.bulk ? '1' : '0', cfg.capBulk, cfg.reserve];
  return [{ json: { route, keys, argv, now, job: { id: f.id, attempt: f.attempt, mode: f.mode, bulk: f.bulk === true, startedAt: now, deadlineAt: d, ttlS: cfg.resultTtlS, maxBytes: cfg.resultMaxBytes } } }];
}
if (route === 'reject') {
  return [{ json: { route, keys: [jk(f.id)], argv: [f.kh, f.mode, f.attempt, now, '{"code":"STH-JOB-503"}', cfg.rejectTtlS], now } }];
}
if (route === 'budget') {
  return [{ json: { route, now, day, keys: ['usage:' + day, 'cfg:daily_units', 'cfg:studio_max_tokens', 'cfg:mr_max_units', 'cfg:bulk_ratio'] } }];
}
const jobs = items.map((i) => ({ id: i.id, kh: i.kh }));
if (route === 'status') {
  return [{ json: { route, now, graceS: cfg.graceS, jobsEnabled: f.jobsEnabled, modes: f.modes, jobs, pipeline: jobs.map((j) => ['HMGET', jk(j.id), 'kh', 'st', 'a', 'd', 'e', 'rb', 'c']) } }];
}
if (route === 'result') {
  // v8: cl / cla (the claim and its time) ride along so that `result` can refuse an answer somebody holds a live claim on
  return [{ json: { route, now, claimLeaseMs: cfg.claimLeaseMs, jobs, pipeline: [['HMGET', jk(jobs[0].id), 'kh', 'st', 'a', 'm', 'cl', 'cla'], ['GET', rk(jobs[0].id)]] } }];
}
if (route === 'ack' || route === 'cancel' || route === 'claim') {
  // nonce: the claim of the caller (v8 ack / claim); '' when the caller sent none
  return [{ json: { route, now, rejectTtlS: cfg.rejectTtlS, collectedTtlS: cfg.collectedTtlS, claimLeaseMs: cfg.claimLeaseMs, jobs: jobs.map((j, i) => ({ id: j.id, kh: j.kh, job: jk(j.id), jobr: rk(j.id), nonce: items[i].nonce || '' })) } }];
}
return [{ json: { route: 'reply', reply: { ok: false, error: { code: 'STH-INPUT-400' } }, now } }];
