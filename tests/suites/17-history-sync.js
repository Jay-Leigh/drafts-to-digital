'use strict';
// C2: History documents sync like study aids. Two simulated devices (two browser contexts) share ONE fake Drive. Covers: a summary list in the sync file's `history`
// field plus one hidden file `sth-history-<id>.json` per entry (body read when opened), deletes reach every device and never come back, the expiry is worked out
// from each entry's own date on every device, deleted ids kept 31 days, an entry over the size ceiling stays on its device, both devices' entries are kept, no ping-pong,
// study aids unaffected, hostile text in the file cannot run, `kbSaved:` markers untouched, a newer field version is left alone, a field dropped by an older client
// does not delete anything.
const { suite, assert, FakeDrive } = require('../lib/harness');
const { connectDrive, studioItem, AFTER } = require('../lib/common');

const t = suite('17-history-sync');
const FILE = 'sth-userdata-v1.json';
const DAY = 86400e3;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const fileData = (drive) => drive.json(drive.byName(FILE)[0].id);
const field = (drive) => fileData(drive).history || null;
const bodies = (drive) => [...drive.files.values()].filter(f => /^sth-history-/.test(f.name));
const bodyOf = (drive, id) => drive.byName(`sth-history-${id}.json`);
const uploads = (drive) => drive.log.filter(l => l.method === 'POST' && /upload\/drive\/v3\/files\?uploadType=multipart/.test(l.url)).length;
const writes = (drive) => drive.log.filter(l => l.method === 'PATCH' && /\/upload\/drive\/v3\/files\//.test(l.url)).length;
const bodyReads = (drive) => drive.log.filter(l => l.method === 'GET' && /alt=media/.test(l.url) && [...drive.files.values()].some(f => /^sth-history-/.test(f.name) && l.url.includes(f.id))).length;
const pull = (app) => app.ev(`syncEnqueue('pull')`);
const push = (app) => app.ev(`pushToDrive()`);
const ids = (app) => app.ev(`getHistory().then(l => l.map(e => e.id).sort())`);
const entry = (app, id) => app.ev(`getHistory().then(l => l.find(e => e.id === ${JSON.stringify(id)}) || null)`);
// a document saved the way a tool run saves it; the debounced push is cancelled so the test decides when the sync runs
async function add(app, mode, text, names = ['essay.docx'], id) {
  const e = await app.ev(`saveToHistory(${JSON.stringify(mode)}, ${JSON.stringify(text)}, ${JSON.stringify(names)}${id ? `, ${JSON.stringify(id)}` : ''})`);
  await app.ev(`clearTimeout(state.driveSyncTimer)`);
  return e;
}
async function seed(app, list) {
  await app.ev(`(async () => { await _historyStore.setItem('entries', ${JSON.stringify(list)}); await refreshHistoryUi(); })()`);
}
const doc = (id, timestamp, over = {}) => ({ id, mode: 'template', resultText: `Result text of ${id}`, fileNames: ['notes.txt'], wordCount: 4, preview: `Preview of ${id}`, timestamp, ...over });
const now = (app) => app.ev('Date.now()');
async function device(h, drive, over = {}) { const app = await h.newApp({ drive, now: AFTER, ...over }); app.h = h; return app; }
async function connected(h, drive, over = {}) { const app = await device(h, drive, over); await connectDrive(app); return app; }
async function openHistory(app) {
  await app.page.click('#historyBtn');
  await app.until(`document.getElementById('historyPanel').classList.contains('open') && !document.getElementById('historyList').hasAttribute('aria-busy')`, { what: 'history open' });
  await app.page.waitForTimeout(400);
}
const rows = (app) => app.page.evaluate(() => [...document.querySelectorAll('#historyList .history-entry')].map(r => ({ id: r.dataset.id, kind: r.dataset.kind, badge: r.querySelector('.history-mode-badge').textContent.trim(), preview: r.querySelector('.history-entry-preview').textContent, meta: r.querySelector('.history-entry-meta').textContent })));
const modalText = (app) => app.page.evaluate(() => ({ open: document.getElementById('historyResultModal').classList.contains('open'), text: document.getElementById('historyResultBody').textContent }));
const rec = (app) => app.ev(`historyRec.load()`);
// the page clock takes steps of at most 24 days (a bigger number overflows inside it)
async function jump(app, ms) { for (let left = ms; left > 0; left -= 20 * DAY) await app.page.clock.fastForward(Math.min(left, 20 * DAY)); }

t.test('an entry made on A: a hidden file per entry, a summary in the sync file (nothing else), then it shows on B and opens like a local one', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const longTail = 'word '.repeat(60) + 'THE-END-MARKER';
  const e = await add(A, 'template', `# Outline\n\nFirst section about **cells**. ${longTail}`, ['essay.docx', 'brief.pdf']);
  await push(A);
  assert.equal(bodies(drive).length, 1);
  const f = drive.json(bodyOf(drive, e.id)[0].id);
  assert.deepEqual(f, { v: 1, id: e.id, mode: 'template', resultText: `# Outline\n\nFirst section about **cells**. ${longTail}` }, 'the hidden file holds the id, kind and result text only');
  const fld = field(drive);
  assert.equal(fld.v, 1);
  assert.deepEqual(Object.keys(fld.items[0]).sort(), ['bytes', 'driveFileId', 'fileNames', 'id', 'mode', 'preview', 'timestamp', 'wordCount'], 'the summary lists only what the privacy page names');
  assert.deepEqual(fld.items[0].fileNames, ['essay.docx', 'brief.pdf']);
  assert.ok(!JSON.stringify(fld).includes('THE-END-MARKER'), 'the result text is not in the sync file (only the short preview)');
  assert.ok(fld.items[0].preview.length <= 161);
  assert.deepEqual(fld.deleted, []);
  const B = await connected(h, drive);
  assert.deepEqual(await ids(B), [e.id], 'B has the entry');
  assert.equal((await entry(B, e.id)).resultText, undefined, 'its text is not downloaded yet');
  assert.equal(await B.ev(`document.getElementById('historyBtn').classList.contains('has-entries')`), true);
  await openHistory(B);
  const r = (await rows(B)).find(x => x.id === e.id);
  assert.equal(r.kind, 'document');
  assert.equal(r.badge, 'template');
  assert.equal(r.preview, (await entry(A, e.id)).preview, 'the same preview');
  assert.match(r.meta, /essay\.docx, brief\.pdf/);
  const before = bodyReads(drive);
  await B.page.click(`#historyList .history-entry[data-id="${e.id}"]`);
  await B.until(`document.getElementById('historyResultModal').classList.contains('open')`, { what: 'result opened' });
  assert.match((await modalText(B)).text, /First section about cells/, 'the text opens (rendered)');
  assert.equal(bodyReads(drive) - before, 1, 'read from Drive once');
  assert.ok((await entry(B, e.id)).resultText.endsWith('THE-END-MARKER'), 'now kept on this device');
  await B.page.click('#historyResultClose');
  await B.page.click(`#historyList .history-entry[data-id="${e.id}"]`);
  await B.until(`document.getElementById('historyResultModal').classList.contains('open')`);
  assert.equal(bodyReads(drive) - before, 1, 'the second time nothing is read');
  assert.deepEqual(B.pageErrors, []);
});

