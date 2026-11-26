'use strict';
// The v8 server contract as the browser sees it (fake n8n = the real renewal rules from n8n/tools/src/auth.lib.js + the claim / collected rules):
// POST student-tools-renew (answers, codes, the 30-day cap, v1 tokens, the epoch, fail closed, n8n's JWT layer), hello v 8, claim, collected after ack, result 409,
// the rollback shape (v7 answers STH-INPUT-400 to claim), and the CURRENT page against a v8 server (sign-in token shape, a normal job still works, nothing resent).
// The client side of renewal and pickup (renewIfDue, claim in the jobs engine) is a later PR: what it must do is written down as KNOWN tests, which flip when it lands.
const crypto = require('crypto');
const { suite, assert } = require('../lib/harness');
const { HOST } = require('../lib/fake-n8n');

const t = suite('14-server-v8');
const DAY = 86400000;
const nonce = () => crypto.randomBytes(32).toString('base64url');

// a request from the page (the same CORS path the app uses)
function call(app, path, body, token, headers = {}) {
  return app.page.evaluate(async ({ url, body, token, headers }) => {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers, ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, text, json };
  }, { url: `https://${HOST}/webhook/${path}`, body, token, headers });
}
const renew = (app, token) => call(app, 'student-tools-renew', { v: 1 }, token);
const op = (app, token, name, jobs) => call(app, 'sth-job', { v: 1, op: name, jobs }, token);
const bare = (h, o = {}) => h.newApp({ v: 8, wait: false, signedIn: false, consent: false, ...o });
const err = (r) => r.json && r.json.error;
// an old token: issued `ageDays` ago, code entered `authDays` ago (fake clock = real time)
const old = (app, ageDays = 2, authDays = 3, o = {}) => { const now = Date.now(); return app.n8n.issueToken(now - ageDays * DAY, 7 * DAY, { authTimeMs: now - authDays * DAY, ...o }); };
// a job that succeeded on the fake server (as if the app had started it)
function seedJob(app, id = 'j_' + 'A'.repeat(22), mode = 'tutor') {
  const key = 'k' + 'B'.repeat(42);
  const j = { id, key, attempt: 1, mode, bulk: false, payload: { mode, messages: [{ role: 'user', text: 'hi' }] }, files: [], state: 'succeeded', plan: null, polls: 0, createdSeq: 1, createdAt: Date.now(), cancelled: false, acked: false, forceDone: false };
  app.n8n.jobs.set(id, j);
  return { id, key };
}

t.test('hello: v 8 and the claim lease; a v7 server has neither; the page still treats v 8 as v7+', async (h) => {
  const app = await h.newApp({ v: 8 });
  const hello = (await op(app, app.n8n.issueToken().token, 'status', [])).json;
  assert.equal(hello.v, 8);
  assert.equal(hello.caps.claimLeaseS, 600);
  assert.equal(hello.caps.maxSources, 15);
  assert.equal(await app.ev('serverHas(7)'), true);
  assert.equal(await app.ev('serverHas(8)'), true);
  const app7 = await h.newApp({ v: 7 });
  const h7 = (await op(app7, app7.n8n.issueToken().token, 'status', [])).json;
  assert.equal(h7.v, 7);
  assert.equal(h7.caps.claimLeaseS, undefined);
  assert.equal(await app7.ev('serverHas(8)'), false);
});

t.test('renew: a fresh token is too early (STH-AUTH-425), nothing is issued', async (h) => {
  const app = await bare(h);
  const tok = app.n8n.issueToken(Date.now() - 30 * 60 * 1000);
  const r = await renew(app, tok.token);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: false, error: { code: 'STH-AUTH-425', retryable: false, reason: 'too_early' } });
  assert.equal(app.n8n.of('renew').at(-1).outcome, 'too_early');
});

