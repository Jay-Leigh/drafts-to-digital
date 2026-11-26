'use strict';
// An in-process stand-in for the n8n backend (auth, the v2 webhook, the job endpoints). Every request is recorded in `log`.
// No real credentials: tokens are signed with a fixed fake secret.
const crypto = require('crypto');
const path = require('path');
const fx = require('./fixtures');
// The server's own renewal rules: the real library of the "Renew Evaluate" / "Auth Build Claims" nodes (n8n/tools/src/auth.lib.js), so the fake and the
// workflow cannot drift apart.
const A = require(path.join(__dirname, '..', '..', 'n8n', 'tools', 'src', 'auth.lib.js'));

const HOST = 'n8n-67295956827.africa-south1.run.app';
const SECRET = 'fake-test-secret-not-a-real-key';
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-max-age': '600' };
const MODES_V7 = ['tutor', 'studio_mindmap', 'studio_flashcards', 'studio_quiz', 'studio_infographic', 'studio_slides', 'studio_digest', 'transcribe', 'template', 'reviewer'];
const MODES_V6 = ['tutor', 'studio_mindmap', 'studio_flashcards', 'studio_quiz'];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

function parseMultipart(buf, boundary) {
  const parts = [];
  const sep = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(sep);
  while (pos >= 0) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const chunk = buf.subarray(pos + sep.length + 2, next - 2); // strip CRLF around
    const headEnd = chunk.indexOf('\r\n\r\n');
    if (headEnd >= 0) {
      const head = chunk.subarray(0, headEnd).toString('utf8');
      const name = /name="([^"]*)"/.exec(head);
      const file = /filename="([^"]*)"/.exec(head);
      parts.push({ name: name ? name[1] : '', filename: file ? file[1] : null, data: chunk.subarray(headEnd + 4) });
    }
    pos = next;
  }
  return parts;
}

class FakeN8n {
  // v: 7 (default), 8 (renewal + claim / collected) or 0 for a v6 server (its hello has no v and no caps)
  constructor(o = {}) {
    this.v = o.v === undefined ? 7 : o.v;
    this.modes = o.modes || (this.v >= 7 ? MODES_V7 : MODES_V6);
    this.caps = { maxSources: 15, tools: ['mindmap', 'flashcards', 'quiz', 'infographic', 'slides', 'digest'], maxParts: 16, partMaxTokens: 200000, reduceMaxTokens: 300000, jobCap: 4, bulkCap: 2, reserve: 2, ...(o.caps || {}) };
    this.jobsEnabled = o.jobsEnabled !== false;
    this.code = 'fake-access-code';
    // Two different things (as on the real server):
    //  secretGen   = the JWT secret of the `STH JWT` credential. Bump it (= rotate the secret) and EVERY token issued so far is refused at once, on every route.
    //  renewEpoch  = the Upstash key auth:ep (0 = absent). Bump it (= `INCR auth:ep`) and renewal refuses the chains of older tokens (STH-AUTH-441); tokens that
    //                already exist stay valid until their own exp. Only the renew route reads it.
    // `epoch` is the old name of secretGen (suite 04 bumps it to log everybody out); kept as an alias.
    this.secretGen = 0;
    this.renewEpoch = 0;
    this.authEpRaw = undefined; // set a string to put a hand-typed value into auth:ep ('abc', ' 1'): renewal then answers unavailable
    this.redisDown = false; // true: the renew route's Redis step fails (fail closed: unavailable)
    this.renewCount = 0; // renewals counted in the hourly breaker so far (set it near RENEW_MAX_PER_HOUR to trip it)
    this.checkExp = false; // true: n8n's own exp check on every route (an expired token is refused: 403 on renew, 401 elsewhere like before); needs `clock`
    this.clock = null; // () => ms: the server's time (default Date.now); tests with a fake page clock set it to the page's time
    this.claimLeaseMs = 600000;
    // renewal faults (client tests): renewDelay = ms the answer is held back; renewFailures = the next n renew requests are cut (network error); renewStatus = every renew
    // request is answered with this HTTP status and no JSON (a gateway, or 404 after a rollback); renewAnswer = a 200 JSON body sent instead of the real answer
    this.renewDelay = 0; this.renewFailures = 0; this.renewStatus = 0; this.renewAnswer = null;
    this.rejectNext = 0; // the next n requests with a valid token (not renew) are answered 401, once each (a refused token)
    this.log = [];
    this.jobs = new Map();
    this.handlers = {}; // mode -> (body, req) => json | { status, json }
    this.rules = []; // job plans, see plan()
    this.directDelay = 0; // ms, or (payload) => ms
    this.budget = { ok: true, used: 0, ceiling: 100e6, remaining: 100e6, bulkCeiling: 60e6, bulkRemaining: 60e6, studioMaxTokens: 400000, mrMaxUnits: 2000000, ...(o.budget || {}) };
    this.budgetStatus = 200; // an HTTP status other than 200 makes the budget op fail
    this.statusFailures = 0; // the next n status/result/ack calls get a 503
    this.networkFailures = 0; // the next n requests (any endpoint but auth) are cut
    this.helloStatus = 200;
    this.enforceCaps = !!o.enforceCaps; // like the server: at most caps.bulkCap bulk jobs and caps.jobCap jobs running; one more is refused as busy
    this.createDelay = 0; // ms the answer to a job create is held back (the job exists on the server meanwhile)
    this.seq = 0;
  }