t.test('a document that was made before sync was connected goes up when sync connects', async (h) => {
  const drive = new FakeDrive();
  const A = await device(h, drive);
  const e = await add(A, 'transcribe', 'old transcription text');
  await connectDrive(A);
  assert.equal(bodies(drive).length, 1);
  assert.equal(field(drive).items[0].id, e.id);
  assert.ok((await entry(A, e.id)).driveFileId, 'the entry knows its hidden file');
});

t.test('a delete on A reaches B and never comes back (also after B pushes, and for "Clear documents")', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const keep = await add(A, 'template', 'keep me'), gone = await add(A, 'reviewer', 'delete me'), gone2 = await add(A, 'transcribe', 'also gone');
  await push(A);
  const B = await connected(h, drive);
  assert.deepEqual(await ids(B), [keep.id, gone.id, gone2.id].sort());
  await A.ev(`deleteHistoryEntry(${JSON.stringify(gone.id)})`);
  await push(A);
  assert.deepEqual(bodies(drive).map(f => f.name).sort(), [`sth-history-${gone2.id}.json`, `sth-history-${keep.id}.json`].sort(), 'its hidden file is deleted');
  assert.deepEqual(field(drive).items.map(i => i.id).sort(), [gone2.id, keep.id].sort());
  const tomb = field(drive).deleted.find(d => d.id === gone.id);
  assert.ok(tomb && Math.abs(tomb.at - await now(A)) < 60000, 'the id is listed as deleted with the time');
  assert.equal(tomb.driveFileId, undefined, 'the file id is dropped once the file is deleted');
  await pull(B);
  assert.deepEqual(await ids(B), [gone2.id, keep.id].sort(), 'gone on B');
  // B pushes something new: the deleted entry stays out of the file and out of A
  const fresh = await add(B, 'template', 'new on B');
  await push(B);
  await pull(A);
  assert.deepEqual(await ids(A), [fresh.id, gone2.id, keep.id].sort());
  assert.ok(!(await ids(B)).includes(gone.id));
  // clear the documents on A: every id is listed as deleted, every hidden file goes
  await A.ev(`clearAllHistory()`);
  await push(A);
  assert.equal(bodies(drive).length, 0);
  assert.deepEqual(field(drive).items, []);
  assert.equal(field(drive).deleted.length, 4);
  await pull(B);
  assert.deepEqual(await ids(B), []);
  await push(B);
  assert.deepEqual(await ids(A), [], 'nothing resurrected by B');
});