t.test('renew: an old token gets a new one; sid and auth_time carry on, the new token works everywhere', async (h) => {
  const app = await bare(h);
  const before = old(app, 2, 3);
  const r = await renew(app, before.token);
  assert.equal(r.json.ok, true);
  assert.deepEqual(Object.keys(r.json).sort(), ['authExpiresAt', 'expiresAt', 'now', 'ok', 'token']);
  const was = before.claims, now = app.n8n.claimsOf(r.json.token);
  assert.equal(now.v, 2);
  assert.equal(now.sid, was.sid);
  assert.equal(now.auth_time, was.auth_time);
  assert.notEqual(now.jti, was.jti);
  assert.equal(now.ep, 0);
  assert.ok(Math.abs(now.iat - Date.now() / 1000) < 5);
  assert.equal(now.exp - now.iat, 7 * 86400);
  assert.equal(new Date(r.json.expiresAt).getTime() / 1000, now.exp);
  assert.equal(new Date(r.json.authExpiresAt).getTime() / 1000, was.auth_time + 30 * 86400);
  assert.ok(Math.abs(r.json.now - Date.now()) < 5000);
  // the renewed token is accepted by the job endpoint, and can be renewed again only after an hour
  assert.equal((await op(app, r.json.token, 'status', [])).json.ok, true);
  assert.equal(err(await renew(app, r.json.token)).code, 'STH-AUTH-425');
});

t.test('renew: the 30-day cap (exp = auth_time + 30 d), STH-AUTH-440 in the last hour, and a chain never outlives it', async (h) => {
  const app = await bare(h);
  const near = old(app, 2, 25);
  const ok = await renew(app, near.token);
  assert.equal(ok.json.ok, true);
  assert.equal(app.n8n.claimsOf(ok.json.token).exp, near.claims.auth_time + 30 * 86400, 'the cap wins over now + 7 d');
  const last = old(app, 2, 30 - 1 / 48, {});
  const r = await renew(app, last.token);
  assert.deepEqual(err(r), { code: 'STH-AUTH-440', retryable: false, reason: 'max_age' });
  // a daily chain from day 0: every token has auth_time = day 0, nothing is issued past day 30
  let tok = old(app, 2, 2).token; let lastExp = 0;
  for (let day = 0; day < 3; day++) { const x = await renew(app, tok); if (!x.json.ok) break; tok = x.json.token; lastExp = app.n8n.claimsOf(tok).exp; }
  assert.ok(lastExp <= app.n8n.claimsOf(tok).auth_time + 30 * 86400);
});

t.test('renew: a v1 token (v7) renews into v2 with auth_time = its own iat; a v2 token WITHOUT auth_time is refused; smuggled claims are refused', async (h) => {
  const app = await bare(h);
  const v1 = app.n8n.issueToken(Date.now() - 2 * DAY, 7 * DAY, { v: 1 });
  const r = await renew(app, v1.token);
  assert.equal(r.json.ok, true);
  const c = app.n8n.claimsOf(r.json.token);
  assert.equal(c.v, 2); assert.equal(c.auth_time, v1.claims.iat, 'the cap does not restart'); assert.equal(c.ep, 0);
  assert.equal(c.sid.length, 36);
  const noAt = old(app, 2, 3, { claims: { auth_time: undefined } });
  assert.deepEqual(err(await renew(app, noAt.token)), { code: 'STH-INPUT-400', retryable: false, reason: 'token' });
  const smuggled = app.n8n.issueToken(Date.now() - 2 * DAY, 7 * DAY, { v: 1, claims: { auth_time: Math.floor(Date.now() / 1000) - 40 * 86400 } });
  assert.equal(err(await renew(app, smuggled.token)).code, 'STH-INPUT-400');
  const lie = old(app, 2, 3, { claims: { auth_time: Math.floor(Date.now() / 1000) + 3600 } });
  assert.equal(err(await renew(app, lie.token)).code, 'STH-INPUT-400', 'auth_time after iat');
  const wrongSub = old(app, 2, 3, { claims: { sub: 'tester' } });
  assert.equal(err(await renew(app, wrongSub.token)).code, 'STH-INPUT-400');
});

