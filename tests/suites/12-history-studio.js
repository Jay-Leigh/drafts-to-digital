'use strict';
// History panel with study aids: rows built live from Study Studio (badge, title, date, size line), interleaved with documents by date, the All / Documents /
// Study aids chips (remembered in sth_history_filter), open in Study Studio, delete through Studio (confirmation, Drive file, tombstone), only ready aids,
// empty states, the button dot, text-only titles, no sideways scroll.
const { suite, assert } = require('../lib/harness');
const { studioItem, connectDrive, noHScroll, AFTER, fx } = require('../lib/common');

const t = suite('12-history-studio');
const DAY = 86400e3;
const D = (day, hour = 12) => Date.UTC(2026, 10, day, hour); // November 2026
const TOOLS = ['mindmap', 'flashcards', 'quiz', 'infographic', 'slides'];
const LABEL = { mindmap: 'Mind map', flashcards: 'Flashcards', quiz: 'Quiz', infographic: 'Infographic', slides: 'Slide deck' };

const aid = (tool, id, createdAt, over = {}) => studioItem(tool, { id, title: `${LABEL[tool]} ${id}`, createdAt, updatedAt: createdAt, ...over });
const doc = (id, timestamp, over = {}) => ({ id, mode: 'template', resultText: `Result text of ${id}`, fileNames: ['notes.txt'], wordCount: 1200, preview: `Preview of ${id}`, timestamp, ...over });

async function seedDocs(app, list) {
  await app.ev(`(async () => { await _historyStore.setItem('entries', ${JSON.stringify(list)}); await refreshHistoryUi(); })()`);
}
async function openHistory(app) {
  await app.page.click('#historyBtn');
  await app.until(`document.getElementById('historyPanel').classList.contains('open') && !document.getElementById('historyList').hasAttribute('aria-busy')`, { what: 'history open' });
  await app.page.waitForTimeout(400); // the panel slides in
}
const rows = (app) => app.page.evaluate(() => [...document.querySelectorAll('#historyList .history-entry')].map(r => ({
  id: r.dataset.id, kind: r.dataset.kind, badge: r.querySelector('.history-mode-badge').textContent.trim(), date: r.querySelector('.history-entry-date').textContent,
  preview: r.querySelector('.history-entry-preview').textContent, meta: r.querySelector('.history-entry-meta').textContent,
})));
const ids = async (app) => (await rows(app)).map(r => r.id);
const chip = (app, name) => app.page.click(`[data-history-filter="${name}"]`);
const pressed = (app) => app.page.evaluate(() => [...document.querySelectorAll('[data-history-filter]')].filter(b => b.getAttribute('aria-pressed') === 'true').map(b => b.dataset.historyFilter));
const count = (app) => app.page.evaluate(() => document.getElementById('historyCount').textContent);
const btnDot = (app) => app.page.evaluate(() => document.getElementById('historyBtn').classList.contains('has-entries'));

t.test('study aid rows: badge, title, date and the size line; only ready aids', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const created = { mindmap: D(10), flashcards: D(11), quiz: D(12), infographic: D(13), slides: D(14) };
  const list = TOOLS.map(tool => aid(tool, `a_${tool}`, created[tool]));
  list.push(aid('flashcards', 'a_remote', D(9), { artifact: null, sourceIds: ['k_a', 'k_b'], sourceNames: ['a.txt', 'b.txt'] }));
  list.push(aid('quiz', 'a_gen', D(15), { status: 'generating', artifact: null }));
  list.push(aid('mindmap', 'a_queued', D(15), { status: 'queued', artifact: null }));
  list.push(aid('slides', 'a_failed', D(16), { status: 'failed', artifact: null, error: { code: 'E1', message: 'No' } }));
  await app.seedItems(list);
  await openHistory(app);
  const r = await rows(app);
  assert.deepEqual(r.map(x => x.id), ['a_slides', 'a_infographic', 'a_quiz', 'a_flashcards', 'a_mindmap', 'a_remote'], 'newest first, ready aids only');
  const by = Object.fromEntries(r.map(x => [x.id, x]));
  for (const tool of TOOLS) {
    assert.equal(by[`a_${tool}`].kind, 'studio');
    assert.equal(by[`a_${tool}`].badge, LABEL[tool], `${tool} badge uses the Studio tool label`);
    assert.equal(by[`a_${tool}`].preview, `${LABEL[tool]} a_${tool}`, `${tool} title`);
    assert.match(by[`a_${tool}`].date, new RegExp(`^${new Date(created[tool]).getUTCDate()} Nov\\.? 2026$`), `${tool} date`);
  }
  assert.equal(by.a_mindmap.meta, `${fx.mindmap('t').nodes.length} ideas`);
  assert.equal(by.a_flashcards.meta, '6 cards');
  assert.equal(by.a_quiz.meta, '5 questions');
  assert.equal(by.a_slides.meta, `${fx.slides().slides.length} slides`);
  assert.equal(by.a_infographic.meta, '1 source', 'no cheap count: the source count');
  assert.equal(by.a_remote.meta, '2 sources', 'artifact not loaded on this device: the source count');
  // each row's icon is the Studio icon of its tool, inside the badge
  assert.equal(await app.page.evaluate(() => document.querySelectorAll('#historyList .badge-studio svg').length), 6);
  assert.deepEqual(app.pageErrors, []);
});

