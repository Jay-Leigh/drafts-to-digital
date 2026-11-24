// End-to-end checks of the flashcards BACKGROUND JOB path (v5) against a real n8n 2.29.7 running the imported v5 test copy
// (external HTTP -> mock; real Redis 7 on :6390, so the Lua scripts run for real).
//   node e2e/run-jobs-fc.js main    after: STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v5-flashcards
//   node e2e/run-jobs-fc.js short   after: JOB_TEST_DEADLINES=tutor=8,studio_mindmap=10,studio_flashcards=10 JOB_TEST_GRACE=2 JOB_TEST_TUTOR_TIMEOUT_MS=30000 STUDIO_TEST_TIMEOUT_MS=30000 e2e/reload.sh v5-flashcards
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const NM = path.join(__dirname, '..', 'n8nrun', 'node_modules');
const jwt = require(path.join(NM, 'jsonwebtoken'));
const flatted = require(path.join(NM, 'flatted'));
const sqlite3 = require(path.join(NM, 'sqlite3'));
const PHASE = process.argv[2] || 'main';
const B = 'http://127.0.0.1:5799/webhook';
const M = 'http://127.0.0.1:5801';
const ORIGIN = 'https://jay-leigh.github.io';
const SECRET = 'test-secret-0123456789abcdef0123456789abcdef';
let pass = 0, fail = 0;
const SRC_OVER = process.env.WF_V7 ? 16 : 11; // v7 accepts 15 sources (v3..v6: 10)
const t = (c, name, extra) => { if (c) pass++; else { fail++; console.log('  FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body, headers = {}, raw) {
  const t0 = Date.now();
  const res = await fetch(B + '/' + p, { method: 'POST', headers: { ...(raw instanceof FormData ? {} : { 'content-type': 'application/json' }), origin: ORIGIN, ...headers }, body: raw !== undefined ? raw : JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, text, json, headers: res.headers, ms: Date.now() - t0 };
}
const state = async () => (await fetch(M + '/_state')).json();
const reset = async () => { await fetch(M + '/_reset'); await fetch(M + '/_set?k=auth:code&v=letmein'); };
const setKey = (k, v) => fetch(`${M}/_set?k=${encodeURIComponent(k)}&v=${encodeURIComponent(v)}`);
const queue = (q, def = 'valid') => fetch(`${M}/_studio?q=${q}&def=${def}`);
const redis = (...a) => require('child_process').execFileSync('redis-cli', ['-p', '6390', ...a]).toString().trim();
const gcalls = async () => (await state()).log.filter((l) => l.gemini);
const logCmds = async () => (await state()).log.filter((l) => l.cmd).length;
function db() { return new sqlite3.Database(path.join(__dirname, '..', 'n8nrun/home/.n8n/database.sqlite'), sqlite3.OPEN_READONLY); }
function allRows(sql) { return new Promise((res, rej) => { const d = db(); d.all(sql, (e, rows) => { d.close(); e ? rej(e) : res(rows); }); }); }
async function execs() {
  const rows = await allRows('SELECT e.id, e.status, d.data FROM execution_entity e JOIN execution_data d ON d.executionId = e.id ORDER BY e.id');
  return rows.map((r) => { let run = {}; try { run = flatted.parse(r.data).resultData.runData; } catch (e) {} return { id: r.id, status: r.status, raw: r.data, run }; });
}
const cmdCount = () => { let n = 0; for (const l of redis('INFO', 'commandstats').split('\n')) { const m = l.match(/^cmdstat_(\w+):calls=(\d+)/); if (m && !['info', 'config', 'flushall', 'keys', 'type', 'ping'].includes(m[1])) n += Number(m[2]); } return n; };
const hgetall = (k) => { const a = require('child_process').execFileSync('redis-cli', ['-p', '6390', '--raw', 'HGETALL', k]).toString().split('\n'); a.pop(); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };

const rid = () => 'j_' + crypto.randomBytes(16).toString('base64url');
const rkey = () => crypto.randomBytes(32).toString('base64url');
const mkJob = (mode = 'tutor', attempt = 1) => ({ id: rid(), key: rkey(), mode, attempt });
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
let H = {};
const envl = (job, o = {}) => ({ v: 1, op: 'create', id: job.id, key: job.key, attempt: job.attempt, mode: job.mode, ...o });
const create = (job, body, h = H) => post('sth-job-start', { ...body, job: envl(job) }, h);
const op = (name, jobs, h = H) => post('sth-job', { v: 1, op: name, jobs: jobs.map((j) => ({ id: j.id, key: j.key })) }, h);
const st = async (jobs) => (await op('status', jobs)).json;
const stOne = async (job) => (await st([job])).jobs[0];
async function waitState(job, want, ms = 90000) { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await stOne(job); if (want.includes(s.state)) return s; await sleep(400); } return s; }
const DONE = ['succeeded', 'failed', 'cancelled', 'rejected', 'lost'];
const tutorBody = (text, chat = 'chat-' + crypto.randomBytes(4).toString('hex'), extra = {}) => ({ mode: 'tutor', chatId: chat, messages: [{ role: 'user', text }], attachedContext: [], documentFingerprints: [], ...extra });
const txt = (id, n, extra = {}) => ({ id, name: id + '.txt', kind: 'txt', markers: 'none', pages: 0, tokens: 1, text: 'lorem ipsum '.repeat(Math.ceil(n / 12)).slice(0, n), ...extra });
const mmBody = (extra = {}) => ({ mode: 'studio_mindmap', v: 1, requestId: 'f_1761580000000_ab12cd', tool: 'mindmap', language: { code: 'en', name: 'English' }, options: {}, description: 'Focus on Theme 1', sources: [{ id: 'S1', name: 'Book.pdf', kind: 'pdf', markers: 'page', pages: 3, tokens: 30, text: '[Page 1]\nalpha beta\n\n[Page 2]\ngamma delta\n\n[Page 3]\nepsilon' }], clientEstimate: 30, promptVersion: 'studio-2026-11-a', ...extra });
const MARK = 'ZZSECRETJOBZZ' + 'q'.repeat(20);
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const login = async (ip) => (await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, ' + ip })).json.token;
const errOf = (s) => s && s.error && s.error.code;
const fcBody = (extra = {}) => ({ mode: 'studio_flashcards', v: 1, requestId: 'f_1761580000000_ab12cd', tool: 'flashcards', language: { code: 'en', name: 'English' }, options: { count: 30, difficulty: 'medium' }, description: 'Focus on Theme 1', sources: [{ id: 'S1', name: 'Book.pdf', kind: 'pdf', markers: 'page', pages: 3, tokens: 30, text: '[Page 1]\nalpha beta\n\n[Page 2]\ngamma delta\n\n[Page 3]\nepsilon' }], clientEstimate: 30, promptVersion: 'studio-2026-11-a', ...extra });
const mkF = () => mkJob('studio_flashcards');
const strip = (j) => { const c = JSON.parse(JSON.stringify(j)); if (c.artifact) delete c.artifact.generatedAt; return JSON.stringify(c); };

async function main() {
  await reset();
  const tok = await login('51.1.1.1'); H = { authorization: 'Bearer ' + tok };

  console.log('[hello, auth]');
  let r = await post('sth-job', { v: 1, op: 'status', jobs: [] }, H);
  t(r.status === 200 && r.json.ok === true && r.json.jobsEnabled === true && r.json.modes.join() === (process.env.WF_V7 ? 'tutor,studio_mindmap,studio_flashcards,studio_quiz,studio_infographic,studio_slides,studio_digest,transcribe,template,reviewer' : process.env.WF_V6 ? 'tutor,studio_mindmap,studio_flashcards,studio_quiz' : 'tutor,studio_mindmap,studio_flashcards'), 'hello advertises modes tutor, studio_mindmap, studio_flashcards', r.text);
  r = await post('sth-job-start', { ...fcBody(), job: envl(mkF()) }); t(r.status === 401, 'sth-job-start without a token -> 401', r.status);
  r = await post('sth-job-start', { ...fcBody(), job: envl(mkF()) }, { authorization: 'Bearer garbage' }); t(r.status === 403, 'garbage token -> 403', r.status);
  t((await gcalls()).length === 0, 'unauthenticated job starts: no Gemini call');

  console.log('[flashcards job: create, poll, result, ack; result equals the sync answer]');
  await queue('valid');
  const jf = mkF(); const t0 = Date.now(); r = await create(jf, fcBody());
  t(r.status === 200 && r.text === '{"ok":true,"accepted":true}' && /application\/json/.test(r.headers.get('content-type')) && r.ms < 3000, 'create answers {"ok":true,"accepted":true} at once', [r.status, r.text, r.ms]);
  let s = await waitState(jf, DONE);
  t(s.state === 'succeeded' && s.attempt === 1 && s.error === null && s.resultBytes > 1000, 'job succeeded (attempt 1)', s);
  const syncF = await post('student-tools-v2', fcBody(), H); r = await op('result', [jf]);
  t(r.json.ok === true && r.json.id === jf.id && r.json.mode === 'studio_flashcards' && strip(r.json.result) === strip(syncF.json) && r.json.result.ok === true && r.json.result.artifact.tool === 'flashcards' && r.json.result.artifact.data.cards.length === 30, 'stored deck == the sync artifact (except generatedAt)', r.text.slice(0, 200));
  t(s.resultBytes === Buffer.byteLength(JSON.stringify(r.json.result)) || Math.abs(s.resultBytes - Buffer.byteLength(JSON.stringify(r.json.result))) < 40, 'resultBytes = size of the stored answer (the sync one differs only in generatedAt)', [s.resultBytes, Buffer.byteLength(JSON.stringify(r.json.result))]);
  let rec = hgetall('sth:job:' + jf.id);
  t(rec.kh === sha(jf.key) && rec.st === 'succeeded' && rec.m === 'studio_flashcards' && !JSON.stringify(rec).includes(jf.key), 'record holds the key hash and the mode, never the key', rec);
  t(Number(redis('TTL', 'sth:job:' + jf.id)) > 259000 && Number(redis('TTL', 'sth:jobr:' + jf.id)) > 259000, 'record and result live 72 h');
  const cnt1 = (await gcalls()).length; await create(jf, fcBody()); await sleep(1500); t((await gcalls()).length === cnt1 && (await stOne(jf)).state === 'succeeded', 'idempotent re-create of a finished job: no new execution');
  r = await op('ack', [jf]); t(r.json.ok === true && r.json.acked.join() === jf.id && redis('EXISTS', 'sth:job:' + jf.id) === '0' && redis('EXISTS', 'sth:jobr:' + jf.id) === '0', 'ack deletes the record and the result');
  t((await stOne(jf)).state === 'unknown', 'after ack: unknown'); r = await op('result', [jf]); t(r.json.ok === false && r.json.error.code === 'STH-JOB-404', 'after ack: result -> STH-JOB-404');
  const bad = { ...jf, key: rkey() }; const jw = mkF(); await create(jw, fcBody()); await waitState(jw, DONE);
  t((await stOne({ ...jw, key: rkey() })).state === 'unknown', 'wrong key: status unknown'); r = await op('result', [{ ...jw, key: rkey() }]); t(r.json.error && r.json.error.code === 'STH-JOB-404', 'wrong key: result 404'); await op('ack', [jw]);
  for (const [count, difficulty] of [[15, 'easy'], [50, 'hard']]) {
    await queue('valid'); const jo = mkF(); await create(jo, fcBody({ options: { count, difficulty } })); s = await waitState(jo, DONE); r = await op('result', [jo]);
    t(s.state === 'succeeded' && r.json.result.artifact.data.cards.length === count && /cards: \d+\ndifficulty: /.test((await gcalls()).at(-1).body.contents[0].parts.at(-1).text) && new RegExp(`cards: ${count}\\ndifficulty: ${difficulty}`).test((await gcalls()).at(-1).body.contents[0].parts.at(-1).text), `job with options ${count}/${difficulty}: ${count} cards`, s); await op('ack', [jo]);
  }
  // salvaged and repaired decks come through a job too
  await queue('trunclate'); const jt = mkF(); await create(jt, fcBody()); s = await waitState(jt, DONE); r = await op('result', [jt]); t(s.state === 'succeeded' && r.json.result.artifact.data.cards.length === 25 && r.json.result.artifact.repairs.length > 0, 'a cut-off answer salvaged in a job: succeeded with 25 cards'); await op('ack', [jt]);

  console.log('[flashcards job: every failure path stores a failed state]');
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.2.2')) };
  const fails = [];
  const F = (name, fx, body, want, retryable, reason, mode = 'studio_flashcards') => fails.push({ name, fx, job: mkJob(mode), body, want, retryable, reason });
  F('Studio reject: 11 sources', 'valid', fcBody({ sources: Array.from({ length: SRC_OVER }, (_, i) => txt('S' + (i + 1), 100)) }), 'STH-STU-413', false, 'too_many_sources');
  F('Studio reject: too much material', 'valid', fcBody({ sources: [txt('S1', 1700000)] }), 'STH-STU-413', false, 'too_much_material');
  F('Studio reject: bad options', 'valid', fcBody({ options: { count: 20, difficulty: 'easy' } }), 'STH-INPUT-400', false, 'options');
  F('Studio reject: bad version', 'valid', fcBody({ v: 2 }), 'STH-INPUT-400', false);
  F('Studio reject: tool/mode mismatch (mind map tool in a flashcards job)', 'valid', fcBody({ tool: 'mindmap' }), 'STH-INPUT-400', false, 'version_or_tool');
  F('mode mismatch (job flashcards, body mind map): thrown by Normalize', 'valid', { ...fcBody({ tool: 'mindmap', options: {} }), mode: 'studio_mindmap' }, 'STH-INPUT-400', false);
  F('Gemini 500 x3', '500,500,500', fcBody(), 'STH-STU-409', true, 'upstream');
  F('Gemini 429 x3', '429,429,429', fcBody(), 'STH-STU-409', true, 'busy');
  F('Gemini timeout x3 (6 s test timeout)', 'hang:20000,hang:20000,hang:20000', fcBody(), 'STH-STU-409', true, 'unreachable');
  F('Gemini 400 twice', '400,400', fcBody(), 'STH-STU-422', true, 'rejected');
  F('safety block', 'safety', fcBody(), 'STH-AI-451', false);
  F('recitation block', 'recitation', fcBody(), 'STH-AI-452', false);
  F('truncated output (MAX_TOKENS, 2 cards)', 'truncated', fcBody(), 'STH-STU-422', true, 'truncated');
  F('prose instead of JSON', 'prose', fcBody(), 'STH-STU-422', true, 'parse');
  F('too few cards (12 of 30)', 'few', fcBody(), 'STH-STU-422', true, 'too_few_cards');
  F('only duplicates', 'alldupes', fcBody(), 'STH-STU-422', true, 'too_few_cards');
  F('wrong schema id', 'wrongschema', fcBody(), 'STH-STU-422', true, 'schema');
  F('empty answers x3', 'empty,empty,empty', fcBody(), 'STH-STU-422', true, 'empty');
  for (const f of fails) {
    await queue(f.fx); await create(f.job, f.body); f.s = await waitState(f.job, DONE, 120000);
    t(f.s.state === 'failed' && errOf(f.s) === f.want && f.s.error.retryable === f.retryable && f.s.resultBytes === 0 && (!f.reason || f.s.error.reason === f.reason), `${f.name} -> failed ${f.want}${f.reason ? ' (' + f.reason + ')' : ''}`, f.s);
    const rr = await op('result', [f.job]); t(rr.json.ok === false && rr.json.error.code === 'STH-JOB-404' && redis('EXISTS', 'sth:jobr:' + f.job.id) === '0', `${f.name}: no result stored`);
  }
  await sleep(14000);
  { const rec2 = hgetall('sth:job:' + fails[0].job.id); t(rec2.st === 'failed' && JSON.parse(rec2.e).code === 'STH-STU-413' && JSON.parse(rec2.e).reason === 'too_many_sources' && Object.keys(JSON.parse(rec2.e)).sort().join() === 'code,reason', 'stored error is just {code, reason}', rec2); }
  t(redis('ZCARD', 'sth:jobs:run:studio_flashcards') === '0' && redis('ZCARD', 'sth:jobs:run:studio_mindmap') === '0', 'all flashcards / mind map run slots are free again');
  // quota ceiling
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.3.3')) }; await setKey('cfg:daily_units', '1'); await setKey('usage:' + today, '5');
  const jq = mkF(); const n0 = (await gcalls()).length; await create(jq, fcBody()); s = await waitState(jq, DONE);
  t(s.state === 'failed' && errOf(s) === 'STH-QUOTA-430' && s.error.retryable === false && (await gcalls()).length === n0, 'quota ceiling -> failed STH-QUOTA-430, no Gemini call', s);
  redis('DEL', 'cfg:daily_units');
  // failed -> attempt 2 -> success; attempts
  await queue('safety'); const ja = mkF(); await create(ja, fcBody()); s = await waitState(ja, DONE); t(s.state === 'failed', 'attempt 1 failed (safety)');
  await queue('valid'); await create({ ...ja, attempt: 3 }, fcBody()); await sleep(1000); t((await stOne(ja)).attempt === 1, 'attempt 3 right after attempt 1 is ignored');
  await create({ ...ja, attempt: 2 }, fcBody()); s = await waitState(ja, ['succeeded']); t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 after a failure is admitted and succeeds', s);

  console.log('[flashcards job: caps, kill switch, cancel race, parallel with the other modes]');
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.4.4')) };
  await queue('slow:3000,slow:3000,slow:3000');
  const f1 = mkF(); await create(f1, fcBody()); await sleep(700);
  t((await stOne(f1)).state === 'running', 'flashcards job 1 running');
  const f2 = mkF(); await create(f2, fcBody()); s = await waitState(f2, DONE, 5000);
  t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429' && s.error.retryable === true && s.error.retryAfterMs === 20000, 'flashcards job 2 while 1 runs: rejected STH-JOB-429 (own cap 1)', s);
  const m1 = mkJob('studio_mindmap'); await create(m1, mmBody()); await sleep(600);
  t((await stOne(m1)).state === 'running', 'a mind map job runs next to the flashcards job (own cap)');
  const tj = [mkJob(), mkJob(), mkJob()]; for (const j of tj) await create(j, tutorBody('[[mock:hang2500]] cap'));
  s = await waitState(tj[2], DONE, 5000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', '3rd tutor while flashcards + mind map + 2 tutors run (4 jobs): rejected (total cap 4)', s);
  for (const j of [f1, m1, tj[0], tj[1]]) t((await waitState(j, DONE)).state === 'succeeded', 'running ' + j.mode + ' job finishes');
  await create(f2, fcBody()); await queue('valid'); s = await waitState(f2, DONE); t(s.state === 'succeeded', 'the rejected flashcards job, re-sent with the same attempt, is admitted once room exists', s);
  await op('ack', [f1, f2, m1, ...tj]);
  // total override + kill switch
  await setKey('cfg:jobs_max_running', '1'); await queue('slow:3000'); const o1 = mkF(); await create(o1, fcBody()); await sleep(500); const o2 = mkJob(); await create(o2, tutorBody('x'));
  s = await waitState(o2, DONE, 5000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'cfg:jobs_max_running 1: a tutor job is refused while a flashcards job runs', s); await waitState(o1, DONE);
  await setKey('cfg:jobs_max_running', '0'); const ng = (await gcalls()).length;
  const ks = mkF(); await create(ks, fcBody()); s = await waitState(ks, DONE, 5000);
  t(s.state === 'rejected' && errOf(s) === 'STH-JOB-503' && s.error.retryable === false && (await gcalls()).length === ng, 'cfg:jobs_max_running 0: flashcards job rejected STH-JOB-503 at once, no Gemini call', s);
  redis('DEL', 'cfg:jobs_max_running'); await queue('valid'); await create(ks, fcBody()); s = await waitState(ks, ['succeeded', 'failed'], 15000); t(s.state === 'succeeded', 'switch removed: the same job (same attempt) is admitted', s);
  await queue('slow:3000'); const inflight = mkF(); await create(inflight, fcBody()); await sleep(700); await setKey('cfg:jobs_max_running', '0');
  t((await waitState(inflight, DONE)).state === 'succeeded', 'a flashcards job running when the switch flips finishes and can be collected'); redis('DEL', 'cfg:jobs_max_running');
  // cancel race
  await queue('slow:4000'); const cj = mkF(); await create(cj, fcBody()); await sleep(700);
  r = await op('cancel', [cj]); t(r.json.ok === true && r.json.state === 'cancelled', 'cancel a running flashcards job', r.json);
  await sleep(5000); s = await stOne(cj); t(s.state === 'cancelled' && redis('EXISTS', 'sth:jobr:' + cj.id) === '0', 'late success after cancel is discarded', s);
  t(redis('ZCARD', 'sth:jobs:run:studio_flashcards') === '0', '...and the run slot was freed by the late store');
  await op('ack', [cj, ks, inflight, o1]);

  console.log('[flashcards job: Redis down at admission; no request text anywhere]');
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.5.5')) };
  const dj = mkF(); const nn = (await gcalls()).length; await fetch(M + '/_down?on=1'); await create(dj, fcBody()); await sleep(2500); r = await op('status', [dj]); await fetch(M + '/_down?on=0');
  t((await gcalls()).length === nn && r.json && r.json.ok === false && r.json.error.code === 'STH-SRV-503', 'Redis down at admission: the chain did not run; status -> STH-SRV-503', r.text);
  await queue('valid'); await create(dj, fcBody()); t((await waitState(dj, DONE)).state === 'succeeded', 'the client re-sends the same create and it works');
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.6.6')) };
  const e0 = (await execs()).length;
  const sec = (extra = {}) => fcBody({ description: MARK + ' description', sources: [{ id: 'S1', name: MARK + '.pdf', kind: 'pdf', markers: 'page', pages: 1, tokens: 1, text: '[Page 1]\n' + MARK + ' body' }], ...extra });
  const leak = [];
  for (const [fx, body, mode] of [['500,500,500', sec(), 'studio_flashcards'], ['few', sec(), 'studio_flashcards'], ['valid', sec({ options: { count: MARK } }), 'studio_flashcards'], ['valid', { ...sec(), mode: 'studio_mindmap' }, 'studio_flashcards'], ['valid', sec(), 'studio_flashcards']]) { await queue(fx); const j = mkJob(mode); leak.push(j); await create(j, body); await waitState(j, DONE, 120000); }
  const lbad = mkF(); const fd2 = new FormData(); fd2.append('payload', '{"mode":"studio_flashcards","description":"' + MARK + '"'); fd2.append('job', JSON.stringify(envl(lbad))); await post('sth-job-start', null, H, fd2); await waitState(lbad, DONE);
  await sleep(3000);
  const all = redis('--scan', '--pattern', '*').split('\n').filter(Boolean); let dump = '';
  for (const k of all) { const ty = redis('TYPE', k); dump += k + '=' + (ty === 'string' ? redis('GET', k) : ty === 'hash' ? JSON.stringify(hgetall(k)) : redis('ZRANGE', k, '0', '-1')) + '\n'; }
  t(!dump.replace(/"artifact".*$/gm, '').includes('ZZSECRET'), 'no Redis key or value (but the finished deck) contains request text', dump.slice(0, 200));
  const rd = await op('result', [leak[4]]); t(rd.json.ok === true && !JSON.stringify(rd.json.result).includes('ZZSECRET'), 'the stored deck holds no request text either (source name, description)');
  t((await stOne(lbad)).state === 'failed' && errOf(await stOne(lbad)) === 'STH-INPUT-400', 'malformed multipart payload -> failed STH-INPUT-400');
  const ex = (await execs()).slice(e0);
  const mails = ex.filter((e) => e.run['Format Workflow Error1']);
  t(mails.length >= 2, 'thrown job failures produce workflow-error mails like sync ones', mails.length);
  t(!mails.some((e) => JSON.stringify(e.run['Format Workflow Error1']).includes('ZZSECRET') || JSON.stringify(e.run['Send Workflow Error Email1'] || '').includes('ZZSECRET')), 'no error mail contains request text');
  t(!ex.some((e) => ['Job - Error Outcome', 'Job - Classify Outcome', 'Job - Store Outcome', 'Job - Error Lookup'].some((n) => e.run[n] && JSON.stringify(e.run[n]).replace(/"artifact".*/, '').includes('ZZSECRET'))), 'job error / store nodes hold no request text');
  t(!JSON.stringify((await state()).log.filter((l) => l.cmd).filter((l) => !/sth:jobr:/.test(JSON.stringify(l.cmd)))).includes('ZZSECRET'), 'no Redis command (but the result store) carried request text');

  console.log('[every sth: key has a TTL; Upstash command counts]');
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.7.7')) };
  const tj2 = mkF(); await create(tj2, fcBody()); await waitState(tj2, ['succeeded']);
  const cj2 = mkF(); await queue('safety'); await create(cj2, fcBody()); await waitState(cj2, DONE);
  for (const k of redis('--scan', '--pattern', 'sth:*').split('\n').filter(Boolean)) t(Number(redis('TTL', k)) > 0, `TTL set on ${k.replace(/j_[A-Za-z0-9_-]{22}/, 'j_<id>').replace(/:\d+$/, ':<n>')}`);
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.8.8')) }; await queue('valid');
  { const cj3 = mkF(); await sleep(1500); const before = cmdCount(); await create(cj3, fcBody()); await sleep(2500); let polls = 0; s = null;
    while (!s || s.state === 'running') { s = await stOne(cj3); polls++; if (s.state === 'running') await sleep(1500); }
    await op('result', [cj3]); await op('ack', [cj3]); const used = cmdCount() - before;
    t(used <= 37 + (process.env.WF_V7 ? 12 : 0) + Math.max(0, polls - 4) + 3, `flashcards job: ${used} Redis commands incl. ${polls} poll(s) (budget ~37 with 4 polls)`, used); console.log(`   flashcards: ${used} commands, ${polls} polls`); }

  console.log('[parallel load: flashcards + mind map + 2 tutor jobs + sync flashcards + sync OCR]');
  await reset(); H = { authorization: 'Bearer ' + (await login('51.1.9.9')) }; await queue('slow:2500');
  await setKey('ocr:' + 'a'.repeat(64) + ':1-1', JSON.stringify({ pages: [{ page: 1, text: 'cached text' }] }));
  const lj = [mkF(), mkJob('studio_mindmap'), mkJob(), mkJob()];
  for (const j of lj) await create(j, j.mode === 'tutor' ? tutorBody('[[mock:hang2500]] load') : j.mode === 'studio_mindmap' ? mmBody() : fcBody());
  const [sy, so] = await Promise.all([post('student-tools-v2', fcBody(), H), post('student-tools-v2', { mode: 'ocr', contentHash: 'a'.repeat(64), startPage: 1, endPage: 1 }, H)]);
  t(sy.json && sy.json.ok === true && so.json && so.json.cached === true, 'sync flashcards and sync OCR answer normally while 4 jobs run', [sy.text.slice(0, 80), so.text.slice(0, 80)]);
  for (const j of lj) t((await waitState(j, DONE)).state === 'succeeded', 'parallel job ' + j.mode + ' succeeded');
}

async function short() {
  await reset(); H = { authorization: 'Bearer ' + (await login('52.1.1.1')) };
  console.log('[short deadlines: flashcards 10 s, grace 2 s]');
  // 1. stalled run -> lost (derived) -> late success wins
  await queue('hang:14000'); const j1 = mkF(); await create(j1, fcBody()); await sleep(1500);
  t((await stOne(j1)).state === 'running', 'stalled flashcards job is running');
  let s = await waitState(j1, ['lost'], 25000);
  t(s.state === 'lost' && errOf(s) === 'STH-JOB-504' && s.error.retryable === true && s.error.retryAfterMs === 0, 'a stalled flashcards run is reported lost (STH-JOB-504) after deadline + grace', s);
  t(hgetall('sth:job:' + j1.id).st === 'running', 'lost is derived: the stored state is still running');
  s = await waitState(j1, ['succeeded'], 20000); t(s.state === 'succeeded' && s.attempt === 1, 'its late success wins over the lost state', s);
  let r = await op('result', [j1]); t(r.json.ok === true && r.json.result.artifact.tool === 'flashcards', 'the late deck can be fetched');
  t(redis('ZCARD', 'sth:jobs:run:studio_flashcards') === '0', 'no slot left behind');
  // 2. lost -> attempt 2 succeeds; attempt 1's late answer does not overwrite it
  await queue('hang:14000,valid'); const j2 = mkF(); await create(j2, fcBody()); await waitState(j2, ['lost'], 25000);
  await create({ ...j2, attempt: 2 }, fcBody()); s = await waitState(j2, ['succeeded'], 20000); t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 admitted over the lost attempt and succeeded', s);
  await sleep(9000); s = await stOne(j2); t(s.state === 'succeeded' && s.attempt === 2 && hgetall('sth:job:' + j2.id).fa === '2', 'attempt 1 finishing late does not overwrite the finished attempt 2', hgetall('sth:job:' + j2.id));
  // 3. fast failures near the deadline: no retry loop (the retry budget comes from the job deadline)
  await queue('500,500,500'); const j3 = mkF(); const tt = Date.now(); const c0 = (await gcalls()).length; await create(j3, fcBody()); s = await waitState(j3, DONE, 20000);
  t(s.state === 'failed' && errOf(s) === 'STH-STU-409' && Date.now() - tt < 9000 && (await gcalls()).length - c0 === 1, 'Gemini 500 with a 10 s job deadline: ONE call, failed STH-STU-409 within seconds (no retry that could not finish)', [s, Date.now() - tt, (await gcalls()).length - c0]);
  await queue('valid');
  // 4. store unreachable
  await reset(); H = { authorization: 'Bearer ' + (await login('52.1.2.2')) };
  await queue('slow:3000'); const j5 = mkF(); await create(j5, fcBody()); await sleep(1500);
  await fetch(M + '/_down?on=1'); await sleep(9000); await fetch(M + '/_down?on=0');
  s = await stOne(j5); t(s.state === 'running' || s.state === 'lost', 'Redis down while the run finished: nothing was stored', s);
  s = await waitState(j5, ['lost', 'succeeded', 'failed'], 15000); t(s.state === 'lost', 'it becomes lost (the client then re-sends)', s);
  await queue('valid'); await create({ ...j5, attempt: 2 }, fcBody()); s = await waitState(j5, ['succeeded', 'failed'], 20000); t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 succeeds after the outage', s);
  // 5. n8n killed mid-run
  await reset(); H = { authorization: 'Bearer ' + (await login('52.1.3.3')) };
  await queue('hang:15000'); const j6 = mkF(); await create(j6, fcBody()); await sleep(1500);
  t((await stOne(j6)).state === 'running', 'running before the crash');
  execSync(path.join(__dirname, 'restart.sh'), { stdio: 'inherit' });
  { let tk = null; for (let i = 0; i < 10 && !tk; i++) { try { tk = await login('52.1.4.4'); } catch (e) { await sleep(1500); } } H = { authorization: 'Bearer ' + tk }; }
  s = await stOne(j6); t(['running', 'lost', 'failed'].includes(s.state), 'after the restart the record is still there', s);
  s = await waitState(j6, ['lost', 'failed'], 20000);
  t((s.state === 'lost' && errOf(s) === 'STH-JOB-504') || (s.state === 'failed' && errOf(s) === 'STH-SRV-500' && s.error.retryable === true), 'a run killed with n8n ends retryable: failed STH-SRV-500 (crash recovery) or lost STH-JOB-504 (watchdog)', s);
  await queue('valid'); await create({ ...j6, attempt: 2 }, fcBody()); s = await waitState(j6, ['succeeded', 'failed'], 20000); t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 after the crash succeeds', s);
  t(redis('ZCARD', 'sth:jobs:run:studio_flashcards') === '0', 'no slot left behind');
}

(async () => {
  try { if (PHASE === 'short') await short(); else await main(); }
  catch (e) { fail++; console.log('CRASH', e); }
  console.log(`\nE2E flashcards jobs (${PHASE}): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
