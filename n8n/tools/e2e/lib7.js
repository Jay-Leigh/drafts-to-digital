// Shared helpers of the v7 end-to-end suites (n8n 2.29.7 + mock on :5801 + real Redis on :6390).
const path = require('path');
const crypto = require('crypto');
const cp = require('child_process');
const NM = path.join(__dirname, '..', 'n8nrun', 'node_modules');
const flatted = require(path.join(NM, 'flatted'));
const sqlite3 = require(path.join(NM, 'sqlite3'));
const B = 'http://127.0.0.1:5799/webhook';
const M = 'http://127.0.0.1:5801';
const ORIGIN = 'https://jay-leigh.github.io';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const t = (c, name, extra) => { if (c) pass++; else { fail++; console.log('  FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 700) : ''); } };
const done = (label) => { console.log(`\n${label}: ${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); };
async function post(p, body, headers = {}) {
  const t0 = Date.now();
  const res = await fetch(B + '/' + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, text, json, headers: res.headers, ms: Date.now() - t0 };
}
const state = async () => (await fetch(M + '/_state')).json();
const reset = async () => { await fetch(M + '/_reset'); await fetch(M + '/_set?k=auth:code&v=letmein'); };
const setKey = (k, v) => fetch(`${M}/_set?k=${encodeURIComponent(k)}&v=${encodeURIComponent(v)}`);
const queue = (q, def = 'valid') => fetch(`${M}/_studio?q=${q}&def=${def}`);
const redis = (...a) => cp.execFileSync('redis-cli', ['-p', '6390', ...a]).toString().trim();
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const usageNow = () => Number(redis('GET', 'usage:' + today) || 0);
const gcalls = async () => (await state()).log.filter((l) => l.gemini);
const login = async (ip) => (await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, ' + ip })).json.token;
const rid = () => 'j_' + crypto.randomBytes(16).toString('base64url');
const rkey = () => crypto.randomBytes(32).toString('base64url');
const mkJob = (mode = 'tutor', attempt = 1, extra = {}) => ({ id: rid(), key: rkey(), mode, attempt, ...extra });
const sha = (k) => crypto.createHash('sha256').update(k).digest('hex');
const envl = (job) => ({ v: 1, op: 'create', id: job.id, key: job.key, attempt: job.attempt, mode: job.mode, ...(job.bulk ? { bulk: true } : {}) });
const hdr = (tok) => ({ authorization: 'Bearer ' + tok });
const create = (job, body, h) => post('sth-job-start', { ...body, job: envl(job) }, h);
const op = (name, jobs, h) => post('sth-job', { v: 1, op: name, jobs: jobs.map((j) => ({ id: j.id, key: j.key })) }, h);
const stOne = async (job, h) => (await op('status', [job], h)).json.jobs[0];
const DONE = ['succeeded', 'failed', 'cancelled', 'rejected', 'lost'];
async function waitState(job, h, want = DONE, ms = 90000) { const t0 = Date.now(); let s; while (Date.now() - t0 < ms) { s = await stOne(job, h); if (want.includes(s.state)) return s; await sleep(300); } return s; }
const hgetall = (k) => { const a = cp.execFileSync('redis-cli', ['-p', '6390', '--raw', 'HGETALL', k]).toString().split('\n'); a.pop(); const o = {}; for (let i = 0; i < a.length; i += 2) o[a[i]] = a[i + 1]; return o; };
const errOf = (s) => s && s.error && s.error.code;
function db() { return new sqlite3.Database(path.join(__dirname, '..', 'n8nrun/home/.n8n/database.sqlite'), sqlite3.OPEN_READONLY); }
function allRows(sql) { return new Promise((res, rej) => { const d = db(); d.all(sql, (e, rows) => { d.close(); e ? rej(e) : res(rows); }); }); }
async function execs() {
  const rows = await allRows('SELECT e.id, e.status, d.data FROM execution_entity e JOIN execution_data d ON d.executionId = e.id ORDER BY e.id');
  return rows.map((r) => { let run = {}; try { run = flatted.parse(r.data).resultData.runData; } catch (e) {} return { id: r.id, status: r.status, raw: r.data, run }; });
}
// request builders
const SENT = 'The war began in 1939 and ended in 1945. About 70 million people died in the war.';
const TEXT1 = '[Page 1]\n' + SENT + '\n\n[Page 2]\nThe economy grew by 3.5% in 1950.\n\n[Page 3]\nGDP was 1,500 billion rand.';
const SRC1 = [{ id: 'S1', name: 'Book.pdf', kind: 'pdf', markers: 'page', pages: 3, tokens: 30, text: TEXT1 }];
const base = (tool, mode, extra = {}) => ({ mode, v: 1, requestId: 'f_1761580000000_ab12cd', tool, language: { code: 'en', name: 'English' }, options: {}, description: 'Focus on Theme 1', sources: SRC1, clientEstimate: 30, promptVersion: 'studio-2026-12-a', ...extra });
const igBody = (extra = {}) => base('infographic', 'studio_infographic', extra);
const slBody = (extra = {}) => base('slides', 'studio_slides', extra);
const dgBody = (extra = {}) => base('digest', 'studio_digest', { part: { i: 1, n: 3 }, ...extra });
const mmBody = (extra = {}) => base('mindmap', 'studio_mindmap', { promptVersion: 'studio-2026-11-a', ...extra });
const tutorBody = (text, chat = 'chat-' + crypto.randomBytes(4).toString('hex')) => ({ mode: 'tutor', chatId: chat, messages: [{ role: 'user', text }], attachedContext: [], documentFingerprints: [] });
const j4Body = (mode, text = 'hello world') => ({ mode, documents: [{ type: 'text', name: 'a.txt', content: text, ...(mode === 'template' ? { role: 'instructions' } : mode === 'reviewer' ? { role: 'essay' } : {}) }] });
const dg = (n) => ({ schema: 'sth.digest/1', topics: [{ heading: 'The war ' + n, level: 1, points: [{ text: 'The war began in 1939 and ended in 1945', source: 'S1', page: 1 }, { text: 'GDP was 1,500 billion rand', source: 'S1', page: 3 }] }], figures: [{ value: '1945', label: 'End of the war', quote: 'began in 1939 and ended in 1945', source: 'S1', page: 1 }] });
const redBody = (tool, mode, extra = {}) => base(tool, mode, { strategy: 'reduce', sources: [{ id: 'S1', name: 'Book.pdf', kind: 'pdf', markers: 'page' }], digests: [dg(1), dg(2), dg(3)], ...extra });
module.exports = { path, crypto, cp, B, M, ORIGIN, sleep, t, done, post, state, reset, setKey, queue, redis, today, usageNow, gcalls, login, rid, rkey, mkJob, sha, envl, hdr, create, op, stOne, DONE, waitState, hgetall, errOf, execs, SENT, TEXT1, SRC1, base, igBody, slBody, dgBody, mmBody, tutorBody, j4Body, dg, redBody, get pass() { return pass; }, get fail() { return fail; } };