t.test('documents and study aids interleave by date, newest first; documents behave as before', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await seedDocs(app, [doc('d3', D(15)), doc('d2', D(12)), doc('d1', D(9))]);
  await app.seedItems([aid('quiz', 's1', D(8)), aid('mindmap', 's2', D(10)), aid('flashcards', 's3', D(14)), aid('slides', 's4', D(16))]);
  await openHistory(app);
  const hash0 = await app.ev('location.hash');
  assert.deepEqual(await ids(app), ['s4', 'd3', 's3', 'd2', 's2', 'd1', 's1']);
  assert.deepEqual((await rows(app)).map(r => r.kind), ['studio', 'document', 'studio', 'document', 'studio', 'document', 'studio']);
  const d = (await rows(app)).find(r => r.id === 'd3');
  assert.equal(d.badge, 'template');
  assert.equal(d.preview, 'Preview of d3');
  assert.match(d.meta, /^1\D?200 words · notes\.txt$/);
  // a document row opens the result modal, as before
  await app.page.click('#historyList [data-id="d3"]');
  await app.until(`document.getElementById('historyResultModal').classList.contains('open')`);
  assert.match(await app.page.evaluate(() => document.getElementById('historyResultBody').textContent), /Result text of d3/);
  assert.equal(await app.ev('location.hash'), hash0, 'a document does not navigate');
});

t.test('chips: real buttons, 44 px, All / Documents / Study aids, live count, the choice is remembered', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await seedDocs(app, [doc('d2', D(12)), doc('d1', D(9))]);
  await app.seedItems([aid('quiz', 's1', D(10)), aid('mindmap', 's2', D(11)), aid('slides', 's3', D(13))]);
  await openHistory(app);
  const chips = await app.page.evaluate(() => [...document.querySelectorAll('[data-history-filter]')].map(b => ({ tag: b.tagName, name: b.dataset.historyFilter, text: b.textContent, h: b.getBoundingClientRect().height, type: b.type })));
  assert.deepEqual(chips.map(c => [c.tag, c.name, c.text, c.type]), [['BUTTON', 'all', 'All', 'button'], ['BUTTON', 'documents', 'Documents', 'button'], ['BUTTON', 'studio', 'Study aids', 'button']]);
  assert.ok(chips.every(c => c.h >= 44), `chip heights ${chips.map(c => c.h)}`);
  assert.equal(await app.page.evaluate(() => { const c = document.getElementById('historyCount'); return `${c.getAttribute('role')}|${c.getAttribute('aria-live')}`; }), 'status|polite');
  assert.deepEqual(await pressed(app), ['all']);
  assert.equal(await count(app), '5 items');
  assert.equal((await ids(app)).length, 5);

  await chip(app, 'documents');
  await app.until(`document.querySelectorAll('#historyList .history-entry').length === 2`);
  assert.deepEqual(await pressed(app), ['documents']);
  assert.deepEqual(await ids(app), ['d2', 'd1']);
  assert.equal(await count(app), '2 items');

  await chip(app, 'studio');
  await app.until(`document.querySelectorAll('#historyList .history-entry').length === 3`);
  assert.deepEqual(await pressed(app), ['studio']);
  assert.deepEqual(await ids(app), ['s3', 's2', 's1']);
  assert.equal(await app.page.evaluate(() => localStorage.getItem('sth_history_filter')), 'studio');

  await app.reload();
  await openHistory(app);
  assert.deepEqual(await pressed(app), ['studio'], 'remembered after a reload');
  assert.deepEqual(await ids(app), ['s3', 's2', 's1']);

  await chip(app, 'all');
  await app.until(`document.querySelectorAll('#historyList .history-entry').length === 5`);
  assert.equal(await app.page.evaluate(() => localStorage.getItem('sth_history_filter')), 'all');
  // a damaged value falls back to All
  await app.page.evaluate(() => localStorage.setItem('sth_history_filter', 'bogus'));
  await app.reload();
  await openHistory(app);
  assert.deepEqual(await pressed(app), ['all']);
});

