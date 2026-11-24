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
  const others = (cfg.modes || []).filter((m) => m !== f.mode); // every mode's running-set is a KEY of ADMIT (total cap)
  const keys = [jk(f.id), 'sth:jobx:' + execId, 'sth:jobs:n:' + day, 'cfg:jobs_max_running', 'sth:jobs:run:' + f.mode, ...others.map((m) => 'sth:jobs:run:' + m)];
  const d = now + f.deadlineS * 1000;
  const argv = [f.kh, f.mode, f.attempt, now, d, cfg.resultTtlS, f.cap, cfg.capTotal, cfg.graceS * 1000, execId, f.id, f.deadlineS + 3600, cfg.rejectTtlS];
  return [{ json: { route, keys, argv, now, job: { id: f.id, attempt: f.attempt, mode: f.mode, startedAt: now, deadlineAt: d, ttlS: cfg.resultTtlS, maxBytes: cfg.resultMaxBytes } } }];
}
if (route === 'reject') {
  return [{ json: { route, keys: [jk(f.id)], argv: [f.kh, f.mode, f.attempt, now, '{"code":"STH-JOB-503"}', cfg.rejectTtlS], now } }];
}
const jobs = items.map((i) => ({ id: i.id, kh: i.kh }));
if (route === 'status') {
  return [{ json: { route, now, graceS: cfg.graceS, jobsEnabled: f.jobsEnabled, modes: f.modes, jobs, pipeline: jobs.map((j) => ['HMGET', jk(j.id), 'kh', 'st', 'a', 'd', 'e', 'rb', 'c']) } }];
}
if (route === 'result') {
  return [{ json: { route, now, jobs, pipeline: [['HMGET', jk(jobs[0].id), 'kh', 'st', 'a', 'm'], ['GET', rk(jobs[0].id)]] } }];
}
if (route === 'ack' || route === 'cancel') {
  return [{ json: { route, now, rejectTtlS: cfg.rejectTtlS, jobs: jobs.map((j) => ({ id: j.id, kh: j.kh, job: jk(j.id), jobr: rk(j.id) })) } }];
}
return [{ json: { route: 'reply', reply: { ok: false, error: { code: 'STH-INPUT-400' } }, now } }];