t.test('a delete made on B of an entry that came from A: A follows', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const e = await add(A, 'reviewer', 'review text');
  await push(A);
  const B = await connected(h, drive);
  assert.deepEqual(await ids(B), [e.id]);
  await B.ev(`deleteHistoryEntry(${JSON.stringify(e.id)})`);
  await push(B);
  assert.equal(bodies(drive).length, 0, 'B deleted the hidden file it only knew from the summary');
  await pull(A);
  assert.deepEqual(await ids(A), []);
  await push(A);
  assert.deepEqual(await ids(B), []);
  assert.deepEqual(field(drive).items, []);
});

t.test('an entry deleted while sync was off for a moment (the tab was reloaded before the push): the delete is remembered and still reaches B', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const e = await add(A, 'template', 'to be deleted');
  await push(A);
  const B = await connected(h, drive);
  await A.ev(`deleteHistoryEntry(${JSON.stringify(e.id)})`);
  await A.ev(`clearTimeout(state.driveSyncTimer)`);
  assert.ok((await rec(A)).removed[e.id], 'remembered on this device');
  await A.reload();
  assert.deepEqual(await ids(A), []);
  await A.ev(`requestSyncToken().then(() => true)`);
  await A.until(`/^Synced/.test(document.getElementById('syncStatus').textContent)`, { what: 'A synced again', timeout: 20000 });
  assert.deepEqual(field(drive).items, [], 'not brought back by the file');
  assert.equal(bodies(drive).length, 0);
  await pull(B);
  assert.deepEqual(await ids(B), []);
});

t.test('with sync never connected a deleted entry leaves no record of its id', async (h) => {
  const A = await device(h, new FakeDrive());
  const e = await add(A, 'template', 'local only');
  await A.ev(`deleteHistoryEntry(${JSON.stringify(e.id)})`);
  assert.deepEqual((await rec(A)).removed, {});
});

t.test('the expiry is the entry\'s own date (30 days) on every device: the same boundary, the file and summary go, nothing comes back', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const r = await app.page.evaluate(() => {
    const T = window.__t, n = Date.now(), D = 86400e3;
    const hs = (age) => T.historySyncRead({ v: 1, items: [{ id: 'x', mode: 'template', fileNames: [], wordCount: 1, preview: '', timestamp: n - age, driveFileId: 'fileid0001', bytes: 5 }], deleted: [] }, n);
    return { d29: hs(29.99 * D).items.size, d30in: hs(30 * D).items.size, d30out: hs(30 * D + 1).items.size, expired: hs(31 * D).expired.length, local30: T.historyExpired({ timestamp: n - 30 * D }, n), local30b: T.historyExpired({ timestamp: n - 30 * D - 1 }, n) };
  });
  assert.deepEqual(r, { d29: 1, d30in: 1, d30out: 0, expired: 1, local30: false, local30b: true });
  // two devices, a day later
  const drive = new FakeDrive();
  const A = await connected(h, drive, { clock: true });
  const old = doc('h_old', await now(A) - 29.5 * DAY), young = doc('h_young', await now(A) - 5 * DAY);
  await seed(A, [old, young]);
  await push(A);
  assert.equal(bodies(drive).length, 2);
  const B = await connected(h, drive, { clock: true });
  assert.deepEqual(await ids(B), ['h_old', 'h_young']);
  await jump(A, DAY); await jump(B, DAY);
  await push(A);
  assert.deepEqual((await ids(A)), ['h_young'], 'expired on A');
  assert.deepEqual(bodies(drive).map(f => f.name), ['sth-history-h_young.json'], 'its hidden file is deleted');
  assert.deepEqual(field(drive).items.map(i => i.id), ['h_young'], 'its summary is dropped');
  await push(B);
  assert.deepEqual((await ids(B)), ['h_young'], 'expired on B too, and not brought back by the file');
  assert.deepEqual(field(drive).items.map(i => i.id), ['h_young']);
  // the other order: B notices first
  const C = await connected(h, drive, { clock: true });
  await jump(C, 26 * DAY); // 31 days after the young one was made... (it is 5 days old + 26)
  await pull(C).catch(() => {});
  await push(C);
  assert.deepEqual(await ids(C), []);
  assert.deepEqual(field(drive).items, []);
  assert.equal(bodies(drive).length, 0);
});

