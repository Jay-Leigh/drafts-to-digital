'use strict';
// B: the CLIENT side of sliding token renewal (server v8 renews; see suite 14 for the server contract). The app renews a sign-in token that is more than a day old when
// it opens and about daily while it stays open; it asks nothing of a young token or a v7 server; one renewal at a time (also across tabs); the new token replaces the old
// one only if the stored token is still the one that was sent (review B4); every refusal or failure leaves the token alone and shows nothing: the gate only comes when
// the token has really run out; failures back off (no storms); renewal does not depend on IndexedDB or on the background-jobs switch (review B2).
const { suite, assert, FakeN8n } = require('../lib/harness');

const t = suite('16-renew-client');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// An app that opens with an old token: issued `age` ms ago, the code typed `authAge` ms ago. prep(n8n) runs after the token is made and before the page loads.
async function open(h, { v = 8, age = 2 * DAY, authAge = age, tokOpts = {}, prep, fake = {}, ...o } = {}) {
  const n8n = new FakeN8n({ v, ...fake });
  const now = Date.now();
  const tok = n8n.issueToken(now - age, 7 * DAY, { authTimeMs: now - authAge, ...tokOpts });
  if (prep) prep(n8n);
  const app = await h.newApp({ n8n, signedIn: false, seed: { sth_token: JSON.stringify({ t: tok.token, exp: tok.exp }) }, ...o });
  app.tok = tok;
  await app.ready();
  await settle(app);
  return app;
}
const settle = async (app) => {
  await app.until('renew.wired && renew.opened', { what: 'renewal looked at the token' });
  await sleep(250);
  await app.until('!renew.inflight', { what: 'renewal settled' });
};
// the server's clock follows the page's: skip() moves both on (the page clock is a fake one that also runs by itself)
function clocked(app) {
  let off = 0;
  app.n8n.clock = () => Date.now() + off;
  return { async skip(ms) { off += ms; await app.page.clock.fastForward(ms); await sleep(300); await app.until('!renew.inflight', { what: 'renewal settled' }); }, offset: () => off };
}
const stored = async (app) => JSON.parse(await app.ev(`localStorage.getItem('sth_token')`));
const calls = (app) => app.n8n.of('renew').length;
const claims = (app, token) => app.n8n.claimsOf(token);
const gateShown = (app) => app.ev(`!document.getElementById('loginOverlay').classList.contains('dismissed')`);
const quiet = async (app, what) => {
  assert.equal(await gateShown(app), false, `${what}: no gate`);
  assert.equal((await app.ev(`document.getElementById('toast').textContent`)).trim(), '', `${what}: no toast`);
  assert.equal(await app.ev(`document.getElementById('statusBanner').hidden`), true, `${what}: no status banner`);
  assert.deepEqual(app.pageErrors, [], `${what}: no page error`);
};
const ping = (app) => app.ev(`webhookRequest({ mode: 'ping' }, { quiet: true })`);
const watchWrites = () => {
  window.__tw = [];
  const set = Storage.prototype.setItem, rm = Storage.prototype.removeItem;
  Storage.prototype.setItem = function (k, v) { if (k === 'sth_token') window.__tw.push(['set', JSON.parse(v).t]); return set.call(this, k, v); };
  Storage.prototype.removeItem = function (k) { if (k === 'sth_token') window.__tw.push(['remove']); return rm.call(this, k); };
};

t.test('threshold: a token older than 24 h is renewed once when the app opens; a younger one (or one under an hour) is not even asked about', async (h) => {
  for (const [age, want] of [[30 * MIN, 0], [23 * HOUR, 0], [25 * HOUR, 1], [3 * DAY, 1]]) {
    const app = await open(h, { age });
    assert.equal(calls(app), want, `${age / HOUR} h old: ${want} renew call(s)`);
    const s = await stored(app);
    if (!want) { assert.equal(s.t, app.tok.token, 'a young token is left as it is'); continue; }
    assert.notEqual(s.t, app.tok.token);
    const was = app.tok.claims, now = claims(app, s.t);
    assert.equal(now.sid, was.sid); assert.equal(now.auth_time, was.auth_time); assert.notEqual(now.jti, was.jti);
    assert.equal(now.exp - now.iat, 7 * 86400);
    assert.ok(Math.abs(s.exp - now.exp * 1000) < 1000, 'the stored end time is the new token\'s');
    assert.equal(await app.ev('authToken.t'), s.t, 'memory and storage hold the same token');
    await quiet(app, `${age / HOUR} h`);
  }
});

