'use strict';
// Study Studio, one call per tool: normalisers, XSS text, request bodies BASE vs NEW, journeys to "ready", viewers at three widths, exports.
const fs = require('fs');
const { suite, assert } = require('../lib/harness');
const { studioItem, noHScroll, mask, AFTER, fx } = require('../lib/common');

const t = suite('03-studio-single');
const TOOLS = ['mindmap', 'flashcards', 'quiz', 'infographic', 'slides'];
const kbs = () => [fx.kbItem('guide.txt', { tokens: 300, id: 'k_guide' }), fx.kbItem('book.pdf', { tokens: 600, pages: 6, id: 'k_book' })];

// ── normalisers (pure) ──
t.test('normalisers accept good data', async (h) => {
  const app = await h.newApp({});
  const r = await app.page.evaluate((fixtures) => {
    const t = window.__t;
    return {
      mm: t.studioNormalizeMindmap(fixtures.mindmap).ok, fc: t.studioNormalizeFlashcards(fixtures.flashcards).ok, qz: t.studioNormalizeQuiz(fixtures.quiz).ok,
      ig: t.studioNormalizeInfographic(fixtures.infographic, { sourceCount: 2 }).ok, sl: t.studioNormalizeSlides(fixtures.slides, { sourceCount: 2 }).ok,
      mmN: t.studioNormalizeMindmap(fixtures.mindmap).nodes.length, fcN: t.studioNormalizeFlashcards(fixtures.flashcards).cards.length, qzN: t.studioNormalizeQuiz(fixtures.quiz).questions.length,
      slN: t.studioNormalizeSlides(fixtures.slides, {}).slides.length,
    };
  }, { mindmap: fx.mindmap(), flashcards: fx.flashcards(6), quiz: fx.quiz(5), infographic: fx.infographic(), slides: fx.slides() });
  assert.deepEqual(r, { mm: true, fc: true, qz: true, ig: true, sl: true, mmN: 5, fcN: 6, qzN: 5, slN: 4 });
});

t.test('normalisers refuse malformed data without throwing', async (h) => {
  const app = await h.newApp({});
  const bad = [null, undefined, 5, 'x', [], {}, { nodes: 'no' }, { cards: {} }, { questions: [null] }, { items: [] }, { slides: [1, 2] }, { nodes: [{ id: 'a', label: 'only one' }] }, { cards: [{ front: '', back: '' }] },
    { questions: [{ stem: 'x', options: [{ text: 'a', correct: true }, { text: 'b', correct: true }] }] }];
  const out = await app.page.evaluate((list) => {
    const t = window.__t, res = [];
    for (const [name, fn] of [['mm', t.studioNormalizeMindmap], ['fc', t.studioNormalizeFlashcards], ['qz', t.studioNormalizeQuiz], ['ig', (d) => t.studioNormalizeInfographic(d, {})], ['sl', (d) => t.studioNormalizeSlides(d, {})]]) {
      for (const d of list) { try { const m = fn(d); res.push([name, m && m.ok === false]); } catch (e) { res.push([name, 'threw ' + e.message]); } }
    }
    return res;
  }, bad);
  const thrown = out.filter(([, v]) => v !== true);
  assert.deepEqual(thrown, [], 'every malformed input gives ok:false');
});

t.test('normalisers: wrong schema, too few items, unknown icon, unknown cite', async (h) => {
  const app = await h.newApp({});
  const r = await app.page.evaluate((f) => {
    const t = window.__t;
    const ig = JSON.parse(JSON.stringify(f.infographic)); ig.items[0].icon = 'not-an-icon'; ig.items[1].cites = [{ source: 'S9', page: 1 }];
    const m = t.studioNormalizeInfographic(ig, { sourceCount: 2 });
    return { schema: t.studioNormalizeInfographic({ ...f.infographic, schema: 'sth.other/9' }, {}).reason, few: t.studioNormalizeInfographic({ items: f.infographic.items.slice(0, 2) }, {}).reason,
      icon: m.items[0].icon, cites: m.items[1].cites.length, repairs: m.repairs.length > 0, slFew: t.studioNormalizeSlides({ slides: f.slides.slides.slice(0, 2) }, {}).reason };
  }, { infographic: fx.infographic(), slides: fx.slides() });
  assert.deepEqual(r, { schema: 'schema', few: 'too_few_items', icon: 'dot', cites: 0, repairs: true, slFew: 'too_few_slides' });
});

