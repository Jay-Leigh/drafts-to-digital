'use strict';
// C1: auto-pull and safe sync merging. Two simulated devices (two browser contexts) share ONE fake Drive.
// Covers: merge-before-push (no clobbering of the other device's KB items and chats), the local three-way base (a deletion on one device reaches the
// other and never comes back), conflicts keep both, auto-pull on tab return / every 5 minutes (fake clock), only when visible, connected and with a
// fresh token (a pull never asks Google), the version check (no download when nothing changed), no write when nothing changed, loop guard,
// one sync at a time across tabs (Web Lock), storage blocked / offline, study aids still sync and their deletion propagates.
const { suite, assert, FakeDrive } = require('../lib/harness');
const { connectDrive, studioItem, AFTER } = require('../lib/common');

const t = suite('15-sync-merge');
const FILE = 'sth-userdata-v1.json';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fileData = (drive) => drive.json(drive.byName(FILE)[0].id);
const fileKb = (drive) => fileData(drive).kbItems.map(i => i.id).sort();
const fileChats = (drive) => fileData(drive).tutorChats.map(c => c.id).sort();
const kbIds = (app) => app.ev(`kb.cache.map(i => i.id).sort()`);
const chatIds = (app) => app.ev(`tutor.chats.map(c => c.id).sort()`);
const writes = (drive) => drive.log.filter(l => l.method === 'PATCH' && /\/upload\/drive\/v3\/files\//.test(l.url)).length;
const downloads = (drive) => drive.log.filter(l => l.method === 'GET' && /alt=media/.test(l.url)).length;
const versionChecks = (drive) => drive.log.filter(l => l.method === 'GET' && /fields=version/.test(l.url)).length;
const pull = (app) => app.ev(`syncEnqueue('pull')`);
const push = (app) => app.ev(`pushToDrive()`);
const status = (app) => app.page.evaluate(() => document.getElementById('syncStatus').textContent);
const setVisible = (app, v) => app.page.evaluate((x) => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => x }); document.dispatchEvent(new Event('visibilitychange')); }, v);

async function addKb(app, id, name = `${id}.txt`) { await app.seedKb([app.h.fx.kbItem(name, { tokens: 40, id })]); }
async function addChat(app, id, title) { await app.ev(`tutor.newChatFor({ id: ${JSON.stringify(id)}, title: ${JSON.stringify(title || id)} })`); }
async function say(app, chatId, msgId, text) {
  await app.ev(`(async () => { const c = tutor.chats.find(x => x.id === ${JSON.stringify(chatId)}); c.messages.push({ id: ${JSON.stringify(msgId)}, ts: Date.now(), role: 'user', text: ${JSON.stringify(text)} }); c.updated = Date.now(); await tutor.persist(); })()`);
}
async function removeKb(app, id) { await app.ev(`kb.remove(${JSON.stringify(id)})`); }
async function removeChat(app, id) { await app.ev(`(async () => { tutor.chats = tutor.chats.filter(c => c.id !== ${JSON.stringify(id)}); await tutor.save([${JSON.stringify(id)}]); })()`); }

// a device: a page of its own (own storage and clock) on the shared Drive, connected to Google sync
async function device(h, drive, over = {}) {
  const app = await h.newApp({ drive, now: AFTER, ...over });
  app.h = h;
  return app;
}
async function connected(h, drive, over = {}) {
  const app = await device(h, drive, over);
  await connectDrive(app);
  return app;
}

