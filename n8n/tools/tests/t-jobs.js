// Unit tests for the background jobs (v4): the five Lua scripts on a REAL Redis 7 (port 6391, separate from the e2e Redis on 6390),
// and every new / changed Code node run through the n8n-like harness. Run: redis-server --port 6391 & node tests/t-jobs.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cmd } = require('./resp');
const { runCode, loadWorkflow, codeOf } = require('./harness');
const PORT = 6391;
const R = (...a) => cmd(a.flat(), PORT);
let pass = 0, fail = 0;
const t = (c, name, extra) => { if (c) pass++; else { fail++; console.log('  FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); } };
const lua = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', 'job-' + n + '.lua'), 'utf8').replace(/\n+$/, '');
const ev = (name, keys, argv) => R('EVAL', lua(name), String(keys.length), ...keys, ...argv.map(String));
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
const ID = (n) => 'j_' + String(n).padStart(22, 'A');
const KEY = (n) => 'k' + String(n).padStart(42, 'A');
const day = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const NOW = 1800000000000;
const GRACE = 60000;

// Redis arguments exactly as "Job - Plan" builds them
function admitArgs(n, { mode = 'tutor', att = 1, now = NOW, key = KEY(n), execId = 'ex' + n } = {}) {
  const m = { tutor: { deadlineS: 420, cap: 3 }, studio_mindmap: { deadlineS: 600, cap: 1 } }[mode];
  const others = ['tutor', 'studio_mindmap'].filter((x) => x !== mode);
  const keys = ['sth:job:' + ID(n), 'sth:jobx:' + execId, 'sth:jobs:n:' + day, 'cfg:jobs_max_running', 'sth:jobs:run:' + mode, ...others.map((o) => 'sth:jobs:run:' + o)];
  const d = now + m.deadlineS * 1000;
  return { keys, argv: [sha(key), mode, att, now, d, 259200, m.cap, 4, GRACE, execId, ID(n), m.deadlineS + 3600, 3600], d };
}
const admit = (n, o) => { const a = admitArgs(n, o); return ev('admit', a.keys, a.argv); };
const storeArgs = (n, { mode = 'tutor', att = 1, state = 'succeeded', err = '', result = state === 'failed' ? '' : '{"r":1}', now = NOW + 1000 } = {}) => ({
  keys: ['sth:job:' + ID(n), 'sth:jobr:' + ID(n), 'sth:jobs:run:' + mode, 'sth:jobs:n:' + day], argv: [att, state, err, result, now, 259200, ID(n) + ':' + att],
});
const store = (n, o) => { const a = storeArgs(n, o); return ev('store', a.keys, a.argv); };
const hget = async (n, ...f) => R('HMGET', 'sth:job:' + ID(n), ...f);
const ttl = async (k) => Number(await R('TTL', k));

(async () => {
  console.log('[ADMIT / STORE / CANCEL / ACK / REJECT: real Redis 7]');
  await R('FLUSHALL');
  let r = await admit(1);
  t(JSON.stringify(r) === '["admitted"]', 'fresh create is admitted', r);
  let h = await R('HGETALL', 'sth:job:' + ID(1)); const H = {}; for (let i = 0; i < h.length; i += 2) H[h[i]] = h[i + 1];
  t(H.kh === sha(KEY(1)) && H.m === 'tutor' && H.st === 'running' && H.a === '1' && H.s === String(NOW) && H.c === String(NOW) && H.d === String(NOW + 420000) && H.x === 'ex1' && H.e === '', 'record fields: kh (hash only), mode, state, attempt, times, execution id', H);
  t(!Object.values(H).includes(KEY(1)), 'the plain key is not stored');
  t((await ttl('sth:job:' + ID(1))) > 259000 && (await ttl('sth:job:' + ID(1))) <= 259200, 'job record TTL 72 h');
  t((await R('GET', 'sth:jobx:ex1')) === ID(1) + '|1|tutor' && (await ttl('sth:jobx:ex1')) > 3900 && (await ttl('sth:jobx:ex1')) <= 3600 + 420, 'jobx maps execution id -> id|attempt|mode, TTL deadline + 1 h');
  t((await R('ZRANGE', 'sth:jobs:run:tutor', 0, -1, 'WITHSCORES')).join() === `${ID(1)}:1,${NOW + 420000 + GRACE}`, 'run-set member id:attempt scored deadline + grace');
  t((await ttl('sth:jobs:run:tutor')) > 86000 && (await ttl('sth:jobs:run:tutor')) <= 86400, 'run-set TTL 1 d');
  t((await R('HGET', 'sth:jobs:n:' + day, 'admitted')) === '1' && (await ttl('sth:jobs:n:' + day)) > 2591000, 'daily counts: admitted 1, TTL 30 d');
  r = await admit(1); t(JSON.stringify(r) === '["duplicate","running"]', 'same create again (same attempt) is a no-op duplicate', r);
  r = await admit(1, { key: KEY(99) }); t(JSON.stringify(r) === '["keymismatch"]', 'same id with another key: keymismatch', r);
  t((await R('HGET', 'sth:job:' + ID(1), 'kh')) === sha(KEY(1)), 'keymismatch leaves the record alone');
  r = await admit(1, { att: 2 }); t(JSON.stringify(r) === '["duplicate","running"]', 'attempt+1 while still running (not lost) is a duplicate', r);

  // caps
  await R('FLUSHALL');
  for (let i = 1; i <= 3; i++) t(JSON.stringify(await admit(i)) === '["admitted"]', `tutor ${i}/3 admitted`);
  r = await admit(4); t(JSON.stringify(r) === '["busy"]', 'tutor 4th: busy (mode cap 3)', r);
  t((await hget(4, 'st', 'e', 'a'))[0] === 'rejected' && JSON.parse((await hget(4, 'e'))[0]).code === 'STH-JOB-429' && (await ttl('sth:job:' + ID(4))) <= 3600 && (await ttl('sth:job:' + ID(4))) > 3500, 'busy -> rejected record STH-JOB-429, TTL 1 h');
  t((await R('HGET', 'sth:jobs:n:' + day, 'busy')) === '1', 'busy counted');
  r = await admit(5, { mode: 'studio_mindmap' }); t(JSON.stringify(r) === '["admitted"]', 'mind map 1/1 admitted next to 3 tutors (total 4)', r);
  r = await admit(6, { mode: 'studio_mindmap' }); t(JSON.stringify(r) === '["busy"]', 'mind map 2nd: busy (mode cap 1)', r);
  await R('DEL', 'sth:job:' + ID(5)); await R('DEL', 'sth:jobs:run:studio_mindmap');
  await store(3, { state: 'succeeded' }); // frees a tutor slot
  r = await admit(7, { mode: 'studio_mindmap' }); t(JSON.stringify(r) === '["admitted"]', 'a finished job frees its slot at once', r);
  r = await admit(8); t(JSON.stringify(r) === '["admitted"]', '2 tutors + 1 mind map running: a third tutor fits (total 4)', r);
  r = await admit(9); t(JSON.stringify(r) === '["busy"]', 'a fourth tutor is refused (mode cap 3; total 4 is full too)', r);
  // total cap with override
  await R('FLUSHALL'); await R('SET', 'cfg:jobs_max_running', '2');
  t(JSON.stringify(await admit(1)) === '["admitted"]' && JSON.stringify(await admit(2, { mode: 'studio_mindmap' })) === '["admitted"]' && JSON.stringify(await admit(3)) === '["busy"]', 'cfg:jobs_max_running 2: third job refused (total over all modes)');
  await R('SET', 'cfg:jobs_max_running', '0'); r = await admit(4);
  t(JSON.stringify(r) === '["off"]' && JSON.parse((await hget(4, 'e'))[0]).code === 'STH-JOB-503' && (await hget(4, 'st'))[0] === 'rejected', 'cfg:jobs_max_running 0: refused at once with STH-JOB-503 (off)', r);
  await R('SET', 'cfg:jobs_max_running', '99'); await R('FLUSHALL'); await R('SET', 'cfg:jobs_max_running', '99');
  for (let i = 1; i <= 3; i++) await admit(i);
  t(JSON.stringify(await admit(4)) === '["busy"]', 'override above 12 is clamped (mode cap still applies)');
  await R('SET', 'cfg:jobs_max_running', 'abc'); await R('FLUSHALL'); await R('SET', 'cfg:jobs_max_running', 'abc');
  for (let i = 1; i <= 3; i++) await admit(i);
  t(JSON.stringify(await admit(9, { mode: 'studio_mindmap' })) === '["admitted"]' && JSON.stringify(await admit(10, { mode: 'studio_mindmap' })) === '["busy"]', 'junk override ignored: defaults apply (4 total)');
  await R('SET', 'cfg:jobs_max_running', '-3'); await R('FLUSHALL'); await R('SET', 'cfg:jobs_max_running', '-3');
  t(JSON.stringify(await admit(1)) === '["off"]', 'negative override = off');

  // re-admission rules
  await R('FLUSHALL');
  await admit(1); // running, attempt 1
  await store(1, { state: 'failed', err: '{"code":"STH-AI-504"}' });
  t((await hget(1, 'st', 'fa', 'rb', 'f')).join() === `failed,1,0,${NOW + 1000}`, 'failed state stored with f / fa / rb');
  r = await admit(1, { att: 1 }); t(JSON.stringify(r) === '["duplicate","failed"]', 'failed + same attempt = duplicate', r);
  r = await admit(1, { att: 3 }); t(JSON.stringify(r) === '["duplicate","failed"]', 'failed + attempt+2 = duplicate', r);
  r = await admit(1, { att: 2, now: NOW + 5000 }); t(JSON.stringify(r) === '["admitted"]', 'failed + attempt+1 is admitted', r);
  t((await hget(1, 'st', 'a', 'f', 'fa', 'rb', 'e', 'c')).join() === `running,2,,,,,${NOW}`, 'attempt 2: running, old f/fa/rb/e cleared, creation time kept', await hget(1, 'st', 'a', 'f', 'fa', 'rb', 'e', 'c'));
  t((await R('GET', 'sth:jobx:ex1')) === ID(1) + '|2|tutor', 'jobx updated for attempt 2');
  // lost (derived): running past deadline + grace
  await R('FLUSHALL'); await admit(1); const dl = NOW + 420000;
  r = await admit(1, { att: 2, now: dl + GRACE }); t(JSON.stringify(r) === '["duplicate","running"]', 'not yet lost at exactly deadline + grace', r);
  r = await admit(1, { att: 2, now: dl + GRACE + 1, execId: 'ex1b' }); t(JSON.stringify(r) === '["admitted"]', 'lost (now > deadline + grace): attempt+1 admitted', r);
  t((await R('ZRANGE', 'sth:jobs:run:tutor', 0, -1)).join() === ID(1) + ':2', 'the lost attempt\'s slot was released, attempt 2 holds one');
  r = await admit(1, { att: 4, now: dl + GRACE + 100000 }); t(JSON.stringify(r) === '["duplicate","running"]', 'attempt 4 is never admitted by the script (client caps at 3; running anyway)');
  // rejected re-admission
  await R('FLUSHALL'); await R('SET', 'cfg:jobs_max_running', '1'); await admit(1); r = await admit(2);
  t(JSON.stringify(r) === '["busy"]', 'second job busy');
  r = await admit(2, { att: 2 }); t(JSON.stringify(r) === '["duplicate","rejected"]', 'rejected + other attempt = duplicate', r);
  await store(1, { state: 'succeeded' });
  r = await admit(2, { att: 1 }); t(JSON.stringify(r) === '["admitted"]', 'rejected + same attempt re-admitted once there is room', r);
  t((await hget(2, 'st', 'e'))[0] === 'running', 'now running');
  // ZSET cleanup of expired scores
  await R('FLUSHALL'); await R('ZADD', 'sth:jobs:run:tutor', NOW - 1, 'old:1', NOW + 100000, 'live:1'); await admit(1);
  t((await R('ZRANGE', 'sth:jobs:run:tutor', 0, -1)).sort().join() === [`${ID(1)}:1`, 'live:1'].sort().join(), 'expired run-set members are removed on admit (slots free themselves)');

  console.log('[STORE]');
  await R('FLUSHALL'); await admit(1);
  r = await store(1, { att: 1, result: '{"ok":true,"x":"é"}' });
  t(r === 'stored', 'running + success stored', r);
  t((await R('GET', 'sth:jobr:' + ID(1))) === '{"ok":true,"x":"é"}' && (await ttl('sth:jobr:' + ID(1))) > 259000, 'result stored with 72 h TTL');
  t((await hget(1, 'st', 'rb', 'e', 'f', 'fa')).join() === `succeeded,${Buffer.byteLength('{"ok":true,"x":"é"}')},,${NOW + 1000},1`, 'record: succeeded, rb is the byte size (UTF-8), f, fa');
  t((await ttl('sth:job:' + ID(1))) > 259000 && (await R('ZCARD', 'sth:jobs:run:tutor')) === 0, 'record TTL restarts from finish; run slot released');
  t((await R('HGET', 'sth:jobs:n:' + day, 'succeeded')) === '1' && (await ttl('sth:jobs:n:' + day)) > 2591000, 'stats succeeded counted, TTL kept');
  r = await store(1, { att: 1, state: 'failed', err: '{"code":"STH-SRV-500"}' }); t(r === 'succeeded', 'a late failure after success is discarded', r);
  r = await store(1, { att: 1, result: '{"other":1}' }); t(r === 'succeeded' && (await R('GET', 'sth:jobr:' + ID(1))) === '{"ok":true,"x":"é"}', 'a second success does not overwrite');
  r = await store(77); t(r === 'gone', 'unknown job: gone (nothing written)', r); t((await R('EXISTS', 'sth:jobr:' + ID(77), 'sth:job:' + ID(77))) === 0, 'gone writes nothing');
  // fencing: stale attempt
  await R('FLUSHALL'); await admit(1); await store(1, { state: 'failed', err: '{"code":"STH-AI-504"}' }); await admit(1, { att: 2 });
  r = await store(1, { att: 1, state: 'failed', err: '{"code":"STH-SRV-500"}' }); t(r === 'stale' && (await hget(1, 'st', 'a'))[0] === 'running', 'a stale attempt-1 FAILURE is ignored while attempt 2 runs', r);
  r = await store(1, { att: 1, state: 'succeeded', result: '{"late":1}' }); t(r === 'stored' && (await hget(1, 'st', 'fa'))[1] === '1' && (await R('GET', 'sth:jobr:' + ID(1))) === '{"late":1}', 'a stale attempt-1 SUCCESS is accepted (first success wins)', r);
  r = await store(1, { att: 2, result: '{"second":1}' }); t(r === 'succeeded' && (await R('GET', 'sth:jobr:' + ID(1))) === '{"late":1}', 'attempt 2 finishing later is discarded');
  // late success after watchdog failure (lost is derived, never written)
  await R('FLUSHALL'); await admit(1); t((await hget(1, 'st'))[0] === 'running', 'lost is never written: still running');
  r = await store(1, { att: 1, result: '{"late":2}', now: dl + 10 * GRACE }); t(r === 'stored', 'late success after the watchdog window still wins', r);
  // empty-string result and failure
  await R('FLUSHALL'); await admit(1); r = await store(1, { att: 1, state: 'failed', err: '{"code":"STH-JOB-413"}' });
  t(r === 'stored' && (await R('EXISTS', 'sth:jobr:' + ID(1))) === 0 && (await hget(1, 'st', 'e', 'rb')).join() === 'failed,{"code":"STH-JOB-413"},0', 'failure stores the error and no result');

  console.log('[CANCEL / ACK / REJECT and races]');
  const cancel = (n, key = KEY(n), now = NOW + 2000) => ev('cancel', ['sth:job:' + ID(n), 'sth:jobr:' + ID(n)], [sha(key), now, 3600]);
  const ack = (n, key = KEY(n)) => ev('ack', ['sth:job:' + ID(n), 'sth:jobr:' + ID(n)], [sha(key)]);
  await R('FLUSHALL'); await admit(1);
  t((await cancel(1, KEY(5))) === 'unknown' && (await hget(1, 'st'))[0] === 'running', 'cancel with the wrong key: unknown, untouched');
  t((await cancel(9)) === 'unknown', 'cancel of a missing job: unknown');
  t((await cancel(1)) === 'cancelled' && (await hget(1, 'st', 'f'))[0] === 'cancelled' && (await ttl('sth:job:' + ID(1))) <= 3600, 'cancel a running job: cancelled, record kept 1 h');
  t((await R('ZCARD', 'sth:jobs:run:tutor')) === 1, 'cancel does not free the run slot (the execution still runs)');
  r = await store(1, { att: 1, result: '{"x":1}' }); t(r === 'cancelled' && (await R('EXISTS', 'sth:jobr:' + ID(1))) === 0, 'late success after cancel is discarded, no result stored', r);
  t((await R('ZCARD', 'sth:jobs:run:tutor')) === 0, '...and the late store frees the slot');
  t((await cancel(1)) === 'cancelled', 'cancel twice is harmless');
  await R('FLUSHALL'); await admit(1); await store(1, { result: '{"x":1}' });
  t((await cancel(1)) === 'succeeded' && (await R('GET', 'sth:jobr:' + ID(1))) === '{"x":1}', 'cancel after success: answers succeeded and keeps the result (client discards + acks)');
  await R('FLUSHALL'); await R('SET', 'cfg:jobs_max_running', '1'); await admit(1); await admit(2);
  t((await cancel(2)) === 'cancelled', 'a rejected job can be cancelled'); await R('DEL', 'cfg:jobs_max_running');
  // ack
  await R('FLUSHALL'); await admit(1); await admit(2); await store(2, { result: '{"x":1}' });
  t((await ack(1)) === 0 && (await R('EXISTS', 'sth:job:' + ID(1))) === 1, 'ack of a running job: 0, nothing deleted');
  t((await ack(2, KEY(7))) === 2 && (await R('EXISTS', 'sth:job:' + ID(2))) === 1, 'ack with the wrong key: 2 (looks like nothing stored), nothing deleted');
  t((await ack(2)) === 1 && (await R('EXISTS', 'sth:job:' + ID(2), 'sth:jobr:' + ID(2))) === 0, 'ack of a finished job deletes record and result');
  t((await ack(2)) === 2 && (await ack(55)) === 2, 'ack again / ack of a missing job: 2 (idempotent)');
  await store(1, { state: 'failed', err: '{"code":"STH-AI-504"}' }); t((await ack(1)) === 1 && (await R('EXISTS', 'sth:job:' + ID(1))) === 0, 'ack of a failed job deletes it');
  // reject script
  await R('FLUSHALL');
  const rej = (n, att = 1, key = KEY(n)) => ev('reject', ['sth:job:' + ID(n)], [sha(key), 'tutor', att, NOW, '{"code":"STH-JOB-503"}', 3600]);
  t((await rej(1)) === 'rejected' && (await hget(1, 'st', 'e', 'a')).join() === 'rejected,{"code":"STH-JOB-503"},1' && (await ttl('sth:job:' + ID(1))) <= 3600, 'REJECT writes a rejected record, TTL 1 h');
  t((await rej(1, 1)) === 'rejected', 'REJECT again for the same rejected job is fine');
  t((await rej(1, 1, KEY(9))) === 'duplicate' && (await hget(1, 'kh'))[0] === sha(KEY(1)), 'REJECT with another key does not overwrite');
  await admit(2); t((await rej(2)) === 'duplicate' && (await hget(2, 'st'))[0] === 'running', 'REJECT never overwrites a running job (kill switch cannot erase live state)');
  // every write path of every script ends in an EXPIRE (static)
  for (const n of ['admit', 'store', 'reject', 'cancel']) { const s = lua(n); t(/EXPIRE|'EX'/.test(s), `${n}.lua sets an expiry on what it writes`); t(!/cjson|redis\.call\('(EVAL|KEYS|FLUSH|SCAN)/i.test(s), `${n}.lua: no cjson, no KEYS/SCAN/EVAL`); }
  // command counts (billing): ADMIT admitted path
  await R('FLUSHALL'); await R('CONFIG', 'RESETSTAT');
  const cmds = async () => { const info = await R('INFO', 'commandstats'); let n = 0; for (const l of info.split('\n')) { const m = l.match(/^cmdstat_(\w+):calls=(\d+)/); if (m && !['info', 'config', 'flushall'].includes(m[1])) n += Number(m[2]); } return n; };
  let c0 = await cmds(); await admit(1); const admitCmds = (await cmds()) - c0;
  c0 = await cmds(); await store(1); const storeCmds = (await cmds()) - c0;
  t(admitCmds === 15, 'ADMIT (admitted path) = 15 Redis commands (EVAL + 14), as budgeted', admitCmds);
  t(storeCmds === 8, 'STORE = 8 Redis commands (spec said 7; +1 EXPIRE on the stats hash so every write has a TTL)', storeCmds);

  await codeNodes();
  console.log(`\njobs unit tests: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e); process.exit(1); });

// ───────────────────────────────────────────────────────────────────────────────────────────────
async function codeNodes() {
  const v3 = loadWorkflow('sth-workflow-v3-studio.json');
  const v4 = loadWorkflow(process.env.JOBS_WF || 'sth-workflow-v4-jobs.json');
  const code = (n) => codeOf(v4, n);
  // v5 adds the studio_flashcards job mode (one more run-set key, one more advertised mode)
  // v6 adds studio_quiz
  const MODES = /studio_quiz: \{/.test(code('Job - Read Request')) ? ['tutor', 'studio_mindmap', 'studio_flashcards', 'studio_quiz'] : /studio_flashcards: \{/.test(code('Job - Read Request')) ? ['tutor', 'studio_mindmap', 'studio_flashcards'] : ['tutor', 'studio_mindmap'];
  const run = (n, opts) => runCode(code(n), opts);
  const J = (o) => ({ json: o });
  const KEYS_OK = { id: ID(1), key: KEY(1) };

  console.log('[Job - Read Request]');
  const rr = async (env, fromStart = false, src) => runCode(src || code('Job - Read Request'), { input: [J({ env })], nodes: {}, executed: fromStart ? { 'Job Start Endpoint': 1 } : null, ...(fromStart ? { nodes: { 'Job Start Endpoint': [J({})] } } : {}) });
  let out = await rr({ v: 1, op: 'status', jobs: [] });
  t(out.length === 1 && out[0].json.route === 'reply' && out[0].json.reply.ok === true && out[0].json.reply.jobsEnabled === true && out[0].json.reply.modes.join() === MODES.join() && typeof out[0].json.reply.now === 'number', 'hello answers jobsEnabled / modes / now without Redis');
  for (const [name, env] of [['no envelope', undefined], ['v 2', { v: 2, op: 'status', jobs: [] }], ['unknown op', { v: 1, op: 'purge', jobs: [] }], ['jobs not an array', { v: 1, op: 'status', jobs: 'x' }], ['11 jobs', { v: 1, op: 'status', jobs: Array.from({ length: 11 }, (_, i) => ({ id: ID(i), key: KEY(i) })) }], ['hello via ack', { v: 1, op: 'ack', jobs: [] }], ['result with 2 jobs', { v: 1, op: 'result', jobs: [KEYS_OK, { id: ID(2), key: KEY(2) }] }], ['bad id', { v: 1, op: 'status', jobs: [{ id: 'j_short', key: KEY(1) }] }], ['bad key', { v: 1, op: 'status', jobs: [{ id: ID(1), key: 'short' }] }], ['key with slash', { v: 1, op: 'status', jobs: [{ id: ID(1), key: 'k' + '/'.repeat(42) }] }], ['job is a string', { v: 1, op: 'status', jobs: ['x'] }], ['create via Job Endpoint', { v: 1, op: 'create', jobs: [KEYS_OK] }], ['id not a string', { v: 1, op: 'status', jobs: [{ id: { $ne: 1 }, key: KEY(1) }] }]]) {
    out = await rr(env); t(out.length === 1 && out[0].json.route === 'reply' && out[0].json.reply.ok === false && out[0].json.reply.error.code === 'STH-INPUT-400', `bad request (${name}) -> STH-INPUT-400, never throws`, out[0].json);
  }
  out = await rr({ v: 1, op: 'status', jobs: [KEYS_OK, { id: ID(2), key: KEY(2) }] });
  t(out.length === 2 && out.every((o) => o.json.route === 'status' && o.json.n === 2) && out[1].json.idx === 1 && out[0].json.key === KEY(1), 'status: one item per job (key kept only until the hash node)');
  out = await rr({ v: 1, op: 'result', jobs: [KEYS_OK] }); t(out.length === 1 && out[0].json.route === 'result', 'result: exactly one job');
  for (const op of ['ack', 'cancel']) { out = await rr({ v: 1, op, jobs: [KEYS_OK] }); t(out[0].json.route === op, op + ' routed'); }
  const cj = (o = {}) => ({ v: 1, op: 'create', id: ID(1), key: KEY(1), attempt: 1, mode: 'tutor', ...o });
  out = await rr({ job: cj() }, true); t(out.length === 1 && out[0].json.route === 'create' && out[0].json.deadlineS === 420 && out[0].json.cap === 3 && out[0].json.cfg.capTotal === 4 && out[0].json.cfg.graceS === 60 && out[0].json.cfg.resultTtlS === 259200, 'create (tutor): route, deadline 420 s, cap 3, settings', out[0].json);
  out = await rr({ job: JSON.stringify(cj({ mode: 'studio_mindmap' })) }, true); t(out[0].json.route === 'create' && out[0].json.deadlineS === 600 && out[0].json.cap === 1, 'create from a multipart job string (mind map): deadline 600 s, cap 1');
  for (const mode of ['transcribe', 'template', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'TUTOR', '']) { out = await rr({ job: cj({ mode }) }, true); t(out[0].json.route === 'reject' || out[0].json.reply, `mode "${mode}" is not allowed (reject or bad request)`, out[0].json); }
  out = await rr({ job: cj({ mode: 'constructor' }) }, true); t(out[0].json.route === 'reject', 'mode "constructor" is refused as a mode, not matched on the prototype', out[0].json);
  for (const [name, job] of [['attempt 0', cj({ attempt: 0 })], ['attempt 4', cj({ attempt: 4 })], ['attempt "1"', cj({ attempt: '1' })], ['attempt 1.5', cj({ attempt: 1.5 })], ['op status', cj({ op: 'status' })], ['v 2', cj({ v: 2 })], ['bad id', cj({ id: 'x' })], ['bad key', cj({ key: 'y' })], ['malformed JSON string', '{not json'], ['null', null], ['array', [1]]]) {
    out = await rr({ job }, true); t(out[0].json.route === 'reply' && out[0].json.reply.error.code === 'STH-INPUT-400', `create with ${name} -> bad request`, out[0].json);
  }
  const off = code('Job - Read Request').replace('const JOBS_ENABLED = true;', 'const JOBS_ENABLED = false;');
  out = await rr({ job: cj() }, true, off); t(out[0].json.route === 'reject', 'JOBS_ENABLED false: create -> reject (STH-JOB-503)');
  out = await rr({ v: 1, op: 'status', jobs: [] }, false, off); t(out[0].json.reply.jobsEnabled === false, 'JOBS_ENABLED false: hello says jobsEnabled false');
  out = await rr({ v: 1, op: 'status', jobs: [KEYS_OK] }, false, off); t(out[0].json.route === 'status', 'JOBS_ENABLED false: status / result / ack still work (jobs in flight can be collected)');

  console.log('[Job - Plan]');
  const hashed = (items) => items.map((o) => J({ ...o.json, kh: sha(o.json.key || '') }));
  const plan = async (items, execution = { id: '4242' }) => (await runCode(code('Job - Plan'), { input: hashed(items), execution }))[0].json;
  let p = await plan(await rr({ job: cj() }, true));
  t(p.route === 'create' && p.keys.length === MODES.length + 4 && p.keys[0] === 'sth:job:' + ID(1) && p.keys[1] === 'sth:jobx:4242' && p.keys[3] === 'cfg:jobs_max_running' && p.keys[4] === 'sth:jobs:run:tutor' && p.keys.slice(5).join() === MODES.filter((m) => m !== 'tutor').map((m) => 'sth:jobs:run:' + m).join(), 'create: declared keys (job, jobx, stats, cfg, own run-set, other run-sets)', p.keys);
  t(p.argv[0] === sha(KEY(1)) && p.argv.length === 13 && p.argv[9] === '4242' && p.argv[10] === ID(1) && p.argv[8] === 60000 && p.argv[11] === 420 + 3600, 'create: 13 arguments, hash not key', p.argv);
  t(!JSON.stringify(p).includes(KEY(1)), 'the plain key is not in the plan');
  t(p.job.deadlineAt === p.job.startedAt + 420000 && p.job.id === ID(1) && p.job.attempt === 1 && p.job.mode === 'tutor' && p.job.ttlS === 259200 && p.job.maxBytes === 524288, 'job record {id, attempt, mode, startedAt, deadlineAt}', p.job);
  // the plan executes against the real script
  await R('FLUSHALL'); let adm = await R('EVAL', lua('admit'), String(p.keys.length), ...p.keys, ...p.argv.map(String)); t(JSON.stringify(adm) === '["admitted"]', 'Plan output runs through the real ADMIT script', adm);
  p = await plan(await rr({ job: cj({ mode: 'studio_mindmap' }) }, true)); t(p.keys[4] === 'sth:jobs:run:studio_mindmap' && p.keys[5] === 'sth:jobs:run:tutor' && p.argv[6] === 1 && p.job.deadlineAt - p.job.startedAt === 600000, 'mind map create: own run-set first, cap 1, 600 s');
  p = await plan(await rr({ job: cj({ mode: 'transcribe' }) }, true)); t(p.route === 'reject' && p.keys.length === 1 && p.argv[1] === 'transcribe' && p.argv[4] === '{"code":"STH-JOB-503"}', 'reject plan');
  p = await plan(await rr({ v: 1, op: 'status', jobs: [KEYS_OK, { id: ID(2), key: KEY(2) }] }));
  t(p.route === 'status' && p.jobs.length === 2 && p.pipeline.length === 2 && p.pipeline[0].join() === `HMGET,sth:job:${ID(1)},kh,st,a,d,e,rb,c` && p.jobs[1].kh === sha(KEY(2)) && p.graceS === 60, 'status: one HMGET per job in a pipeline', p.pipeline);
  p = await plan(await rr({ v: 1, op: 'result', jobs: [KEYS_OK] })); t(p.route === 'result' && p.pipeline.length === 2 && p.pipeline[1].join() === `GET,sth:jobr:${ID(1)}`, 'result: HMGET + GET');
  p = await plan(await rr({ v: 1, op: 'ack', jobs: [KEYS_OK] })); t(p.route === 'ack' && p.jobs[0].job === 'sth:job:' + ID(1) && p.jobs[0].jobr === 'sth:jobr:' + ID(1) && p.jobs[0].kh === sha(KEY(1)), 'ack plan');
  p = await plan(await rr({ v: 1, op: 'cancel', jobs: [KEYS_OK] })); t(p.route === 'cancel' && p.rejectTtlS === 3600, 'cancel plan');
  p = await plan(await rr({ v: 1, op: 'status', jobs: [] })); t(p.route === 'reply' && p.reply.ok === true, 'hello passes through');
  t(!JSON.stringify(await plan(await rr({ v: 1, op: 'status', jobs: [KEYS_OK] }))).includes(KEY(1)), 'no plan contains a plain key');

  console.log('[Job - Admit Result / Reply / Status / Result / Ack / Cancel]');
  const jobObj = { id: ID(1), attempt: 1, mode: 'tutor', startedAt: NOW, deadlineAt: NOW + 420000, ttlS: 259200, maxBytes: 524288 };
  for (const [res, want] of [[{ result: ['admitted'] }, true], [{ result: ['busy'] }, false], [{ result: ['off'] }, false], [{ result: ['duplicate', 'running'] }, false], [{ result: ['keymismatch'] }, false], [{ error: { message: 'x' } }, false], [{}, false], [{ result: 'OK' }, false]]) {
    out = await runCode(code('Job - Admit Result'), { input: [J(res)], nodes: { 'Job - Plan': [J({ job: jobObj })] } });
    t(out[0].json.admitted === want && (want ? out[0].json.job.id === ID(1) : out[0].json.job === null), `Admit Result ${JSON.stringify(res).slice(0, 40)} -> admitted ${want} (fail closed)`);
  }
  out = await runCode(code('Job - Reply'), { input: [J({ reply: { ok: true, a: 1 } })] }); t(JSON.stringify(out[0].json) === '{"ok":true,"a":1}', 'Reply forwards the answer');

  const statusPlan = { now: NOW + 100000, graceS: 60, jobsEnabled: true, modes: ['tutor', 'studio_mindmap'], jobs: [{ id: ID(1), kh: sha(KEY(1)) }, { id: ID(2), kh: sha(KEY(2)) }, { id: ID(3), kh: sha(KEY(3)) }, { id: ID(4), kh: sha(KEY(4)) }, { id: ID(5), kh: sha(KEY(5)) }, { id: ID(6), kh: sha(KEY(6)) }, { id: ID(7), kh: sha(KEY(7)) }, { id: ID(8), kh: sha(KEY(8)) }] };
  const row = (kh, st, a, d, e, rb, c) => J({ result: [kh, st, a, d, e, rb, c] });
  const sr = async (rows, plan = statusPlan) => (await runCode(code('Job - Status Reply'), { input: rows, nodes: { 'Job - Plan': [J(plan)] } }))[0].json;
  let s = await sr([
    row(sha(KEY(1)), 'running', '1', String(NOW + 420000), '', null, String(NOW)),
    row(sha(KEY(2)), 'succeeded', '1', String(NOW + 420000), '', '55', String(NOW - 5000)),
    row(sha(KEY(3)), 'failed', '2', String(NOW + 420000), '{"code":"STH-AI-504"}', '0', String(NOW)),
    row(sha(KEY(4)), 'running', '1', String(NOW - 1000000), '', null, String(NOW - 1100000)),
    row(sha(KEY(5)), 'rejected', '1', null, '{"code":"STH-JOB-429"}', null, String(NOW)),
    row('someotherhash', 'running', '1', String(NOW + 420000), '', null, String(NOW)),
    row(null, null, null, null, null, null, null),
    row(sha(KEY(8)), 'cancelled', '1', String(NOW + 420000), '', null, String(NOW)),
  ]);
  const by = (n) => s.jobs[n - 1];
  t(s.ok === true && s.jobsEnabled === true && s.modes.length === 2 && s.now === NOW + 100000 && s.jobs.length === 8, 'status envelope: ok, jobsEnabled, modes, now, jobs (same order)');
  t(by(1).state === 'running' && by(1).attempt === 1 && by(1).error === null && by(1).resultBytes === 0 && by(1).ageMs === 100000, 'running', by(1));
  t(by(2).state === 'succeeded' && by(2).resultBytes === 55 && by(2).ageMs === 105000, 'succeeded with resultBytes', by(2));
  t(by(3).state === 'failed' && by(3).attempt === 2 && JSON.stringify(by(3).error) === '{"code":"STH-AI-504","retryable":true,"retryAfterMs":20000}', 'failed with retryable AI-504 / 20 s', by(3).error);
  t(by(4).state === 'lost' && JSON.stringify(by(4).error) === '{"code":"STH-JOB-504","retryable":true,"retryAfterMs":0}', 'running past deadline + grace is derived as lost (JOB-504, retry now)', by(4));
  t(by(5).state === 'rejected' && by(5).error.code === 'STH-JOB-429' && by(5).error.retryAfterMs === 20000, 'rejected JOB-429 retryable after 20 s', by(5).error);
  t(by(6).state === 'unknown' && by(7).state === 'unknown' && by(6).error === null && JSON.stringify(by(6)) === JSON.stringify({ ...by(7), id: ID(6) }), 'wrong key and missing record look identical: unknown');
  t(by(8).state === 'cancelled', 'cancelled');
  s = await sr([row(sha(KEY(1)), 'running', '1', String(NOW + 100000 - 60000), '', null, String(NOW))].concat(Array(7).fill(J({ result: [null] }))));
  t(by(1).state === 'running', 'exactly deadline + grace is still running (lost only after)');
  const retryTable = { 'STH-JOB-429': [true, 20000], 'STH-AI-429': [true, 60000], 'STH-AI-500': [true, 20000], 'STH-AI-503': [true, 20000], 'STH-AI-504': [true, 20000], 'STH-SRV-500': [true, 20000], 'STH-STU-409': [true, 60000], 'STH-STU-422': [true, 0], 'STH-JOB-504': [true, 0], 'STH-AI-451': [false, 0], 'STH-AI-452': [false, 0], 'STH-AI-204': [false, 0], 'STH-QUOTA-430': [false, 0], 'STH-STU-413': [false, 0], 'STH-INPUT-400': [false, 0], 'STH-JOB-413': [false, 0], 'STH-JOB-503': [false, 0] };
  for (const [code2, [rt, ms]] of Object.entries(retryTable)) {
    s = await sr([row(sha(KEY(3)), 'failed', '1', '1', JSON.stringify({ code: code2 }), '0', String(NOW))], { ...statusPlan, jobs: [statusPlan.jobs[2]] });
    t(s.jobs[0].error.code === code2 && s.jobs[0].error.retryable === rt && s.jobs[0].error.retryAfterMs === ms, `retry table: ${code2} -> ${rt ? 'retryable ' + ms : 'not retryable'}`, s.jobs[0].error);
  }
  s = await sr([row(sha(KEY(3)), 'failed', '1', '1', JSON.stringify({ code: 'STH-STU-413', reason: 'too_much_material', maxTokens: 400000 }), '0', String(NOW))], { ...statusPlan, jobs: [statusPlan.jobs[2]] });
  t(s.jobs[0].error.reason === 'too_much_material' && s.jobs[0].error.maxTokens === 400000, 'reason and maxTokens pass through (whitelisted)');
  s = await sr([row(sha(KEY(3)), 'failed', '1', '1', JSON.stringify({ code: 'not a code <b>', reason: '<script>', maxTokens: 'x' }), '0', String(NOW))], { ...statusPlan, jobs: [statusPlan.jobs[2]] });
  t(s.jobs[0].error.code === 'STH-SRV-500' && !('reason' in s.jobs[0].error) && !('maxTokens' in s.jobs[0].error), 'a corrupt stored error is shown as SRV-500 without reason / maxTokens');
  s = await sr([J({ error: 'ERR' })], { ...statusPlan, jobs: [statusPlan.jobs[0]] }); t(s.ok === false && s.error.code === 'STH-SRV-503' && s.error.retryable === true, 'Redis error -> STH-SRV-503 (never "unknown", which would trigger a resubmit)');
  s = await sr([J({ error: { message: 'timeout' } })], { ...statusPlan, jobs: [statusPlan.jobs[0]] }); t(s.ok === false && s.error.code === 'STH-SRV-503', 'HTTP failure item -> STH-SRV-503');
  s = await sr([], statusPlan); t(s.ok === false, 'missing rows -> STH-SRV-503');

  const resPlan = { jobs: [{ id: ID(1), kh: sha(KEY(1)) }] };
  const rs = async (a, b) => (await runCode(code('Job - Result Reply'), { input: [J({ result: a }), J({ result: b })], nodes: { 'Job - Plan': [J(resPlan)] } }))[0].json;
  const body = { result: 'MOCK GEMINI REPLY', reuploadScannedPdfs: [] };
  let x = await rs([sha(KEY(1)), 'succeeded', '1', 'tutor'], JSON.stringify(body));
  t(JSON.stringify(x) === JSON.stringify({ ok: true, id: ID(1), mode: 'tutor', result: body }), 'result returns exactly the stored answer', x);
  for (const [name, a, b] of [['wrong key', ['other', 'succeeded', '1', 'tutor'], JSON.stringify(body)], ['missing record', [null, null, null, null], null], ['running', [sha(KEY(1)), 'running', '1', 'tutor'], null], ['failed', [sha(KEY(1)), 'failed', '1', 'tutor'], null], ['expired result', [sha(KEY(1)), 'succeeded', '1', 'tutor'], null], ['corrupt result', [sha(KEY(1)), 'succeeded', '1', 'tutor'], '{nope'], ['cancelled', [sha(KEY(1)), 'cancelled', '1', 'tutor'], JSON.stringify(body)]]) {
    x = await rs(a, b); t(JSON.stringify(x) === '{"ok":false,"error":{"code":"STH-JOB-404"}}', `result (${name}) -> STH-JOB-404`, x);
  }
  x = (await runCode(code('Job - Result Reply'), { input: [J({ error: 'x' })], nodes: { 'Job - Plan': [J(resPlan)] } }))[0].json; t(x.error.code === 'STH-SRV-503', 'result: Redis failure -> STH-SRV-503');

  const ackPlan = { jobs: [{ id: ID(1) }, { id: ID(2) }, { id: ID(3) }] };
  x = (await runCode(code('Job - Ack Reply'), { input: [J({ result: 1 }), J({ result: 0 }), J({ result: 2 })], nodes: { 'Job - Plan': [J(ackPlan)] } }))[0].json;
  t(JSON.stringify(x) === JSON.stringify({ ok: true, acked: [ID(1), ID(3)] }), 'ack: deleted (1) and nothing-stored (2) count as acked, running (0) does not', x);
  x = (await runCode(code('Job - Ack Reply'), { input: [J({ error: 'x' })], nodes: { 'Job - Plan': [J(ackPlan)] } }))[0].json; t(x.ok === false && x.error.code === 'STH-SRV-503', 'ack: Redis failure -> SRV-503');
  x = (await runCode(code('Job - Cancel Reply'), { input: [J({ result: 'cancelled' }), J({ result: 'unknown' })], nodes: { 'Job - Plan': [J({ jobs: [{ id: ID(1) }, { id: ID(2) }] })] } }))[0].json;
  t(JSON.stringify(x) === JSON.stringify({ ok: true, state: 'cancelled', jobs: [{ id: ID(1), state: 'cancelled' }, { id: ID(2), state: 'unknown' }] }), 'cancel: state of the first job + per-job states', x);

  console.log('[Job - Classify Outcome]');
  const cl = async (resp, job = jobObj) => (await runCode(code('Job - Classify Outcome'), { input: [J(resp)], nodes: { 'Job - Admit Result': [J({ job })] } }))[0].json;
  const asArgs = (o) => ({ att: o.argv[0], state: o.argv[1], err: o.argv[2], result: o.argv[3] });
  let c = await cl({ result: 'MOCK GEMINI REPLY', reuploadScannedPdfs: [] });
  t(c.state === 'succeeded' && c.argv[3] === JSON.stringify({ result: 'MOCK GEMINI REPLY', reuploadScannedPdfs: [] }) && c.argv[2] === '' && c.keys.join() === `sth:job:${ID(1)},sth:jobr:${ID(1)},sth:jobs:run:tutor,sth:jobs:n:${day}` && c.argv[0] === 1 && c.argv[6] === ID(1) + ':1' && c.argv[5] === 259200, 'tutor reply -> succeeded; stored result is exactly the sync response text', c);
  const tutorMarkers = { '[Busy] The tutor is handling too many requests right now.': 'STH-AI-429', '[No reply] The tutor returned an empty response.': 'STH-AI-204', '[Blocked] The AI safety filters prevented processing this content.': 'STH-AI-451', '[Transcription blocked] The AI detected this may be published.': 'STH-AI-452' };
  for (const [txt, codeWant] of Object.entries(tutorMarkers)) { c = await cl({ result: txt, reuploadScannedPdfs: [] }); t(c.state === 'failed' && JSON.parse(c.argv[2]).code === codeWant && c.argv[3] === '', `tutor marker ${txt.split(']')[0]}] -> failed ${codeWant}, no result stored`, c.argv); }
  c = await cl({ result: 'A normal answer mentioning [Busy] later', reuploadScannedPdfs: [] }); t(c.state === 'succeeded', 'a marker word later in the text is not a failure');
  c = await cl({ ok: false, error: { code: 'STH-QUOTA-430', retryable: false } }); t(c.state === 'failed' && c.argv[2] === '{"code":"STH-QUOTA-430"}', 'Quota Exceeded -> failed STH-QUOTA-430');
  c = await cl({ ok: false, error: { code: 'STH-STU-413', retryable: false, reason: 'too_much_material', maxTokens: 400000 } }, { ...jobObj, mode: 'studio_mindmap' }); t(c.state === 'failed' && JSON.parse(c.argv[2]).reason === 'too_much_material' && JSON.parse(c.argv[2]).maxTokens === 400000 && c.keys[2] === 'sth:jobs:run:studio_mindmap', 'Studio reject keeps the whitelisted reason and maxTokens');
  c = await cl({ ok: false, error: { code: 'STH-STU-422', retryable: true, reason: 'ZZSECRET text here' } }); t(JSON.parse(c.argv[2]).code === 'STH-STU-422' && !('reason' in JSON.parse(c.argv[2])) && !c.argv[2].includes('ZZSECRET'), 'a reason that is not a fixed tag is dropped');
  c = await cl({ ok: false, error: { code: 'STH-<script>alert(1)</script>', retryable: true } }); t(c.argv[2] === '{"code":"STH-SRV-500"}', 'a code that is not STH-XXX-nnn becomes STH-SRV-500');
  c = await cl({ ok: false, error: { code: 'STH-' + 'A'.repeat(500) + '-123' } }); t(c.argv[2] === '{"code":"STH-SRV-500"}', 'an overlong code is replaced');
  c = await cl({ ok: false, error: { code: 'STH-STU-413', reason: 'too_much_material', maxTokens: 1.5 } }); t(!('maxTokens' in JSON.parse(c.argv[2])), 'a non-integer maxTokens is dropped');
  const studioOk = { ok: true, artifact: { envelope: 'sth.studio/1', data: { nodes: [{ id: 'n1' }] } } };
  c = await cl(studioOk, { ...jobObj, mode: 'studio_mindmap' }); t(c.state === 'succeeded' && c.argv[3] === JSON.stringify(studioOk), 'Studio success stored verbatim');
  for (const [name, resp] of [['empty object', {}], ['null-ish', null], ['an array', [1]], ['ok:false without error', { ok: false }], ['result not a string', { result: 5 }]]) { c = await cl(resp); t(c.state === 'failed' && c.argv[2] === '{"code":"STH-SRV-500"}', `unexpected end shape (${name}) -> failed STH-SRV-500`, c.argv); }
  // sizes: boundary and UTF-8
  const mk = (bytes, ch = 'a') => { const per = Buffer.byteLength(ch); const wrap = JSON.stringify({ result: '', reuploadScannedPdfs: [] }).length; return { result: ch.repeat(Math.floor((bytes - wrap) / per)), reuploadScannedPdfs: [] }; };
  let big = mk(524288); c = await cl(big); t(Buffer.byteLength(JSON.stringify(big)) <= 524288 && c.state === 'succeeded', 'a result at 524288 bytes is stored', Buffer.byteLength(JSON.stringify(big)));
  big = mk(524288 + 10); big.result += 'aaaaaaaaaaaaaaa'; c = await cl(big); t(c.state === 'failed' && c.argv[2] === '{"code":"STH-JOB-413"}' && c.argv[3] === '', 'a result over 524288 bytes -> failed STH-JOB-413, not stored', Buffer.byteLength(JSON.stringify(big)));
  big = { result: '€'.repeat(180000), reuploadScannedPdfs: [] }; c = await cl(big); t(JSON.stringify(big).length < 524288 && Buffer.byteLength(JSON.stringify(big)) > 524288 && c.state === 'failed' && JSON.parse(c.argv[2]).code === 'STH-JOB-413', 'size is counted in UTF-8 bytes (180000 euro signs are < 524288 characters but 540000 bytes)');
  big = { result: '😀'.repeat(100000), reuploadScannedPdfs: [] }; c = await cl(big); t(Buffer.byteLength(JSON.stringify(big)) > 400000 && Buffer.byteLength(JSON.stringify(big)) < 400100 && c.state === 'succeeded', 'surrogate pairs count 4 bytes (400 KB passes)', Buffer.byteLength(JSON.stringify(big)));
  big = { result: '😀'.repeat(140000), reuploadScannedPdfs: [] }; c = await cl(big); t(JSON.stringify(big).length < 524288 && Buffer.byteLength(JSON.stringify(big)) > 524288 && c.state === 'failed', '140000 emoji: 280000 UTF-16 units but 560000 bytes -> JOB-413');
  for (const e of [c.argv[2]]) t(e.length <= 200, 'stored error JSON is at most 200 bytes');
  for (const [i, resp] of [{ ok: false, error: { code: 'STH-STU-413', reason: 'r'.repeat(40), maxTokens: 900000 } }].entries()) { c = await cl(resp); t(c.argv[2].length <= 200, 'worst-case error JSON stays under 200 bytes', c.argv[2].length); }

  console.log('[Job - Error Outcome (thrown errors via the Error Trigger map)]');
  const eo = async (msg, mapped = `${ID(1)}|2|tutor`, extra = {}) => (await runCode(code('Job - Error Outcome'), { input: [J({ result: mapped })], nodes: { 'Error Trigger': [J({ execution: { id: '4242', error: { message: msg, ...extra }, lastNodeExecuted: 'X' }, workflow: { name: 'W' } })] } }))[0].json;
  for (const [msg, want] of [['STH-AI-504 probe failure [line 1]', 'STH-AI-504'], ['STH-INPUT-400 The job mode does not match the request', 'STH-INPUT-400'], ['Tutor Gemini failed: HTTP 500 mock failure', 'STH-AI-500'], ['Tutor Gemini failed: HTTP 503 x', 'STH-AI-503'], ['Tutor Gemini failed: HTTP 504 x', 'STH-AI-504'], ['Tutor Gemini failed: HTTP 403 key', 'STH-AI-403'], ['Tutor Gemini failed: HTTP 400 bad', 'STH-SRV-500'], ['HTTP 500 mock failure [line 13]', 'STH-AI-500'], ['HTTP 503 x [line 13]', 'STH-AI-503'], ['HTTP 400 mock failure [line 13]', 'STH-SRV-500'], ['The connection was aborted, perhaps the server is offline', 'STH-AI-504'], ['The connection timed out', 'STH-AI-504'], ['user wrote HTTP 500 inside', 'STH-SRV-500'], ['timeout of 300000ms exceeded', 'STH-AI-504'], ['connect ETIMEDOUT 1.2.3.4:443', 'STH-AI-504'], ['ECONNABORTED', 'STH-AI-504'], ['The service refused the connection', 'STH-SRV-500'], ['Cannot read properties of undefined', 'STH-SRV-500'], ['', 'STH-SRV-500']]) {
    const o = await eo(msg); t(o.state === 'failed' && JSON.parse(o.argv[2]).code === want, `thrown "${msg.slice(0, 40)}" -> ${want}`, o.argv);
  }
  let o = await eo('x'); t(o.argv[0] === 2 && o.argv[6] === ID(1) + ':2' && o.keys[2] === 'sth:jobs:run:tutor' && o.argv[3] === '' && o.argv[5] === 259200, 'attempt, member and keys come from the jobx mapping');
  o = await eo('Secret text ZZSECRETZZ in the error message STH-AI-504 with more request text ZZSECRETZZ'); t(!JSON.stringify(o).includes('ZZSECRET') && o.argv[2] === '{"code":"STH-AI-504"}', 'the error message is never stored (only the code)');
  o = await eo('x', `${ID(1)}|1|studio_mindmap`); t(o.keys[2] === 'sth:jobs:run:studio_mindmap', 'mind map mapping');
  t(/const RESULT_TTL_S = 259200;/.test(code('Job - Read Request')) && /ttlS: 259200/.test(code('Job - Error Outcome')), 'Error Outcome TTL equals RESULT_TTL_S');

  console.log('[Normalize Multipart Body: sync unchanged, job entry]');
  const n3 = codeOf(v3, 'Normalize Multipart Body');
  const webhookItem = { json: { headers: { h: 1 }, params: {}, query: { _job: 'forged' }, body: { payload: JSON.stringify({ mode: 'tutor', chatId: 'c1', messages: [] }), scanned_0: 'x' }, jwtPayload: { sub: 'sth' } }, binary: { scanned_0: { data: 'AAA', mimeType: 'application/pdf' } } };
  const syncOut = await runCode(code('Normalize Multipart Body'), { input: [webhookItem] });
  const v3Out = await runCode(n3, { input: [webhookItem] });
  t(JSON.stringify(syncOut) === JSON.stringify(v3Out) && !('_job' in syncOut[0].json), 'sync path: output identical to v3 (no _job)', syncOut);
  t(JSON.stringify(await runCode(code('Normalize Multipart Body'), { input: [{ json: { body: { mode: 'ocr', a: 1 } } }] })) === JSON.stringify(await runCode(n3, { input: [{ json: { body: { mode: 'ocr', a: 1 } } }] })), 'sync path, JSON body: identical to v3');
  const startItem = { json: { headers: {}, params: {}, query: {}, body: { payload: JSON.stringify({ mode: 'tutor', chatId: 'c1', job: { forged: true }, _job: { id: 'forged' } }), job: '{"v":1}' }, jwtPayload: { sub: 'sth' } }, binary: { scanned_0: { data: 'AAA' } } };
  const jobRun = (item, job = jobObj) => runCode(code('Normalize Multipart Body'), { input: [J({ admitted: true })], nodes: { 'Job Start Endpoint': [item], 'Job - Admit Result': [J({ job })] } });
  out = await jobRun(startItem);
  t(out[0].json._job.id === ID(1) && out[0].json._job.deadlineAt === NOW + 420000 && out[0].json.body.mode === 'tutor' && !('job' in out[0].json.body) && !('payload' in out[0].json.body) && out[0].json.jwtPayload.sub === 'sth' && out[0].binary.scanned_0.data === 'AAA', 'job run: reads the start webhook, adds _job at the top level, removes body.job, keeps jwtPayload and binary', out[0].json);
  t(out[0].json.body._job && out[0].json.body._job.id === 'forged' && out[0].json._job.id === ID(1), 'a forged body._job stays inside body and cannot reach the top-level _job');
  let thrown = null; try { await jobRun({ json: { ...startItem.json, body: { payload: JSON.stringify({ mode: 'studio_mindmap' }) } } }); } catch (e) { thrown = e; }
  t(thrown && /^STH-INPUT-400/.test(thrown.message), 'mode in the body differing from the job mode throws STH-INPUT-400', thrown && thrown.message);
  thrown = null; try { await jobRun({ json: { ...startItem.json, body: { payload: '{"mode":"tutor", ZZSECRETZZ' } } }); } catch (e) { thrown = e; }
  t(thrown && /^STH-INPUT-400/.test(thrown.message) && !/ZZSECRET/.test(thrown.message), 'a malformed payload throws STH-INPUT-400 WITHOUT quoting the parser message', thrown && thrown.message);
  thrown = null; try { await runCode(n3, { input: [{ json: { body: { payload: '{"mode":"tutor", ZZSECRETZZ' } } }] }); } catch (e) { thrown = e; }
  t(thrown && /^Malformed multipart/.test(thrown.message), 'sync path keeps its original message (unchanged behaviour)');
  out = await jobRun({ json: { ...startItem.json, body: { mode: 'tutor', chatId: 'c', job: { v: 1 } } } }); t(out[0].json.body.mode === 'tutor' && !('job' in out[0].json.body), 'JSON (non-multipart) create: body.job removed');

  console.log('[Tutor / Studio edits: sync unchanged, job behaviour]');
  // Prep — Tutor
  const prepIn = (conv) => ({ input: [J({ body: { chatId: 'c1', messages: [{ role: 'user', text: 'Q2' }], attachedContext: [], cachableContext: [], attachedImages: [] }, session: { conversation: conv }, documentHash: 'h', geminiFileParts: [] })] });
  const conv = [{ role: 'user', text: 'Q1' }, { role: 'model', text: 'A1', jobId: ID(1) }, { role: 'user', text: 'Q1b', jobId: ID(1) }, { role: 'model', text: 'A1b' }];
  const norm = (job) => ({ 'Normalize Multipart Body': [J({ jwtPayload: { sub: 'sth' }, ...(job ? { _job: job } : {}) })] });
  const texts = (r) => r[0].json.geminiBody.contents.map((c) => c.parts[0].text);
  const pSync3 = await runCode(codeOf(v3, 'Prep — Tutor'), { ...prepIn(conv), nodes: norm(null) });
  const pSync4 = await runCode(code('Prep — Tutor'), { ...prepIn(conv), nodes: norm(null) });
  t(JSON.stringify(pSync3) === JSON.stringify(pSync4), 'Prep — Tutor sync: identical to v3, tagged entries stay');
  const pJob = await runCode(code('Prep — Tutor'), { ...prepIn(conv), nodes: norm(jobObj) });
  t(texts(pJob).join('|') === 'Q1|A1b|Q2' || (texts(pJob).includes('Q1') && texts(pJob).includes('A1b') && !texts(pJob).includes('A1') && !texts(pJob).includes('Q1b')), 'Prep — Tutor job: entries of this jobId are skipped, others kept', texts(pJob));
  t(!texts(prepIn.length ? pJob : pJob).includes('A1'), 'a re-run never sees its own earlier answer');
  // Save Session Builder
  const ssbNodes = (job, prior) => ({ 'Prep — Tutor': [J({ sessionId: 'c1', documentHash: 'h' })], 'Scanned PDF Resolution Complete': [J({ session: { conversation: prior, createdAt: 1 }, body: { messages: [{ role: 'user', text: 'Q2' }], attachedContext: [] } })], 'Extract Tutor Text': [J({ result: 'A2' })], ...norm(job) });
  const prior = [{ role: 'user', text: 'Q1' }, { role: 'model', text: 'A1' }];
  const s3 = await runCode(codeOf(v3, 'Save Session Builder'), { input: [J({})], nodes: ssbNodes(null, prior) });
  const s4 = await runCode(code('Save Session Builder'), { input: [J({})], nodes: ssbNodes(null, prior) });
  const stripExp = (r) => { const v = JSON.parse(r[0].json.sessionValue); delete v.expiresAt; return JSON.stringify({ ...r[0].json, sessionValue: v }); };
  t(stripExp(s3) === stripExp(s4), 'Save Session Builder sync: identical to v3 (no jobId fields)');
  const sj = JSON.parse((await runCode(code('Save Session Builder'), { input: [J({})], nodes: ssbNodes(jobObj, prior) }))[0].json.sessionValue);
  t(sj.conversation.length === 4 && sj.conversation[2].jobId === ID(1) && sj.conversation[3].jobId === ID(1) && !('jobId' in sj.conversation[0]), 'job run: the new pair is tagged with the jobId', sj.conversation);
  const sj2 = JSON.parse((await runCode(code('Save Session Builder'), { input: [J({})], nodes: ssbNodes(jobObj, sj.conversation) }))[0].json.sessionValue);
  t(sj2.conversation.length === 4 && sj2.conversation.filter((m) => m.jobId === ID(1)).length === 2, 'a re-run REPLACES its earlier pair (no duplicate in the session)', sj2.conversation.map((m) => m.text));
  const sj3 = JSON.parse((await runCode(code('Save Session Builder'), { input: [J({})], nodes: { ...ssbNodes(jobObj, sj.conversation), 'Extract Tutor Text': [J({ failed: true, result: '[Busy]' })] } }))[0].json.sessionValue);
  t(sj3.conversation.filter((m) => m.jobId === ID(1)).length === 0, 'a failed re-run adds nothing (the earlier pair is removed, as the job is being redone)');
  // Tutor Retry Check
  const trIn = (status) => ({ input: [J({ statusCode: status, body: { error: { message: 'x' } } })], runIndex: 0 });
  const trNodes = (job) => ({ 'Prep — Tutor': [J({ geminiBody: {} })], ...norm(job) });
  const t3 = await runCode(codeOf(v3, 'Tutor Retry Check'), { ...trIn(500), nodes: trNodes(null) });
  const t4 = await runCode(code('Tutor Retry Check'), { ...trIn(500), nodes: trNodes(null) });
  t(JSON.stringify(t3) === JSON.stringify(t4) && t4[0].json.retry === true && t4[0].json.waitSeconds === 5, 'Tutor Retry Check sync: identical to v3 (retries 500)', t4[0].json);
  const tj = await runCode(code('Tutor Retry Check'), { ...trIn(500), nodes: trNodes({ ...jobObj, deadlineAt: Date.now() + 420000 }) });
  t(tj[0].json.retry === true && tj[0].json.waitSeconds === 5, 'job with a fresh 420 s deadline: retries as before', tj[0].json);
  const tj2 = await runCode(code('Tutor Retry Check'), { ...trIn(500), nodes: trNodes({ ...jobObj, deadlineAt: Date.now() + 330000 }) });
  t(tj2[0].json.retry === false && tj2[0].json.waitSeconds === 0, 'job near its deadline: no retry that could not finish (wait + 300 s call + 30 s)', tj2[0].json);
  const tj3 = await runCode(code('Tutor Retry Check'), { ...trIn(429), nodes: trNodes({ ...jobObj, deadlineAt: Date.now() + 330000 }) });
  t(tj3[0].json.retry === false, '429 near the deadline: no retry either');
  // Studio Retry Check
  const stIn = { input: [J({ statusCode: 500, body: {} })], runIndex: 0 };
  const stNodes = (job, started) => ({ 'Studio - Validate Request': [J({ ok: true, started, estimate: 1000, model: 'gemini-2.5-flash', variant: 0, geminiBody: { generationConfig: {} } })], ...norm(job) });
  const started0 = Date.now() - 100000;
  const sc3 = await runCode(codeOf(v3, 'Studio - Retry Check'), { ...stIn, nodes: stNodes(null, started0) });
  const sc4 = await runCode(code('Studio - Retry Check'), { ...stIn, nodes: stNodes(null, started0) });
  const noTime = (r) => JSON.stringify(r[0].json, (k, v) => (k === 'elapsedMs' ? undefined : v));
  const timeoutOf = (r) => r[0].json.timeoutMs;
  t(noTime(sc3).replace(/"timeoutMs":\d+/, '') === noTime(sc4).replace(/"timeoutMs":\d+/, '') && Math.abs(timeoutOf(sc3) - timeoutOf(sc4)) < 200, 'Studio Retry Check sync: identical to v3 (budget 270 s)', sc4[0].json);
  const sc4b = await runCode(code('Studio - Retry Check'), { ...stIn, nodes: stNodes(null, Date.now() - 200000) });
  t(sc4b[0].json.retry === false, 'sync, 200 s elapsed: no retry (budget unchanged)');
  const scj = await runCode(code('Studio - Retry Check'), { ...stIn, nodes: stNodes(jobObj, Date.now() - 200000) });
  t(scj[0].json.retry === true && scj[0].json.timeoutMs === 240000, 'job, 200 s elapsed: retries with a full 240 s call (budget 570 s)', scj[0].json);
  const scj2 = await runCode(code('Studio - Retry Check'), { ...stIn, nodes: stNodes(jobObj, Date.now() - 330000) });
  t(scj2[0].json.retry === false, 'job, 330 s elapsed: a retry could not fit a whole call -> no retry', scj2[0].json);
  const scj3 = await runCode(code('Studio - Retry Check'), { ...stIn, nodes: stNodes(jobObj, Date.now() - 10000) });
  t(scj3[0].json.retry === true && scj3[0].json.timeoutMs === 240000, 'job, early: retry as usual');

  console.log('[structure]');
  const rrCode = code('Job - Read Request');
  t(!/\bthrow\b/.test(rrCode) && !/\bthrow\b/.test(code('Job - Plan')) && !/\bthrow\b/.test(code('Job - Status Reply')), 'gateway Code nodes never throw');
  t(!/\bthrow\b/.test(code('Job - Classify Outcome')), 'Classify never throws');
  for (const n of ['Job - Read Request', 'Job - Plan', 'Job - Status Reply', 'Job - Result Reply', 'Job - Ack Reply', 'Job - Cancel Reply', 'Job - Classify Outcome', 'Job - Error Outcome', 'Job - Admit Result', 'Job - Reply']) t(!/require\(|process\.|fetch\(|new URL|crypto\./.test(code(n).replace(/\/\/.*$/gm, '')), `${n}: no require / process / fetch / URL / crypto`);
}
