'use strict';
// Infographic "Show sources on the picture" (client-only choice kept on the study aid and in the sync summary) and the app icon in the footer of the
// pictures and slides we make (the sentence "AI-generated, so check it against your sources" is gone from them).
const fs = require('fs');
const path = require('path');
const { suite, assert, FakeDrive } = require('../lib/harness');
const { studioItem, connectDrive, noHScroll, mask, AFTER, fx } = require('../lib/common');

const t = suite('11-ig-sources-icon');
const GREEN = '#4DBB79', WHITE = '#FFFFFF';
const OWNER_PATHS = ['M69 40 60 35 26 53 60 71 94 53 86 49', 'M40 61v13c0 6 9 11 20 11s20-5 20-11V61', 'M32 57v15l-3 13h6l-3-13'];
const OWNER_SPARK = 'M78 34c.8 5.5 2.5 7.2 8 8-5.5.8-7.2 2.5-8 8-.8-5.5-2.5-7.2-8-8 5.5-.8 7.2-2.5 8-8Z';
const kbs = () => [fx.kbItem('guide.txt', { tokens: 300, id: 'k_guide' }), fx.kbItem('book.pdf', { tokens: 600, pages: 6, id: 'k_book' })];

// infographic answers that cover every layout, with figures (their own footnotes) and citations
const FIGS = [{ value: '42', label: 'The answer', quote: 'the answer is 42', source: 'S1', page: 3, verified: true }, { value: '7', label: 'Lucky', quote: 'seven is lucky 7', source: 'S2', page: 1, verified: true }];
const LAYOUTS = {
  steps: () => ({ ...fx.infographic(), figures: FIGS }),
  facts: () => ({ ...fx.infographic(), layout: 'facts', figures: FIGS }),
  timeline: () => { const d = fx.infographic(); d.layout = 'timeline'; d.items.forEach((it, i) => { it.when = `${1900 + i * 10}`; }); return d; },
  comparison: () => { const d = fx.infographic(); d.layout = 'comparison'; d.columns = ['Old way', 'New way']; d.items.forEach((it, i) => { it.left = `Old ${i}`; it.right = `New ${i}`; }); return d; },
};
// one picture as strings, drawn by the page's own function
const drawIg = (app, data, { pick, ...opts } = {}) => app.page.evaluate(({ data, pick, opts }) => {
  const t = window.__t, model = t.studioNormalizeInfographic(data, { pick, sourceCount: 2 });
  const out = t.studioIgSvg(model, { nameOf: (n) => `Name${n}`, ...opts });
  const doc = new DOMParser().parseFromString(out.svg, 'image/svg+xml');
  return { svg: out.svg, width: out.width, height: out.height, texts: [...doc.querySelectorAll('text')].map(x => x.textContent), icons: doc.querySelectorAll('.sth-icon').length };
}, { data, pick, opts });
const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

// ── the helper ──
t.test('studioAppIcon: the owner\'s paths, green by default, white variant, size and position', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const r = await app.page.evaluate(() => { const t = window.__t; return { green: t.studioAppIcon(10, 20, 24), white: t.studioAppIcon(0, 0, 120, '#FFFFFF'), c: t.STUDIO_APP_ICON }; });
  for (const d of OWNER_PATHS) { assert.ok(r.green.includes(`d="${d}"`) && r.white.includes(`d="${d}"`), d); }
  assert.ok(r.green.includes(`d="${OWNER_SPARK}"`), 'sparkle');
  assert.equal(r.c.green, GREEN);
  assert.equal(r.c.white, WHITE);
  assert.ok(r.green.includes(`stroke="${GREEN}"`) && r.green.includes(`fill="${GREEN}"`) && !r.green.includes(WHITE), 'green: lines and sparkle');
  assert.ok(r.white.includes(`stroke="${WHITE}"`) && r.white.includes(`fill="${WHITE}"`) && !r.white.includes(GREEN), 'white: lines and sparkle');
  assert.ok(r.green.includes('translate(10 20) scale(0.2)'), 'placed and scaled from the 120 grid');
  // small sizes get a heavier stroke so the lines stay visible (about 1.2 px per 100 px of picture width); at the full 120 grid it is the owner's 2.5
  assert.ok(r.green.includes('stroke-width="6"') && r.white.includes('stroke-width="2.5"') && r.green.includes('stroke-linecap="round"') && r.green.includes('stroke-linejoin="round"'));
  assert.ok(!/<script|onload|href=/i.test(r.green), 'inline vector only');
  // contrast of the white variant on the darkest background of the app (the green of the master bar and the dark infographic card)
  const lum = (hex) => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  assert.ok(ratio(WHITE, '#2c5f2d') >= 4.5, `white on dark green ${ratio(WHITE, '#2c5f2d').toFixed(1)}:1`);
});