// ── pure rules ──
t.test('the three-way rules (pure): deleted elsewhere, deleted here, edit wins, no base = join, unreadable file never shortens', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const r = await app.page.evaluate(() => {
    const T = window.__t;
    const item = (id, t, name) => ({ id, timestamp: t, name: name || id });
    const tm = (x) => x.updatedAt || x.timestamp || 0;
    const pair = (l, r2) => (tm(l) >= tm(r2) ? l : r2);
    const ids = (o) => o.list.map(x => x.id).sort();
    const run = (local, remote, o) => T.syncThreeWay(local, remote, { reliable: true, removed: {}, t: tm, pair, ...o });
    const out = {};
    // in base, gone from the file, unchanged here -> deleted here too
    out.deletedElsewhere = run([item('a', 10), item('b', 10)], [item('b', 10)], { base: { a: 10, b: 10 } });
    // in base, gone from the file, edited here after the base -> kept
    out.editWins = run([item('a', 50)], [], { base: { a: 10 } });
    // never synced here (not in the base), gone from the file -> a new local item, kept
    out.newLocal = run([item('n', 99)], [], { base: { a: 10 } });
    // in base, gone here, still in the file unchanged -> deleted here: not taken back
    out.deletedHere = run([], [item('a', 10)], { base: { a: 10 } });
    // ... but edited in the file since -> taken
    out.deletedHereEdited = run([], [item('a', 77)], { base: { a: 10 } });
    // the removed map alone (no base) also keeps it out; an item edited after the removal comes back
    out.removedMap = run([], [item('z', 5), item('y', 500)], { base: null, removed: { z: 100, y: 100 } });
    // no base: a plain join, nothing shortened
    out.join = run([item('l', 1)], [item('r', 1)], { base: null });
    // unreadable / unreliable file: never shortens even with a base
    out.unreliable = run([item('a', 10)], [], { base: { a: 10 }, reliable: false });
    // the keep hook (a chat that is answering)
    out.keep = run([item('a', 10)], [], { base: { a: 10 }, keep: () => true });
    // equal times, different names: both orders pick the same copy
    const a = { id: 'x', type: 'txt', name: 'alpha', timestamp: 5 }, b = { id: 'x', type: 'txt', name: 'beta', timestamp: 5 };
    out.tie = [T.syncKbPair(a, b).name, T.syncKbPair(b, a).name];
    return { deletedElsewhere: [ids(out.deletedElsewhere), out.deletedElsewhere.dropped], editWins: ids(out.editWins), newLocal: ids(out.newLocal), deletedHere: ids(out.deletedHere), deletedHereEdited: ids(out.deletedHereEdited),
      removedMap: ids(out.removedMap), join: ids(out.join), unreliable: ids(out.unreliable), keep: ids(out.keep), tie: out.tie };
  });
  assert.deepEqual(r.deletedElsewhere, [['b'], ['a']]);
  assert.deepEqual(r.editWins, ['a']);
  assert.deepEqual(r.newLocal, ['n']);
  assert.deepEqual(r.deletedHere, []);
  assert.deepEqual(r.deletedHereEdited, ['a']);
  assert.deepEqual(r.removedMap, ['y']);
  assert.deepEqual(r.join, ['l', 'r']);
  assert.deepEqual(r.unreliable, ['a']);
  assert.deepEqual(r.keep, ['a']);
  assert.equal(r.tie[0], r.tie[1], 'the same copy wins on both devices');
});

// ── two devices ──
t.test('B adds a KB item and a chat; A pulls them without overwriting its own (no write needed)', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await addKb(A, 'k_a'); await addChat(A, 'c_a', 'Chat A');
  await connectDrive(A);
  const B = await connected(h, drive);
  assert.deepEqual(await kbIds(B), ['k_a'], 'B received A\'s item at its first sync');
  await addKb(B, 'k_b'); await addChat(B, 'c_b', 'Chat B');
  await push(B);
  assert.deepEqual(fileKb(drive), ['k_a', 'k_b']);
  const w = writes(drive);
  const res = await pull(A);
  assert.deepEqual(await kbIds(A), ['k_a', 'k_b']);
  assert.deepEqual(await chatIds(A), ['c_a', 'c_b']);
  assert.equal(await A.ev(`tutor.chats.find(c => c.id === 'c_a').title`), 'Chat A', 'its own chat is untouched');
  assert.equal(res.wrote, false, 'nothing to write back');
  assert.equal(writes(drive), w, 'no write by the pull');
  assert.match(await status(A), /^Synced/);
});