// ── XSS strings stay text ──
const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
t.test('XSS strings from the model are shown as text in every viewer and in the list', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const evil = (tool) => {
    const it = studioItem(tool, { id: `x_${tool}`, title: XSS });
    const d = it.artifact.data;
    d.title = XSS;
    if (tool === 'mindmap') { d.nodes[1].label = XSS; d.nodes[1].detail = XSS; }
    if (tool === 'flashcards') { d.cards[0].front = XSS; d.cards[0].back = XSS; d.cards[0].topic = XSS; }
    if (tool === 'quiz') { d.questions[0].stem = XSS; d.questions[0].options[0].text = XSS; d.questions[0].explanation = XSS; }
    if (tool === 'infographic') { d.items[0].heading = XSS; d.items[0].text = XSS; d.takeaway = XSS; }
    if (tool === 'slides') { d.slides[1].title = XSS; d.slides[1].bullets = [XSS, 'ok']; }
    return it;
  };
  await app.seedItems(TOOLS.map(evil));
  await app.goto('#studio');
  await app.until(`document.querySelectorAll('#viewStudio .studio-item, #viewStudio [data-studio-item]').length > 0 || studio.items.length === 5`);
  for (const tool of TOOLS) {
    await app.goto(`#studio/x_${tool}`);
    await app.until(`studio.viewerId === 'x_${tool}' && !!document.querySelector('#studioViewerCard #studio${{ mindmap: 'Mm', flashcards: 'Fc', quiz: 'Qz', infographic: 'Ig', slides: 'Sl' }[tool]}')`, { what: `${tool} viewer` });
    if (tool === 'flashcards') await app.page.evaluate(() => document.getElementById('studioFcPlay') && (document.getElementById('studioFcPlay').hidden = false));
    await app.page.evaluate(() => { document.querySelectorAll('#studioViewerCard details').forEach(d => { d.open = true; }); });
    await h.sleep(150);
    const r = await app.page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('#studioViewerCard img[src="x"], #viewStudio img[src="x"]').length, scripts: document.querySelectorAll('#studioViewerCard script').length }));
    assert.deepEqual(r, { xss: undefined, imgs: 0, scripts: 0 }, `${tool} viewer`);
  }
  await app.goto('#studio');
  await h.sleep(200);
  const list = await app.page.evaluate(() => ({ xss: window.__xss, imgs: document.querySelectorAll('#viewStudio img[src="x"]').length, hasText: document.getElementById('viewStudio').textContent.includes('<img src=x') }));
  assert.equal(list.xss, undefined);
  assert.equal(list.imgs, 0);
  assert.equal(list.hasText, true, 'the markup shows as literal text');
});

// ── request bodies, BASE vs NEW ──
async function captureBodies(h, kind, jobsOn) {
  // a date after the release gate of BOTH pages (the baseline may still carry the older gate date)
  const app = await h.newApp({ page: kind, now: Date.UTC(2026, 11, 10, 12), jobs: jobsOn, clock: true });
  await app.seedKb(kbs());
  const bodies = {};
  // with the jobs flag off the page never hears the server's hello, so the v7 tools (infographic, slides) are not on offer: only the three older tools
  for (const tool of jobsOn ? TOOLS : TOOLS.slice(0, 3)) {
    const mode = await app.ev(`STUDIO_TOOLS['${tool}'].mode`);
    await app.ev(`studio.openDialog('${tool}', { language: 'af', topic: 'Focus on chapter 2', sourceIds: ['k_guide', 'k_book'] })`);
    await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`, { what: 'generate enabled' });
    await app.page.click('#studioGenerateBtn');
    const before = jobsOn ? app.n8n.creates(mode).length : app.n8n.direct(mode).length;
    await app.waitNode(() => (jobsOn ? app.n8n.creates(mode).length : app.n8n.direct(mode).length) > before, { what: `${tool} request` });
    const rec = (jobsOn ? app.n8n.creates(mode) : app.n8n.direct(mode)).slice(-1)[0];
    bodies[tool] = { payload: rec.payload, head: jobsOn ? { mode: rec.mode, bulk: rec.bulk, attempt: rec.attempt } : null };
    await app.until(`!studio.dialog.tool`, { what: 'dialog closed' });
  }
  return bodies;
}
for (const jobsOn of [true, false]) {
  t.test(`request bodies of the five tools are identical in BASE and NEW (${jobsOn ? 'job path' : 'direct path'})`, async (h) => {
    const base = await captureBodies(h, 'base', jobsOn);
    const nu = await captureBodies(h, 'new', jobsOn);
    for (const tool of Object.keys(nu)) {
      const a = mask(nu[tool]), b = mask(base[tool]);
      if (a !== b) { let i = 0; while (a[i] === b[i]) i++; assert.fail(`${tool} request differs at char ${i}: NEW ...${a.slice(Math.max(0, i - 60), i + 80)}... BASE ...${b.slice(Math.max(0, i - 60), i + 80)}...`); }
      assert.equal(nu[tool].payload.tool, tool);
      assert.equal(nu[tool].payload.sources.length, 2);
      assert.equal(Object.keys(nu).length, jobsOn ? 5 : 3);
      assert.equal(nu[tool].payload.language.code, 'af');
      assert.equal(nu[tool].payload.description, 'Focus on chapter 2');
      assert.ok(!('part' in nu[tool].payload) && !('strategy' in nu[tool].payload), 'a single call carries no part or strategy');
    }
  }, { needsBase: true, timeout: 80000 });
}

// ── journeys ──
for (const tool of TOOLS) {
  t.test(`${tool}: from the dialog to a ready study aid (job path), viewer opens`, async (h) => {
    const app = await h.newApp({ now: AFTER });
    await app.seedKb(kbs());
    await app.goto('#studio');
    await app.ev(`studio.openDialog('${tool}', { sourceIds: ['k_guide'] })`);
    await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
    await app.page.click('#studioGenerateBtn');
    await app.advanceUntil(`studio.items.length === 1 && studio.items[0].status === 'ready'`, { what: `${tool} ready`, step: 2000 });
    const item = await app.ev('({ tool: studio.items[0].tool, title: studio.items[0].title, env: studio.items[0].artifact.envelope })');
    assert.equal(item.tool, tool);
    assert.equal(item.env, 'sth.studio/1');
    assert.equal(app.n8n.creates().length, 1);
    assert.equal(app.n8n.direct().length, 0);
    await app.goto(`#studio/${await app.ev('studio.items[0].id')}`);
    const root = { mindmap: 'studioMm', flashcards: 'studioFc', quiz: 'studioQz', infographic: 'studioIg', slides: 'studioSl' }[tool];
    await app.until(`!!document.getElementById('${root}')`, { what: 'viewer mounted' });
    assert.deepEqual(app.pageErrors, []);
  });
}