t.test('with storage blocked the chips still work for the session', async (h) => {
  const app = await h.newApp({ now: AFTER, storageBlocked: true, signedIn: false, consent: false, wait: false });
  await app.until(`typeof setHistoryFilter === 'function'`, { what: 'page script' });
  await app.ev(`setHistoryFilter('documents')`);
  assert.equal(await app.ev('_historyFilter'), 'documents');
  assert.deepEqual(app.pageErrors, []);
});

t.test('clicking a study aid row opens it in Study Studio and closes History; long-press does not open', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([aid('quiz', 's_open', D(10))]);
  await seedDocs(app, [doc('d1', D(9))]);
  await openHistory(app);
  await app.page.click('#historyList [data-id="s_open"] .history-entry-preview');
  await app.until(`location.hash === '#studio/s_open' && studio.viewerId === 's_open'`, { what: 'studio viewer' });
  assert.equal(await app.page.evaluate(() => document.getElementById('historyPanel').classList.contains('open') || document.getElementById('historyOverlay').classList.contains('open')), false, 'History closed');
  // long-press: the first click after it only clears the mark
  await openHistory(app);
  await app.page.evaluate(() => document.querySelector('#historyList [data-id="s_open"]').classList.add('longpress-active'));
  await app.goto('#home');
  await app.page.click('#historyList [data-id="s_open"] .history-entry-preview');
  assert.equal(await app.ev('location.hash'), '#home', 'the long-press click does not open');
  assert.equal(await app.page.evaluate(() => document.querySelector('#historyList [data-id="s_open"]').classList.contains('longpress-active')), false);
  assert.equal(await app.page.evaluate(() => document.getElementById('historyPanel').classList.contains('open')), true);
});

t.test('x on a study aid row: the Studio confirmation, then the Drive file goes and a tombstone is left', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await seedDocs(app, [doc('d1', D(9))]);
  await app.seedItems([aid('quiz', 'qz_del', D(10), { title: 'Delete me' }), aid('mindmap', 'mm_keep', D(11))]);
  await connectDrive(app);
  assert.equal(app.drive.byName('sth-studio-qz_del.json').length, 1);
  const driveFileId = await app.ev(`studio.items.find(i => i.id === 'qz_del').driveFileId`);
  assert.ok(driveFileId, 'the aid has a Drive file');
  await openHistory(app);
  const hash0 = await app.ev('location.hash');

  // cancel: nothing changes
  await app.page.hover('#historyList [data-id="qz_del"]');
  await app.page.click('#historyList [data-id="qz_del"] .history-entry-del');
  await app.page.waitForSelector('#confirmOverlay.open');
  const msg = await app.page.evaluate(() => document.getElementById('confirmMsg').innerHTML);
  assert.equal(msg, 'Delete <strong>Delete me</strong>? This removes it from this device and, if sync is on, from your Google Drive and your other devices.', 'the Studio wording');
  assert.equal(await app.page.evaluate(() => document.getElementById('confirmOk').textContent), 'Delete');
  await app.confirm(false);
  assert.deepEqual(await ids(app), ['mm_keep', 'qz_del', 'd1']);
  assert.equal(await app.ev(`location.hash`), hash0, 'the click on x did not open the aid');

  // confirm
  await app.page.click('#historyList [data-id="qz_del"] .history-entry-del');
  await app.confirm(true);
  await app.until(`!document.querySelector('#historyList [data-id="qz_del"]')`, { what: 'row gone' });
  assert.deepEqual(await ids(app), ['mm_keep', 'd1']);
  assert.equal(await app.ev(`studio.items.some(i => i.id === 'qz_del')`), false);
  assert.equal(await app.ev(`document.querySelectorAll('[data-studio-item="qz_del"]').length`), 0, 'gone from Study Studio too');
  await app.ev('pushToDrive()');
  assert.equal(app.drive.byName('sth-studio-qz_del.json').length, 0, 'hidden Drive file deleted');
  assert.equal(app.drive.byName('sth-studio-mm_keep.json').length, 1, 'the other aid is untouched');
  const sync = app.drive.json(app.drive.byName('sth-userdata-v1.json')[0].id);
  assert.ok(sync.studio.deleted.some(x => x.id === 'qz_del'), 'tombstone in the sync file');
  assert.equal(sync.studio.items.some(x => x.id === 'qz_del'), false);
  assert.deepEqual(app.pageErrors, []);
});