t.test('epoch: renewEpoch only stops RENEWAL (STH-AUTH-441); existing tokens live on; secretGen (the old `epoch`) logs everybody out at once', async (h) => {
  const app = await bare(h);
  const a = old(app, 2, 3);
  app.n8n.renewEpoch = 1;
  assert.deepEqual(err(await renew(app, a.token)), { code: 'STH-AUTH-441', retryable: false, reason: 'revoked' });
  assert.equal((await op(app, a.token, 'status', [])).json.ok, true, 'the token itself still works until its exp');
  const b = old(app, 2, 3); // minted after the bump: epoch 1
  assert.equal(b.claims.ep, 1);
  const r = await renew(app, b.token);
  assert.equal(r.json.ok, true); assert.equal(app.n8n.claimsOf(r.json.token).ep, 1);
  app.n8n.renewEpoch = 0; // the key was deleted: epoch-1 chains are refused, nothing is revived
  assert.equal(err(await renew(app, b.token)).code, 'STH-AUTH-441');
  // the JWT secret: everything is refused at once, on every route
  const c = old(app, 2, 3);
  app.n8n.secretGen++;
  assert.equal((await renew(app, c.token)).status, 403);
  assert.equal((await op(app, c.token, 'status', [])).status, 401);
  app.n8n.epoch = 5; assert.equal(app.n8n.secretGen, 5, '`epoch` stays an alias of the secret generation (suite 04)');
});

t.test('renew fails closed: Redis down, an invalid auth:ep, and the hourly breaker (all STH-AUTH-503, retry in 30 min)', async (h) => {
  const app = await bare(h);
  const fresh = () => old(app, 2, 3).token;
  const want = (r, reason) => { assert.equal(r.status, 200); assert.deepEqual(r.json, { ok: false, error: { code: 'STH-AUTH-503', retryable: true, retryAfterMs: 1800000, reason } }); };
  app.n8n.redisDown = true; want(await renew(app, fresh()), 'unavailable'); app.n8n.redisDown = false;
  for (const bad of ['abc', ' 1', '-1', '1.5', '']) { app.n8n.authEpRaw = bad; want(await renew(app, fresh()), 'unavailable'); }
  app.n8n.authEpRaw = undefined;
  assert.equal((await renew(app, fresh())).json.ok, true, 'auth:ep absent again: renews');
  app.n8n.renewCount = 1999; assert.equal((await renew(app, fresh())).json.ok, true, 'the 2000th of the hour passes');
  want(await renew(app, fresh()), 'busy');
});

t.test("n8n's JWT layer: no header 401, garbage / another algorithm / edited payload / expired 403 (the workflow never runs)", async (h) => {
  const app = await bare(h);
  app.n8n.checkExp = true;
  const rec = () => app.n8n.of('renew').at(-1);
  assert.equal((await renew(app, null)).status, 401);
  assert.equal((await renew(app, 'garbage')).status, 403);
  const good = old(app, 2, 3);
  const [hd, pl, sg] = good.token.split('.');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal((await renew(app, `${b64({ alg: 'none', typ: 'JWT' })}.${pl}.`)).status, 403, 'alg none');
  assert.equal((await renew(app, `${b64({ alg: 'HS512', typ: 'JWT' })}.${pl}.${sg}`)).status, 403, 'another algorithm');
  assert.equal((await renew(app, `${hd}.${b64({ ...good.claims, ep: 9 })}.${sg}`)).status, 403, 'payload edited after signing');
  const expired = app.n8n.issueToken(Date.now() - 8 * DAY, 7 * DAY, { authTimeMs: Date.now() - 8 * DAY });
  assert.equal((await renew(app, expired.token)).status, 403, 'expired');
  assert.equal(rec().auth, false);
  assert.equal((await renew(app, good.token)).json.ok, true, 'control: the good one passes');
});

