// End-to-end checks of the background jobs (v4) against a real n8n 2.29.7 running the imported v4 test copy
// (external HTTP -> mock; real Redis 7 on :6390, so the Lua scripts run for real).
//   node e2e/run-jobs.js main    after: STUDIO_TEST_TIMEOUT_MS=6000 JOB_TEST_TUTOR_TIMEOUT_MS=4000 e2e/reload.sh v4-jobs
//   node e2e/run-jobs.js short   after: JOB_TEST_DEADLINES=tutor=8,studio_mindmap=10 JOB_TEST_GRACE=2 JOB_TEST_TUTOR_TIMEOUT_MS=30000 STUDIO_TEST_TIMEOUT_MS=30000 e2e/reload.sh v4-jobs
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
const V7_MODES = 'tutor,studio_mindmap,studio_flashcards,studio_quiz,studio_infographic,studio_slides,studio_digest,transcribe,template,reviewer';
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

async function main() {
  await reset();
  const tok = await login('31.1.1.1'); H = { authorization: 'Bearer ' + tok };

  console.log('[auth, CORS, hello, bad requests]');
  let c0 = await logCmds();
  for (const p of ['sth-job', 'sth-job-start']) {
    let r = await post(p, { v: 1, op: 'status', jobs: [] }); t(r.status === 401, `${p}: no token -> 401`, r.status);
    r = await post(p, {}, { authorization: 'Bearer garbage' }); t(r.status === 403, `${p}: garbage token -> 403`, r.status);
    r = await post(p, {}, { authorization: 'Bearer ' + jwt.sign({ sub: 'sth' }, 'other-secret-xxxxxxxxxxxxxxxxxxxx') }); t(r.status === 403, `${p}: wrong secret -> 403`, r.status);
    r = await post(p, {}, { authorization: 'Bearer ' + jwt.sign({ sub: 'sth', exp: Math.floor(Date.now() / 1000) - 60 }, SECRET) }); t(r.status === 403, `${p}: expired token -> 403`, r.status);
    const pre = await fetch(B + '/' + p, { method: 'OPTIONS', headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' } });
    t(pre.status === 204 && pre.headers.get('access-control-allow-origin') === ORIGIN, `${p}: preflight allows the Pages origin`, [pre.status]);
  }
  t((await logCmds()) === c0 && (await gcalls()).length === 0, 'unauthenticated calls: 0 Redis commands, 0 Gemini calls');
  let r = await post('sth-job', { v: 1, op: 'status', jobs: [] }, H);
  t(r.status === 200 && r.json.ok === true && r.json.jobsEnabled === true && r.json.modes.join() === (process.env.WF_V7 ? V7_MODES : process.env.WF_V6 ? 'tutor,studio_mindmap,studio_flashcards,studio_quiz' : process.env.WF_V5 ? 'tutor,studio_mindmap,studio_flashcards' : 'tutor,studio_mindmap') && Math.abs(r.json.now - Date.now()) < 5000 && r.headers.get('access-control-allow-origin') === ORIGIN, 'hello: jobsEnabled, modes, now, CORS', r.text);
  t((await logCmds()) === c0, 'hello costs 0 Redis commands');
  for (const [name, body] of [['v 2', { v: 2, op: 'status', jobs: [] }], ['unknown op', { v: 1, op: 'purge', jobs: [] }], ['11 jobs', { v: 1, op: 'status', jobs: Array.from({ length: 11 }, () => ({ id: rid(), key: rkey() })) }], ['bad id', { v: 1, op: 'status', jobs: [{ id: 'x', key: rkey() }] }], ['not json object', null]]) {
    r = await post('sth-job', body, H, body === null ? '[1,2' : undefined); t(r.status === 200 ? r.json.ok === false && r.json.error.code === 'STH-INPUT-400' : r.status >= 400 && r.status < 500, `bad request (${name}) -> STH-INPUT-400, no crash`, [r.status, r.text.slice(0, 100)]);
  }
  t((await logCmds()) === c0, 'bad requests cost 0 Redis commands');

  console.log('[tutor job: create, poll, result, ack; result equals the sync answer]');
  const jt = mkJob(); const chatA = 'chat-A';
  const t0 = Date.now(); r = await create(jt, tutorBody('hello there', chatA));
  t(r.status === 200 && r.text === '{"ok":true,"accepted":true}' && /application\/json/.test(r.headers.get('content-type')) && r.ms < 3000, 'create answers {"ok":true,"accepted":true} at once (JSON, 200)', [r.status, r.text, r.ms]);
  let s = await waitState(jt, DONE);
  t(s.state === 'succeeded' && s.attempt === 1 && s.error === null && s.resultBytes > 20, 'job succeeded (attempt 1)', s);
  const calls1 = (await gcalls()).length;
  const syncR = await post('student-tools-v2', tutorBody('hello there', 'chat-A-sync'), H);
  r = await op('result', [jt]);
  t(r.json.ok === true && r.json.id === jt.id && r.json.mode === 'tutor' && JSON.stringify(r.json.result) === JSON.stringify(syncR.json) && syncR.json.result === 'MOCK GEMINI REPLY', 'result == exactly what the sync path returns', { job: r.json, sync: syncR.json });
  t(s.resultBytes === Buffer.byteLength(JSON.stringify(syncR.json)), 'resultBytes = size of the stored answer');
  let rec = hgetall('sth:job:' + jt.id);
  t(rec.kh === sha(jt.key) && rec.st === 'succeeded' && rec.m === 'tutor' && !JSON.stringify(rec).includes(jt.key), 'record holds the key hash, never the key', rec);
  const sess = JSON.parse(redis('GET', 'session:' + chatA));
  t(sess.conversation.length === 2 && sess.conversation.every((m) => m.jobId === jt.id), 'session pair is tagged with the jobId', sess.conversation);
  t(Number(redis('TTL', 'sth:job:' + jt.id)) > 259000 && Number(redis('TTL', 'sth:jobr:' + jt.id)) > 259000, 'record and result live 72 h');
  r = await create(jt, tutorBody('hello there', chatA)); await sleep(1500);
  t((await gcalls()).length === calls1 + 1 && (await stOne(jt)).state === 'succeeded', 'idempotent re-create of a finished job: no new execution (only the sync call above ran)');
  r = await op('ack', [jt]); t(r.json.ok === true && r.json.acked.join() === jt.id, 'ack -> acked', r.json);
  t(process.env.WF_V8 ? redis('HGET', 'sth:job:' + jt.id, 'st') === 'collected' && redis('EXISTS', 'sth:jobr:' + jt.id) === '0' : redis('EXISTS', 'sth:job:' + jt.id) === '0' && redis('EXISTS', 'sth:jobr:' + jt.id) === '0', process.env.WF_V8 ? 'ack left a contentless collected note and deleted the result (v8)' : 'ack deleted the record and the result');
  t((await stOne(jt)).state === (process.env.WF_V8 ? 'collected' : 'unknown'), process.env.WF_V8 ? 'after ack: collected (v8)' : 'after ack: unknown');
  r = await op('result', [jt]); t(r.json.ok === false && r.json.error.code === 'STH-JOB-404', 'after ack: result -> STH-JOB-404');
  r = await op('ack', [jt]); t(r.json.ok === true && r.json.acked.join() === jt.id, 'second ack is harmless');

  console.log('[keys, batches, expiry, duplicates]');
  const jw = mkJob(); await create(jw, tutorBody('wrong key test')); await waitState(jw, DONE);
  const bad = { ...jw, key: rkey() };
  t((await stOne(bad)).state === 'unknown', 'wrong key: status unknown');
  r = await op('result', [bad]); t(r.json.error && r.json.error.code === 'STH-JOB-404', 'wrong key: result 404');
  r = await op('cancel', [bad]); t(r.json.state === 'unknown' && (await stOne(jw)).state === 'succeeded', 'wrong key: cancel unknown, job untouched');
  r = await op('ack', [bad]); t(redis('EXISTS', 'sth:job:' + jw.id) === '1', 'wrong key: ack deletes nothing');
  let n0 = (await gcalls()).length; r = await create(bad, tutorBody('hijack')); await sleep(1200);
  t((await gcalls()).length === n0 && hgetall('sth:job:' + jw.id).kh === sha(jw.key), 'create with a known id and another key: no execution, record untouched');
  const batch = [jw, ...Array.from({ length: 8 }, () => mkJob()), bad];
  s = (await st(batch)).jobs; t(s.length === 10 && s[0].id === jw.id && s[0].state === 'succeeded' && s.slice(1).every((x) => x.state === 'unknown'), 'batch of 10: one entry per job in order', s.map((x) => x.state));
  redis('EXPIRE', 'sth:job:' + jw.id, '1'); await sleep(1500);
  t((await stOne(jw)).state === 'unknown', 'expired record: unknown'); r = await op('result', [jw]); t(r.json.error.code === 'STH-JOB-404', 'expired record: result 404');
  const je = mkJob(); await create(je, tutorBody('expired result')); await waitState(je, ['succeeded']); redis('DEL', 'sth:jobr:' + je.id);
  r = await op('result', [je]); t(r.json.ok === false && r.json.error.code === 'STH-JOB-404' && (await stOne(je)).state === 'succeeded', 'result expired but record kept: status succeeded, result 404 (client shows "expired")');
  // running job: duplicate create, ack refused
  const jr = mkJob(); n0 = (await gcalls()).length; await create(jr, tutorBody('[[mock:hang3000]] dup test')); await sleep(800);
  await create(jr, tutorBody('[[mock:hang3000]] dup test')); await sleep(500);
  t((await stOne(jr)).state === 'running', 'running while Gemini answers late');
  r = await op('ack', [jr]); t(r.json.acked.length === 0 && redis('EXISTS', 'sth:job:' + jr.id) === '1', 'ack of a running job is refused');
  await waitState(jr, DONE); t((await gcalls()).length - n0 === 1, 'create sent twice for a running job: ONE execution / one Gemini call');
  t((await stOne(jr)).state === 'succeeded', 'it still succeeded (3 s < the 4 s test timeout)');
  await op('ack', [jw, je, jr]);

  console.log('[mind map job]');
  await queue('valid');
  const jm = mkJob('studio_mindmap'); r = await create(jm, mmBody());
  s = await waitState(jm, DONE); t(s.state === 'succeeded' && s.resultBytes > 500, 'mind map job succeeded', s);
  const syncM = await post('student-tools-v2', mmBody(), H); r = await op('result', [jm]);
  const strip = (j) => { const c = JSON.parse(JSON.stringify(j)); delete c.artifact.generatedAt; return JSON.stringify(c); };
  t(r.json.ok === true && r.json.mode === 'studio_mindmap' && strip(r.json.result) === strip(syncM.json) && r.json.result.ok === true, 'stored mind map == the sync artifact (except generatedAt)', r.text.slice(0, 200));
  await op('ack', [jm]);
  // multipart with a scanned PDF (binary reaches the chain from the start webhook)
  const hash = 'h'.repeat(64); await setKey('gemini-file:' + hash, JSON.stringify({ uri: 'https://files.test/abc', mimeType: 'application/pdf', expiresAt: Date.now() + 3600000 }));
  const jp = mkJob(); const fd = new FormData();
  fd.append('payload', JSON.stringify(tutorBody('about the pdf', 'chat-pdf', { scannedPdfDocs: [{ fieldName: 'pdf0', name: 'a.pdf', contentHash: hash }] })));
  fd.append('job', JSON.stringify(envl(jp))); fd.append('pdf0', new Blob(['%PDF-1.4 fake pdf bytes'], { type: 'application/pdf' }), 'a.pdf');
  r = await post('sth-job-start', null, H, fd); t(r.status === 200 && r.json && r.json.accepted === true, 'multipart create accepted', r.text);
  s = await waitState(jp, DONE); t(s.state === 'succeeded', 'multipart tutor job with a scanned PDF succeeded', s);
  const gb = (await gcalls()).at(-1).body; t(JSON.stringify(gb).includes('https://files.test/abc'), 'the cached Gemini file reached the request');
  { const ex = (await execs()).find((e) => e.run['Extract Scanned PDF Bytes'] && JSON.stringify(e.run['Extract Scanned PDF Bytes']).includes(Buffer.from('%PDF-1.4 fake pdf bytes').toString('base64')));
    t(!!ex, 'binary of the multipart job reached "Extract Scanned PDF Bytes" (base64 of the file)'); }
  await op('ack', [jp]);

  console.log('[failure paths: every one stores a failed state]');
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.2.2')) };
  const fails = []; // [name, job, body, wantCode, retryable, extra]
  const F = (name, body, want, retryable, mode = 'tutor', extra = {}) => fails.push({ name, job: mkJob(mode), body, want, retryable, ...extra });
  F('Gemini 500 (retried 4x, then thrown)', tutorBody('[[mock:500]] x'), 'STH-AI-500', true);
  F('Gemini 429 (retried, then [Busy])', tutorBody('[[mock:429]] x'), 'STH-AI-429', true);
  F('Gemini timeout (node timeout 4 s, thrown)', tutorBody('[[mock:hang9000]] x'), 'STH-AI-504', true);
  F('Gemini 400 (thrown)', tutorBody('[[mock:400]] x'), 'STH-SRV-500', true);
  F('safety block', tutorBody('[[mock:safety]] x'), 'STH-AI-451', false);
  F('recitation block', tutorBody('[[mock:recite]] x'), 'STH-AI-452', false);
  F('oversized result (600 KB)', tutorBody('[[mock:big]] x'), 'STH-JOB-413', false);
  F('mode mismatch (job tutor, body mind map)', mmBody(), 'STH-INPUT-400', false, 'tutor');
  F('thrown Code error (no messages array)', { mode: 'tutor', chatId: 'c-throw' }, 'STH-SRV-500', true);
  F('Studio reject: 11 sources', mmBody({ sources: Array.from({ length: SRC_OVER }, (_, i) => txt('S' + (i + 1), 100)) }), 'STH-STU-413', false, 'studio_mindmap', { reason: 'too_many_sources' });
  F('Studio reject: bad version', mmBody({ v: 2 }), 'STH-INPUT-400', false, 'studio_mindmap');
  const ids = fails.map((f) => f.job.id);
  // fire the slow ones in parallel (tutor cap 3: start in two waves)
  const wave = async (list) => { for (const f of list) await create(f.job, f.body); return Promise.all(list.map(async (f) => { f.s = await waitState(f.job, DONE, 120000); })); };
  await wave(fails.slice(0, 3)); await wave(fails.slice(3, 6)); await wave(fails.slice(6, 9));
  await queue('valid'); await wave(fails.slice(9, 10)); await queue('valid'); await wave(fails.slice(10));
  for (const f of fails) {
    t(f.s.state === 'failed' && errOf(f.s) === f.want && f.s.error.retryable === f.retryable && f.s.resultBytes === 0, `${f.name} -> failed ${f.want} (retryable ${f.retryable})`, f.s);
    if (f.reason) t(f.s.error.reason === f.reason, `${f.name}: reason ${f.reason}`, f.s.error);
    const rr = await op('result', [f.job]); t(rr.json.ok === false && rr.json.error.code === 'STH-JOB-404', `${f.name}: no result stored`);
    t(redis('EXISTS', 'sth:jobr:' + f.job.id) === '0', `${f.name}: no result key`);
  }
  { const rec2 = hgetall('sth:job:' + fails[0].job.id); t(rec2.st === 'failed' && /^\{"code":"STH-AI-500"\}$/.test(rec2.e) && rec2.rb === '0', 'stored error is just the code', rec2); }
  t(redis('ZCARD', 'sth:jobs:run:tutor') === '0' && redis('ZCARD', 'sth:jobs:run:studio_mindmap') === '0', 'all run slots are free again');
  // Studio failures
  const sf = async (name, q, want, retryable, reason) => { await queue(q); const j = mkJob('studio_mindmap'); await create(j, mmBody()); const x = await waitState(j, DONE, 120000); t(x.state === 'failed' && errOf(x) === want && x.error.retryable === retryable && (!reason || x.error.reason === reason), `Studio ${name} -> ${want}${reason ? ' (' + reason + ')' : ''}`, x); return j; };
  await sf('truncated output', 'truncated', 'STH-STU-422', true, 'truncated');
  await sf('safety', 'safety', 'STH-AI-451', false);
  await sf('500 x3', '500,500,500', 'STH-STU-409', true);
  await sf('Gemini timeout x3 (6 s test timeout)', 'hang:20000,hang:20000,hang:20000', 'STH-STU-409', true);
  await sleep(12000);
  // quota ceiling
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.3.3')) }; await setKey('cfg:daily_units', '1'); await setKey('usage:' + today, '5');
  const jq = mkJob(); n0 = (await gcalls()).length; await create(jq, tutorBody('quota')); s = await waitState(jq, DONE);
  t(s.state === 'failed' && errOf(s) === 'STH-QUOTA-430' && s.error.retryable === false && (await gcalls()).length === n0, 'quota ceiling -> failed STH-QUOTA-430, no Gemini call', s);
  const jq2 = mkJob('studio_mindmap'); await create(jq2, mmBody()); s = await waitState(jq2, DONE); t(errOf(s) === 'STH-QUOTA-430', 'mind map: quota ceiling too', s);
  redis('DEL', 'cfg:daily_units');
  // failed -> attempt 2 -> success; attempt rules
  const jf = mkJob(); await create(jf, tutorBody('[[mock:safety]] first')); s = await waitState(jf, DONE);
  t(s.state === 'failed', 'attempt 1 failed (safety)');
  await create({ ...jf, attempt: 3 }, tutorBody('skip ahead')); await sleep(1000); t((await stOne(jf)).state === 'failed' && (await stOne(jf)).attempt === 1, 'attempt 3 right after attempt 1 is ignored');
  await create({ ...jf, attempt: 2 }, tutorBody('second try')); s = await waitState(jf, ['succeeded']); t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 after a failure is admitted and succeeds', s);
  await create({ ...jf, attempt: 4 }, tutorBody('too many')); await sleep(800); t((await stOne(jf)).attempt === 2, 'attempt 4 is refused');

  console.log('[caps, kill switch, cancel race]');
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.4.4')) };
  const hang = () => tutorBody('[[mock:hang3000]] cap');
  const caps = [mkJob(), mkJob(), mkJob()]; for (const j of caps) await create(j, hang());
  const j4 = mkJob(); await create(j4, hang()); s = await waitState(j4, DONE, 5000);
  t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429' && s.error.retryable === true && s.error.retryAfterMs === 20000, 'tutor 4th while 3 run: rejected STH-JOB-429, retry after 20 s', s);
  const jm1 = mkJob('studio_mindmap'); await queue('slow:3000'); await create(jm1, mmBody()); await sleep(600);
  t((await stOne(jm1)).state === 'running', 'mind map 1 admitted next to 3 tutors (total 4)');
  const jm2 = mkJob('studio_mindmap'); await create(jm2, mmBody()); s = await waitState(jm2, DONE, 5000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'mind map 2nd: rejected (cap 1)', s);
  const j5 = mkJob(); await create(j5, hang()); s = await waitState(j5, DONE, 5000); t(s.state === 'rejected', 'a tutor while 3 tutors + 1 mind map run: rejected');
  for (const j of caps) t((await waitState(j, DONE)).state === 'succeeded', 'running capped job finishes');
  await waitState(jm1, DONE);
  await create(j4, hang()); s = await waitState(j4, DONE); t(s.state === 'succeeded', 'the rejected job, re-sent with the same attempt, is admitted once room exists and succeeds', s);
  await op('ack', [...caps, j4, jm1, j5, jm2]);
  // total override
  await setKey('cfg:jobs_max_running', '2'); const o = [mkJob(), mkJob(), mkJob()]; for (const j of o) await create(j, hang());
  s = await waitState(o[2], DONE, 5000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'cfg:jobs_max_running 2: third tutor refused (total cap)', s);
  for (const j of o.slice(0, 2)) await waitState(j, DONE);
  // kill switch
  await setKey('cfg:jobs_max_running', '0'); n0 = (await gcalls()).length;
  const ks = mkJob(); await create(ks, tutorBody('kill switch')); s = await waitState(ks, DONE, 5000);
  t(s.state === 'rejected' && errOf(s) === 'STH-JOB-503' && s.error.retryable === false && (await gcalls()).length === n0, 'cfg:jobs_max_running 0: rejected STH-JOB-503 at once, no Gemini call', s);
  t(Number(redis('TTL', 'sth:job:' + ks.id)) <= 3600 && Number(redis('TTL', 'sth:job:' + ks.id)) > 0, 'rejected record lives 1 h');
  r = await post('sth-job', { v: 1, op: 'status', jobs: [] }, H); t(r.json.ok === true, 'hello still answers with the switch on');
  redis('DEL', 'cfg:jobs_max_running'); await create(ks, tutorBody('kill switch')); s = await waitState(ks, ['succeeded', 'failed'], 15000); t(s.state === 'succeeded', 'switch removed: the same job (same attempt) is admitted', s);
  const inflight = mkJob(); await create(inflight, hang()); await sleep(700); await setKey('cfg:jobs_max_running', '0');
  t((await waitState(inflight, DONE)).state === 'succeeded', 'a job running when the switch flips finishes and can be collected'); redis('DEL', 'cfg:jobs_max_running');
  const NOT_JOB = process.env.WF_V7 ? 'reference' : 'transcribe'; // v7 runs transcribe as a job
  const nm = mkJob(NOT_JOB); await create(nm, { mode: NOT_JOB, documents: [] }); s = await waitState(nm, DONE, 5000);
  t(s.state === 'rejected' && errOf(s) === 'STH-JOB-503', `a mode that is not allowed (${NOT_JOB}): rejected STH-JOB-503`);
  // cancel races
  const cj = mkJob(); await create(cj, hang()); await sleep(700);
  r = await op('cancel', [cj]); t(r.json.ok === true && r.json.state === 'cancelled', 'cancel a running job', r.json);
  await sleep(4500); s = await stOne(cj); t(s.state === 'cancelled' && redis('EXISTS', 'sth:jobr:' + cj.id) === '0', 'late success after cancel is discarded: still cancelled, no result stored', s);
  t(redis('ZCARD', 'sth:jobs:run:tutor') === '0', '...and the run slot was freed by the late store');
  r = await op('cancel', [cj]); t(r.json.state === 'cancelled', 'cancel twice is harmless');
  const cs = mkJob(); await create(cs, tutorBody('quick')); await waitState(cs, ['succeeded']);
  r = await op('cancel', [cs]); t(r.json.state === 'succeeded', 'cancel after success answers succeeded'); r = await op('result', [cs]); t(r.json.ok === true, '...and the result is still there');
  r = await op('ack', [cj, cs]); t(r.json.acked.length === 2, 'ack of cancelled and finished jobs');

  console.log('[Redis down: fail closed at admission, status reports SRV-503]');
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.5.5')) };
  const dj = mkJob(); n0 = (await gcalls()).length; await fetch(M + '/_down?on=1'); await create(dj, tutorBody('redis down')); await sleep(2500);
  r = await op('status', [dj]); await fetch(M + '/_down?on=0');
  t((await gcalls()).length === n0, 'Redis down at admission: the chain did not run (no Gemini spend)');
  t(r.json && r.json.ok === false && r.json.error.code === 'STH-SRV-503', 'status while Redis is down -> STH-SRV-503 (not "unknown")', r.text);
  t((await stOne(dj)).state === 'unknown' && redis('EXISTS', 'sth:job:' + dj.id) === '0', 'afterwards: unknown, nothing stored');
  await create(dj, tutorBody('redis back')); t((await waitState(dj, DONE)).state === 'succeeded', 'the client re-sends the same create and it works');

  console.log('[no request text in stored errors, Redis, e-mails]');
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.6.6')) };
  const e0 = (await execs()).length;
  const leak = [mkJob(), mkJob()];
  await create(leak[0], tutorBody(`[[mock:hang9000]] ${MARK}`, 'c-leak1', { attachedContext: [{ name: MARK + '.txt', content: MARK }] }));
  await create(leak[1], tutorBody(`[[mock:500]] ${MARK}`));
  const lmm = mkJob('tutor'); await create(lmm, mmBody({ description: MARK })); await waitState(lmm, DONE);
  const lbad = mkJob(); const fd2 = new FormData(); fd2.append('payload', '{"mode":"tutor","messages":[{"text":"' + MARK + '"'); fd2.append('job', JSON.stringify(envl(lbad)));
  await post('sth-job-start', null, H, fd2);
  for (const j of [leak[0], leak[1], lmm, lbad]) await waitState(j, DONE, 120000);
  await sleep(3000);
  const all = redis('--scan', '--pattern', '*').split('\n').filter(Boolean); let dump = '';
  for (const k of all) { const ty = redis('TYPE', k); dump += k + '=' + (ty === 'string' ? redis('GET', k) : ty === 'hash' ? JSON.stringify(hgetall(k)) : redis('ZRANGE', k, '0', '-1')) + '\n'; }
  t(!dump.includes('ZZSECRET'), 'no Redis key or value contains request text', dump.slice(0, 300));
  t((await stOne(lbad)).state === 'failed' && errOf(await stOne(lbad)) === 'STH-INPUT-400', 'malformed multipart payload -> failed STH-INPUT-400');
  const ex = (await execs()).slice(e0);
  const mails = ex.filter((e) => e.run['Format Workflow Error1']);
  t(mails.length >= 3, 'job failures produce workflow-error mails like sync ones', mails.length);
  t(!mails.some((e) => JSON.stringify(e.run['Format Workflow Error1']).includes('ZZSECRET') || JSON.stringify(e.run['Send Workflow Error Email1'] || '').includes('ZZSECRET')), 'no error mail contains request text');
  t(!ex.some((e) => ['Job - Error Outcome', 'Job - Classify Outcome', 'Job - Store Outcome', 'Job - Error Lookup'].some((n) => e.run[n] && JSON.stringify(e.run[n]).includes('ZZSECRET'))), 'job error / store nodes hold no request text');
  t(!JSON.stringify((await state()).log.filter((l) => l.cmd)).includes('ZZSECRET'), 'no Redis command carried request text');

  console.log('[every sth: key has a TTL; Upstash command counts]');
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.7.7')) };
  const tj = mkJob(); await create(tj, tutorBody('ttl check')); await waitState(tj, ['succeeded']);
  const cj2 = mkJob(); await create(cj2, tutorBody('[[mock:safety]] ttl')); await waitState(cj2, DONE);
  const ks2 = mkJob(); await setKey('cfg:jobs_max_running', '0'); await create(ks2, tutorBody('x')); await waitState(ks2, DONE); redis('DEL', 'cfg:jobs_max_running');
  for (const k of redis('--scan', '--pattern', 'sth:*').split('\n').filter(Boolean)) t(Number(redis('TTL', k)) > 0, `TTL set on ${k.replace(/j_[A-Za-z0-9_-]{22}/, 'j_<id>').replace(/:\d+$/, ':<n>')}`);
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.8.8')) };
  for (const [mode, body, label] of [['tutor', tutorBody('count me'), 'tutor'], ['studio_mindmap', mmBody(), 'mind map']]) {
    await queue('valid'); const cj3 = mkJob(mode); await sleep(1500); const before = cmdCount();
    await create(cj3, body); await sleep(2500); let polls = 0; s = null;
    while (!s || s.state === 'running') { s = await stOne(cj3); polls++; if (s.state === 'running') await sleep(1500); }
    await op('result', [cj3]); await op('ack', [cj3]); const used = cmdCount() - before;
    t(used <= 37 + (process.env.WF_V7 ? 12 : 0) + Math.max(0, polls - 4) + 3, `${label} job: ${used} Redis commands incl. ${polls} poll(s) (budget ~37 with 4 polls)`, used);
    console.log(`   ${label}: ${used} commands, ${polls} polls`);
  }

  console.log('[parallel load: 3 tutor jobs + 1 mind map + 1 sync tutor + 1 sync OCR]');
  await reset(); H = { authorization: 'Bearer ' + (await login('31.1.9.9')) }; await queue('slow:2500');
  await setKey('ocr:' + 'a'.repeat(64) + ':1-1', JSON.stringify({ pages: [{ page: 1, text: 'cached text' }] }));
  const lj = [mkJob(), mkJob(), mkJob(), mkJob('studio_mindmap')];
  for (const j of lj) await create(j, j.mode === 'tutor' ? tutorBody('[[mock:hang2500]] load') : mmBody());
  const [sy, so] = await Promise.all([post('student-tools-v2', tutorBody('sync during jobs'), H), post('student-tools-v2', { mode: 'ocr', contentHash: 'a'.repeat(64), startPage: 1, endPage: 1 }, H)]);
  t(sy.json && sy.json.result === 'MOCK GEMINI REPLY' && so.json && so.json.cached === true, 'sync tutor and sync OCR answer normally while 4 jobs run', [sy.text.slice(0, 80), so.text.slice(0, 80)]);
  for (const j of lj) t((await waitState(j, DONE)).state === 'succeeded', 'parallel job ' + j.mode + ' succeeded');
}

async function short() {
  await reset(); H = { authorization: 'Bearer ' + (await login('32.1.1.1')) };
  console.log('[short deadlines: tutor 8 s, mind map 10 s, grace 2 s]');
  // 1. stalled run -> lost (derived) -> attempt 2 -> late success of attempt 1 loses to the finished attempt 2
  const j1 = mkJob(); const chat = 'chat-lost';
  await create(j1, tutorBody('[[mock:hang15000]] stall', chat)); await sleep(1500);
  t((await stOne(j1)).state === 'running', 'stalled job is running');
  let s = await waitState(j1, ['lost'], 20000);
  t(s.state === 'lost' && errOf(s) === 'STH-JOB-504' && s.error.retryable === true && s.error.retryAfterMs === 0, 'a stalled run is reported lost (STH-JOB-504) after deadline + grace', s);
  t(hgetall('sth:job:' + j1.id).st === 'running', 'lost is derived: the stored state is still running');
  await create({ ...j1, attempt: 2 }, tutorBody('retry quickly', chat)); s = await waitState(j1, ['succeeded'], 20000);
  t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 admitted over the lost attempt and succeeded', s);
  const res2 = await op('result', [j1]); t(res2.json.ok === true && res2.json.result.result === 'MOCK GEMINI REPLY', 'result available');
  await sleep(7000); // attempt 1's late answer arrives (15 s)
  s = await stOne(j1); t(s.state === 'succeeded' && s.attempt === 2 && hgetall('sth:job:' + j1.id).fa === '2', 'attempt 1 finishing late does not overwrite the finished attempt 2', hgetall('sth:job:' + j1.id));
  const sess = JSON.parse(redis('GET', 'session:' + chat)); t(sess.conversation.filter((m) => m.jobId === j1.id).length === 2, 'the session holds ONE pair for the job (no duplicate after the re-run)', sess.conversation.map((m) => [m.role, m.jobId && 'tag']));
  t(redis('ZCARD', 'sth:jobs:run:tutor') === '0', 'no slot left behind');
  // 2. late success after the watchdog failure wins
  const j2 = mkJob(); await create(j2, tutorBody('[[mock:hang14000]] late')); s = await waitState(j2, ['lost'], 20000); t(s.state === 'lost', 'lost first');
  s = await waitState(j2, ['succeeded'], 20000); t(s.state === 'succeeded' && s.attempt === 1, 'the late success of the original run wins over the lost state', s);
  r = await op('result', [j2]); t(r.json.ok === true, 'its result can be fetched');
  // 3. attempt 2 running while attempt 1 succeeds late: the first success wins, attempt 2's is discarded
  const j3 = mkJob(); const chat3 = 'chat-race';
  await create(j3, tutorBody('[[mock:hang13000]] race', chat3)); await waitState(j3, ['lost'], 20000);
  await create({ ...j3, attempt: 2 }, tutorBody('[[mock:hang9000]] race', chat3)); await sleep(500);
  t((await stOne(j3)).state === 'running' && (await stOne(j3)).attempt === 2, 'attempt 2 is running');
  s = await waitState(j3, ['succeeded'], 20000); t(s.state === 'succeeded', 'attempt 1 (stale) success accepted while attempt 2 runs', s);
  await sleep(11000); t(hgetall('sth:job:' + j3.id).fa === '1' && (await stOne(j3)).state === 'succeeded', 'attempt 2 finishing later changes nothing (first success wins)', hgetall('sth:job:' + j3.id));
  const sess3 = JSON.parse(redis('GET', 'session:' + chat3)); t(sess3.conversation.filter((m) => m.jobId === j3.id).length === 2, 'still one session pair for the job');
  // 4. mind map stalled -> lost -> late success wins
  await queue('hang:14000'); const jm = mkJob('studio_mindmap'); await create(jm, mmBody()); s = await waitState(jm, ['lost'], 25000);
  t(s.state === 'lost', 'stalled mind map run is lost after 10 s + 2 s', s); s = await waitState(jm, ['succeeded'], 20000); t(s.state === 'succeeded', 'its late success wins', s);
  await queue('valid');
  // 5. store unreachable (Redis down while the run finishes): stays running -> lost -> resubmit works
  await reset(); H = { authorization: 'Bearer ' + (await login('32.1.2.2')) };
  const j5 = mkJob(); await create(j5, tutorBody('[[mock:hang3000]] store down')); await sleep(1500);
  await fetch(M + '/_down?on=1'); await sleep(9000); await fetch(M + '/_down?on=0');
  s = await stOne(j5); t(s.state === 'running' || s.state === 'lost', 'Redis down while the run finished: nothing was stored', s);
  s = await waitState(j5, ['lost', 'succeeded', 'failed'], 15000); t(s.state === 'lost', 'it becomes lost (the client then re-sends)', s);
  await create({ ...j5, attempt: 2 }, tutorBody('after the outage')); s = await waitState(j5, ['succeeded', 'failed'], 20000); t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 succeeds after the outage', s);
  // 6. n8n killed mid-run (all in-flight runs lost): lost -> attempt 2
  await reset(); H = { authorization: 'Bearer ' + (await login('32.1.3.3')) };
  const j6 = mkJob(); await create(j6, tutorBody('[[mock:hang15000]] crash')); await sleep(1500);
  t((await stOne(j6)).state === 'running', 'running before the crash');
  execSync(path.join(__dirname, 'restart.sh'), { stdio: 'inherit' });
  { let tk = null; for (let i = 0; i < 10 && !tk; i++) { try { tk = await login('32.1.4.4'); } catch (e) { await sleep(1500); } } H = { authorization: 'Bearer ' + tk }; }
  // n8n marks the interrupted run as crashed at start-up and runs the error workflow for it (finding on 2.29.7): the job is then
  // stored failed STH-SRV-500 (retryable) at once; if that did not happen the watchdog reports it lost after deadline + grace.
  s = await stOne(j6); t(['running', 'lost', 'failed'].includes(s.state), 'after the restart the record is still there', s);
  s = await waitState(j6, ['lost', 'failed'], 20000);
  t((s.state === 'lost' && errOf(s) === 'STH-JOB-504') || (s.state === 'failed' && errOf(s) === 'STH-SRV-500' && s.error.retryable === true), 'a run killed with n8n ends retryable: failed STH-SRV-500 (crash recovery) or lost STH-JOB-504 (watchdog)', s);
  await create({ ...j6, attempt: 2 }, tutorBody('after the crash')); s = await waitState(j6, ['succeeded', 'failed'], 20000); t(s.state === 'succeeded' && s.attempt === 2, 'attempt 2 after the crash succeeds', s);
  t(redis('ZCARD', 'sth:jobs:run:tutor') === '0', 'no slot left behind');
  // 7. fast failures: retry loop is capped by the job deadline
  const j7 = mkJob(); const tt = Date.now(); await create(j7, tutorBody('[[mock:500]] capped')); s = await waitState(j7, DONE, 20000);
  t(s.state === 'failed' && errOf(s) === 'STH-AI-500' && Date.now() - tt < 8000, 'Gemini 500 near the job deadline: no retry loop, failed STH-AI-500 within seconds', [s, Date.now() - tt]);
}

(async () => {
  try { if (PHASE === 'short') await short(); else await main(); }
  catch (e) { fail++; console.log('CRASH', e); }
  console.log(`\nE2E jobs (${PHASE}): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