t.test('the new token replaces the old one in one write (the stored token is never removed or empty), and the next request uses it; nothing is shown', async (h) => {
  const app = await open(h, { age: 2 * DAY, initScript: watchWrites });
  const w = await app.ev('window.__tw');
  assert.equal(w.length, 1, JSON.stringify(w));
  assert.equal(w[0][0], 'set');
  assert.notEqual(w[0][1], app.tok.token);
  assert.equal(w[0][1], (await stored(app)).t);
  await ping(app);
  const last = app.n8n.of('direct').at(-1);
  assert.equal(last.auth, true);
  await quiet(app, 'renewed');
  assert.ok(!app.n8n.log.some(r => /eyJ[\w-]+\./.test(JSON.stringify(r.payload || {}))), 'no token in any request body');
  assert.equal(app.n8n.direct('error_report').length, 0, 'no error report');
});

t.test('single flight: many triggers at once make one request; a token younger than an hour is never renewed (not even when forced); about daily while the app stays open', async (h) => {
  const app = await open(h, { age: 2 * DAY, clock: true });
  const clk = clocked(app);
  assert.equal(calls(app), 1);
  await app.ev(`Promise.all([renew.maybe('a'), renew.maybe('b'), renew.maybe('c'), renew.maybe('d')])`);
  for (let i = 0; i < 8; i++) { await app.page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); }); }
  await sleep(300);
  assert.equal(calls(app), 1, 'the token is fresh now: nothing more');
  assert.equal(await app.ev(`renew.attempt(true)`), 'notdue', 'under an hour: not asked, even when forced');
  assert.equal(calls(app), 1);
  const first = (await stored(app)).t;
  await clk.skip(20 * HOUR);
  assert.equal(calls(app), 1, '20 h later: still not due');
  await clk.skip(5 * HOUR);
  assert.equal(calls(app), 2, 'a day after it was issued: renewed again');
  const second = (await stored(app)).t;
  assert.notEqual(second, first);
  assert.equal(claims(app, second).sid, app.tok.claims.sid, 'one chain');
  assert.equal(claims(app, second).auth_time, app.tok.claims.auth_time, 'the code time never moves');
  await quiet(app, 'daily');
});

t.test('two tabs open together: one renewal, both end up with the same new token', async (h) => {
  const app = await open(h, { age: 2 * DAY, fake: { renewDelay: 1200 } });
  const p2 = await app.context.newPage();
  p2.on('pageerror', (e) => app.pageErrors.push(String(e && e.message || e)));
  await p2.goto(app.page.url());
  await p2.waitForFunction(() => window.__t && window.__t.authInitDone === true, null, { timeout: 20000 });
  await app.until(`JSON.parse(localStorage.getItem('sth_token')).t !== ${JSON.stringify(app.tok.token)}`, { what: 'token renewed', timeout: 20000 });
  await p2.waitForFunction((t) => window.__t.ev('authToken.t') === JSON.parse(localStorage.getItem('sth_token')).t && window.__t.ev('authToken.t') !== t, app.tok.token, { timeout: 20000 });
  await sleep(500);
  assert.equal(calls(app), 1, 'one renewal for two tabs');
  assert.equal(await app.ev('authToken.t'), await p2.evaluate(() => window.__t.ev('authToken.t')));
});

t.test('cross-tab race (review B4): a sign-in saved by another tab while the answer is on its way is never overwritten', async (h) => {
  const n8n = new FakeN8n({ v: 8 });
  n8n.renewDelay = 2500;
  const now = Date.now();
  const tok = n8n.issueToken(now - 2 * DAY, 7 * DAY, { authTimeMs: now - 2 * DAY });
  const app = await h.newApp({ n8n, signedIn: false, seed: { sth_token: JSON.stringify({ t: tok.token, exp: tok.exp }) } });
  await app.ready();
  await app.waitNode(() => calls(app) === 1, { what: 'renew request on the wire' });
  // another tab signs in again (a new chain, the code typed just now) and stores its token
  const other = n8n.issueToken(Date.now(), 7 * DAY);
  await app.page.evaluate((o) => localStorage.setItem('sth_token', JSON.stringify(o)), { t: other.token, exp: other.exp });
  await app.until('!renew.inflight', { timeout: 20000 });
  assert.equal((await stored(app)).t, other.token, 'the newer sign-in stays');
  assert.equal(await app.ev('authToken.t'), other.token, 'this tab takes it too');
  assert.equal(calls(app), 1);
  await quiet(app, 'race');
  // the other direction: the stored token is an OLDER token of the same chain (another tab renewed first): it is replaced
  const app2 = await open(h, { age: 2 * DAY, fake: { renewDelay: 1500 } });
  await app2.waitNode(() => calls(app2) === 1, { what: 'renew request on the wire' });
  await app2.until('!renew.inflight', { timeout: 20000 });
  assert.notEqual((await stored(app2)).t, app2.tok.token);
});