t.test('claim: the answer + mode; a second nonce 409; the same nonce again; result inside the lease 409; ack with the right nonce -> collected', async (h) => {
  const app = await bare(h);
  const tok = app.n8n.issueToken().token; const { id, key } = seedJob(app);
  const n1 = nonce(), n2 = nonce();
  const c = (j, n) => op(app, tok, 'claim', [{ id: j.id, key: j.key, nonce: n }]);
  let r = await c({ id, key }, n1);
  assert.equal(r.json.ok, true); assert.equal(r.json.mode, 'tutor'); assert.ok(r.json.result.text);
  r = await c({ id, key }, n2);
  assert.deepEqual(r.json, { ok: false, error: { code: 'STH-JOB-409', retryable: false, reason: 'claimed' } });
  assert.equal((await c({ id, key }, n1)).json.ok, true, 'the same nonce claims again');
  assert.deepEqual(err(await op(app, tok, 'result', [{ id, key }])), { code: 'STH-JOB-409', retryable: false, reason: 'claimed' }, 'result cannot bypass a claim');
  r = await op(app, tok, 'ack', [{ id, key, nonce: n2 }]);
  assert.deepEqual([r.json.acked, r.json.notYours], [[], [id]]);
  assert.equal(app.n8n.job(id).state, 'succeeded');
  r = await op(app, tok, 'ack', [{ id, key, nonce: n1 }]);
  assert.deepEqual([r.json.acked, r.json.notYours], [[id], []]);
  assert.equal(app.n8n.job(id).state, 'collected');
  const st = (await op(app, tok, 'status', [{ id, key }])).json.jobs[0];
  assert.deepEqual([st.id, st.state], [id, 'collected']);
  assert.equal(err(await op(app, tok, 'result', [{ id, key }])).code, 'STH-JOB-404');
  const again = (await c({ id, key }, n2)).json;
  assert.deepEqual([again.ok, again.state, again.result], [true, 'collected', undefined]);
});

t.test('claim race: five devices at once, one winner; the lease runs out and a dead winner is replaced', async (h) => {
  const app = await bare(h);
  const tok = app.n8n.issueToken().token; const { id, key } = seedJob(app);
  const rs = await Promise.all(Array.from({ length: 5 }, () => op(app, tok, 'claim', [{ id, key, nonce: nonce() }])));
  assert.equal(rs.filter((r) => r.json.ok === true && r.json.result).length, 1);
  assert.equal(rs.filter((r) => r.json.ok === false && r.json.error.code === 'STH-JOB-409').length, 4);
  // 10 minutes later (the server's clock) another device takes it over
  const t0 = Date.now(); app.n8n.clock = () => t0 + 600000;
  const n3 = nonce();
  assert.equal((await op(app, tok, 'claim', [{ id, key, nonce: n3 }])).json.ok, true);
  app.n8n.clock = () => t0 + 600000 + 599999;
  assert.equal(err(await op(app, tok, 'claim', [{ id, key, nonce: nonce() }])).code, 'STH-JOB-409');
});

t.test('claim: wrong key and unknown id are the same 404; a running job gives its state; bad nonce / two jobs / no nonce are STH-INPUT-400', async (h) => {
  const app = await bare(h);
  const tok = app.n8n.issueToken().token; const { id, key } = seedJob(app);
  const n = nonce();
  const wrong = (await op(app, tok, 'claim', [{ id, key: 'k' + 'C'.repeat(42), nonce: n }])).json;
  const none = (await op(app, tok, 'claim', [{ id: 'j_' + 'Z'.repeat(22), key, nonce: n }])).json;
  assert.deepEqual(wrong, none); assert.equal(wrong.error.code, 'STH-JOB-404');
  app.n8n.job(id).state = 'running';
  assert.deepEqual((await op(app, tok, 'claim', [{ id, key, nonce: n }])).json, { ok: true, id, state: 'running' });
  for (const jobs of [[{ id, key }], [{ id, key, nonce: 'short' }], [{ id, key, nonce: n }, { id, key, nonce: n }], []]) assert.equal(err(await op(app, tok, 'claim', jobs)).code, 'STH-INPUT-400');
});

t.test('ack: failed / cancelled jobs are dropped as before, never collected; a running job is left alone', async (h) => {
  const app = await bare(h);
  const tok = app.n8n.issueToken().token;
  const a = seedJob(app, 'j_' + 'D'.repeat(22)); app.n8n.job(a.id).state = 'failed';
  const b = seedJob(app, 'j_' + 'E'.repeat(22)); app.n8n.job(b.id).state = 'running';
  const r = await op(app, tok, 'ack', [{ ...a, nonce: nonce() }, b]);
  assert.deepEqual(r.json.acked, [a.id]);
  assert.equal(app.n8n.job(a.id).state, 'failed', 'a failure is never turned into collected');
  assert.equal(app.n8n.job(b.id).state, 'running');
});