t.test('A deletes a KB item and a chat; B receives the deletions; they never come back, also after B pushes', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await addKb(A, 'k_x'); await addKb(A, 'k_keep'); await addChat(A, 'c_x'); await addChat(A, 'c_keep');
  await connectDrive(A);
  const B = await connected(h, drive);
  assert.deepEqual(await kbIds(B), ['k_keep', 'k_x']);
  await removeKb(A, 'k_x'); await removeChat(A, 'c_x');
  await push(A);
  assert.deepEqual(fileKb(drive), ['k_keep'], 'the file no longer holds the deleted item');
  assert.deepEqual(fileChats(drive), ['c_keep']);
  await pull(B);
  assert.deepEqual(await kbIds(B), ['k_keep'], 'deleted on B too');
  assert.deepEqual(await chatIds(B), ['c_keep']);
  assert.deepEqual(await B.ev(`kb.store.getItem('knowledge_bay_removed').then(m => Object.keys(m))`), ['k_x'], 'recorded as removed so another tab does not bring it back');
  // B now adds something and pushes: the deleted ones stay out of the file and A
  await addKb(B, 'k_new'); await push(B);
  assert.deepEqual(fileKb(drive), ['k_keep', 'k_new']);
  await pull(A);
  assert.deepEqual(await kbIds(A), ['k_keep', 'k_new']);
  assert.deepEqual(await chatIds(A), ['c_keep']);
  // a reload of B reads the same lists from its own storage
  await B.reload();
  assert.deepEqual(await kbIds(B), ['k_keep', 'k_new']);
});

t.test('B pushes without having pulled: the deletion made on A is applied, not undone', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await addKb(A, 'k_x'); await addKb(A, 'k_keep'); await addChat(A, 'c_x');
  await connectDrive(A);
  const B = await connected(h, drive);
  await removeKb(A, 'k_x'); await removeChat(A, 'c_x');
  await push(A);
  await addKb(B, 'k_b');
  await push(B); // merges first: k_x and c_x were unchanged on B, so they go
  assert.deepEqual(fileKb(drive), ['k_b', 'k_keep']);
  assert.deepEqual(fileChats(drive), []);
  assert.deepEqual(await kbIds(B), ['k_b', 'k_keep']);
  assert.deepEqual(await chatIds(B), []);
});

t.test('an edit on B beats a delete on A (kept, and it comes back to A with the edit)', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await addKb(A, 'k_x'); await addKb(A, 'k_keep');
  await connectDrive(A);
  const B = await connected(h, drive);
  await removeKb(A, 'k_x');
  await push(A);
  await B.advance(120000, { step: 20000 }); // B's clock is later than A's delete
  await B.ev(`kb.rename('k_x', 'Renamed on B')`);
  await pull(B);
  assert.equal(await B.ev(`kb.cache.find(i => i.id === 'k_x').name`), 'Renamed on B', 'kept');
  assert.ok(fileKb(drive).includes('k_x'), 'written back');
  await pull(A);
  assert.equal(await A.ev(`(kb.cache.find(i => i.id === 'k_x') || {}).name`), 'Renamed on B', 'A takes the edited item back');
});

t.test('simultaneous changes keep both: items of both devices, and the messages of both in a shared chat', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await addChat(A, 'c_s', 'Shared'); await say(A, 'c_s', 'm0', 'first');
  await connectDrive(A);
  const B = await connected(h, drive);
  await addKb(A, 'k_a2'); await say(A, 'c_s', 'mA', 'from A');
  await addKb(B, 'k_b2'); await say(B, 'c_s', 'mB', 'from B');
  await push(A);
  await push(B);
  await pull(A);
  for (const dev of [A, B]) {
    assert.deepEqual(await kbIds(dev), ['k_a2', 'k_b2']);
    assert.deepEqual(await dev.ev(`tutor.chats.find(c => c.id === 'c_s').messages.map(m => m.id).sort()`), ['m0', 'mA', 'mB']);
  }
  assert.deepEqual(fileKb(drive), ['k_a2', 'k_b2']);
  assert.equal(fileData(drive).tutorChats[0].messages.length, 3);
});