t.test('studioAppIconPng: a PNG data URL with the chosen colour (green on light, white on dark)', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const px = await app.page.evaluate(async () => {
    const t = window.__t, out = {};
    for (const [name, color] of [['green', undefined], ['white', '#FFFFFF']]) {
      const url = await t.studioAppIconPng(color);
      const img = new Image(); img.src = `data:${url}`; await img.decode();
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let n = 0, r = 0, gr = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 200) { n++; r += d[i]; gr += d[i + 1]; b += d[i + 2]; }
      out[name] = { prefix: url.slice(0, 22), w: img.width, opaque: n, rgb: [Math.round(r / n), Math.round(gr / n), Math.round(b / n)] };
    }
    return out;
  });
  assert.equal(px.green.prefix, 'image/png;base64,iVBOR');
  assert.ok(px.green.opaque > 100 && px.white.opaque > 100, 'something is drawn');
  assert.deepEqual(px.green.rgb, [0x4D, 0xBB, 0x79]);
  assert.deepEqual(px.white.rgb, [255, 255, 255]);
});

// ── the picture: sources on (default) and off ──
t.test('infographic SVG: sources on by default (option missing = on); the icon replaces the sentence', async (h) => {
  const app = await h.newApp({ now: AFTER });
  for (const [name, make] of Object.entries(LAYOUTS)) {
    const dflt = await drawIg(app, make(), { pick: name, sourceNames: ['Zebra notes', 'Yak reader'] });
    const on = await drawIg(app, make(), { pick: name, sourceNames: ['Zebra notes', 'Yak reader'], showSources: true });
    assert.equal(dflt.svg, on.svg, `${name}: default = on`);
    assert.ok(dflt.texts.some(x => /^\[\d/.test(x)), `${name}: footnote numbers`);
    assert.ok(dflt.texts.includes('Sources') && dflt.texts.some(x => /^\[1\] Name1/.test(x)), `${name}: Sources block`);
    assert.ok(dflt.texts.some(x => x === 'Made with Student Tools Hub from: Zebra notes, Yak reader'), `${name}: footer names the sources`);
    assert.equal(dflt.icons, 1, `${name}: one icon`);
    assert.ok(dflt.svg.includes(`stroke="${GREEN}"`));
    assert.ok(!/AI-generated/i.test(dflt.svg), `${name}: the sentence is gone`);
  }
});

t.test('infographic SVG: sources off removes footnotes, the Sources block and the names in the footer, in every layout', async (h) => {
  const app = await h.newApp({ now: AFTER });
  for (const [name, make] of Object.entries(LAYOUTS)) {
    const on = await drawIg(app, make(), { pick: name, sourceNames: ['Zebra notes', 'Yak reader'] });
    const off = await drawIg(app, make(), { pick: name, sourceNames: ['Zebra notes', 'Yak reader'], showSources: false });
    assert.ok(!off.texts.some(x => /^\[\d/.test(x) || /^\[\d+\]/.test(x)), `${name}: no footnote numbers`);
    assert.ok(!off.texts.includes('Sources'), `${name}: no Sources heading`);
    assert.ok(!off.texts.some(x => /Name\d|Zebra|Yak/.test(x)), `${name}: no source names anywhere`);
    assert.ok(off.texts.includes('Made with Student Tools Hub'), `${name}: footer text stays, without names`);
    assert.equal(off.icons, 1, `${name}: icon stays`);
    assert.ok(off.height < on.height, `${name}: shorter without the Sources block (${off.height} < ${on.height})`);
    // the rest of the picture is the same
    for (const x of ['Steps of the process', 'Step 1', 'Follow the steps in order.']) assert.equal(off.texts.includes(x), on.texts.includes(x), `${name}: ${x}`);
  }
});

t.test('footer icon never overlaps text and stays inside the picture (360, 390, 1080 wide, long source names, on and off)', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const longNames = ['A very long study guide name for the first term', 'Another remarkably long prescribed book title second edition', 'x'.repeat(60)];
  for (const width of [360, 390, 720, 1080]) {
    for (const showSources of [true, false]) {
      const r = await app.page.evaluate(({ data, width, showSources, longNames }) => {
        const t = window.__t, model = t.studioNormalizeInfographic(data, { sourceCount: 2 });
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:0;top:0';
        host.innerHTML = t.studioIgSvg(model, { width, nameOf: (n) => `Name${n}`, sourceNames: longNames, showSources }).svg;
        document.body.appendChild(host);
        const svg = host.querySelector('svg').getBoundingClientRect(), ic = host.querySelector('.sth-icon').getBoundingClientRect();
        const hit = [], wide = [];
        for (const x of host.querySelectorAll('text')) {
          const r = x.getBoundingClientRect();
          if (r.left < ic.right - 0.5 && r.right > ic.left + 0.5 && r.top < ic.bottom - 0.5 && r.bottom > ic.top + 0.5) hit.push(x.textContent);
          if (r.right > svg.right + 0.5 || r.left < svg.left - 0.5) wide.push(x.textContent);
        }
        const m = /scale\(([\d.]+)\)/.exec(host.querySelector('.sth-icon').getAttribute('transform'));
        const vb = host.querySelector('svg').viewBox.baseVal.width, box = Number(m[1]) * 120 * svg.width / vb;
        const out = { hit, wide, inside: ic.left >= svg.left && ic.right <= svg.right && ic.top >= svg.top && ic.bottom <= svg.bottom, size: Math.round(box) };
        host.remove();
        return out;
      }, { data: fx.infographic(), width, showSources, longNames });
      assert.deepEqual(r.hit, [], `${width}/${showSources}: text over the icon`);
      assert.deepEqual(r.wide, [], `${width}/${showSources}: text outside the picture`);
      assert.equal(r.inside, true, `${width}/${showSources}: icon inside`);
      if (width === 1080) assert.ok(r.size >= 38 && r.size <= 46, `about 42 px in a 1080 export (${r.size})`);
    }
  }
});

t.test('mind map image: icon next to "Made with Student Tools Hub from: ...", no AI sentence, no overlap', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const r = await app.page.evaluate((data) => {
    const t = window.__t, model = t.studioNormalizeMindmap(data);
    const out = t.studioMapSvg(model, new Set(model.nodes.map(n => n.id)), { nameOf: (n) => `Src${n}`, sourceNames: ['guide', 'a much longer name of a prescribed book'] });
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:0;top:0'; host.innerHTML = out.svg; document.body.appendChild(host);
    const ic = host.querySelector('.sth-icon').getBoundingClientRect(), svg = host.querySelector('svg').getBoundingClientRect();
    const hit = [...host.querySelectorAll('text')].filter(x => { const r = x.getBoundingClientRect(); return r.left < ic.right - 0.5 && r.right > ic.left + 0.5 && r.top < ic.bottom - 0.5 && r.bottom > ic.top + 0.5; }).map(x => x.textContent);
    const foot = [...host.querySelectorAll('text')].map(x => x.textContent).filter(x => /Made with|guide/.test(x));
    return { svg: out.svg, hit, foot, inside: ic.bottom <= svg.bottom && ic.right <= svg.right, icons: host.querySelectorAll('.sth-icon').length };
  }, fx.mindmap());
  assert.equal(r.icons, 1);
  assert.deepEqual(r.hit, []);
  assert.equal(r.inside, true);
  assert.ok(r.foot.join(' ').includes('Made with Student Tools Hub from: guide'), r.foot.join('|'));
  assert.ok(!/AI-generated/i.test(r.svg));
  assert.ok(r.svg.includes(`stroke="${GREEN}"`));
});

