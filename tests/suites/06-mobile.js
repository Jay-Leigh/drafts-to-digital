'use strict';
// Mobile layout smoke at 320, 360, 390 and 430 px: no horizontal scroll on home, tutor, studio, Knowledge Bay and the tool views; the tutor top bar order.
const { suite, assert } = require('../lib/harness');
const { studioItem, noHScroll, AFTER, fx } = require('../lib/common');

const t = suite('06-mobile');
const WIDTHS = [320, 360, 390, 430];
const LONG = 'Averyveryveryverylongwordwithoutanybreaksatallthatkeepsgoingandgoingandgoing' + 'x'.repeat(80);

async function seed(app) {
  await app.seedKb([
    fx.kbItem(`${LONG}.txt`, { tokens: 120, id: 'k_long' }), fx.kbItem('Study guide for the whole of learning unit three.pdf', { tokens: 400, pages: 4, id: 'k_pdf' }), fx.kbItem('notes.txt', { tokens: 50, id: 'k_n' }),
  ]);
  await app.seedItems(['mindmap', 'flashcards', 'quiz', 'infographic', 'slides'].map(tool => studioItem(tool, { id: `m_${tool}`, title: `${tool} ${LONG}`, sourceIds: ['k_long', 'k_pdf'], sourceNames: [`${LONG}.txt`, 'guide.pdf'] })));
  const id = await app.ev(`(async () => {
    const c = await tutor.newChatFor({ title: 'Chat with wide content ${LONG}' });
    c.messages.push({ id: 'u1', ts: Date.now(), role: 'user', text: '${LONG}' });
    c.messages.push({ id: 'm1', ts: Date.now(), role: 'model', text: '| a | b | c | d | e | f |\\n|---|---|---|---|---|---|\\n| ${LONG} | 2 | 3 | 4 | 5 | 6 |\\n\\n\`\`\`\\n${'code '.repeat(60)}\\n\`\`\`\\n\\nhttps://example.test/${'path/'.repeat(30)}' });
    await tutor.save(); return c.id; })()`);
  return id;
}

for (const width of WIDTHS) {
  t.test(`${width}px: no horizontal scroll on home, tutor, studio, Knowledge Bay and the tools (notice banner showing)`, async (h) => {
    const app = await h.newApp({ width, height: 760 });
    const chat = await seed(app);
    assert.equal(await app.ev(`document.getElementById('noticeBanner').hidden`), false, 'the 8 Dec notice is showing today');
    const views = [['#home', 'home'], ['#tutor', 'tutor landing'], [`#tutor/${chat}`, 'tutor chat'], ['#studio', 'studio'], ['#studio/m_mindmap', 'studio viewer'], ['#knowledge', 'Knowledge Bay'], ['#transcribe', 'transcribe'], ['#template', 'template'], ['#reviewer', 'reviewer'], ['#references', 'references']];
    for (const [hash, label] of views) {
      await app.goto(hash);
      await h.sleep(450); // the view change takes ~140 ms plus its entrance
      const r = await app.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, bw: document.body.scrollWidth }));
      assert.ok(r.sw <= r.cw + 1 && r.bw <= r.cw + 1, `${label} scrolls sideways at ${width}px (scrollWidth ${r.sw} / ${r.bw}, client ${r.cw})`);
    }
    assert.deepEqual(app.pageErrors, []);
  });

  t.test(`${width}px: the tutor top bar reads burger, title, menu, in one row`, async (h) => {
    const app = await h.newApp({ width, height: 760, now: AFTER });
    const chat = await seed(app);
    await app.openChat(chat);
    await h.sleep(500);
    const b = await app.page.evaluate(() => {
      const box = (id) => { const e = document.getElementById(id); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, r: r.right, cy: r.y + r.height / 2 }; };
      return { burger: box('btnHamburger'), title: box('tutorChatTitle'), menu: box('btnTutorMenu') };
    });
    assert.ok(b.burger && b.title && b.menu, 'all three exist');
    for (const k of ['burger', 'title', 'menu']) assert.ok(b[k].w > 0 && b[k].x >= 0 && b[k].r <= width + 1, `${k} is on screen: ${JSON.stringify(b[k])}`);
    assert.ok(b.burger.r <= b.title.x + 1, `burger (${b.burger.r}) is left of the title (${b.title.x})`);
    assert.ok(b.title.r <= b.menu.x + 1, `title ends (${b.title.r}) before the menu (${b.menu.x})`);
    assert.ok(Math.abs(b.burger.cy - b.menu.cy) < 12 && Math.abs(b.title.cy - b.menu.cy) < 20, 'one row');
    assert.equal(await app.ev(noHScroll), true);
  });
}

t.run();