t.test('deleted ids are kept 31 days, no longer (the rule, and the file)', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive, { clock: true });
  const r = await A.page.evaluate(() => {
    const T = window.__t, n = Date.now(), D = 86400e3;
    const has = (age) => T.historySyncReadTombs([{ id: 'x', at: n - age }], n).has('x');
    return { d30: has(30 * D), d31: has(31 * D), d31p: has(31 * D + 1000), merged: T.historySyncMergeTombs(new Map([['a', { at: n - 32 * D }]]), new Map([['b', { at: n - 1 * D }]]), n).size };
  });
  assert.deepEqual(r, { d30: true, d31: true, d31p: false, merged: 1 });
  const e = await add(A, 'template', 'gone soon');
  await push(A);
  await A.ev(`deleteHistoryEntry(${JSON.stringify(e.id)})`);
  await push(A);
  assert.ok(field(drive).deleted.some(d => d.id === e.id));
  await jump(A, 30 * DAY);
  const x = await add(A, 'template', 'after 30 days');
  await push(A);
  assert.ok(field(drive).deleted.some(d => d.id === e.id), 'still listed at 30 days');
  await jump(A, 2 * DAY);
  const y = await add(A, 'template', 'after 32 days');
  await push(A);
  assert.ok(!(field(drive).deleted || []).some(d => d.id === e.id), 'gone from the list after 31 days');
  assert.ok(x.id && y.id);
});

t.test('an entry over the size ceiling stays on its device: no file, no summary, not tried again; the others sync', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const small = await add(A, 'template', 'small one');
  const big = await add(A, 'transcribe', 'x'.repeat(1100000), ['huge.pdf']);
  await push(A);
  assert.deepEqual(bodies(drive).map(f => f.name), [`sth-history-${small.id}.json`]);
  assert.deepEqual(field(drive).items.map(i => i.id), [small.id]);
  const mine = await entry(A, big.id);
  assert.equal(mine.localOnly, true);
  assert.equal(mine.resultText.length, 1100000, 'still all there');
  assert.equal(mine.driveFileId, undefined);
  const up = uploads(drive), w = writes(drive);
  await push(A); await push(A);
  assert.equal(uploads(drive), up, 'not tried again');
  assert.equal(writes(drive), w, 'nothing to write');
  const B = await connected(h, drive);
  assert.deepEqual(await ids(B), [small.id], 'B never sees it');
  await push(B);
  assert.deepEqual(await ids(A), [big.id, small.id].sort(), 'and A keeps it');
});

t.test('both devices add entries before they meet: both are kept, each opens on the other; the same id made on both is one entry with one file', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  const a1 = await add(A, 'template', 'made on A'), b1 = await add(B, 'reviewer', 'made on B');
  const sa = await add(A, 'transcribe', 'same run text', ['x.png'], 'h_g_samerun'), sb = await add(B, 'transcribe', 'same run text', ['x.png'], 'h_g_samerun');
  assert.equal(sa.id, sb.id);
  await push(A);
  await push(B);
  await pull(A);
  assert.deepEqual(await ids(A), [a1.id, b1.id, 'h_g_samerun'].sort());
  assert.deepEqual(await ids(B), [a1.id, b1.id, 'h_g_samerun'].sort());
  assert.equal(bodyOf(drive, 'h_g_samerun').length, 1, 'one hidden file for the shared id');
  assert.equal(bodies(drive).length, 3);
  assert.equal(field(drive).items.length, 3);
  // each opens on the other device
  await B.ev(`getHistory().then(l => openHistoryEntry(l.find(e => e.id === ${JSON.stringify(a1.id)})))`);
  await B.until(`document.getElementById('historyResultModal').classList.contains('open') && /made on A/.test(document.getElementById('historyResultBody').textContent)`, { what: 'A\'s entry opened on B' });
  await A.ev(`getHistory().then(l => openHistoryEntry(l.find(e => e.id === ${JSON.stringify(b1.id)})))`);
  await A.until(`document.getElementById('historyResultModal').classList.contains('open') && /made on B/.test(document.getElementById('historyResultBody').textContent)`, { what: 'B\'s entry opened on A' });
});