t.test('a push does not clobber items it has not seen (merge before write)', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await addKb(B, 'k_b'); await addChat(B, 'c_b');
  await push(B);
  await addKb(A, 'k_a'); await addChat(A, 'c_a'); // A never pulled
  await push(A);
  assert.deepEqual(fileKb(drive), ['k_a', 'k_b']);
  assert.deepEqual(fileChats(drive), ['c_a', 'c_b']);
  assert.deepEqual(await kbIds(A), ['k_a', 'k_b'], 'and A has B\'s now');
});

t.test('another device writes between the read and the write: the push reads and merges again instead of overwriting', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  await addKb(A, 'k_a3');
  const id = drive.byName(FILE)[0].id;
  const orig = drive.handle.bind(drive);
  let checks = 0;
  drive.handle = async (route) => {
    const req = route.request();
    if (req.method() === 'GET' && /fields=version/.test(req.url())) {
      checks++;
      if (checks === 2) { const d = drive.json(id); d.kbItems.push(h.fx.kbItem('inj.txt', { id: 'k_inj' })); drive.put(id, d); } // the other device's write, right before ours
    }
    return orig(route);
  };
  const w = writes(drive);
  await push(A);
  assert.deepEqual(fileKb(drive), ['k_a3', 'k_inj'], 'nothing lost');
  assert.deepEqual(await kbIds(A), ['k_a3', 'k_inj']);
  assert.equal(writes(drive) - w, 1, 'one write, after the second read');
  assert.ok(checks >= 4, `read, check, read again, check (${checks})`);
});

// ── auto-pull ──
t.test('auto-pull: on return to the tab, and every 5 minutes while visible; never while hidden', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  // 1 — the tab was hidden, then visible again (more than a minute after the last round)
  await addKb(B, 'k_1'); await push(B);
  await A.advance(70000, { step: 10000 });
  await setVisible(A, 'hidden');
  await sleep(100);
  assert.deepEqual(await kbIds(A), [], 'hidden: nothing pulled');
  const d0 = downloads(drive);
  await setVisible(A, 'visible');
  await A.until(`kb.cache.some(i => i.id === 'k_1')`, { what: 'pulled on return' });
  assert.equal(downloads(drive), d0 + 1);
  // 2 — the 5-minute timer, no event at all
  await addKb(B, 'k_2'); await push(B);
  await A.advance(3.8 * 60000, { step: 10000 });
  assert.deepEqual(await kbIds(A), ['k_1'], 'not yet (the timer is 5 minutes, jitter at most 20 % early)');
  await A.advance(2.4 * 60000, { step: 10000 }); // 6.2 min in all: past the latest possible tick
  await A.until(`kb.cache.some(i => i.id === 'k_2')`, { what: 'pulled by the timer' });
  // 3 — hidden: the timer ticks but nothing is requested
  await addKb(B, 'k_3'); await push(B);
  await setVisible(A, 'hidden');
  const log0 = drive.log.length;
  await A.advance(7 * 60000, { step: 10000 });
  assert.equal(drive.log.length, log0, 'no request at all while hidden');
  assert.deepEqual((await kbIds(A)).includes('k_3'), false);
  await setVisible(A, 'visible');
  await A.until(`kb.cache.some(i => i.id === 'k_3')`, { what: 'pulled when visible again' });
  assert.match(await status(A), /^Synced/);
});

t.test('a quiet pull: calm status, no toast, no spinner stuck, and a return within a minute pulls nothing', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await A.ev(`window.__toasts = []; const o = showToast; showToast = (...a) => { window.__toasts.push(a[0]); return o(...a); }; true`);
  await addKb(B, 'k_1'); await push(B);
  await A.advance(70000, { step: 10000 });
  await setVisible(A, 'hidden'); await setVisible(A, 'visible');
  await A.until(`kb.cache.some(i => i.id === 'k_1')`);
  await A.until(`!document.getElementById('syncSection').getAttribute('aria-busy') || document.getElementById('syncSection').getAttribute('aria-busy') === 'false'`);
  assert.deepEqual(await A.page.evaluate(() => window.__toasts), [], 'no toast for a pull');
  assert.match(await status(A), /^Synced \u2014 \d\d:\d\d/);
  const v = versionChecks(drive);
  await setVisible(A, 'hidden'); await setVisible(A, 'visible'); // inside the 60 s gap
  await sleep(200);
  assert.equal(versionChecks(drive), v, 'no second check within a minute of the last round');
});