// ── every answer of the server ──
const CAP_EXP = (authAge) => Math.floor((Date.now() - authAge) / 1000) + 30 * 86400; // a real chain ends at auth_time + 30 d
const kept = async (app, what) => {
  assert.equal((await stored(app)).t, app.tok.token, `${what}: the token is untouched`);
  assert.equal(await app.ev('authToken.t'), app.tok.token);
  await quiet(app, what);
};

t.test('425 too early: nothing happens, the token stays, no hammering', async (h) => {
  const app = await open(h, { age: 2 * DAY, clock: true, prep: (n) => { n.renewAnswer = { ok: false, error: { code: 'STH-AUTH-425', retryable: false, reason: 'too_early' } }; } });
  const clk = clocked(app);
  assert.equal(calls(app), 1);
  await kept(app, '425');
  await clk.skip(30 * MIN);
  assert.equal(calls(app), 1, 'not again within the hour');
  await app.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await sleep(200);
  assert.equal(calls(app), 1);
  await kept(app, '425 later');
});

t.test('440 (30 days since the code): the token is left to run out, no more asking, no gate', async (h) => {
  const authAge = 20 * DAY;
  const app = await open(h, { age: 2 * DAY, authAge, tokOpts: { claims: { exp: CAP_EXP(authAge) } }, clock: true, prep: (n) => { n.renewAnswer = { ok: false, error: { code: 'STH-AUTH-440', retryable: false, reason: 'max_age' } }; } });
  assert.equal(calls(app), 1);
  await kept(app, '440');
  assert.equal(await app.ev('renew.blocked === authToken.t'), true);
  await app.page.evaluate(() => { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); });
  await app.page.clock.fastForward(30 * MIN);
  await sleep(300);
  assert.equal(calls(app), 1, 'asked once, then left alone');
  await kept(app, '440 later');
});

t.test('a chain within an hour of its 30-day limit is not even asked (the server would refuse)', async (h) => {
  const authAge = 30 * DAY - 30 * MIN;
  const app = await open(h, { age: 2 * DAY, authAge, tokOpts: { claims: { exp: CAP_EXP(authAge) } } });
  assert.equal(calls(app), 0);
  await kept(app, 'at the limit');
});

t.test('441 (the access code was changed): same, the token lives out its own end and the app keeps working', async (h) => {
  const app = await open(h, { age: 2 * DAY, clock: true, prep: (n) => { n.renewEpoch = 1; } });
  assert.equal(calls(app), 1);
  assert.equal(app.n8n.of('renew').at(-1).outcome, 'revoked');
  await kept(app, '441');
  await ping(app);
  assert.equal(app.n8n.of('direct').at(-1).auth, true, 'the token still works for requests');
  await kept(app, '441 after a request');
});

t.test('INPUT-400 (invalid token): left alone, no more asking, no gate', async (h) => {
  const iatS = Math.floor((Date.now() - 2 * DAY) / 1000);
  const app = await open(h, { age: 2 * DAY, tokOpts: { claims: { auth_time: iatS + 3600 } } });
  assert.equal(calls(app), 1);
  assert.equal(app.n8n.of('renew').at(-1).outcome, 'token');
  await kept(app, '400');
  assert.equal(await app.ev('renew.blocked === authToken.t'), true);
});

t.test('n8n answers 401/403 to the renewal (the token layer): left alone, no gate from the renewal itself', async (h) => {
  const app = await open(h, { age: 2 * DAY, prep: (n) => { n.renewStatus = 403; } });
  assert.equal(calls(app), 1);
  await kept(app, '403');
  assert.equal(await app.ev('renew.blocked === authToken.t'), true);
});