t.test('rollback: a v7 server does not know claim (STH-INPUT-400) and its ack keeps the old shape', async (h) => {
  const app = await bare(h, { v: 7 });
  const tok = app.n8n.issueToken().token; const { id, key } = seedJob(app);
  assert.equal(err(await op(app, tok, 'claim', [{ id, key, nonce: nonce() }])).code, 'STH-INPUT-400');
  assert.deepEqual((await op(app, tok, 'ack', [{ id, key }])).json, { ok: true });
  assert.equal(app.n8n.job(id).state, 'succeeded', 'v7: no collected state');
});

t.test('the page against a v8 server: the sign-in answer is a v2 token and the app works with it', async (h) => {
  const app = await h.newApp({ v: 8, clock: true, signedIn: false, wait: false });
  await app.until('authInitDone');
  await app.page.fill('#loginInput', app.n8n.code);
  await app.page.check('#loginConsent');
  await app.page.click('#loginBtn');
  await app.until(`document.getElementById('loginOverlay').classList.contains('dismissed')`, { what: 'signed in' });
  const stored = JSON.parse(await app.ev(`localStorage.getItem('sth_token')`));
  const c = app.n8n.claimsOf(stored.t);
  assert.deepEqual([c.v, c.sub, c.ac, c.sid === c.jti, c.auth_time === c.iat, c.ep], [2, 'sth', 'sth', true, true, 0]);
  assert.ok(Math.abs(stored.exp - c.exp * 1000) < 1000);
  await app.ready();
  assert.equal(await app.ev('serverHas(8)'), true);
});

t.test('the page against a v8 server: a normal job runs once (status, result, ack) and ends collected, nothing resent', async (h) => {
  const app = await h.newApp({ v: 8, clock: true });
  // a job from the page
  app.n8n.plan(null, { type: 'hold' });
  await app.seedKb([h.fx.kbItem('a.txt', { tokens: 100, id: 'k_a' })]);
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_a'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.until(`[...jobs.recs.values()].some(r => r.state === 'submitted')`);
  const id = await app.ev(`[...jobs.recs.values()][0].id`);
  app.n8n.release();
  await app.advanceUntil(`jobs.recs.get('${id}').state === 'done'`, { what: 'done', step: 1000 });
  const ops = app.n8n.log.filter((r) => r.kind === 'job' && r.ids && r.ids.includes(id)).map((r) => r.op);
  assert.equal(ops.filter((o) => o === 'result').length, 1);
  assert.equal(ops.filter((o) => o === 'ack').length, 1);
  assert.equal(ops.filter((o) => o === 'claim').length, 0, 'the current client does not claim (PR-D)');
  assert.equal(app.n8n.job(id).state, 'collected');
  assert.equal(app.n8n.creates().length, 1);
});

t.known('a client that sees `collected` (another device collected the answer) must treat it as done elsewhere and NEVER resend (review D2) - PR-D', async (h) => {
  const app = await h.newApp({ v: 8, clock: true });
  app.n8n.plan(null, { type: 'hold' });
  await app.seedKb([h.fx.kbItem('a.txt', { tokens: 100, id: 'k_a' })]);
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_a'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.until(`[...jobs.recs.values()].some(r => r.state === 'submitted')`);
  const id = await app.ev(`[...jobs.recs.values()][0].id`);
  await app.advanceUntil(`jobs.recs.get('${id}').state === 'running'`, { what: 'running', step: 1000 });
  // another device collects it
  const j = app.n8n.job(id); j.plan = null; j.state = 'succeeded';
  const tok = app.n8n.issueToken().token; const n = nonce();
  assert.equal((await op(app, tok, 'claim', [{ id, key: j.key, nonce: n }])).json.ok, true);
  assert.deepEqual((await op(app, tok, 'ack', [{ id, key: j.key, nonce: n }])).json.acked, [id]);
  await app.advance(20000);
  assert.equal(app.n8n.creates().length, 1, 'no resend: the job must not run (and be billed) twice');
});

t.run();