t.test('no ping-pong: once both devices agree, pushes and pulls on either side write and upload nothing', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const B = await connected(h, drive);
  await add(A, 'template', 'one'); await add(B, 'reviewer', 'two');
  await push(A); await push(B); await push(A); await pull(B); await pull(A);
  const w = writes(drive), u = uploads(drive), body = JSON.stringify(field(drive));
  for (let i = 0; i < 3; i++) { await push(A); await push(B); await pull(A); await pull(B); }
  assert.equal(writes(drive), w, 'no more writes of the sync file');
  assert.equal(uploads(drive), u, 'no more uploads');
  assert.equal(JSON.stringify(field(drive)), body, 'the field is the same');
  assert.deepEqual(await ids(A), await ids(B));
});

t.test('study aids are unaffected: they keep their own field and files, appear in History next to the documents on the other device, and never enter the history field', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  await A.seedItems([studioItem('mindmap', { id: 'a_map', title: 'Cell map' })]);
  const e = await add(A, 'template', 'a document');
  await push(A);
  assert.equal(drive.byName('sth-studio-a_map.json').length, 1);
  assert.deepEqual(field(drive).items.map(i => i.id), [e.id]);
  assert.equal(fileData(drive).studio.items.length, 1);
  const B = await connected(h, drive);
  assert.deepEqual(await B.ev(`studio.items.map(i => i.id)`), ['a_map']);
  assert.deepEqual(await ids(B), [e.id], 'the History store holds documents only');
  await openHistory(B);
  const r = await rows(B);
  assert.deepEqual(r.map(x => x.kind).sort(), ['document', 'studio'], 'both rows, the study aid read live from Study Studio');
  await A.ev(`deleteHistoryEntry(${JSON.stringify(e.id)})`);
  await push(A);
  assert.equal(fileData(drive).studio.items.length, 1, 'deleting a document leaves the study aid alone');
  assert.equal(drive.byName('sth-studio-a_map.json').length, 1);
});