t.test('not connected: the timer and tab return do nothing (no Drive request, no Google request)', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await A.advance(7 * 60000, { step: 10000 });
  await setVisible(A, 'hidden'); await setVisible(A, 'visible');
  await sleep(200);
  assert.equal(drive.log.length, 0);
  assert.equal(await A.page.evaluate(() => window.__gis ? window.__gis.requests.length : 0), 0);
});

t.test('no fresh token: a pull is skipped quietly and never asks Google for one', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await A.ev(`SYNC_SILENT_NO_GESTURE = false; state.driveSyncTokenExpiresAt = Date.now() - 1; hasFreshSyncToken()`);
  await addKb(B, 'k_1'); await push(B);
  const log0 = drive.log.length;
  const gis0 = await A.page.evaluate(() => window.__gis.requests.length);
  const statusBefore = await status(A);
  await A.advance(70000, { step: 10000 });
  await setVisible(A, 'hidden'); await setVisible(A, 'visible');
  await A.advance(6.5 * 60000, { step: 10000 });
  const direct = await pull(A);
  assert.deepEqual(direct, { skipped: 'no-token' });
  assert.equal(drive.log.length, log0, 'no Drive request');
  assert.equal(await A.page.evaluate(() => window.__gis.requests.length), gis0, 'no Google request');
  assert.deepEqual(await kbIds(A), []);
  assert.equal(await status(A), statusBefore, 'status untouched');
});

t.test('with the silent renewal: the renewal (prompt none) is the only Google request, and the merge it starts brings the other device\'s items', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await addKb(B, 'k_1'); await push(B);
  await A.ev(`SYNC_SILENT_NO_GESTURE = true; state.driveSyncTokenExpiresAt = Date.now() - 1; true`);
  const gis0 = await A.page.evaluate(() => window.__gis.requests.length);
  await A.advance(70000, { step: 10000 });
  await setVisible(A, 'hidden'); await setVisible(A, 'visible');
  await A.until(`kb.cache.some(i => i.id === 'k_1')`, { what: 'merged after the silent renewal', timeout: 20000 });
  const reqs = (await A.page.evaluate(() => window.__gis.requests.slice())).slice(gis0);
  assert.equal(reqs.length, 1, 'one request');
  assert.equal(reqs[0].prompt, 'none', 'silent, no window');
  assert.match(await status(A), /^Synced/);
});

t.test('the version check: nothing is downloaded when the file did not change; a pull that changes nothing writes nothing', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await addKb(A, 'k_a');
  await connectDrive(A);
  const B = await connected(h, drive);
  assert.equal(writes(drive), 0, 'B\'s first sync found nothing to write');
  const d = downloads(drive), w = writes(drive), v = versionChecks(drive);
  assert.deepEqual(await pull(A), { unchanged: true });
  assert.deepEqual(await pull(A), { unchanged: true });
  assert.equal(downloads(drive), d, 'no download');
  assert.equal(writes(drive), w, 'no write');
  assert.equal(versionChecks(drive) - v, 2, 'one small request per pull');
  await addKb(B, 'k_b'); await push(B);
  const w2 = writes(drive), d2 = downloads(drive);
  const res = await pull(A);
  assert.equal(res.wrote, false);
  assert.equal(res.merged, true);
  assert.equal(downloads(drive), d2 + 1, 'one download');
  assert.equal(writes(drive), w2, 'merged, nothing to write back');
  assert.deepEqual(await pull(A), { unchanged: true }, 'the file version is remembered');
  assert.equal(downloads(drive), d2 + 1);
});