t.test('503 / gateway / network: the token stays, nothing is shown, and it tries again later with a growing wait', async (h) => {
  for (const [name, prep] of [['503 unavailable', (n) => { n.redisDown = true; }], ['502 gateway', (n) => { n.renewStatus = 502; }], ['network cut', (n) => { n.renewFailures = 1; }]]) {
    const app = await open(h, { age: 2 * DAY, clock: true, prep });
    const clk = clocked(app);
    assert.equal(calls(app), 1, name);
    await kept(app, name);
    await clk.skip(14 * MIN);
    assert.equal(calls(app), 1, `${name}: not before 15 minutes`);
    await clk.skip(name === '503 unavailable' ? 32 * MIN : 12 * MIN); // the timer carries a little jitter; the server said "30 minutes" for a 503
    assert.equal(calls(app), 2, `${name}: tried again`);
    if (name === 'network cut') { // the next one gets through
      assert.notEqual((await stored(app)).t, app.tok.token, 'renewed on the second try');
      await quiet(app, name);
    } else await kept(app, `${name} (second)`);
  }
});

t.test('404 on the renewal (the server went back to v7): renewal stops asking for a while, token and UI untouched', async (h) => {
  const app = await open(h, { age: 2 * DAY, clock: true, prep: (n) => { n.renewStatus = 404; } });
  const clk = clocked(app);
  assert.equal(calls(app), 1);
  assert.ok(await app.ev('renew.fails') >= 1);
  await kept(app, '404');
  await app.page.evaluate(() => { for (let k = 0; k < 5; k++) { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); } });
  await clk.skip(5 * MIN);
  assert.equal(calls(app), 1, 'no storm while the server has no renewal');
});

t.test('no storms: a server that keeps failing is asked a handful of times a day at most, and tab events do not add requests', async (h) => {
  const app = await open(h, { age: 2 * DAY, clock: true, prep: (n) => { n.redisDown = true; } });
  const clk = clocked(app);
  assert.equal(calls(app), 1);
  const counts = [];
  for (let i = 0; i < 48; i++) {
    await app.page.evaluate(() => { for (let k = 0; k < 5; k++) { window.dispatchEvent(new Event('online')); document.dispatchEvent(new Event('visibilitychange')); } });
    await clk.skip(30 * MIN);
    counts.push(calls(app));
  }
  assert.ok(counts.at(-1) >= 4 && counts.at(-1) <= 10, `calls in 24 h: ${counts.at(-1)} (${counts.join(',')})`);
  for (let i = 1; i < counts.length; i++) assert.ok(counts[i] - counts[i - 1] <= 1, 'never two attempts in one half hour');
  await kept(app, 'failing for a day');
  // the server comes back: the next try renews
  app.n8n.redisDown = false;
  await clk.skip(5 * HOUR);
  assert.notEqual((await stored(app)).t, app.tok.token, 'renewed once it is back');
});

t.test('two tabs, server down: the failure of one holds the other back (about one attempt per 15 minutes for the browser)', async (h) => {
  const app = await open(h, { age: 2 * DAY, prep: (n) => { n.redisDown = true; } });
  const p2 = await app.context.newPage();
  await p2.goto(app.page.url());
  await p2.waitForFunction(() => window.__t && window.__t.authInitDone === true, null, { timeout: 20000 });
  await sleep(1500);
  assert.equal(calls(app), 1, 'the second tab did not ask as well');
});

// ── no surprise logout ──
t.test('after a refusal the token is used until it really ends: the gate comes only then', async (h) => {
  const app = await open(h, { age: 2 * DAY, clock: true, prep: (n) => { n.renewEpoch = 1; n.checkExp = true; } });
  const clk = clocked(app);
  assert.equal(app.n8n.of('renew').at(-1).outcome, 'revoked');
  await clk.skip(4 * DAY);
  await ping(app);
  assert.equal(await gateShown(app), false, '4 days later (token valid to day 5): no gate');
  assert.equal(calls(app), 1, 'and no more asking');
  await clk.skip(2 * DAY); // past the end of the token
  await app.ev(`(window.__late = webhookRequest({ mode: 'ping' }, { quiet: true }).catch(() => {}), 1)`);
  await app.until(`!document.getElementById('loginOverlay').classList.contains('dismissed')`, { what: 'gate once the token has really run out' });
});