t.test('hostile text in the sync file or a hidden file cannot run: rows are escaped, an unknown kind is never shown, the opened text is sanitised', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const e = await add(A, 'template', 'fine');
  await push(A);
  const n = await now(A);
  const evilBody = drive.add('sth-history-h_evil1.json', { v: 1, id: 'h_evil1', mode: 'template', resultText: '<img src=x onerror="window.__xss=5"> <script>window.__xss=6</script> **bold**' });
  const evilTx = drive.add('sth-history-h_evil2.json', { v: 1, id: 'h_evil2', mode: 'transcribe', resultText: '<img src=x onerror="window.__xss=7"> plain' });
  const id = drive.byName(FILE)[0].id;
  const d = drive.json(id);
  d.history.items.push(
    { id: 'h_evil1', mode: 'template', fileNames: ['<img src=x onerror=window.__xss=1>.txt', '<script>window.__xss=2</script>', 7, null], wordCount: '<b>9</b>', preview: '<img src=x onerror=window.__xss=3>', timestamp: n - 1000, driveFileId: evilBody, bytes: 80 },
    { id: 'h_evil2', mode: 'transcribe', fileNames: [], wordCount: 3, preview: 'tx', timestamp: n - 2000, driveFileId: evilTx, bytes: 80 },
    { id: 'h_evil3', mode: '<img src=x onerror=window.__xss=4>', fileNames: [], wordCount: 1, preview: 'p', timestamp: n - 3000, driveFileId: 'someotherfile', bytes: 1 },
    { id: 'bad id with spaces', mode: 'template', timestamp: n, driveFileId: 'someotherfile2' },
    { id: 'h_evil4', mode: 'template', timestamp: n, driveFileId: '../../etc/passwd' },
  );
  drive.put(id, d);
  const B = await connected(h, drive);
  assert.deepEqual(await ids(B), [e.id, 'h_evil1', 'h_evil2'].sort(), 'unknown kind, bad ids and bad file ids are not taken');
  await openHistory(B);
  const html = await B.page.evaluate(() => ({ imgs: document.querySelectorAll('#historyList img').length, scripts: document.querySelectorAll('#historyList script').length, text: document.getElementById('historyList').textContent }));
  assert.equal(html.imgs, 0); assert.equal(html.scripts, 0);
  assert.ok(html.text.includes('<img src=x onerror=window.__xss=3>'), 'the preview is shown as text');
  assert.ok(html.text.includes('<img src=x onerror=window.__xss=1>.txt'), 'file names as text');
  await B.page.click('#historyList .history-entry[data-id="h_evil1"]');
  await B.until(`document.getElementById('historyResultModal').classList.contains('open') && /bold/.test(document.getElementById('historyResultBody').textContent)`, { what: 'opened' });
  assert.equal(await B.page.evaluate(() => document.querySelectorAll('#historyResultBody script').length), 0);
  assert.equal(await B.page.evaluate(() => document.querySelectorAll('#historyResultBody [onerror]').length), 0, 'event handlers stripped');
  await B.page.click('#historyResultClose');
  await B.page.click('#historyList .history-entry[data-id="h_evil2"]');
  await B.until(`document.getElementById('historyResultModal').classList.contains('open')`);
  assert.equal(await B.page.evaluate(() => document.querySelectorAll('#historyResultBody img').length), 0, 'a transcription is plain text');
  assert.ok((await modalText(B)).text.includes('<img src=x onerror="window.__xss=7">'));
  assert.equal(await B.page.evaluate(() => window.__xss), undefined, 'nothing ran');
  // the unknown kind stays in the file for a newer version, untouched
  await push(B);
  assert.ok(field(drive).items.some(i => i.id === 'h_evil3' && i.mode === '<img src=x onerror=window.__xss=4>'));
  assert.deepEqual(B.pageErrors, []);
});

t.test('a hidden file that does not match its summary (wrong id or kind, no text) is refused, not stored, and the entry stays closed', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const e = await add(A, 'template', 'real text');
  await push(A);
  const B = await connected(h, drive);
  drive.put(bodyOf(drive, e.id)[0].id, { v: 1, id: 'h_other', mode: 'template', resultText: 'swapped' });
  await B.ev(`getHistory().then(l => openHistoryEntry(l[0]))`);
  await B.until(`/Could not load/.test(document.getElementById('toast').textContent)`, { what: 'error toast' });
  assert.equal((await entry(B, e.id)).resultText, undefined);
  assert.equal(await B.page.evaluate(() => document.getElementById('historyResultModal').classList.contains('open')), false);
  drive.put(bodyOf(drive, e.id)[0].id, { v: 1, id: e.id, mode: 'template', resultText: 'now fine' });
  await B.ev(`getHistory().then(l => openHistoryEntry(l[0]))`);
  await B.until(`document.getElementById('historyResultModal').classList.contains('open')`, { what: 'opened after repair' });
  // a file that is gone
  const C = await connected(h, drive);
  drive.files.delete(bodyOf(drive, e.id)[0].id);
  await C.ev(`getHistory().then(l => openHistoryEntry(l[0]))`);
  await C.until(`/no longer in your Google Drive/.test(document.getElementById('toast').textContent)`, { what: 'missing file toast' });
});

