'use strict';
// Stay connected to Google (design A): the first tap or key press of a visit renews the sync token silently (prompt '', login_hint = stored e-mail),
// the token's end time is tracked, one request at a time, one automatic try per visit, the account is checked before any merge, tabs hand the token to
// each other in memory only, sign-out reaches the other tabs, Docs export reuses the sync token, "Sign out" link in the Re-connect view.
const { suite, assert } = require('../lib/harness');
const { connectDrive, AFTER } = require('../lib/common');

const t = suite('13-google-reconnect');
const EMAIL = 'tester@example.test';
const USER = JSON.stringify({ name: 'Test User', email: EMAIL, picture: '' });
const SEED = { sth_sync_user: USER };

const ev = (page, code) => page.evaluate((c) => window.__t.ev(c), code);
async function until(page, code, { timeout = 15000, what = code } = {}) {
  const t0 = Date.now();
  for (;;) {
    let v; try { v = await ev(page, code); } catch { v = undefined; }
    if (v) return v;
    if (Date.now() - t0 > timeout) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise(r => setTimeout(r, 40));
  }
}
const SYNCED = `/^Synced/.test(document.getElementById('syncStatus').textContent)`;
const reqs = (page) => page.evaluate(() => window.__gis.requests.slice());
const syncReqs = async (page) => (await reqs(page)).filter(r => /drive\.appdata/.test(r.scope));
const status = (page) => page.evaluate(() => document.getElementById('syncStatus').textContent);
const signedOutShown = (page) => page.evaluate(() => !document.getElementById('syncSignedOut').classList.contains('hidden'));
const btnText = (page) => page.evaluate(() => document.getElementById('btnSyncSignIn').textContent.trim());
const linkShown = (page) => page.evaluate(() => !document.getElementById('btnSyncSignOutLink').classList.contains('hidden'));
// a real mouse click on an inert spot of the page (a tap)
const tap = (page) => page.locator('.main-area').click({ position: { x: 3, y: 3 }, force: true });
const stored = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);
const toastText = (page) => page.evaluate(() => document.getElementById('toast').textContent);