t.test('x on a document row deletes only that document (no confirmation, as before); study aids stay', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await seedDocs(app, [doc('d2', D(12)), doc('d1', D(9))]);
  await app.seedItems([aid('quiz', 's1', D(10))]);
  await openHistory(app);
  await app.page.click('#historyList [data-id="d2"] .history-entry-del', { force: true });
  await app.until(`document.querySelectorAll('#historyList .history-entry').length === 2`);
  assert.deepEqual(await ids(app), ['s1', 'd1']);
  assert.equal(await app.ev('studio.items.length'), 1);
  // "Clear documents" leaves the study aids
  await app.page.click('#historyClearAll');
  await app.until(`document.querySelectorAll('#historyList .history-entry').length === 1`);
  assert.deepEqual(await ids(app), ['s1']);
  assert.equal(await app.ev('studio.items.length'), 1);
});

t.test('the list follows Study Studio: an aid that becomes ready or is deleted updates an open panel; another tab too', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([aid('quiz', 's_run', D(10), { status: 'generating', artifact: null })]);
  await openHistory(app);
  assert.deepEqual(await ids(app), [], 'generating: not listed');
  assert.equal(await btnDot(app), false, 'a generating aid does not light the button');
  // finishes in this tab
  await app.ev(`(async () => { const it = studio.items.find(i => i.id === 's_run'); it.status = 'ready'; it.artifact = ${JSON.stringify(studioItem('quiz').artifact)}; await studio.save(it); })()`);
  await app.until(`!!document.querySelector('#historyList [data-id="s_run"]')`, { what: 'row appears' });
  assert.equal(await btnDot(app), true);
  // failed later (regenerate) leaves the list again
  await app.ev(`(async () => { const it = studio.items.find(i => i.id === 's_run'); it.status = 'failed'; await studio.save(it); })()`);
  await app.until(`!document.querySelector('#historyList [data-id="s_run"]')`, { what: 'row leaves' });

  // another tab adds one, then deletes it
  const other = await app.context.newPage();
  await other.goto(app.page.url());
  await other.waitForFunction(() => window.__t && window.__t.studio && window.__t.studio.ready, null, { timeout: 20000 });
  await other.evaluate(async (it) => { const t = window.__t; t.studio.items.unshift(it); await t.studio.persist(it); t.studio.refreshViews(); }, aid('mindmap', 's_other', D(12)));
  await app.until(`!!document.querySelector('#historyList [data-id="s_other"]')`, { what: 'row from the other tab' });
  await other.evaluate(async () => { const t = window.__t; const it = t.studio.items.find(i => i.id === 's_other'); t.studio.items = t.studio.items.filter(i => i !== it); await t.studio.persist(null, 's_other'); t.studio.refreshViews(); });
  await app.until(`!document.querySelector('#historyList [data-id="s_other"]')`, { what: 'row removed by the other tab' });
  await other.close();
  assert.equal(await btnDot(app), false);
  assert.deepEqual(app.pageErrors, []);
});

t.test('empty filter messages', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await openHistory(app);
  const msg = () => app.page.evaluate(() => document.querySelector('#historyList .history-empty p')?.textContent || '');
  assert.match(await msg(), /No saved generations yet/);
  await chip(app, 'documents');
  await app.until(`/No saved documents/.test(document.getElementById('historyList').textContent)`);
  assert.equal(await count(app), '0 items');
  await chip(app, 'studio');
  await app.until(`/No study aids yet/.test(document.getElementById('historyList').textContent)`);
  assert.match(await msg(), /Make one in Study Studio/);
  // documents only: the study filter is empty, the documents filter is not
  await seedDocs(app, [doc('d1', D(9))]);
  await app.until(`/No study aids yet/.test(document.getElementById('historyList').textContent)`);
  await chip(app, 'documents');
  await app.until(`document.querySelectorAll('#historyList .history-entry').length === 1`);
  // study aids only: the documents filter is empty
  await seedDocs(app, []);
  await app.seedItems([aid('quiz', 's1', D(10))]);
  await app.until(`/No saved documents/.test(document.getElementById('historyList').textContent)`);
  assert.equal(await count(app), '0 items');
  await chip(app, 'all');
  await app.until(`document.querySelectorAll('#historyList .history-entry').length === 1`);
  assert.equal(await count(app), '1 item');
});