// ── the dialog, the item and the request ──
t.test('dialog: a real checkbox with a label, on by default, only for the infographic; at 320 px nothing scrolls sideways', async (h) => {
  const app = await h.newApp({ now: AFTER, width: 320, height: 700 });
  await app.seedKb(kbs());
  await app.ev(`studio.openDialog('infographic', { sourceIds: ['k_guide'] })`);
  const box = app.page.getByRole('checkbox', { name: 'Show sources on the picture' });
  assert.equal(await box.isVisible(), true);
  assert.equal(await box.isChecked(), true, 'default on');
  assert.equal(await app.page.evaluate(() => document.querySelector('label[for="studioShowSources"]').textContent.trim()), 'Show sources on the picture');
  assert.equal(await app.ev(noHScroll), true);
  const r = await box.boundingBox();
  assert.ok(r.width >= 18 && r.height >= 18);
  await app.ev(`studio.closeDialog()`);
  for (const tool of ['mindmap', 'flashcards', 'quiz', 'slides']) {
    await app.ev(`studio.openDialog('${tool}', { sourceIds: ['k_guide'] })`);
    assert.equal(await app.ev(`document.getElementById('studioShowSourcesField').hidden`), true, `${tool}: no checkbox`);
    await app.ev(`studio.closeDialog()`);
  }
});