  get epoch() { return this.secretGen; }
  set epoch(v) { this.secretGen = v; }
  now() { return this.clock ? this.clock() : Date.now(); }

  // ── tokens ──
  secret(gen = this.secretGen) { return `${SECRET}:${gen}`; }
  // A token as the real server mints it (v2: sub, sid, ac, v, jti, iat, exp, auth_time, ep). `o` overrides claims (v: 1 drops auth_time and ep; claims: {...} replaces fields;
  // ttlMs; authTimeMs; ep; gen = the secret generation it is signed with).
  issueToken(nowMs = Date.now(), ttlMs = 7 * 86400000, o = {}) {
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const iat = Math.floor(nowMs / 1000);
    const jti = A.authNewId();
    const claims = o.v === 1
      ? { sub: 'sth', sid: jti, ac: 'sth', v: 1, jti, iat, exp: Math.floor((nowMs + ttlMs) / 1000) }
      : { sub: 'sth', sid: o.sid || jti, ac: 'sth', v: 2, jti, iat, exp: Math.floor((nowMs + ttlMs) / 1000), auth_time: Math.floor((o.authTimeMs === undefined ? nowMs : o.authTimeMs) / 1000), ep: o.ep === undefined ? this.renewEpoch : o.ep };
    Object.assign(claims, o.claims || {});
    for (const k of Object.keys(claims)) if (claims[k] === undefined) delete claims[k];
    const payload = b64(claims);
    const sig = crypto.createHmac('sha256', this.secret(o.gen === undefined ? this.secretGen : o.gen)).update(`${head}.${payload}`).digest('base64url');
    return { token: `${head}.${payload}.${sig}`, exp: claims.exp * 1000, claims };
  }
  claimsOf(token) { try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString()); } catch { return null; } }
  // n8n's own JWT check: a well-formed token, signed with the CURRENT secret, HS256 only, not expired (when checkExp). Returns the claims or null.
  verify(header) {
    const m = /^Bearer (\S+)$/.exec(header || '');
    if (!m) return null;
    const [h, p, s] = m[1].split('.');
    if (!h || !p || !s) return null;
    try {
      if (JSON.parse(Buffer.from(h, 'base64url').toString()).alg !== 'HS256') return null;
      if (crypto.createHmac('sha256', this.secret()).update(`${h}.${p}`).digest('base64url') !== s) return null;
      const c = JSON.parse(Buffer.from(p, 'base64url').toString());
      if (this.checkExp && !(Number(c.exp) > this.now() / 1000)) return null;
      return c;
    } catch { return null; }
  }
  validToken(header) { return !!this.verify(header); }

  // ── what tests read ──
  of(kind) { return this.log.filter(r => r.kind === kind); }
  direct(mode) { return this.log.filter(r => r.kind === 'direct' && (!mode || r.mode === mode)); }
  creates(mode) { return this.log.filter(r => r.kind === 'jobStart' && (!mode || r.mode === mode)); }
  ops(op) { return this.log.filter(r => r.kind === 'job' && r.op === op); }
  sentJobCount() { return this.creates().length; }
  reset() { this.log.length = 0; }
  job(id) { return this.jobs.get(id); }
  // jobs by the order they were created
  list(filter) { return [...this.jobs.values()].filter(j => !filter || filter(j)); }

  // ── what tests set ──
  // plan(matchFn | null, action, times = 1): the next `times` jobs created that match get the action.
  //   { type: 'busy' } status answers rejected / STH-JOB-429      { type: 'fail', code, retryable }   status answers failed
  //   { type: 'hold' } stays running until release()              { type: 'rejected', code }         rejected with another code
  plan(match, action, times = 1) { this.rules.push({ match: match || (() => true), action, times }); return this; }
  release(id) { for (const j of this.jobs.values()) if ((!id || j.id === id) && j.plan && j.plan.type === 'hold') { j.plan = null; } }
  clearRules() { this.rules.length = 0; for (const j of this.jobs.values()) if (j.plan && j.plan.type === 'hold') j.plan = null; }
  complete(id) { const j = this.jobs.get(id); if (j) { j.plan = null; j.forceDone = true; } }

  answer(body) {
    const h = this.handlers[body.mode];
    if (h) return h(body, this);
    const m = body.mode || '';
    if (m === 'tutor') { const msgs = body.messages || []; const last = msgs[msgs.length - 1]; return { text: `Tutor reply to: ${last ? last.text : ''}` }; }
    if (m === 'transcribe') return { text: `Transcript of batch ${body.batchIndex || 1}` };
    if (m === 'template') return { text: '# Template\nSection one' };
    if (m === 'reviewer') return { text: '# Review\nGood work' };
    if (m === 'ping') return { ok: true };
    if (m.startsWith('studio_')) return fx.studioAnswer(body);
    return { ok: false, error: { code: 'STH-SRV-500' } };
  }

  // ── transport ──
  attach(context) {
    return context.route(new RegExp(`^https://${HOST.replace(/\./g, '\\.')}/`), (route) => this.handle(route).catch((e) => { try { route.abort('failed'); } catch { /* page gone */ } if (!/closed|disposed|Target/i.test(String(e))) console.error('[fake-n8n]', e); }));
  }

  reply(route, status, json) {
    return route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json' }, body: typeof json === 'string' ? json : JSON.stringify(json) });
  }

  async handle(route) {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/webhook\//, '');
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const rec = { seq: ++this.seq, at: Date.now(), path, kind: path === 'student-tools-auth' ? 'auth' : path === 'student-tools-v2' ? 'direct' : path === 'sth-job-start' ? 'jobStart' : path === 'sth-job' ? 'job' : path === 'student-tools-renew' ? 'renew' : 'other', status: 0, auth: this.validToken(req.headers().authorization) };
    rec.hasAuthHeader = !!req.headers().authorization;
    this.log.push(rec);
    // body
    const ctype = req.headers()['content-type'] || '';
    const buf = req.postDataBuffer();
    try {
      if (/multipart\/form-data/.test(ctype) && buf) {
        const boundary = /boundary=([^;]+)/.exec(ctype)[1];
        const parts = parseMultipart(buf, boundary);
        const field = (n) => { const p = parts.find(x => x.name === n && x.filename === null); return p ? JSON.parse(p.data.toString('utf8')) : null; };
        rec.payload = field('payload');
        rec.jobHead = field('job');
        rec.files = parts.filter(p => p.filename !== null).map(p => ({ field: p.name, filename: p.filename, size: p.data.length }));
      } else if (buf) {
        rec.payload = JSON.parse(buf.toString('utf8'));
      }
    } catch { rec.payload = null; rec.badBody = true; }
    const send = (status, json) => { rec.status = status; rec.response = json; return this.reply(route, status, json); };

    if (rec.kind === 'auth') {
      if (rec.payload && rec.payload.code === this.code) { const t = this.issueToken(this.now()); return send(200, { token: t.token, expiresAt: new Date(t.exp).toISOString() }); }
      return send(401, { ok: false, error: 'bad_code' });
    }
    if (rec.kind === 'renew') {
      if (this.renewDelay) await sleep(this.renewDelay);
      if (this.renewFailures > 0) { this.renewFailures--; rec.status = -1; return route.abort('failed'); }
      if (this.renewStatus) return send(this.renewStatus, 'x');
      if (this.renewAnswer) { rec.outcome = 'forced'; return send(200, this.renewAnswer); }
      return this.renew(rec, req, send);
    }
    if (!rec.auth) return send(401, { message: 'Unauthorized' });
    if (this.rejectNext > 0) { this.rejectNext--; return send(401, { message: 'Unauthorized' }); }
    if (this.networkFailures > 0) { this.networkFailures--; rec.status = -1; return route.abort('failed'); }
    const body = rec.payload || {};
    rec.mode = body.mode || (rec.jobHead && rec.jobHead.mode) || (body.job && body.job.mode);

    if (rec.kind === 'direct') {
      const d = typeof this.directDelay === 'function' ? this.directDelay(body) : this.directDelay;
      if (d) await sleep(d);
      const out = this.answer(body);
      if (out && out.status && out.json) return send(out.status, out.json);
      return send(200, out);
    }
    if (rec.kind === 'jobStart') { const r = this.jobStart(rec, body, send, true); if (this.createDelay) await sleep(this.createDelay); return r(); }
    if (rec.kind === 'job') return this.jobOp(rec, body, send);
    return send(404, { message: 'not found' });
  }

  // POST student-tools-renew: n8n's JWT Auth first (no header 401 'No token provided'; bad signature, wrong algorithm or expired 403 'jwt ...'), then the workflow: the
  // renewal rules are the real ones (auth.lib.js). 200 with {ok:true, token, expiresAt, authExpiresAt, now} or {ok:false, error:{code, retryable, reason}}.
  renew(rec, req, send) {
    if (!rec.hasAuthHeader) return send(401, 'No token provided');
    const claims = this.verify(req.headers().authorization);
    if (!claims) return send(403, 'jwt malformed');
    const now = this.now();
    const prep = A.renewPrepare(claims, now);
    const ep = this.authEpRaw !== undefined ? this.authEpRaw : this.renewEpoch ? String(this.renewEpoch) : null;
    const reply = this.redisDown ? { error: 'down' } : { result: [++this.renewCount, ep] };
    const out = A.renewDecide(prep, reply, now);
    rec.outcome = out.outcome === 'ok' ? 'ok' : out.reason;
    if (out.outcome !== 'ok') return send(200, out.reply);
    const head = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64(out.claims);
    const sig = crypto.createHmac('sha256', this.secret()).update(`${head}.${payload}`).digest('base64url');
    rec.claims = out.claims;
    return send(200, { ok: true, token: `${head}.${payload}.${sig}`, expiresAt: out.expiresAt, authExpiresAt: out.authExpiresAt, now });
  }

  // does the work now and returns the function that answers (so a delay can sit between the two)
  jobStart(rec, body, send0) {
    let sent = null;
    const send = (status, json) => { sent = [status, json]; return () => send0(...sent); };
    if (!this.jobsEnabled) return send(200, { ok: false, error: { code: 'STH-JOB-503' } });
    const head = rec.jobHead || body.job || {};
    const payload = { ...body }; delete payload.job;
    rec.op = 'create'; rec.jobId = head.id; rec.attempt = head.attempt; rec.bulk = !!head.bulk; rec.mode = head.mode; rec.part = payload.part || null;
    rec.payload = payload;
    const old = this.jobs.get(head.id);
    if (old && old.attempt >= head.attempt && old.state !== 'rejected') return send(200, { ok: true, id: head.id, state: old.state }); // a refused (busy) job takes no slot: sending it again is a new job
    const job = { id: head.id, key: head.key, attempt: head.attempt, mode: head.mode, bulk: !!head.bulk, payload, files: rec.files || [], state: 'running', plan: null, polls: 0, createdSeq: rec.seq, createdAt: Date.now(), cancelled: false, acked: false, forceDone: false };
    const rule = this.rules.find(r => r.times > 0 && r.match(job));
    if (rule) { rule.times--; job.plan = rule.action; }
    else if (this.enforceCaps) {
      const act = [...this.jobs.values()].filter(j => j.state === 'running' && !j.cancelled);
      if ((job.bulk && act.filter(j => j.bulk).length >= this.caps.bulkCap) || act.length >= this.caps.jobCap) { job.plan = { type: 'busy' }; this.overCap = (this.overCap || 0) + 1; }
    }
    this.jobs.set(job.id, job);
    return send(200, { ok: true, id: job.id, state: 'running' });
  }

  async jobOp(rec, body, send) {
    rec.op = body.op;
    const list = Array.isArray(body.jobs) ? body.jobs : [];
    rec.ids = list.map(j => j.id);
    if (this.statusFailures > 0 && (body.op !== 'status' || list.length)) { this.statusFailures--; return send(503, { message: 'unavailable' }); }
    if (body.op === 'status' && !list.length) {
      if (this.helloStatus !== 200) return send(this.helloStatus, { message: 'no' });
      const hello = { ok: true, jobsEnabled: this.jobsEnabled, modes: this.modes, now: this.now() };
      if (this.v) { hello.v = this.v; hello.caps = this.v >= 8 ? { ...this.caps, claimLeaseS: Math.round(this.claimLeaseMs / 1000) } : this.caps; }
      return send(200, hello);
    }
    if (body.op === 'budget') {
      if (this.budgetStatus !== 200) return send(this.budgetStatus, { message: 'no' });
      return send(200, this.budget);
    }
    const mine = list.map(j => { const x = this.jobs.get(j.id); return x && x.key === j.key ? x : null; });
    if (body.op === 'status') {
      const out = list.map((j, k) => {
        const x = mine[k];
        if (!x) return { id: j.id, state: 'unknown' };
        x.polls++;
        if (x.cancelled) return { id: x.id, state: 'cancelled', attempt: x.attempt };
        if (x.state === 'collected') return { id: x.id, state: 'collected', attempt: x.attempt };
        if (x.state === 'running') {
          const p = x.plan;
          if (p && p.type === 'busy') { x.state = 'rejected'; x.error = { code: 'STH-JOB-429' }; }
          else if (p && p.type === 'rejected') { x.state = 'rejected'; x.error = { code: p.code }; }
          else if (p && p.type === 'fail') { x.state = 'failed'; x.error = { code: p.code || 'STH-AI-500', retryable: !!p.retryable }; }
          else if (p && p.type === 'hold' && !x.forceDone) { /* stays running */ }
          else if (p && p.type === 'delay' && Date.now() - x.createdAt < p.ms && !x.forceDone) { /* stays running */ }
          else x.state = 'succeeded';
        }
        return { id: x.id, state: x.state, attempt: x.attempt, ...(x.error ? { error: x.error } : {}) };
      });
      return send(200, { ok: true, jobsEnabled: this.jobsEnabled, modes: this.modes, now: Date.now(), jobs: out }); // like the real server: modes and jobsEnabled ride along, v only in the hello
    }
    if (body.op === 'claim') {
      // v8 only (a v7 server does not know the op: STH-INPUT-400). One job, a 43-character nonce. The real rules are in job-claim.lua / job-claim-reply.js.
      if (this.v < 8) return send(200, { ok: false, error: { code: 'STH-INPUT-400' } });
      const nonce = list[0] && list[0].nonce;
      if (list.length !== 1 || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) return send(200, { ok: false, error: { code: 'STH-INPUT-400' } });
      const x = mine[0];
      if (!x) return send(200, { ok: false, error: { code: 'STH-JOB-404' } });
      if (x.state !== 'succeeded' || x.cancelled) return send(200, { ok: true, id: x.id, state: x.cancelled ? 'cancelled' : x.state });
      if (x.claim && x.claim.nonce !== nonce && this.now() - x.claim.at < this.claimLeaseMs) return send(200, { ok: false, error: { code: 'STH-JOB-409', retryable: false, reason: 'claimed' } });
      x.claim = { nonce, at: this.now() };
      x.claimed = (x.claimed || 0) + 1;
      return send(200, { ok: true, id: x.id, mode: x.mode, result: this.answer(x.payload) });
    }
    if (body.op === 'result') {
      const x = mine[0];
      if (!x || x.state !== 'succeeded') return send(200, { ok: false, error: { code: 'STH-JOB-404' } });
      if (this.v >= 8 && x.claim && this.now() - x.claim.at < this.claimLeaseMs) return send(200, { ok: false, error: { code: 'STH-JOB-409', retryable: false, reason: 'claimed' } });
      x.resultServed = (x.resultServed || 0) + 1;
      const out = this.answer(x.payload);
      return send(200, { ok: true, id: x.id, result: out });
    }
    if (body.op === 'ack') {
      if (this.v < 8) { for (const x of mine) if (x) x.acked = true; return send(200, { ok: true }); }
      // v8: a finished job becomes `collected` (a contentless record), a claim by another nonce is left alone (notYours), other states are dropped as before
      const acked = [], notYours = [];
      list.forEach((j, k) => {
        const x = mine[k];
        if (!x) { acked.push(j.id); return; }
        if (x.state === 'running') return;
        if (x.state === 'succeeded' && !x.cancelled) {
          if (x.claim && x.claim.nonce !== (j.nonce || '')) { notYours.push(j.id); return; }
          x.state = 'collected'; x.collectedAt = this.now(); x.claim = null; x.acked = true;
        } else x.acked = true;
        acked.push(j.id);
      });
      return send(200, { ok: true, acked, notYours });
    }
    if (body.op === 'cancel') { for (const x of mine) if (x) { x.cancelled = true; x.cancelAt = Date.now(); } return send(200, { ok: true, jobs: list.map((j, k) => ({ id: j.id, state: mine[k] ? 'cancelled' : 'unknown' })) }); }
    return send(400, { ok: false });
  }
}

module.exports = { FakeN8n, HOST, MODES_V7, MODES_V6, sleep, parseMultipart, CORS };