t.test('a request refused (401) after a failed renewal gets one more renewal before the gate; without a failed renewal it goes straight to the gate', async (h) => {
  const app = await open(h, { age: 2 * DAY, prep: (n) => { n.redisDown = true; } });
  assert.equal(calls(app), 1);
  assert.equal(await app.ev('renew.fails'), 1);
  app.n8n.redisDown = false;
  app.n8n.rejectNext = 1;
  const r = await ping(app);
  assert.ok(r, 'the request went through after the rescue');
  assert.equal(calls(app), 2, 'one extra renewal');
  assert.notEqual((await stored(app)).t, app.tok.token);
  assert.equal(await gateShown(app), false);
  // now no failed renewal is on record: a refused token goes straight to the gate
  app.n8n.rejectNext = 1;
  await app.ev(`(window.__again = webhookRequest({ mode: 'ping' }, { quiet: true }).catch(() => {}), 1)`);
  await app.until(`!document.getElementById('loginOverlay').classList.contains('dismissed')`, { what: 'gate' });
  assert.equal(calls(app), 2, 'no extra renewal');
});

// ── what it depends on ──
t.test('a v7 server: no renewal calls at all (the hello says v 7), the token is left alone', async (h) => {
  for (const o of [{}, { jobs: false }]) {
    const app = await open(h, { v: 7, age: 3 * DAY, ...o });
    await sleep(600);
    assert.equal(calls(app), 0, JSON.stringify(o));
    assert.equal(await app.ev('renew.v'), 7);
    assert.equal((await stored(app)).t, app.tok.token);
    await quiet(app, 'v7');
  }
});

t.test('review B2: with IndexedDB blocked and the jobs switch off, the token is still renewed (the hello is asked by the renewal itself)', async (h) => {
  const app = await open(h, { age: 2 * DAY, jobs: false, idbBlocked: true });
  assert.equal(await app.ev('jobs.available'), false, 'no jobs engine');
  assert.equal(await app.ev('service.server.seen'), false, 'the jobs engine never heard the hello');
  assert.equal(await app.ev('serverHas(8)'), false);
  assert.equal(calls(app), 1, 'renewed anyway');
  assert.notEqual((await stored(app)).t, app.tok.token);
  await quiet(app, 'idb blocked');
});

t.test('localStorage blocked: the renewal still works for the visit, in memory', async (h) => {
  const n8n = new FakeN8n({ v: 8 });
  const tok = n8n.issueToken(Date.now() - 2 * DAY, 7 * DAY, { authTimeMs: Date.now() - 2 * DAY });
  // a visit with no storage: sign in, then the token is old only in the page's memory (the fake clock moves a day on)
  const app = await h.newApp({ n8n, storageBlocked: true, signedIn: false, wait: false, clock: true });
  const clk = clocked(app);
  await app.page.fill('#loginInput', n8n.code);
  await app.page.check('#loginConsent');
  await app.page.click('#loginBtn');
  await app.until(`document.getElementById('appContent').classList.contains('unlocked') && authInitDone`, { timeout: 20000 });
  await app.until('renew.wired');
  const first = await app.ev('authToken.t');
  assert.equal(calls(app), 0);
  await clk.skip(25 * HOUR);
  assert.equal(calls(app), 1);
  assert.notEqual(await app.ev('authToken.t'), first, 'the token in memory is the new one');
  assert.equal(tok.token === first, false);
});

t.test('an old (v1) token is read and renewed into a v2 token whose code time is the old issue time', async (h) => {
  const app = await open(h, { age: 2 * DAY, tokOpts: { v: 1 } });
  assert.equal(app.tok.claims.v, 1);
  assert.equal(calls(app), 1);
  const s = await stored(app);
  const c = claims(app, s.t);
  assert.equal(c.v, 2);
  assert.equal(c.auth_time, app.tok.claims.iat, 'the 30 days do not restart');
  assert.equal(c.sid.length, 36);
  await quiet(app, 'v1');
});

t.test('sign-in still works and arms the renewal for the new token (a token issued by the gate is not asked about for a day)', async (h) => {
  const app = await h.newApp({ v: 8, clock: true, signedIn: false, wait: false });
  await app.page.waitForSelector('#loginInput', { state: 'visible' });
  await app.page.fill('#loginInput', app.n8n.code);
  await app.page.check('#loginConsent');
  await app.page.click('#loginBtn');
  await app.until(`document.getElementById('loginOverlay').classList.contains('dismissed') && renew.wired`, { what: 'signed in' });
  const clk = clocked(app);
  await sleep(500);
  assert.equal(calls(app), 0, 'a fresh token is not renewed');
  await clk.skip(26 * HOUR);
  assert.equal(calls(app), 1, 'a day later it is');
  assert.equal(await gateShown(app), false);
});

t.run();