async function generate(app, { uncheck }) {
  await app.ev(`studio.openDialog('infographic', { language: 'af', topic: 'Focus', sourceIds: ['k_guide', 'k_book'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  if (uncheck) await app.page.getByRole('checkbox', { name: 'Show sources on the picture' }).uncheck();
  await app.page.click('#studioGenerateBtn');
}

t.test('generate with the box unchecked: the aid keeps showSources:false and the request carries nothing about it', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedKb(kbs());
  await generate(app, { uncheck: true });
  await app.advanceUntil(`studio.items.length === 1 && studio.items[0].status === 'ready'`, { step: 2000 });
  assert.equal(await app.ev('studio.items[0].showSources'), false);
  const req = app.n8n.creates()[0];
  assert.ok(!/showSources|sources on the picture/i.test(JSON.stringify(req)), 'the whole create call has no trace of the choice');
  assert.deepEqual(req.payload.options, { layout: 'auto' });
  assert.deepEqual(await app.ev(`studioCleanOptions('infographic', { layout: 'steps', showSources: false })`), { layout: 'steps' }, 'the option machinery drops it');
  // it is not forgotten on Regenerate: the dialog opens with the item's choice
  await app.ev(`studio.openDialog('infographic', { options: studio.items[0].options, showSources: studio.items[0].showSources, sourceIds: ['k_guide'] })`);
  assert.equal(await app.page.getByRole('checkbox', { name: 'Show sources on the picture' }).isChecked(), false);
});

t.test('generate with the box left checked: showSources:true; other tools get no such field', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedKb(kbs());
  await generate(app, { uncheck: false });
  await app.advanceUntil(`studio.items.length === 1 && studio.items[0].status === 'ready'`, { step: 2000 });
  assert.equal(await app.ev('studio.items[0].showSources'), true);
  await app.ev(`studio.openDialog('mindmap', { sourceIds: ['k_guide'] })`);
  await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
  await app.page.click('#studioGenerateBtn');
  await app.advanceUntil(`studio.items.length === 2 && studio.items.every(i => i.status === 'ready')`, { step: 2000 });
  assert.equal(await app.ev(`'showSources' in studio.items.find(i => i.tool === 'mindmap')`), false);
});

t.test('request bodies of the infographic are identical to BASE with the box unchecked (and checked)', async (h) => {
  const capture = async (kind, uncheck) => {
    const app = await h.newApp({ page: kind, now: Date.UTC(2026, 11, 10, 12), jobs: true, clock: true });
    await app.seedKb(kbs());
    await app.ev(`studio.openDialog('infographic', { language: 'af', topic: 'Focus', sourceIds: ['k_guide', 'k_book'] })`);
    await app.until(`document.getElementById('studioGenerateBtn').getAttribute('aria-disabled') === 'false'`);
    if (uncheck) await app.page.getByRole('checkbox', { name: 'Show sources on the picture' }).uncheck();
    await app.page.click('#studioGenerateBtn');
    await app.waitNode(() => app.n8n.creates('studio_infographic').length > 0, { what: 'request' });
    const rec = app.n8n.creates('studio_infographic')[0];
    return mask({ payload: rec.payload, mode: rec.mode, bulk: rec.bulk, attempt: rec.attempt });
  };
  const base = await capture('base', false);
  assert.equal(await capture('new', true), base, 'unchecked');
  assert.equal(await capture('new', false), base, 'checked');
}, { needsBase: true, timeout: 80000 });

// ── the viewer ──
const viewerHas = (app) => app.page.evaluate(() => {
  const svg = document.querySelector('#studioIgStage svg');
  const texts = [...svg.querySelectorAll('text')].map(x => x.textContent);
  return { marks: texts.filter(x => /^\[\d/.test(x)).length, sourcesBlock: texts.includes('Sources'), foot: texts[texts.length - 1], chips: document.querySelectorAll('#studioIgTextBody .studio-mm-chip').length, box: document.getElementById('studioIgSources').checked, icon: !!svg.querySelector('.sth-icon') };
});
async function openIg(app, id) {
  await app.goto(`#studio/${id}`);
  await app.until(`!!document.getElementById('studioIg') && !!document.querySelector('#studioIgStage svg')`, { what: 'infographic viewer' });
}

t.test('viewer: an aid without the field shows sources; the toggle is a real labelled checkbox; Text version keeps its citations either way', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([studioItem('infographic', { id: 'ig_old', sourceIds: ['k_a'], sourceNames: ['a.txt'] })]);
  await openIg(app, 'ig_old');
  assert.equal(await app.ev(`'showSources' in studio.items[0]`), false, 'an old aid has no field');
  let v = await viewerHas(app);
  assert.deepEqual({ box: v.box, on: v.marks > 0 && v.sourcesBlock, chips: v.chips > 0, icon: v.icon }, { box: true, on: true, chips: true, icon: true });
  const box = app.page.getByRole('checkbox', { name: 'Show sources on the picture' });
  assert.equal(await box.isVisible(), true);
  assert.equal(await app.page.evaluate(() => document.getElementById('studioIgSources').type), 'checkbox');
  const before = await app.ev('studio.items[0].updatedAt');
  await box.uncheck();
  await app.until(`studio.items[0].showSources === false`);
  v = await viewerHas(app);
  assert.deepEqual({ marks: v.marks, block: v.sourcesBlock, foot: v.foot, icon: v.icon }, { marks: 0, block: false, foot: 'Made with Student Tools Hub', icon: true });
  assert.ok(v.chips > 0, 'the Text version for screen readers still has its citations');
  assert.ok((await app.ev('studio.items[0].updatedAt')) >= before);
  assert.equal(await app.ev(`document.getElementById('studioLive').textContent`), 'Sources hidden on the picture.');
  await box.check();
  v = await viewerHas(app);
  assert.ok(v.marks > 0 && v.sourcesBlock, 'back on');
  assert.deepEqual(app.pageErrors, []);
});