t.test('the History button dot: documents, study aids, neither', async (h) => {
  const app = await h.newApp({ now: AFTER });
  assert.equal(await btnDot(app), false);
  await app.seedItems([aid('quiz', 's1', D(10))]);
  await app.until(`document.getElementById('historyBtn').classList.contains('has-entries')`, { what: 'dot for a study aid' });
  await app.reload();
  await app.until(`document.getElementById('historyBtn').classList.contains('has-entries')`, { what: 'dot after reload' });
  const del = app.ev(`studio.remove('s1')`);
  await app.confirm(true);
  await del;
  await app.until(`!document.getElementById('historyBtn').classList.contains('has-entries')`, { what: 'dot off' });
  await seedDocs(app, [doc('d1', D(9))]);
  await app.until(`document.getElementById('historyBtn').classList.contains('has-entries')`, { what: 'dot for a document' });
  await app.ev(`clearAllHistory()`);
  await app.until(`!document.getElementById('historyBtn').classList.contains('has-entries')`);
  await app.ev(`saveToHistory('template', 'hello world', ['a.txt'])`);
  await app.until(`document.getElementById('historyBtn').classList.contains('has-entries')`, { what: 'dot for a new document' });
});

t.test('XSS: a title like <img onerror> is text only in the row and its labels', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await app.seedItems([aid('flashcards', 's_x', D(10), { title: XSS })]);
  await openHistory(app);
  const r = await app.page.evaluate(() => { const row = document.querySelector('#historyList [data-id="s_x"]'); return { text: row.querySelector('.history-entry-preview').textContent, imgs: document.querySelectorAll('#historyList img, #historyList script').length, xss: window.__xss, aria: row.querySelector('.history-entry-del').getAttribute('aria-label') }; });
  assert.equal(r.text, XSS);
  assert.equal(r.imgs, 0);
  assert.equal(r.xss, undefined);
  assert.equal(r.aria, `Delete ${XSS}`);
  // the confirmation text is escaped as well
  await app.page.click('#historyList [data-id="s_x"] .history-entry-del', { force: true });
  await app.page.waitForSelector('#confirmOverlay.open');
  assert.equal(await app.page.evaluate(() => document.querySelectorAll('#confirmMsg img, #confirmMsg script').length), 0);
  await app.confirm(false);
  assert.deepEqual(app.pageErrors, []);
});

for (const width of [320, 390, 1280]) {
  t.test(`${width}px: History with long titles has no sideways scroll; chips and rows fit`, async (h) => {
    const app = await h.newApp({ now: AFTER, width, height: 760 });
    const LONG = 'Averyveryveryverylongwordwithoutanybreaksatallthatkeepsgoingandgoing' + 'x'.repeat(80);
    await seedDocs(app, [doc('d1', D(9), { preview: LONG, fileNames: [`${LONG}.txt`, 'b.txt', 'c.txt'] })]);
    await app.seedItems(TOOLS.map((tool, i) => aid(tool, `s_${tool}`, D(10 + i), { title: `${tool} ${LONG}` })));
    await openHistory(app);
    await h.sleep(400); // the panel slides in
    assert.equal(await app.page.evaluate(noHScroll), true, 'page');
    const r = await app.page.evaluate(() => {
      const panel = document.getElementById('historyPanel').getBoundingClientRect(), list = document.getElementById('historyList');
      const chips = [...document.querySelectorAll('.history-chip')].map(c => c.getBoundingClientRect());
      return { listOver: list.scrollWidth - list.clientWidth, chipsOut: chips.filter(c => c.right > panel.right + 1 || c.left < panel.left - 1).length, tall: chips.every(c => c.height >= 44),
        rowsOut: [...list.querySelectorAll('.history-entry')].filter(e => e.getBoundingClientRect().right > panel.right + 1).length, n: list.querySelectorAll('.history-entry').length };
    });
    assert.equal(r.n, 6);
    assert.ok(r.listOver <= 1, `list scrolls sideways by ${r.listOver}`);
    assert.equal(r.chipsOut, 0, 'chips inside the panel');
    assert.equal(r.rowsOut, 0, 'rows inside the panel');
    assert.equal(r.tall, true);
    await chip(app, 'studio');
    await app.until(`document.querySelectorAll('#historyList .history-entry').length === 5`);
    assert.equal(await app.page.evaluate(noHScroll), true, 'page, study aids only');
  });
}

t.run();