t.test('`kbSaved:` markers are never touched by History sync (sync rounds, delete, clear, expiry)', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive, { clock: true });
  const n = await now(A);
  await A.ev(`_historyStore.setItem('kbSaved:g_run1', ${n}).then(() => _historyStore.setItem('kbSaved:g_old', ${n - 40 * DAY}))`);
  const e = await add(A, 'transcribe', 'run text', ['p.png'], 'h_g_run1');
  await push(A);
  const B = await connected(h, drive);
  await push(B); await pull(B);
  const keys = (app) => app.ev(`_historyStore.keys().then(k => k.sort())`);
  assert.deepEqual((await keys(A)).filter(k => k.startsWith('kbSaved:')), ['kbSaved:g_old', 'kbSaved:g_run1']);
  await A.ev(`deleteHistoryEntry('h_g_run1')`); await push(A); await A.ev(`clearAllHistory()`); await push(A);
  assert.deepEqual((await keys(A)).filter(k => k.startsWith('kbSaved:')), ['kbSaved:g_old', 'kbSaved:g_run1'], 'sync and delete leave the markers');
  await A.ev(`purgeExpiredHistory()`);
  assert.deepEqual((await keys(A)).filter(k => k.startsWith('kbSaved:')), ['kbSaved:g_run1'], 'only the old marker expires, as before');
  assert.ok(e.id);
  assert.deepEqual((await keys(B)).filter(k => k.startsWith('kbSaved:')), [], 'markers stay on the device that made them');
});

t.test('a newer field version is left exactly as it is: nothing uploaded, nothing changed, local entries kept', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const id = drive.byName(FILE)[0].id;
  const d = drive.json(id);
  d.history = { v: 2, items: [{ id: 'h_future', anything: 1 }], deleted: [], extra: { x: 1 } };
  drive.put(id, d);
  const e = await add(A, 'template', 'local only for now');
  const up = uploads(drive);
  await push(A);
  assert.deepEqual(field(drive), { v: 2, items: [{ id: 'h_future', anything: 1 }], deleted: [], extra: { x: 1 } });
  assert.equal(uploads(drive), up, 'no hidden file made');
  assert.deepEqual(await ids(A), [e.id]);
  assert.equal(bodies(drive).length, 0);
});

t.test('a field dropped by an older client deletes nothing: the entries stay and are written back', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const e = await add(A, 'template', 'must survive');
  await push(A);
  const B = await connected(h, drive);
  const id = drive.byName(FILE)[0].id;
  const d = drive.json(id); delete d.history; drive.put(id, d); // an older version of the app writes the file without it
  await push(A);
  assert.deepEqual(await ids(A), [e.id]);
  assert.deepEqual(field(drive).items.map(i => i.id), [e.id], 'written back');
  assert.equal(bodies(drive).length, 1, 'the hidden file is the same one (not uploaded twice)');
  await pull(B);
  assert.deepEqual(await ids(B), [e.id]);
});

t.test('a summary missing from the file (not deleted: no deleted id) is deleted here only when this device had read it before and the field is a proper one', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const e1 = await add(A, 'template', 'one'), e2 = await add(A, 'template', 'two');
  await push(A);
  const B = await connected(h, drive);
  assert.deepEqual(await ids(B), [e1.id, e2.id].sort());
  // an editor removes e2 from the field by hand without a deleted id (the other device deleted it and lost the id): B follows because it had listed it
  const id = drive.byName(FILE)[0].id;
  const d = drive.json(id); d.history.items = d.history.items.filter(i => i.id !== e2.id); drive.put(id, d);
  await pull(B);
  assert.deepEqual(await ids(B), [e1.id]);
  // a brand-new local entry that was never listed is NOT deleted by a field that lacks it
  const n = await add(B, 'reviewer', 'new on B');
  await push(B);
  assert.deepEqual(await ids(B), [e1.id, n.id].sort());
});

t.test('signing out of sync clears the list of listed entries but keeps the deleted ids (the hidden file is still deleted next time)', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  const e = await add(A, 'template', 'x');
  await push(A);
  assert.ok(Object.keys((await rec(A)).ids).includes(e.id));
  await A.ev(`deleteHistoryEntry(${JSON.stringify(e.id)})`);
  await A.ev(`clearTimeout(state.driveSyncTimer)`);
  await A.ev(`signOutSync()`);
  await sleep(300);
  const r = await rec(A);
  assert.deepEqual([r.fid, r.ids], ['', {}], 'the list belongs to one file: gone');
  assert.ok(r.removed[e.id] && r.removed[e.id].driveFileId, 'the id and its hidden file are remembered');
});

t.test('storage blocked or the History store failing: syncing does not crash', async (h) => {
  const drive = new FakeDrive();
  const A = await connected(h, drive);
  await add(A, 'template', 'x');
  await A.ev(`(historyRec.save = async (r) => { historyRec.mem = r; }, 1)`); // as if the store refused the record
  await push(A);
  assert.equal(bodies(drive).length, 1);
  assert.deepEqual(A.pageErrors, []);
});

t.run();
