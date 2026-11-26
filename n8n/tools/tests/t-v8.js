// Unit tests for the v8 job pickup (sth-workflow-v8-bundle.json): hello v 8, the `claim` op, the `collected` state after `ack`, `result` honouring a live claim.
// Everything runs through the real nodes (Job - Read Request -> Job - Plan -> the Redis command of the node expression on a REAL Redis 7, port 6391 -> the reply node),
// plus a differential run against v7 and the extra-origin build. Run: redis-server --port 6391 & node tests/t-v8.js
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const { cmd } = require('./resp');
const { runCode, loadWorkflow, codeOf } = require('./harness');
const R = (...a) => cmd(a.flat(), 6391);
let pass = 0, fail = 0;
const t = (c, name, extra) => { if (c) pass++; else { fail++; console.log('  FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); } };
const v8 = loadWorkflow('sth-workflow-v8-bundle.json');
const v7 = loadWorkflow('sth-workflow-v7-bundle.json');
const nodeOf = (wf, n) => wf.nodes.find((x) => x.name === n);
const lua = (n) => fs.readFileSync(path.join(__dirname, '..', 'src', n), 'utf8').replace(/\n+$/, '');
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
const ID = (n) => 'j_' + String(n).padStart(22, 'A');
const KEY = (n) => 'k' + String(n).padStart(42, 'A');
const NONCE = (n) => 'n' + String(n).padStart(42, 'A');
const NOW = 1800000000000;
const DAY = new Date(NOW).toISOString().slice(0, 10).replace(/-/g, '');
const LEASE = 600000;
const J = (json) => ({ json });
const evalExpr = (expr, $json = {}) => new Function('$json', '"use strict"; return (' + expr.slice(3, -2) + ');')($json);

// ── the server, as the workflow wires it ──
async function server(env, { now = NOW, fromStart = false, wf = v8 } = {}) {
  const clock = `Date.now = () => ${now};\n`;
  const items = await runCode(clock + codeOf(wf, 'Job - Read Request'), { input: [J({ env })], nodes: fromStart ? { 'Job Start Endpoint': [J({})] } : {} });
  if (items[0].json.route === 'reply') return { items, reply: items[0].json.reply };
  const hashed = items.map((o) => J({ ...o.json, kh: sha(o.json.key || '') }));
  const plan = (await runCode(codeOf(wf, 'Job - Plan'), { input: hashed, execution: { id: '4242' } }))[0].json;
  const exec = async (cmds) => { const rows = []; for (const c of cmds) rows.push({ result: await R(c) }); return rows.map(J); };
  let rows, replyNode;
  if (plan.route === 'status') { rows = await exec(plan.pipeline); replyNode = 'Job - Status Reply'; }
  else if (plan.route === 'result') { rows = await exec(plan.pipeline); replyNode = 'Job - Result Reply'; }
  else if (plan.route === 'ack') { rows = await exec(evalExpr(nodeOf(wf, 'Job - Ack').parameters.jsonBody, plan)); replyNode = 'Job - Ack Reply'; }
  else if (plan.route === 'claim') { rows = await exec(evalExpr(nodeOf(wf, 'Job - Claim').parameters.jsonBody, plan)); replyNode = 'Job - Claim Reply'; }
  else if (plan.route === 'cancel') { rows = await exec(plan.jobs.map((j) => ['EVAL', lua('job-cancel.lua'), '2', j.job, j.jobr, j.kh, String(plan.now), String(plan.rejectTtlS)])); replyNode = 'Job - Cancel Reply'; }
  else throw new Error('route ' + plan.route);
  const out = (await runCode(clock + codeOf(wf, replyNode), { input: rows, nodes: { 'Job - Plan': [J(plan)] } }))[0].json;
  return { plan, rows, reply: out };
}
const job = (n) => ({ id: ID(n), key: KEY(n) });
const op = (name, jobs, o) => server({ v: 1, op: name, jobs }, o);
const claim = (n, nonce, o) => op('claim', [{ ...job(n), nonce }], o);
const ack = (n, nonce, o) => op('ack', [nonce === undefined ? job(n) : { ...job(n), nonce }], o);
const status = (n, o) => op('status', [job(n)], o);
const result = (n, o) => op('result', [job(n)], o);
const hall = async (n) => { const a = await R('HGETALL', 'sth:job:' + ID(n)); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };

// a job in a given state (through the v7 ADMIT / STORE scripts, with the arguments "Job - Plan" builds)
const MODES = { tutor: [420, 3, 0], studio_quiz: [420, 1, 0], studio_infographic: [420, 1, 0], transcribe: [600, 2, 1] };
async function admit(n, { mode = 'tutor', att = 1, now = NOW } = {}) {
  const [dl, cap, bulk] = MODES[mode];
  const others = Object.keys(MODES).filter((m) => m !== mode);
  const keys = ['sth:job:' + ID(n), 'sth:jobx:ex' + n, 'sth:jobs:n:' + DAY, 'cfg:jobs_max_running', 'sth:jobs:run:' + mode, 'sth:jobs:run:bulk', ...others.map((m) => 'sth:jobs:run:' + m)];
  return R('EVAL', lua('job7-admit.lua'), String(keys.length), ...keys, sha(KEY(n)), mode, att, now, now + dl * 1000, 259200, cap, 4, 60000, 'ex' + n, ID(n), dl + 3600, 3600, bulk ? '1' : '0', 2, 2);
}
async function store(n, { mode = 'tutor', att = 1, state = 'succeeded', result = '{"ok":true,"result":"hello"}', now = NOW + 1000 } = {}) {
  return R('EVAL', lua('job7-store.lua'), '5', 'sth:job:' + ID(n), 'sth:jobr:' + ID(n), 'sth:jobs:run:' + mode, 'sth:jobs:n:' + DAY, 'sth:jobs:run:bulk', att, state, state === 'failed' ? '{"code":"STH-AI-504"}' : '', state === 'succeeded' ? result : '', now, 259200, ID(n) + ':' + att);
}
const done = async (n, o = {}) => { await admit(n, o); await store(n, o); };

(async () => {
  console.log('[hello v 8 and the op validation]');
  let r = (await server({ v: 1, op: 'status', jobs: [] })).reply;
  t(r.ok === true && r.v === 8 && r.jobsEnabled === true && r.caps.claimLeaseS === 600 && r.caps.maxSources === 15 && r.caps.bulkCap === 2 && r.caps.reserve === 2 && r.caps.jobCap === 4 && r.caps.maxParts === 16 && r.modes.join() === 'tutor,studio_mindmap,studio_flashcards,studio_quiz,studio_infographic,studio_slides,studio_digest,transcribe,template,reviewer', 'hello answers v 8, claimLeaseS 600 and everything v7 said (modes, caps)', r);
  { const h7 = (await server({ v: 1, op: 'status', jobs: [] }, { wf: v7 })).reply; const { claimLeaseS, ...caps8 } = r.caps; t(JSON.stringify({ ...r, v: 7, caps: caps8, now: 0 }) === JSON.stringify({ ...h7, now: 0 }), 'hello v8 = hello v7 + v 8 + claimLeaseS, nothing else changed', [h7, r]); }
  for (const [name, env] of [['claim without a nonce', { v: 1, op: 'claim', jobs: [job(1)] }], ['claim with a 42-character nonce', { v: 1, op: 'claim', jobs: [{ ...job(1), nonce: NONCE(1).slice(1) }] }], ['claim with a non-string nonce', { v: 1, op: 'claim', jobs: [{ ...job(1), nonce: 5 }] }], ['claim with a nonce of bad characters', { v: 1, op: 'claim', jobs: [{ ...job(1), nonce: 'n' + '!'.repeat(42) }] }], ['claim of two jobs', { v: 1, op: 'claim', jobs: [{ ...job(1), nonce: NONCE(1) }, { ...job(2), nonce: NONCE(1) }] }], ['claim of none', { v: 1, op: 'claim', jobs: [] }], ['ack with a bad nonce', { v: 1, op: 'ack', jobs: [{ ...job(1), nonce: 'short' }] }], ['claim with a bad key', { v: 1, op: 'claim', jobs: [{ id: ID(1), key: 'x', nonce: NONCE(1) }] }], ['claim with a bad id', { v: 1, op: 'claim', jobs: [{ id: 'nope', key: KEY(1), nonce: NONCE(1) }] }], ['an op nobody knows', { v: 1, op: 'steal', jobs: [job(1)] }], ['claim v 2', { v: 2, op: 'claim', jobs: [{ ...job(1), nonce: NONCE(1) }] }]]) {
    r = (await server(env)).reply; t(r.ok === false && r.error.code === 'STH-INPUT-400', `${name} -> STH-INPUT-400`, r);
  }
  r = await server({ v: 1, op: 'ack', jobs: [job(1)] }); t(r.plan && r.plan.route === 'ack' && r.plan.jobs[0].nonce === '', 'ack without a nonce is fine (a cached v7 page): nonce ""');
  r = await server({ v: 1, op: 'ack', jobs: [{ ...job(1), nonce: null }] }); t(r.plan && r.plan.jobs[0].nonce === '', 'ack with a null nonce = none');
  r = await server({ v: 1, op: 'status', jobs: [{ ...job(1), nonce: NONCE(1) }] }); t(r.plan.route === 'status' && !JSON.stringify(r.plan).includes(NONCE(1)), 'a nonce on any other op is ignored and never reaches Redis');
  r = await server({ v: 1, op: 'claim', jobs: [{ ...job(1), nonce: NONCE(1) }] }); t(r.plan.jobs.length === 1 && !JSON.stringify(r.plan).includes(KEY(1)), 'the plain key is dropped by the plan (only its hash goes on)');
  t(!JSON.stringify(r.rows) .includes(KEY(1)), 'nothing sent to Redis holds the plain key');

  console.log('[claim: wrong key, unknown, not finished, race, lease]');
  await R('FLUSHALL');
  r = (await claim(1, NONCE(1))).reply; t(r.ok === false && r.error.code === 'STH-JOB-404', 'unknown job -> STH-JOB-404', r);
  await admit(1);
  r = (await claim(1, NONCE(1))).reply; t(r.ok === true && r.state === 'running' && r.result === undefined && !(await hall(1)).cl, 'a running job: {ok, state: running}, no answer, nothing claimed', r);
  r = (await op('claim', [{ id: ID(1), key: KEY(99), nonce: NONCE(1) }])).reply; const wrongKey = JSON.stringify(r);
  const absent = JSON.stringify((await claim(77, NONCE(1))).reply);
  t(wrongKey === absent && JSON.parse(wrongKey).error.code === 'STH-JOB-404', 'wrong key, absent record: the very same STH-JOB-404 (no existence oracle)', [wrongKey, absent]);
  await store(1, { state: 'failed' });
  r = (await claim(1, NONCE(1))).reply; t(r.ok === true && r.state === 'failed' && !(await hall(1)).cl, 'a failed job: its state, nothing claimed', r);
  await R('FLUSHALL'); await done(2, { mode: 'transcribe' });
  const ttl0 = await R('TTL', 'sth:job:' + ID(2));
  r = (await claim(2, NONCE(1), { now: NOW + 5000 })).reply;
  t(r.ok === true && r.id === ID(2) && r.mode === 'transcribe' && JSON.stringify(r.result) === '{"ok":true,"result":"hello"}', 'a finished job: the answer and its mode (like `result`)', r);
  let h = await hall(2); t(h.cl === NONCE(1) && h.cla === String(NOW + 5000) && h.st === 'succeeded' && h.c === String(NOW), 'the claim is stored (cl, cla); creation time c untouched', h);
  { const ttl1 = await R('TTL', 'sth:job:' + ID(2)); t(ttl1 <= ttl0 && ttl1 > ttl0 - 5 && (await R('TTL', 'sth:jobr:' + ID(2))) > 0, 'claiming does not change the expiry of the record or the answer', [ttl0, ttl1]); }
  r = (await claim(2, NONCE(2), { now: NOW + 5000 + LEASE - 1 })).reply; t(r.ok === false && r.error.code === 'STH-JOB-409' && r.error.reason === 'claimed' && r.error.retryable === false && r.result === undefined, 'a second nonce inside the lease -> STH-JOB-409 (reason claimed), no answer', r);
  h = await hall(2); t(h.cl === NONCE(1), 'the loser changed nothing');
  r = (await claim(2, NONCE(1), { now: NOW + 5000 + LEASE - 1 })).reply; t(r.ok === true && r.result, 'the same nonce claims again (a retry after a crash)');
  h = await hall(2); t(h.cla === String(NOW + 5000 + LEASE - 1), 'the same nonce RENEWS the lease (cla moved on)', h);
  r = (await claim(2, NONCE(2), { now: NOW + 5000 + LEASE - 1 + LEASE - 1 })).reply; t(r.ok === false && r.error.code === 'STH-JOB-409', 'after the renewal the lease runs from the new time: still held 599.999 s later');
  r = (await claim(2, NONCE(2), { now: NOW + 5000 + LEASE - 1 + LEASE })).reply; t(r.ok === true && r.result, 'lease over (exactly 600 s after the last renewal): the other nonce takes it over');
  h = await hall(2); t(h.cl === NONCE(2), 'cl is now the new holder');
  r = (await claim(2, NONCE(1), { now: NOW + 5000 + LEASE - 1 + LEASE + 1000 })).reply; t(r.ok === false && r.error.code === 'STH-JOB-409', 'the old holder is now the one refused (a dead winner does not hold the answer forever; a slow one loses it)');
  // claim race: 20 devices at once
  await R('FLUSHALL'); await done(3);
  const racers = await Promise.all(Array.from({ length: 20 }, (_, i) => claim(3, NONCE(100 + i), { now: NOW + 1000 })));
  const wins = racers.filter((x) => x.reply.ok === true && x.reply.result), lost = racers.filter((x) => x.reply.ok === false && x.reply.error.code === 'STH-JOB-409');
  t(wins.length === 1 && lost.length === 19, 'claim race: 20 devices at once, EXACTLY ONE gets the answer, 19 get STH-JOB-409', [wins.length, lost.length]);
  h = await hall(3); const widx = racers.indexOf(wins[0]); t(widx >= 0 && h.cl === NONCE(100 + widx), 'the stored claim is the winner\'s nonce', [h.cl, widx]);
  r = (await claim(3, NONCE(100 + widx), { now: NOW + 2000 })).reply; t(r.ok === true, 'the winner can claim again');
  // claim of an answer that is gone
  await R('FLUSHALL'); await done(4); await R('DEL', 'sth:jobr:' + ID(4));
  r = (await claim(4, NONCE(1))).reply; t(r.ok === false && r.error.code === 'STH-JOB-404' && !(await hall(4)).cl, 'record without its answer: STH-JOB-404, nothing claimed');
  // a corrupt answer
  await R('FLUSHALL'); await done(5, { result: 'not json' });
  r = (await claim(5, NONCE(1))).reply; t(r.ok === false && r.error.code === 'STH-JOB-404', 'an answer that is not JSON: STH-JOB-404');
  // Redis down: the reply node fails closed
  { const bad = await runCode(codeOf(v8, 'Job - Claim Reply'), { input: [J({ error: 'x' })], nodes: { 'Job - Plan': [J({ jobs: [{ id: ID(1) }] })] } }); t(bad[0].json.ok === false && bad[0].json.error.code === 'STH-SRV-503' && bad[0].json.error.retryable === true, 'Redis error: STH-SRV-503, retryable'); }

  console.log('[result honours a live claim (a cached v7 page cannot bypass it)]');
  await R('FLUSHALL'); await done(6);
  r = (await result(6, { now: NOW + 1000 })).reply; t(r.ok === true && r.id === ID(6) && r.mode === 'tutor' && r.result.result === 'hello', 'no claim: `result` works as in v7');
  await claim(6, NONCE(1), { now: NOW + 1000 });
  r = (await result(6, { now: NOW + 1000 + LEASE - 1 })).reply; t(r.ok === false && r.error.code === 'STH-JOB-409' && r.error.reason === 'claimed', '`result` inside a live claim -> STH-JOB-409', r);
  r = (await result(6, { now: NOW + 1000 + LEASE })).reply; t(r.ok === true && r.result.result === 'hello', '`result` after the lease: served');
  { const same = (await result(6, { now: NOW + 1000 + LEASE - 1, wf: v7 })).reply; t(same.ok === true, 'control: the v7 workflow has no such check (that is the bypass the v8 `result` closes)'); }

  console.log('[ack: collected only from succeeded, nonce check, expiry]');
  await R('FLUSHALL'); await done(7); await claim(7, NONCE(1), { now: NOW + 1000 });
  const before = await hall(7);
  r = (await ack(7, NONCE(2), { now: NOW + 2000 })).reply; t(r.ok === true && r.acked.length === 0 && r.notYours.join() === ID(7), 'ack with another nonce: not acknowledged, listed in notYours', r);
  h = await hall(7); t(JSON.stringify(h) === JSON.stringify(before) && (await R('EXISTS', 'sth:jobr:' + ID(7))) === 1, 'a refused ack leaves the record and the answer exactly as they were');
  r = (await ack(7, undefined, { now: NOW + 2000 })).reply; t(r.ok === true && r.acked.length === 0 && r.notYours.join() === ID(7), 'a v7-style ack (no nonce) on a claimed answer is refused too', r);
  r = (await ack(7, NONCE(1), { now: NOW + 3000 })).reply; t(r.ok === true && r.acked.join() === ID(7) && r.notYours.length === 0, 'ack with the claim\'s nonce: acknowledged', r);
  h = await hall(7);
  t(h.st === 'collected' && h.co === String(NOW + 3000) && h.kh === sha(KEY(7)) && h.m === 'tutor' && h.a === '1' && h.c === String(NOW) && h.cl === undefined && h.cla === undefined && h.x === undefined && h.rb === undefined && h.e === '' && Object.keys(h).sort().join() === 'a,c,co,d,e,f,fa,kh,m,s,st', 'collected record: state, collected-at, kh, mode, attempt, times kept; claim, execution id and size gone; NO content', h);
  t((await R('EXISTS', 'sth:jobr:' + ID(7))) === 0, 'the answer is deleted');
  { const ttl = await R('TTL', 'sth:job:' + ID(7)); t(ttl > 259000 && ttl <= 259200, 'the collected note lives 72 h (259200 s)', ttl); }
  r = (await ack(7, NONCE(1), { now: NOW + 4000 })).reply; t(r.ok === true && r.acked.join() === ID(7) && (await hall(7)).co === String(NOW + 3000), 'a repeated ack is harmless (still acknowledged, collected-at not moved)');
  r = (await ack(7, NONCE(9), { now: NOW + 4000 })).reply; t(r.acked.join() === ID(7), 'a repeated ack after collection is harmless even with another nonce');
  r = (await status(7, { now: NOW + 5000 })).reply; const j7 = r.jobs[0]; t(j7.state === 'collected' && j7.attempt === 1 && j7.ageMs === 5000 && j7.error === null && j7.resultBytes === 0, 'status after collection: state collected, ageMs counted from the CREATION (c unchanged), no error, no bytes', j7);
  t((await result(7, { now: NOW + 5000 })).reply.error.code === 'STH-JOB-404', '`result` after collection: STH-JOB-404');
  r = (await claim(7, NONCE(3), { now: NOW + 5000 })).reply; t(r.ok === true && r.state === 'collected' && r.result === undefined, 'claim after collection: {state: collected}, no answer (the other device already applied it)', r);
  r = (await op('cancel', [job(7)], { now: NOW + 5000 })).reply; t(r.state === 'collected', 'cancel of a collected job answers its state (collected); nothing changes', r);
  t((await store(7, { now: NOW + 6000 })) === 'collected' && (await R('EXISTS', 'sth:jobr:' + ID(7))) === 0, 'a late STORE of the same job does not bring the answer back');
  // admission: a collected job is never re-run while its note exists
  t(JSON.stringify(await admit(7)) === '["duplicate","collected"]' && JSON.stringify(await admit(7, { att: 2 })) === '["duplicate","collected"]' && JSON.stringify(await admit(7, { att: 3 })) === '["duplicate","collected"]', 'create / retry (attempt 1, 2, 3) of a collected job is a duplicate: it is NOT re-run and NOT billed again (also for a cached v7 page)');
  r = (await status(7, { now: NOW + 71 * 3600 * 1000 })).reply.jobs[0]; t(r.state === 'collected', 'still collected at 71 h');
  // what the server cannot do after the note expired (documented limit, the client rule D1 covers it: never resend for a published job)
  await R('DEL', 'sth:job:' + ID(7));
  t((await status(7)).reply.jobs[0].state === 'unknown' && JSON.stringify(await admit(7, { att: 2 })) === '["admitted"]', 'after the 72 h note is gone the server only sees an unknown id (it would admit a resend): the client must never resend a job it published (review D1)');
  // other states
  for (const [state, name] of [['failed', 'failed'], ['rejected', 'rejected']]) {
    await R('FLUSHALL'); await admit(8);
    if (state === 'failed') await store(8, { state: 'failed' });
    else { await R('FLUSHALL'); await R('SET', 'cfg:jobs_max_running', '0'); await admit(8); await R('DEL', 'cfg:jobs_max_running'); }
    r = (await ack(8, NONCE(1))).reply; t(r.ok === true && r.acked.join() === ID(8) && (await R('EXISTS', 'sth:job:' + ID(8))) === 0, `ack of a ${name} job: deleted as in v7, NEVER collected (a retryable failure must not look like a success)`, r);
  }
  await R('FLUSHALL'); await admit(9); r = (await op('cancel', [job(9)])).reply; t(r.state === 'cancelled', 'cancelled'); r = (await ack(9, NONCE(1))).reply; t(r.acked.join() === ID(9) && (await R('EXISTS', 'sth:job:' + ID(9))) === 0, 'ack of a cancelled job: deleted, never collected');
  await R('FLUSHALL'); await admit(10); r = (await ack(10, NONCE(1))).reply; t(r.ok === true && r.acked.length === 0 && r.notYours.length === 0 && (await hall(10)).st === 'running', 'ack of a RUNNING job: not acknowledged, not touched (as v7)', r);
  r = (await ack(77, NONCE(1))).reply; t(r.acked.join() === ID(77), 'ack of an unknown job counts as acknowledged (repeat-safe, as v7)');
  r = (await op('ack', [{ id: ID(10), key: KEY(99), nonce: NONCE(1) }])).reply; t(r.acked.join() === ID(10) && (await hall(10)).st === 'running', 'ack with a wrong key: "nothing of yours" (acknowledged), the record is untouched');
  // a never-claimed answer acked the v7 way
  await R('FLUSHALL'); await done(11); r = (await ack(11)).reply; t(r.acked.join() === ID(11) && (await hall(11)).st === 'collected', 'a cached v7 page: result + ack on an unclaimed job -> collected');
  // batch ack: mixed
  await R('FLUSHALL'); await done(12); await done(13); await claim(13, NONCE(5), { now: NOW + 1000 }); await admit(14);
  r = (await op('ack', [{ ...job(12), nonce: NONCE(4) }, { ...job(13), nonce: NONCE(6) }, job(14)], { now: NOW + 2000 })).reply;
  t(r.acked.join() === ID(12) && r.notYours.join() === ID(13) && (await hall(12)).st === 'collected' && (await hall(13)).st === 'succeeded' && (await hall(14)).st === 'running', 'a batch ack: each job on its own (collected / not yours / running)', r);
  t((await R('EXISTS', 'sth:jobr:' + ID(12))) === 0 && (await R('EXISTS', 'sth:jobr:' + ID(13))) === 1, 'only the collected one lost its answer');

  console.log('[scripts and nodes]');
  for (const f of ['job-claim.lua', 'job8-ack.lua']) { const s = lua(f); t(!/cjson|redis\.call\('(EVAL|KEYS|FLUSH|SCAN)/i.test(s), `${f}: no cjson / KEYS / SCAN / EVAL`); }
  t(!/EXPIRE|'SET'/.test(lua('job-claim.lua')) && /'HSET',KEYS\[1\],'cl',ARGV\[2\],'cla',ARGV\[3\]/.test(lua('job-claim.lua')), 'claim writes only cl / cla (no new expiry, no new key)');
  await R('FLUSHALL');
  { const ttlGuard = await R('EVAL', lua('job-claim.lua'), '2', 'sth:job:' + ID(50), 'sth:jobr:' + ID(50), sha(KEY(50)), NONCE(1), String(NOW), String(LEASE)); t(JSON.stringify(ttlGuard) === '["unknown"]' && (await R('EXISTS', 'sth:job:' + ID(50))) === 0, 'claim on a missing record creates nothing'); }
  // differential: the v7 and v8 workflows differ in exactly the intended nodes (details in validate.js); here: the unchanged job nodes are byte-identical
  for (const nm of ['Job - Status Read', 'Job - Status Reply', 'Job - Cancel', 'Job - Cancel Reply', 'Job - Admit', 'Job - Store Outcome', 'Job - Hash Key', 'Job - Reply', 'Job - Classify Outcome', 'Job - Error Outcome', 'Job - Result Read', 'Job - Budget Read', 'Job - Budget Reply']) {
    const a = nodeOf(v7, nm), b = nodeOf(v8, nm); const strip = (x) => JSON.stringify({ ...x, notes: undefined });
    t(strip(a) === strip(b), `${nm} is unchanged from v7`);
  }
  // v7 behaviour of the changed nodes is kept for everything v7 knew
  for (const env of [{ v: 1, op: 'status', jobs: [job(1), job(2)] }, { v: 1, op: 'cancel', jobs: [job(1)] }, { v: 1, op: 'budget', jobs: [] }, { v: 1, op: 'result', jobs: [job(1)] }, { v: 1, op: 'result', jobs: [job(1), job(2)] }, { v: 1, op: 'ack', jobs: [job(1)] }, { v: 1, op: 'nope', jobs: [] }, { v: 1, op: 'status' }]) {
    const a = await runCode(`Date.now = () => ${NOW};\n` + codeOf(v7, 'Job - Read Request'), { input: [J({ env })] }), b = await runCode(`Date.now = () => ${NOW};\n` + codeOf(v8, 'Job - Read Request'), { input: [J({ env })] });
    const norm = (x) => JSON.stringify(x.map((i) => { const j = { ...i.json }; if (j.cfg) { const { claimLeaseMs, collectedTtlS, ...c } = j.cfg; j.cfg = c; } delete j.nonce; return j; }));
    t(norm(a) === norm(b), `Job - Read Request: v7 and v8 agree on ${env.op} ${env.jobs ? env.jobs.length : '-'} jobs`);
  }
  // rollback (review D8): the v7 workflow does not know `claim` and answers STH-INPUT-400 (a v8 client must then fall back to result + ack for its own jobs)
  { const r7 = (await server({ v: 1, op: 'claim', jobs: [{ ...job(1), nonce: NONCE(1) }] }, { wf: v7 })).reply; t(r7.ok === false && r7.error.code === 'STH-INPUT-400', 'a v7 workflow answers claim with STH-INPUT-400 (the rollback shape the fake also has)', r7); }
  // create path (Job Start): unchanged
  { const cj = { v: 1, op: 'create', id: ID(1), key: KEY(1), attempt: 1, mode: 'transcribe' };
    const a = await runCode(codeOf(v7, 'Job - Read Request'), { input: [J({ env: { job: cj } })], nodes: { 'Job Start Endpoint': [J({})] } }), b = await runCode(codeOf(v8, 'Job - Read Request'), { input: [J({ env: { job: cj } })], nodes: { 'Job Start Endpoint': [J({})] } });
    const strip = (x) => { const j = { ...x[0].json, now: 0 }; const { claimLeaseMs, collectedTtlS, ...c } = j.cfg; j.cfg = c; return JSON.stringify(j); }; t(strip(a) === strip(b), 'create is routed exactly as in v7'); }

  console.log('[extra-origin build (review B1): every webhook, Renew Endpoint included]');
  { const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'sth-extra-'));
    const build = (env) => cp.spawnSync('node', ['build.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, STH_OUT_DIR: dir, ...env }, encoding: 'utf8' });
    let b = build({ STH_EXTRA_ORIGIN: 'https://school.example.org' });
    t(b.status === 0, 'build with STH_EXTRA_ORIGIN succeeds', b.stderr.slice(-300));
    const w8 = JSON.parse(fs.readFileSync(path.join(dir, 'sth-workflow-v8-bundle.json'), 'utf8')), w7 = JSON.parse(fs.readFileSync(path.join(dir, 'sth-workflow-v7-bundle.json'), 'utf8'));
    const origins = (w) => w.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').map((n) => [n.name, n.parameters.options.allowedOrigins]);
    t(origins(w8).length === 5 && origins(w8).every(([, o]) => o === 'https://jay-leigh.github.io,https://school.example.org') && origins(w8).some(([n]) => n === 'Renew Endpoint'), 'v8: all FIVE webhooks (Renew Endpoint included) allow both origins', origins(w8));
    t(origins(w7).filter(([, o]) => o === 'https://jay-leigh.github.io,https://school.example.org').length === 4 && origins(w7).some(([n, o]) => n === 'Auth Endpoint' && /school/.test(o)), 'v7 (rollback copy): its four webhooks allow both origins', origins(w7));
    for (const f of ['sth-workflow-v1-additive.json', 'sth-workflow-v2-enforce.json', 'sth-workflow-v3-studio.json', 'sth-workflow-v4-jobs.json', 'sth-workflow-v5-flashcards.json', 'sth-workflow-v6-quiz.json']) t(fs.readFileSync(path.join(dir, f), 'utf8') === fs.readFileSync(path.join(__dirname, '..', f), 'utf8'), `${f} never changes with the extra origin`);
    // the rewrite differs from the plain build in the allowedOrigins strings only
    const plain = JSON.stringify(v8), extra = JSON.stringify(w8).split('https://jay-leigh.github.io,https://school.example.org').join('https://jay-leigh.github.io');
    t(plain === extra, 'apart from the allowedOrigins strings the extra-origin bundle is identical to the plain one');
    for (const bad of ['http://x.example', 'https://x.example/path', 'https://', 'javascript:alert(1)', 'https://a b.example', 'https://x.example,https://y.example']) { b = build({ STH_EXTRA_ORIGIN: bad }); t(b.status !== 0 && /STH_EXTRA_ORIGIN must be an https origin/.test(b.stderr), `STH_EXTRA_ORIGIN ${JSON.stringify(bad)} is refused`); }
    b = build({}); const p8 = fs.readFileSync(path.join(dir, 'sth-workflow-v8-bundle.json'), 'utf8'); t(b.status === 0 && p8 === fs.readFileSync(path.join(__dirname, '..', 'sth-workflow-v8-bundle.json'), 'utf8') && fs.readFileSync(path.join(dir, 'sth-workflow-v7-bundle.json'), 'utf8') === fs.readFileSync(path.join(__dirname, '..', '..', 'sth-workflow-v7-bundle.json'), 'utf8'), 'without the variable v8 is the shipped bundle and v7 is byte-identical to the committed v7');
    fs.rmSync(dir, { recursive: true, force: true }); }

  await R('FLUSHALL');
  console.log(`\nt-v8: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