t.test('viewer: the choice survives a reload', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([studioItem('infographic', { id: 'ig_keep' }), studioItem('infographic', { id: 'ig_other' })]);
  await openIg(app, 'ig_keep');
  await app.page.getByRole('checkbox', { name: 'Show sources on the picture' }).uncheck();
  await app.until(`studio.items.find(i => i.id === 'ig_keep').showSources === false`);
  await h.sleep(300);
  await app.reload();
  await openIg(app, 'ig_keep');
  const v = await viewerHas(app);
  assert.deepEqual({ box: v.box, marks: v.marks, block: v.sourcesBlock }, { box: false, marks: 0, block: false });
  await openIg(app, 'ig_other');
  assert.equal((await viewerHas(app)).box, true, 'another aid is untouched');
});

async function download(app, root, act) {
  await app.page.evaluate((r) => { document.querySelector('#' + r + ' details.studio-menu').open = true; }, root);
  const [dl] = await Promise.all([app.page.waitForEvent('download', { timeout: 20000 }), app.page.click(`#${root} [data-studio-act="${act}"]`)]);
  return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
}

t.test('exports (SVG, PNG, PDF) follow the current setting', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([studioItem('infographic', { id: 'ig_x' })]);
  await openIg(app, 'ig_x');
  // see the SVG that every export hands on to the PNG maker
  await app.ev(`window.__svgs = []; { const o = studioSvgPng; studioSvgPng = (svg, ...rest) => { window.__svgs.push(svg); return o(svg, ...rest); }; }`);
  const run = async () => {
    const svg = await download(app, 'studioIg', 'export-ig-svg');
    const png = await download(app, 'studioIg', 'export-ig-png');
    const pdf = await download(app, 'studioIg', 'export-ig-pdf');
    const sent = await app.page.evaluate(() => { const s = window.__svgs.slice(); window.__svgs.length = 0; return s; });
    return { svg: svg.data.toString('utf8'), png: pngSize(png.data), pdfOk: pdf.data.subarray(0, 4).toString() === '%PDF', sent };
  };
  const texts = (svg) => app.page.evaluate((s) => [...new DOMParser().parseFromString(s, 'image/svg+xml').querySelectorAll('text')].map(x => x.textContent), svg);
  const on = await run();
  await app.page.getByRole('checkbox', { name: 'Show sources on the picture' }).uncheck();
  await app.until(`studio.items[0].showSources === false`);
  const off = await run();
  const [tOn, tOff] = [await texts(on.svg), await texts(off.svg)];
  assert.ok(tOn.some(x => /^\[\d/.test(x)) && tOn.includes('Sources'), 'SVG on');
  assert.ok(!tOff.some(x => /^\[\d/.test(x)) && !tOff.includes('Sources') && !tOff.some(x => /a\.txt|Name|\ba\b/.test(x)) && tOff[tOff.length - 1] === 'Made with Student Tools Hub', `SVG off: ${tOff.join('|')}`);
  assert.equal(on.sent.length, 2, 'PNG and PDF each draw once');
  assert.deepEqual(on.sent.map(s => s === on.sent[0]), [true, true]);
  for (const s of off.sent) assert.ok(!/>\[\d/.test(s) && !/>Sources</.test(s), 'the picture behind PNG and PDF has no sources');
  for (const s of on.sent) assert.ok(/>\[\d/.test(s) && />Sources</.test(s));
  assert.ok(off.png.h < on.png.h && off.png.w === on.png.w, `PNG shorter without sources (${off.png.h} < ${on.png.h})`);
  assert.ok(on.pdfOk && off.pdfOk);
  assert.ok(!/AI-generated/i.test(on.svg + off.svg));
});

// ── sync ──
t.test('Drive sync: the summary carries showSources (true for an aid without the field), other tools carry nothing', async (h) => {
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([studioItem('infographic', { id: 'ig_on' }), studioItem('infographic', { id: 'ig_off', showSources: false }), studioItem('mindmap', { id: 'mm_one' })]);
  await connectDrive(app);
  const sum = () => Object.fromEntries(app.drive.json(app.drive.byName('sth-userdata-v1.json')[0].id).studio.items.map(i => [i.id, i]));
  let s = sum();
  assert.equal(s.ig_on.showSources, true);
  assert.equal(s.ig_off.showSources, false);
  assert.equal('showSources' in s.mm_one, false);
  assert.deepEqual(s.ig_off.options, {}, 'options are not touched');
  // toggled in the viewer, then pushed: the summary follows
  await openIg(app, 'ig_on');
  await app.page.getByRole('checkbox', { name: 'Show sources on the picture' }).uncheck();
  await app.until(`studio.items.find(i => i.id === 'ig_on').showSources === false`);
  await h.sleep(300);
  await app.ev('pushToDrive()');
  s = sum();
  assert.equal(s.ig_on.showSources, false);
  assert.ok(s.ig_on.updatedAt > s.ig_off.createdAt);
});

t.test('Drive sync: pull of an aid without the field = on; an explicit false is kept; a newer remote choice reaches an existing aid; junk is ignored', async (h) => {
  const drive = new FakeDrive();
  const art = studioItem('infographic').artifact;
  const file = (id) => drive.add(`sth-studio-${id}.json`, { v: 1, id, tool: 'infographic', artifact: art });
  const now = AFTER;
  const sum = (id, over = {}) => ({ id, tool: 'infographic', title: id, language: 'en', topic: '', options: { layout: 'auto', showSources: false }, sourceIds: ['k_a'], sourceNames: ['a.txt'], createdAt: now - 5000, updatedAt: now - 2000, driveFileId: file(id), artifactBytes: 10, ...over });
  drive.add('sth-userdata-v1.json', { kbItems: [], tutorChats: [], createdDocs: [], removedDocIds: [], syncedAt: now, studio: { v: 1, progress: {}, deleted: [], items: [
    sum('r_missing'), sum('r_false', { showSources: false }), sum('r_junk', { showSources: 'no' }), sum('r_newer', { showSources: false, updatedAt: now - 100 }), sum('r_older', { showSources: false, updatedAt: now - 9000 }),
  ] } });
  const app = await h.newApp({ drive, now: AFTER });
  // two aids already here: one older than the remote summary, one newer
  await app.seedItems([studioItem('infographic', { id: 'r_newer', updatedAt: now - 3000, createdAt: now - 5000, driveFileId: 'fid000001x' }), studioItem('infographic', { id: 'r_older', updatedAt: now - 1000, createdAt: now - 5000, driveFileId: 'fid000001x' })]);
  await connectDrive(app);
  const got = await app.ev(`Object.fromEntries(studio.items.map(i => [i.id, { s: i.showSources, o: i.options }]))`);
  assert.equal(got.r_missing.s, undefined, 'missing stays missing (= on)');
  assert.equal(got.r_false.s, false);
  assert.equal(got.r_junk.s, undefined, 'a non-boolean is ignored');
  assert.equal(got.r_newer.s, false, 'newer remote choice applied');
  assert.equal(got.r_older.s, undefined, 'older remote choice does not overwrite');
  for (const k of ['r_missing', 'r_false', 'r_junk']) assert.deepEqual(got[k].o, { layout: 'auto' }, 'options in the sync file are cleaned as before');
  // the viewer shows them
  await openIg(app, 'r_missing');
  assert.equal((await viewerHas(app)).box, true);
});

t.test('older data and older tabs: studioSyncCleanSummary and studioCleanOptions tolerate a missing or extra field', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const r = await app.page.evaluate((tm) => {
    const t = window.__t;
    const raw = { id: 'a1', tool: 'infographic', driveFileId: 'fid000001x', createdAt: tm, options: { layout: 'steps' } };
    return {
      missing: 'showSources' in t.studioSyncCleanSummary(raw), no: t.studioSyncCleanSummary({ ...raw, showSources: false }).showSources, yes: t.studioSyncCleanSummary({ ...raw, showSources: true }).showSources,
      junk: ['no', 0, null, {}].map(v => 'showSources' in t.studioSyncCleanSummary({ ...raw, showSources: v })),
      otherTool: 'showSources' in t.studioSyncCleanSummary({ ...raw, tool: 'mindmap', showSources: false }),
      opt: t.studioCleanOptions('infographic', { layout: 'timeline', showSources: false }),
      summary: t.studioSyncSummary({ id: 'x', tool: 'infographic', title: 't', language: 'en', topic: '', options: {}, sourceIds: [], sourceNames: [], createdAt: 1, updatedAt: 1, driveFileId: 'f' }).showSources,
      show: [t.studioShowSources({}), t.studioShowSources({ showSources: true }), t.studioShowSources({ showSources: false })],
    };
  }, AFTER - 1000);
  assert.deepEqual(r, { missing: false, no: false, yes: true, junk: [false, false, false, false], otherTool: false, opt: { layout: 'timeline' }, summary: true, show: [true, true, false] });
});

// ── slides: the .pptx ──
t.test('.pptx: one icon image on every slide (larger on the title slide), "Made with Student Tools Hub", the AI sentence is gone', async (h) => {
  let JSZip;
  try { JSZip = require(path.join(__dirname, '..', '.cache', 'jszip.min.js')); } catch { /* handled below */ }
  assert.ok(JSZip, 'tests/.cache/jszip.min.js is needed (run tests/lib/vendor.js ensure)');
  const app = await h.newApp({ now: AFTER });
  await app.seedItems([studioItem('slides', { id: 'sl_x' })]);
  await app.goto('#studio/sl_x');
  await app.until(`!!document.getElementById('studioSl')`, { what: 'slides viewer' });
  const file = await download(app, 'studioSl', 'export-sl-pptx');
  assert.match(file.name, /\.pptx$/);
  assert.deepEqual(app.pageErrors, []);
  assert.deepEqual(app.blocked, [], 'no request beyond the library from jsDelivr');
  const zip = await JSZip.loadAsync(file.data);
  const names = Object.keys(zip.files);
  const slides = names.filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
  assert.equal(slides.length, 5, 'four slides and the Sources slide');
  const media = names.filter(n => /^ppt\/media\//.test(n));
  assert.ok(media.length >= slides.length, `media entries: ${media.join(', ')}`);
  const sizes = [];
  for (const [i, sName] of slides.entries()) {
    const num = sName.match(/slide(\d+)\.xml/)[1];
    const rels = await zip.file(`ppt/slides/_rels/slide${num}.xml.rels`).async('string');
    const images = [...rels.matchAll(/Type="[^"]*\/image"[^>]*Target="([^"]+)"/g)].map(m => m[1]).concat([...rels.matchAll(/Target="([^"]+)"[^>]*Type="[^"]*\/image"/g)].map(m => m[1]));
    assert.equal(images.length, 1, `slide ${i + 1} has exactly one image`);
    const target = path.posix.normalize(path.posix.join('ppt/slides', images[0]));
    const png = await zip.file(target).async('nodebuffer');
    assert.equal(png.subarray(1, 4).toString(), 'PNG', `slide ${i + 1} image is a PNG`);
    const xml = await zip.file(sName).async('string');
    assert.ok(xml.includes('Made with Student Tools Hub'), `slide ${i + 1} footer text`);
    assert.ok(/descr="Graduation cap with a sparkle"/.test(xml), `slide ${i + 1} alt text`);
    sizes.push(Number(xml.match(/<p:pic>[\s\S]*?<a:ext cx="(\d+)"/)[1]));
  }
  assert.ok(sizes[0] > sizes[1] && sizes.slice(1).every(s => s === sizes[1]), `the title slide icon is larger: ${sizes.join(', ')}`);
  for (const n of names.filter(n => /\.(xml|rels)$/.test(n))) {
    const text = await zip.file(n).async('string');
    assert.ok(!/AI-generated|check against your sources/i.test(text), `${n} has no AI sentence`);
  }
  // the masters and layouts carry no picture of their own
  for (const n of names.filter(n => /^ppt\/(slideMasters|slideLayouts)\/_rels\/.+\.rels$/.test(n))) assert.ok(!/\/image"/.test(await zip.file(n).async('string')), `${n} has no image`);
});

// ── what must not change ──
t.test('Markdown outline keeps its AI sentence, flashcards TSV has no footer: both identical to BASE', async (h) => {
  const grab = async (kind) => {
    const app = await h.newApp({ page: kind, now: AFTER });
    await app.seedItems([studioItem('mindmap', { id: 'e_mm' }), studioItem('flashcards', { id: 'e_fc' })]);
    await app.goto('#studio/e_mm');
    await app.until(`!!document.getElementById('studioMm')`);
    const md = await download(app, 'studioMm', 'export-md');
    await app.goto('#studio/e_fc');
    await app.until(`!!document.getElementById('studioFc')`);
    const tsv = await download(app, 'studioFc', 'export-tsv');
    return { md: md.data.toString('utf8'), tsv: tsv.data.toString('utf8') };
  };
  const nu = await grab('new');
  assert.ok(nu.md.trimEnd().endsWith('Made with Student Tools Hub. AI-generated, so check it against your sources.'), 'the outline keeps its text line');
  assert.equal(nu.tsv.trim().split('\n').length, 6);
  assert.ok(!/Student Tools Hub|AI-generated/.test(nu.tsv), 'a footer would break the Anki import');
  const base = await grab('base');
  assert.equal(nu.md, base.md);
  assert.equal(nu.tsv, base.tsv);
}, { needsBase: true, timeout: 60000 });

t.test('in-app viewer notices that say AI can be wrong stay', async (h) => {
  const app = await h.newApp({ now: AFTER });
  const tools = ['mindmap', 'flashcards', 'quiz', 'infographic', 'slides'];
  await app.seedItems(tools.map(tool => studioItem(tool, { id: `n_${tool}` })));
  const root = { mindmap: 'studioMm', flashcards: 'studioFc', quiz: 'studioQz', infographic: 'studioIg', slides: 'studioSl' };
  for (const tool of tools) {
    await app.goto(`#studio/n_${tool}`);
    await app.until(`!!document.getElementById('${root[tool]}')`);
    assert.match(await app.page.evaluate((r) => document.querySelector(`#${r} .studio-mm-foot`).textContent, root[tool]), /AI-generated, so check it against your sources/, tool);
  }
});

t.run();