t.test('no ping-pong: two devices that each hold something new settle after two writes and then only check versions', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await addKb(A, 'k_a'); await addChat(A, 'c_a', 'A'); await say(A, 'c_a', 'ma', 'hello');
  await addKb(B, 'k_b'); await addChat(B, 'c_b', 'B');
  await push(A); // write 1: A's news
  for (let i = 0; i < 4; i++) { await pull(B); await pull(A); } // B merges and writes the union (write 2); after that nobody has anything to write
  assert.equal(writes(drive), 2, 'A wrote its news, B merged and wrote the union; nobody wrote again');
  assert.deepEqual(await kbIds(A), ['k_a', 'k_b']);
  assert.deepEqual(await kbIds(B), ['k_a', 'k_b']);
  assert.deepEqual(await chatIds(A), ['c_a', 'c_b']);
  assert.deepEqual(await chatIds(B), ['c_a', 'c_b']);
  const d = downloads(drive);
  for (let i = 0; i < 3; i++) { await pull(A); await pull(B); }
  assert.equal(writes(drive), 2);
  assert.ok(downloads(drive) - d <= 1, 'at most one more download (the one that saw the last write)');
});

t.test('loop guard: after three writes by pulls in a row a pull only reads; the next push still writes', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await A.ev(`syncPullWrites = [Date.now(), Date.now(), Date.now()]; true`);
  await addKb(B, 'k_b'); await push(B);
  await addKb(A, 'k_local');
  const w = writes(drive);
  const res = await pull(A);
  assert.equal(res.wrote, false);
  assert.equal(writes(drive), w, 'the pull did not write');
  assert.deepEqual(await kbIds(A), ['k_b', 'k_local'], 'but it merged what it read');
  await push(A);
  assert.equal(writes(drive), w + 1);
  assert.deepEqual(fileKb(drive), ['k_b', 'k_local']);
});

// ── tabs ──
t.test('one sync at a time across tabs: a tab that finds the lock taken skips its pull (no request); the other tab\'s pull still works', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  // a second tab of device A, connected too
  const page2 = await A.context.newPage();
  await page2.goto(A.page.url());
  await page2.waitForFunction(() => window.__t && window.__t.authInitDone === true, null, { timeout: 20000 });
  const tab2 = Object.assign(Object.create(Object.getPrototypeOf(A)), A, { page: page2 });
  await tab2.until('!kb.loading && !tutor.loading && studio.ready');
  await tab2.ev(`requestSyncToken().then(() => true)`);
  await tab2.until(`/^Synced/.test(document.getElementById('syncStatus').textContent)`, { what: 'tab 2 synced', timeout: 20000 });
  await addKb(B, 'k_1'); await push(B);
  // tab 1 holds the lock (a round in progress)
  await A.page.evaluate(() => { window.__rel = null; navigator.locks.request('sth-drive-sync', () => new Promise(r => { window.__rel = r; })); });
  await A.until(`typeof window.__rel === 'function'`).catch(() => {});
  await sleep(100);
  const log0 = drive.log.length;
  const res = await pull(tab2);
  assert.deepEqual(res, { skipped: 'locked' });
  assert.equal(drive.log.length, log0, 'no request');
  await A.page.evaluate(() => window.__rel());
  await sleep(100);
  const res2 = await pull(tab2);
  assert.ok(res2 && !res2.skipped, 'works once the lock is free');
  assert.deepEqual(await kbIds(tab2), ['k_1']);
  // the other tab hears about it through the cross-tab post and shows it too
  await A.until(`kb.cache.some(i => i.id === 'k_1')`, { what: 'tab 1 refreshed from storage' });
  // a push waits for the lock instead of skipping
  await A.page.evaluate(() => { navigator.locks.request('sth-drive-sync', () => new Promise(r => { window.__rel = r; })); });
  await sleep(100);
  await addKb(tab2, 'k_2');
  const p = push(tab2);
  await sleep(300);
  assert.ok(!fileKb(drive).includes('k_2'), 'the push is waiting');
  await A.page.evaluate(() => window.__rel());
  await p;
  assert.ok(fileKb(drive).includes('k_2'));
});