t.test('a failed answer shows a failed card with the error; Retry sends again', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedKb(kbs());
  app.n8n.plan(null, { type: 'fail', code: 'STH-STU-422', retryable: false });
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_guide'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.advanceUntil(`studio.items.length === 1 && studio.items[0].status === 'failed'`, { step: 2000 });
  const code = await app.ev('studio.items[0].error.code');
  assert.ok(code, 'an error code is shown');
  const id = await app.ev('studio.items[0].id');
  await app.ev(`studio.retry('${id}')`);
  await app.advanceUntil(`studio.items[0].status === 'ready'`, { step: 2000 });
  assert.equal(app.n8n.creates('studio_mindmap').length, 2);
});

// ── viewers at three widths ──
const ROOT = { mindmap: 'studioMm', flashcards: 'studioFc', quiz: 'studioQz', infographic: 'studioIg', slides: 'studioSl' };
for (const width of [320, 390, 1280]) {
  t.test(`viewers at ${width}px: no horizontal scroll, key controls visible`, async (h) => {
    const app = await h.newApp({ now: AFTER, width, height: width > 500 ? 800 : 700 });
    await app.seedItems(TOOLS.map(tool => studioItem(tool, { id: `v_${tool}` })));
    await app.goto('#studio');
    await app.until('studio.active()');
    assert.equal(await app.ev(noHScroll), true, 'studio list');
    for (const tool of TOOLS) {
      await app.goto(`#studio/v_${tool}`);
      await app.until(`!!document.getElementById('${ROOT[tool]}')`, { what: `${tool} viewer` });
      await h.sleep(250);
      assert.equal(await app.ev(noHScroll), true, `${tool} viewer scrolls sideways at ${width}px`);
      const vis = await app.page.evaluate((root) => {
        const q = (sel) => { const e = document.querySelector(sel); if (!e) return false; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.left >= -1 && r.right <= innerWidth + 1; };
        return { root: q('#' + root), back: q('#' + root + ' a[href="#studio"]'), menu: q('#' + root + ' details.studio-menu > summary') };
      }, ROOT[tool]);
      assert.deepEqual(vis, { root: true, back: true, menu: true }, `${tool} controls at ${width}px`);
    }
  });
}

// ── exports ──
t.test('export smoke: infographic SVG and PNG, mind map PNG, flashcards TSV, outline markdown', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([studioItem('infographic', { id: 'e_ig' }), studioItem('mindmap', { id: 'e_mm' }), studioItem('flashcards', { id: 'e_fc' })]);
  const grab = async (hash, root, act) => {
    await app.goto(hash);
    await app.until(`!!document.getElementById('${root}')`);
    await app.page.evaluate((r) => { document.querySelector('#' + r + ' details.studio-menu').open = true; }, root);
    const [dl] = await Promise.all([app.page.waitForEvent('download', { timeout: 15000 }), app.page.click(`#${root} [data-studio-act="${act}"]`)]);
    return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
  };
  const svg = await grab('#studio/e_ig', 'studioIg', 'export-ig-svg');
  assert.match(svg.name, /\.svg$/);
  assert.match(svg.data.toString('utf8').slice(0, 200), /<svg/);
  assert.ok(!/<script/i.test(svg.data.toString('utf8')));
  const png = await grab('#studio/e_ig', 'studioIg', 'export-ig-png');
  assert.equal(png.data.subarray(1, 4).toString(), 'PNG');
  const mm = await grab('#studio/e_mm', 'studioMm', 'export-png');
  assert.equal(mm.data.subarray(1, 4).toString(), 'PNG');
  const md = await grab('#studio/e_mm', 'studioMm', 'export-md');
  assert.match(md.data.toString('utf8'), /Branch A/);
  const tsv = await grab('#studio/e_fc', 'studioFc', 'export-tsv');
  assert.equal(tsv.data.toString('utf8').trim().split('\n').length, 6);
});

t.run();