async function openTab(app) {
  const page = await app.context.newPage();
  page.on('pageerror', (e) => app.pageErrors.push(String(e && e.message || e)));
  await page.goto(app.page.url());
  await page.waitForFunction(() => window.__t && window.__t.authInitDone === true, null, { timeout: 20000 });
  await until(page, '!kb.loading && !tutor.loading && studio.ready', { what: 'tab ready' });
  return page;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

t.test('a stored account shows a quiet status, not the button, and nothing is requested without a tap', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`, { what: 'sync client' });
  await sleep(800);
  assert.equal((await reqs(app.page)).length, 0, 'no request without a gesture');
  assert.match(await status(app.page), /Paused/);
  assert.equal(await signedOutShown(app.page), false, 'Re-connect button not shown yet');
  assert.equal(await app.ev('state.syncAuto'), true);
  await app.page.mouse.move(300, 300);
  await app.page.mouse.wheel(0, 200);
  await sleep(200);
  assert.equal((await reqs(app.page)).length, 0, 'moving or scrolling is no gesture');
});

t.test('first tap: one silent request with prompt "" and login_hint, then synced; later taps ask nothing', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await tap(app.page);
  await app.until(SYNCED, { what: 'synced after the tap', timeout: 20000 });
  const r = await reqs(app.page);
  assert.equal(r.length, 1);
  assert.equal(r[0].prompt, '');
  assert.equal(r[0].login_hint, EMAIL);
  assert.match(r[0].scope, /drive\.appdata/);
  assert.equal(await app.ev('hasFreshSyncToken()'), true);
  const left = await app.ev('state.driveSyncTokenExpiresAt - Date.now()');
  assert.ok(left > 3400e3 && left <= 3540e3, `expiry tracked from expires_in (${left})`);
  await tap(app.page); await tap(app.page);
  await app.page.keyboard.press('x');
  await sleep(200);
  assert.equal((await reqs(app.page)).length, 1, 'a fresh token is not asked for again');
});

t.test('a second tap while a request is open does not send another (gesture, button and tap share it)', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await app.page.evaluate(() => { window.__gis.mode = 'hold'; });
  await tap(app.page); await tap(app.page);
  await app.page.keyboard.press('x');
  await app.until(`!!syncTokenInflight`);
  assert.equal((await reqs(app.page)).length, 1);
  await app.ev(`triggerSyncSignIn()`); // the button path joins too
  await app.ev(`(ensureGoogleToken().catch(() => {}), true)`); // and so does export
  assert.equal((await reqs(app.page)).length, 1, 'one request for tap, tap, key, button and export');
  await app.page.evaluate(() => window.__gis.complete('ok'));
  await app.until(SYNCED, { what: 'synced', timeout: 20000 });
  assert.equal((await reqs(app.page)).length, 1);
});

t.test('typing in a text field is no trigger; the next tap is', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await app.newChat('Typing');
  await app.until(`document.getElementById('tutorInput').offsetParent !== null`);
  await app.page.evaluate(() => document.getElementById('tutorInput').focus());
  assert.equal(await app.page.evaluate(() => document.activeElement.id), 'tutorInput');
  await app.page.keyboard.type('hello there');
  await sleep(200);
  assert.equal((await reqs(app.page)).length, 0, 'no request while typing');
  await app.page.keyboard.press('Shift');
  await app.page.keyboard.press('Escape');
  await app.page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sleep(100);
  assert.equal((await reqs(app.page)).length, 0, 'bare modifiers and Escape are no gesture');
  await tap(app.page);
  await app.until(`state.driveSyncToken`, { what: 'token after the tap' });
  assert.equal((await reqs(app.page)).length, 1);
});

t.test('a key press outside text fields triggers the request', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await app.page.evaluate(() => document.activeElement && document.activeElement.blur());
  await app.page.keyboard.press('ArrowDown');
  await app.until(`state.driveSyncToken`, { what: 'token after a key' });
  assert.equal((await reqs(app.page)).length, 1);
});

t.test('the sign-in gate triggers nothing, and neither does a first-time visit without a stored account', async (h) => {
  const gate = await h.newApp({ now: AFTER, seed: SEED, signedIn: false, wait: false });
  await gate.page.waitForSelector('#loginOverlay');
  await gate.page.click('#loginOverlay', { position: { x: 4, y: 4 }, force: true });
  await sleep(300);
  assert.equal((await reqs(gate.page)).length, 0, 'nothing on the gate');
  const fresh = await h.newApp({ now: AFTER });
  await fresh.until(`!!state.driveSyncClient`);
  await tap(fresh.page);
  await sleep(200);
  assert.equal((await reqs(fresh.page)).length, 0, 'never connected: no automatic request');
  assert.equal(await fresh.ev('state.syncAuto'), false);
  assert.equal(await linkShown(fresh.page), false, 'no Sign out link for a visitor who never connected');
});

t.test('the token ends after expires_in: the next tap renews, a tap before does not', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await app.page.evaluate(() => { window.__gis.expiresIn = 1800; });
  await tap(app.page);
  await app.until(SYNCED, { timeout: 20000 });
  assert.equal((await reqs(app.page)).length, 1);
  await app.page.clock.fastForward(20 * 60e3); // 20 min: still fresh
  await tap(app.page);
  await sleep(150);
  assert.equal((await reqs(app.page)).length, 1, 'still fresh');
  await app.page.clock.fastForward(11 * 60e3); // past 30 min minus the 60 s margin
  assert.equal(await app.ev('hasFreshSyncToken()'), false);
  await tap(app.page);
  await app.until(`hasFreshSyncToken()`, { what: 'renewed', timeout: 20000 });
  const r = await reqs(app.page);
  assert.equal(r.length, 2, 'one new request');
  assert.equal(r[1].prompt, ''); assert.equal(r[1].login_hint, EMAIL);
  await app.until(SYNCED, { what: 'push after the renewal', timeout: 20000 });
  assert.equal(app.drive.byName('sth-userdata-v1.json').length, 1, 'no second sync file');
});

for (const [mode, text] of [['blocked', /blocked/i], ['closed', /closed/i], ['cancel', /cancel/i]]) {
  t.test(`window ${mode}: one toast, the Re-connect button and Sign out link, and no retry on later taps`, async (h) => {
    const app = await h.newApp({ now: AFTER, seed: SEED });
    await app.until(`!!state.driveSyncClient`);
    await app.page.evaluate((m) => { window.__gis.mode = m; }, mode);
    await tap(app.page);
    await app.until(`state.syncAuto === false`, { what: 'automatic try over' });
    assert.match(await toastText(app.page), text);
    assert.equal(await signedOutShown(app.page), true);
    assert.equal(await btnText(app.page), 'Re-connect Google');
    assert.equal(await linkShown(app.page), true);
    for (let i = 0; i < 3; i++) await tap(app.page);
    await app.page.keyboard.press('ArrowDown');
    await sleep(300);
    assert.equal((await reqs(app.page)).length, 1, 'no retry loop');
    // the button is the explicit way back
    await app.page.evaluate(() => { window.__gis.mode = 'ok'; });
    await app.page.click('#btnSyncSignIn');
    await app.until(SYNCED, { what: 'reconnected by the button', timeout: 20000 });
    const r = await reqs(app.page);
    assert.equal(r.length, 2);
    assert.equal(r[1].login_hint, EMAIL, 'the button also hints the account');
    assert.equal(await app.ev('state.syncAuto'), true, 'a success re-arms renewals');
    assert.equal(await linkShown(app.page), false);
  });
}

t.test('a stored account without an e-mail cannot be renewed by itself: the button shows from the start', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: { sth_sync_user: JSON.stringify({ name: 'No Mail' }) } });
  await app.until(`!!state.driveSyncClient`);
  assert.equal(await btnText(app.page), 'Re-connect Google');
  assert.equal(await linkShown(app.page), true);
  await tap(app.page);
  await sleep(200);
  assert.equal((await reqs(app.page)).length, 0);
});

t.test('a second tab gets the token without a popup (open before and after the first tap)', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  const p2 = await openTab(app);
  await until(p2, `!!state.driveSyncClient`);
  await tap(app.page);
  await app.until(SYNCED, { timeout: 20000 });
  await until(p2, `hasFreshSyncToken()`, { what: 'tab 2 got the token' });
  await until(p2, SYNCED, { what: 'tab 2 synced', timeout: 20000 });
  assert.equal((await reqs(p2)).length, 0, 'tab 2 asked Google for nothing');
  const tok1 = await app.ev('state.driveSyncToken');
  assert.equal(await ev(p2, 'state.driveSyncToken'), tok1);
  assert.equal(await ev(p2, 'state.driveSyncTokenExpiresAt'), await app.ev('state.driveSyncTokenExpiresAt'));
  // a tab opened later asks the others when it starts
  const p3 = await openTab(app);
  await until(p3, `hasFreshSyncToken()`, { what: 'tab 3 got the token' });
  assert.equal((await reqs(p3)).length, 0);
  await p3.locator('.main-area').click({ position: { x: 3, y: 3 }, force: true });
  await sleep(200);
  assert.equal((await reqs(p3)).length, 0, 'tab 3 taps without a request');
});

t.test('a token shared by a tab of another account is not taken', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  const before = await app.ev('state.driveSyncToken');
  await app.page.evaluate(() => {
    const ch = new BroadcastChannel('sth-gtoken');
    ch.postMessage({ type: 'token', tab: 'zzzz', token: 'foreign', exp: Date.now() + 3e6, email: 'other@example.test' });
    ch.postMessage({ type: 'token', tab: 'zzzz', token: 'expired', exp: Date.now() - 1000, email: 'tester@example.test' });
    ch.close();
  });
  await sleep(300);
  assert.equal(await app.ev('state.driveSyncToken'), before);
  assert.equal(await app.ev('state.driveSyncToken'), null);
});

t.test('wrong account: nothing is merged, the token is dropped and revoked, Re-connect and Sign out are shown', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  app.drive.add('sth-userdata-v1.json', { kbItems: [], tutorChats: [], createdDocs: [], removedDocIds: [], syncedAt: 1 });
  await app.until(`!!state.driveSyncClient`);
  await app.page.evaluate(() => { window.__gis.mode = 'otherAccount'; });
  const filesBefore = JSON.stringify([...app.drive.files.values()]);
  await tap(app.page);
  await app.until(`state.syncAuto === false`, { what: 'mismatch handled' });
  assert.match(await toastText(app.page), /different Google account \(other@example\.test\)\. Sign out of sync first/);
  assert.equal(await app.ev('state.driveSyncToken'), null);
  const drivePaths = app.drive.log.map(l => new URL(l.url).pathname);
  assert.deepEqual(drivePaths, ['/oauth2/v3/userinfo'], 'only the account check; no Drive file was read or written');
  assert.equal(JSON.stringify([...app.drive.files.values()]), filesBefore, 'Drive untouched');
  assert.deepEqual(await app.page.evaluate(() => window.__gis.revoked), ['fake-other-token']);
  assert.equal(await stored(app.page, 'sth_sync_user'), USER, 'the stored account is unchanged');
  assert.equal(await btnText(app.page), 'Re-connect Google');
  assert.equal(await linkShown(app.page), true);
  // the explicit button with the wrong account is refused the same way
  await app.page.click('#btnSyncSignIn');
  await app.until(`(window.__gis.requests.length === 2) && !syncTokenInflight`);
  await sleep(200);
  assert.equal(await app.ev('state.driveSyncToken'), null);
  assert.deepEqual(app.drive.log.map(l => new URL(l.url).pathname), ['/oauth2/v3/userinfo', '/oauth2/v3/userinfo']);
  // the right account works again
  await app.page.evaluate(() => { window.__gis.mode = 'ok'; });
  await app.page.click('#btnSyncSignIn');
  await app.until(SYNCED, { timeout: 20000 });
});

t.test('export reuses the sync token: no second window, and one request when both are open at once', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await tap(app.page);
  await app.until(SYNCED, { timeout: 20000 });
  assert.equal((await reqs(app.page)).length, 1);
  const tok = await app.ev('state.driveSyncToken');
  assert.equal(await app.ev('ensureGoogleToken()'), tok, 'export gets the sync token');
  // the real export button
  await app.ev(`(() => { state.resultMode = 'template'; state.resultText = '# Title\\n\\nSome text.'; return true; })()`);
  const popup = app.page.waitForEvent('popup', { timeout: 10000 }).catch(() => null);
  await app.ev(`triggerGoogleExport()`);
  await app.waitNode(() => app.drive.log.some(l => l.method === 'POST' && /docs\.googleapis\.com\/v1\/documents$/.test(l.url)), { what: 'Doc created' });
  await popup;
  assert.equal((await reqs(app.page)).length, 1, 'no window for the export');
  assert.equal((await reqs(app.page)).filter(r => !/appdata/.test(r.scope)).length, 0, 'the export client was never asked');
  // token ended, a connected user exports: the sync request is used (hinted), not the export client
  await app.page.clock.fastForward(61 * 60e3);
  const first = app.ev(`ensureGoogleToken()`);
  const second = app.ev(`ensureGoogleToken()`);
  assert.equal(await first, 'fake-drive-token');
  assert.equal(await second, 'fake-drive-token');
  const r = await reqs(app.page);
  assert.equal(r.length, 2, 'one new request for two callers');
  assert.match(r[1].scope, /drive\.appdata/);
  assert.equal(r[1].login_hint, EMAIL);
});

t.test('someone who never connected still exports with the export client', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.until(`!!state.googleTokenClient`);
  assert.equal(await app.ev('ensureGoogleToken()'), 'fake-drive-token');
  const r = await reqs(app.page);
  assert.equal(r.length, 1);
  assert.doesNotMatch(r[0].scope, /appdata/);
});

t.test('401 from background sync is quiet ("Paused"), the next tap renews; a token Google refuses is not retried by itself', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await tap(app.page);
  await app.until(SYNCED, { timeout: 20000 });
  app.drive.token = 'rotated'; // Google ended the token
  await app.ev('pushToDrive()');
  assert.match(await status(app.page), /Paused/);
  assert.equal(await signedOutShown(app.page), false, 'no Re-connect button for a plain expiry');
  assert.equal(await app.ev('state.driveSyncToken'), null);
  await app.page.evaluate(() => { window.__gis.token = 'rotated'; });
  await tap(app.page);
  await app.until(SYNCED, { what: 'renewed after a 401', timeout: 20000 });
  assert.equal((await reqs(app.page)).length, 2);
  // a 403 (not an expiry) is never retried by itself
  app.drive.token = 'blocked-now';
  await app.page.evaluate(() => { window.__gis.token = 'blocked-now'; });
  const origHandle = app.drive.handle.bind(app.drive);
  app.drive.handle = async (route) => { // answer 403 to the Drive file calls only
    const u = new URL(route.request().url());
    if (u.hostname === 'www.googleapis.com' && u.pathname.startsWith('/drive/v3/files')) return route.fulfill({ status: 403, headers: { 'access-control-allow-origin': '*' }, body: '{}' });
    return origHandle(route);
  };
  await app.ev('state.driveSyncToken = null; state.driveSyncTokenExpiresAt = 0; true');
  await tap(app.page);
  await app.until(`state.syncAuto === false`, { what: 'refused token ends the automatic tries', timeout: 20000 });
  assert.equal(await btnText(app.page), 'Re-connect Google');
  const n = (await reqs(app.page)).length;
  await tap(app.page); await tap(app.page);
  await sleep(200);
  assert.equal((await reqs(app.page)).length, n, 'no tap loop');
});

t.test('sign-out in one tab reaches the others: token dropped, stored e-mail cleared, no further requests', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  const p2 = await openTab(app);
  await until(p2, `!!state.driveSyncClient`);
  await tap(app.page);
  await app.until(SYNCED, { timeout: 20000 });
  await until(p2, SYNCED, { timeout: 20000 });
  await app.page.click('#btnSyncSignOut');
  await until(p2, `state.driveSyncToken === null && state.syncAuto === false`, { what: 'tab 2 signed out' });
  assert.equal(await stored(app.page, 'sth_sync_user'), null, 'stored e-mail cleared');
  assert.equal(await stored(p2, 'sth_sync_user'), null);
  assert.equal(await signedOutShown(p2), true, 'tab 2 shows signed-out');
  assert.equal(await btnText(p2), 'Sync across devices');
  assert.equal(await linkShown(p2), false, 'link hidden on tab 2');
  assert.equal(await app.ev('state.driveSyncToken'), null);
  assert.equal((await app.page.evaluate(() => window.__gis.revoked)).length >= 1, true, 'the signing-out tab revoked the token');
  await p2.locator('.main-area').click({ position: { x: 3, y: 3 }, force: true });
  await app.page.mouse.click(400, 400);
  await sleep(300);
  assert.equal((await reqs(p2)).length, 0, 'tab 2 asks nothing after sign-out');
  assert.equal((await reqs(app.page)).length, 1);
  // a reload does not reconnect either
  await app.reload();
  assert.equal(await app.ev('state.syncAuto'), false);
});

t.test('"Sign out" in the Re-connect view clears the account and the link goes away', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await app.page.evaluate(() => { window.__gis.mode = 'blocked'; });
  await tap(app.page);
  await app.until(`state.syncAuto === false`);
  assert.equal(await linkShown(app.page), true);
  assert.equal(await app.page.evaluate(() => document.getElementById('btnSyncSignOutLink').textContent.trim()), 'Sign out');
  await app.page.click('#btnSyncSignOutLink');
  await app.until(`!storageGet('sth_sync_user')`, { what: 'stored account removed' });
  assert.equal(await btnText(app.page), 'Sync across devices');
  assert.equal(await linkShown(app.page), false);
  assert.equal(await signedOutShown(app.page), true);
  assert.match(await toastText(app.page), /Signed out/);
  await app.page.reload();
  await app.ready();
  assert.equal(await app.ev('state.syncAuto'), false, 'a reload does not reconnect');
  assert.equal(await btnText(app.page), 'Sync across devices');
});

t.test('no Google token is ever written to localStorage, sessionStorage or IndexedDB', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  const p2 = await openTab(app);
  await until(p2, `!!state.driveSyncClient`);
  await tap(app.page);
  await app.until(SYNCED, { timeout: 20000 });
  await until(p2, SYNCED, { timeout: 20000 });
  await app.ev(`ensureGoogleToken()`);
  await app.ev(`tabSync.post('kb')`);
  await sleep(300);
  for (const page of [app.page, p2]) {
    const dump = await page.evaluate(async () => {
      const out = [];
      for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) out.push(s.key(i), s.getItem(s.key(i)));
      const dbs = indexedDB.databases ? await indexedDB.databases() : [];
      for (const d of dbs) {
        const db = await new Promise((res, rej) => { const r = indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        for (const name of db.objectStoreNames) {
          const rows = await new Promise((res) => { const q = db.transaction(name).objectStore(name).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); });
          out.push(name);
          try { out.push(JSON.stringify(rows)); } catch { /* blobs */ }
        }
        db.close();
      }
      return out.join('\n');
    });
    assert.ok(dump.length > 100, 'something was scanned');
    assert.equal(/fake-drive-token|fake-other-token/.test(dump), false, 'the token is memory-only');
  }
});

t.test('the Re-connect button and a second press share one request', async (h) => {
  const app = await h.newApp({ now: AFTER, seed: SEED });
  await app.until(`!!state.driveSyncClient`);
  await app.page.evaluate(() => { window.__gis.mode = 'blocked'; });
  await tap(app.page);
  await app.until(`state.syncAuto === false`);
  await app.page.evaluate(() => { window.__gis.mode = 'hold'; });
  await app.page.click('#btnSyncSignIn');
  await app.page.click('#btnSyncSignIn', { force: true });
  await app.until(`!!syncTokenInflight`);
  assert.equal((await reqs(app.page)).length, 2, 'blocked try + one button request (a second press joins)');
  await app.page.evaluate(() => { window.__gis.mode = 'ok'; window.__gis.complete('ok'); });
  await app.until(SYNCED, { timeout: 20000 });
});

t.run();