// ── study aids ──
t.test('study aids keep syncing, and an aid deleted on one device is gone on the other and stays gone', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await A.seedItems([studioItem('mindmap', { id: 'mm_x' }), studioItem('quiz', { id: 'qz_keep' })]);
  await connectDrive(A);
  const B = await connected(h, drive);
  assert.equal(await B.ev(`studio.items.some(i => i.id === 'mm_x')`), true, 'the aid arrived');
  const del = A.ev(`studio.remove('mm_x')`);
  await A.confirm(true);
  await del;
  await push(A);
  assert.equal(drive.byName('sth-studio-mm_x.json').length, 0, 'its Drive file is gone');
  await pull(B);
  assert.equal(await B.ev(`studio.items.some(i => i.id === 'mm_x')`), false, 'deleted on B');
  assert.equal(await B.ev(`studio.items.some(i => i.id === 'qz_keep')`), true);
  await addKb(B, 'k_b'); await push(B);
  await pull(A);
  assert.equal(await A.ev(`studio.items.some(i => i.id === 'mm_x')`), false, 'did not come back');
  assert.ok(!fileData(drive).studio.items.some(i => i.id === 'mm_x'));
});

// ── storage and network trouble ──
t.test('the base is kept in the two existing IndexedDB stores (key sync_base), and sign-out removes it', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  await addKb(A, 'k_a'); await addChat(A, 'c_a');
  await connectDrive(A);
  const fid = await A.ev('getSyncFileId()');
  const kbBase = await A.ev(`kb.store.getItem('sync_base')`);
  const chatBase = await A.ev(`tutor.store.getItem('sync_base')`);
  assert.equal(kbBase.fid, fid);
  assert.deepEqual(Object.keys(kbBase.ids), ['k_a']);
  assert.deepEqual(Object.keys(chatBase.ids), ['c_a']);
  await A.ev(`signOutSync()`);
  await A.until(`(async () => { window.__gone = (await kb.store.getItem('sync_base')) === null && (await tutor.store.getItem('sync_base')) === null; return true; })() && window.__gone === true`, { what: 'base removed' });
});

t.test('localStorage blocked and the base store failing: sync and deletion propagation still work in memory, no crash', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await device(h, drive);
  await addKb(A, 'k_x'); await addKb(A, 'k_keep');
  await push(A);
  // B: localStorage unusable, and the base cannot be written to IndexedDB
  await B.page.evaluate(() => {
    const boom = () => { throw new DOMException('blocked', 'SecurityError'); };
    Storage.prototype.getItem = boom; Storage.prototype.setItem = boom; Storage.prototype.removeItem = boom;
  });
  await B.ev(`(() => { for (const s of [kb.store, tutor.store]) { const o = s.setItem.bind(s); s.setItem = (k, v) => k === 'sync_base' ? Promise.reject(new Error('quota')) : o(k, v); } return true; })()`);
  await connectDrive(B);
  assert.deepEqual(await kbIds(B), ['k_keep', 'k_x']);
  await removeKb(A, 'k_x'); await push(A);
  assert.deepEqual(await pull(B).then(r => !!r), true);
  assert.deepEqual(await kbIds(B), ['k_keep'], 'the deletion arrived through the in-memory base');
  assert.deepEqual(B.pageErrors, []);
});

t.test('offline: pulls and pushes fail quietly, nothing crashes, and it picks up again when the network is back', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await addKb(B, 'k_1'); await push(B);
  // offline: the page says so, and the requests fail
  const origHandle = drive.handle.bind(drive);
  drive.handle = async (route) => { try { await route.abort('internetdisconnected'); } catch { /* gone */ } };
  await A.page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false }));
  await A.advance(70000, { step: 10000 });
  const log0 = drive.log.length;
  await setVisible(A, 'hidden'); await setVisible(A, 'visible');
  await sleep(200);
  assert.equal(drive.log.length, log0, 'offline: no request is made');
  await A.page.evaluate(() => { delete navigator.onLine; });
  await A.page.evaluate(() => Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })); // the page believes it is online but the request fails
  const failed = await pull(A);
  assert.deepEqual(failed, { error: true });
  await addKb(A, 'k_off');
  await push(A);
  assert.match(await status(A), /Sync failed/);
  assert.deepEqual(A.pageErrors, []);
  drive.handle = origHandle;
  await A.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await A.until(`kb.cache.some(i => i.id === 'k_1')`, { what: 'pulled after coming back online' });
  await push(A);
  assert.deepEqual(fileKb(drive), ['k_1', 'k_off']);
  assert.match(await status(A), /^Synced/);
});

t.run();
