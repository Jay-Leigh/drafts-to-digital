'use strict';
// Map-reduce, pure functions of the client: studioMrPlan, studioMrEstimate, studioMrMerge, studioMrHash, studioMrNormalizeDigest, studioMrCheckPart, studioMrReduceCites.
const { suite, assert } = require('../lib/harness');
const { AFTER } = require('../lib/common');

const t = suite('08-mr-pure');

// helpers that live in the page for the length of the test (they build big texts there instead of sending them over)
const HELPERS = `
window.__mk = (id, pages, tokPerPage, o = {}) => {
  let text = '';
  for (let p = 1; p <= pages; p++) { const head = '[Page ' + p + ']\\n'; text += head + 'w'.repeat(tokPerPage * 4 - head.length - 1) + '\\n'; }
  return { id, name: id + '.pdf', kind: 'pdf', markers: 'page', pages, tokens: Math.ceil(text.length / 4), text, ...o };
};
window.__plain = (id, tokens, o = {}) => {
  let text = ''; const para = 'This is a paragraph of plain prose that goes on for a while. '.repeat(20);
  while (text.length < tokens * 4) text += para + '\\n\\n';
  text = text.slice(0, tokens * 4);
  return { id, name: id + '.txt', kind: 'txt', markers: 'none', pages: 0, tokens: Math.ceil(text.length / 4), text, ...o };
};
window.__plan = (sources, tool = 'mindmap', options = {}, ctx = {}, cap = 400000) => __t.studioMrPlan(sources, cap, tool, options, ctx);
window.__brief = (p) => p.ok ? (p.fits ? { ok: true, fits: true } : { ok: true, n: p.n, reduce: p.reduce, total: p.total, tokens: p.parts.map(x => x.tokens), counts: p.parts.map(x => x.count), hashes: p.parts.map(x => x.hash), labels: p.parts.map(x => x.label) }) : p;
`;
async function app(h) {
  const a = await h.newApp({ now: AFTER });
  await a.page.evaluate(HELPERS);
  return a;
}
const run = (a, code) => a.page.evaluate(`(() => { ${code} })()`);

t.test('plan: one call takes it when it fits; the same input always gives the same plan', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const s = [__mk('S1', 10, 10000), __mk('S2', 10, 10000)];
    const fits = __plan(s, 'mindmap', {}, {}, 400000);
    const big = () => __plan([__mk('S1', 40, 10000), __mk('S2', 30, 10000)], 'mindmap', {}, { language: 'en', topic: 'x' });
    return { fits: __brief(fits), same: JSON.stringify(big()) === JSON.stringify(big()), n: big().n };`);
  assert.deepEqual(r.fits, { ok: true, fits: true });
  assert.equal(r.same, true);
  assert.equal(r.n, 5, '700k tokens in 10k pages at 150k a part is five parts');
});

t.test('plan: never splits a page; every part is at most 150,000 tokens; the pieces rebuild the sources', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const s = [__mk('S1', 40, 10000), __mk('S2', 30, 10000)];
    const p = __plan(s, 'mindmap');
    const rebuilt = { S1: '', S2: '' }, starts = [];
    for (const part of p.parts) for (const src of part.sources) { rebuilt[src.id] += src.text; starts.push(/^\\[Page \\d+\\]/.test(src.text)); }
    return { n: p.n, tokens: p.parts.map(x => x.tokens), starts: starts.every(Boolean), s1: rebuilt.S1 === s[0].text, s2: rebuilt.S2 === s[1].text, labels: p.parts.map(x => x.label), sum: p.parts.reduce((a, x) => a + x.tokens, 0), total: p.total, reduce: p.reduce, partTool: p.partTool };`);
  assert.equal(r.n, 5);
  assert.ok(r.tokens.every(x => x <= 150000), `parts ${r.tokens}`);
  assert.equal(r.starts, true, 'every piece starts at a page marker');
  assert.equal(r.s1 && r.s2, true, 'nothing dropped, nothing repeated');
  assert.equal(r.sum, r.total);
  assert.equal(r.reduce, true);
  assert.equal(r.partTool, 'digest');
  assert.match(r.labels[0], /S1\.pdf, pages 1–15/);
  assert.match(r.labels[2], /S1\.pdf, pages 31–40/);
});

t.test('plan: a page bigger than a part, and text without pages, are cut at paragraph ends', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const one = __plain('S1', 450000);
    const p = __plan([one], 'mindmap');
    const rebuilt = p.parts.map(x => x.sources[0].text).join('');
    return { n: p.n, tokens: p.parts.map(x => x.tokens), same: rebuilt === one.text, startsAtBreak: p.parts.slice(1).every(x => x.sources[0].text.startsWith('\\n\\n') || /^This is/.test(x.sources[0].text)) };`);
  assert.ok(r.n === 3 || r.n === 4, `450k tokens are 3 parts, or 4 when the cuts at paragraph ends leave a small last piece (got ${r.n})`);
  assert.ok(r.tokens.every(x => x <= 150000));
  assert.equal(r.same, true);
});

t.test('plan: text with no break at all is cut without splitting an emoji', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const text = '\\u{1F600}'.repeat(1000000); // 2,000,000 UTF-16 units, 500,000 tokens, not one space or newline
    const src = { id: 'S1', name: 'e.txt', kind: 'txt', markers: 'none', pages: 0, tokens: Math.ceil(text.length / 4), text };
    const p = __plan([src], 'mindmap');
    const lone = (s) => /[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]/.test(s);
    return { n: p.n, lone: p.parts.some(x => lone(x.sources[0].text)), same: p.parts.map(x => x.sources[0].text).join('') === text };`);
  assert.equal(r.lone, false, 'no lone surrogate at a cut');
  assert.equal(r.same, true);
});

t.test('plan: at most 16 parts and 15 sources', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const pages = (n) => [__mk('S1', n, 149000)];
    const many = (n) => Array.from({ length: n }, (_, i) => __mk('S' + (i + 1), 1, 1000));
    return {
      p16: __brief(__plan(pages(16), 'mindmap')), p17: __plan(pages(17), 'mindmap'),
      s15: __plan(many(15), 'flashcards', { count: 50 }, {}, 10).ok, s16: __plan(many(16), 'flashcards', { count: 50 }, {}, 10),
      limited: __plan(pages(9), 'mindmap', {}, { maxParts: 8 }), empty: __plan([], 'mindmap'),
      partMax: __brief(__plan([__mk('S1', 10, 100000)], 'mindmap', {}, { partMax: 100000 })),
    };`);
  assert.equal(r.p16.n, 16);
  assert.deepEqual({ ok: r.p17.ok, reason: r.p17.reason, n: r.p17.n }, { ok: false, reason: 'parts', n: 17 });
  assert.equal(r.s15, true, 'fifteen sources can be planned');
  assert.deepEqual({ ok: r.s16.ok, reason: r.s16.reason }, { ok: false, reason: 'sources' });
  assert.deepEqual({ ok: r.limited.ok, reason: r.limited.reason }, { ok: false, reason: 'parts' }, 'the hello cap maxParts lowers the limit');
  assert.equal(r.empty.reason, 'empty');
  assert.ok(r.partMax.tokens.every(x => x <= 100000), 'the hello cap partMaxTokens lowers the part size');
});

t.test('plan: the last step must fit (n x 12,000 tokens <= min(300k, hello reduceMax, cap)) or the run is refused before anything is paid', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const pages = (n) => [__mk('S1', n, 149000)];
    return {
      hello9: __plan(pages(9), 'mindmap', {}, { reduceMax: 100000 }), hello8: __plan(pages(8), 'mindmap', {}, { reduceMax: 100000 }).ok,
      cap13: __plan(pages(13), 'mindmap', {}, {}, 150000), cap12: __plan(pages(12), 'mindmap', {}, {}, 150000).ok,
      big16: __plan(pages(16), 'mindmap').ok,
      infographic: __plan(pages(9), 'infographic', {}, { reduceMax: 100000 }).reason, slides: __plan(pages(9), 'slides', {}, { reduceMax: 100000 }).reason,
      listTools: __plan(pages(9), 'flashcards', { count: 50 }, { reduceMax: 100000 }).ok,
    };`);
  assert.deepEqual({ ok: r.hello9.ok, reason: r.hello9.reason, n: r.hello9.n, limit: r.hello9.limit }, { ok: false, reason: 'reduce', n: 9, limit: 100000 });
  assert.equal(r.hello8, true);
  assert.deepEqual({ reason: r.cap13.reason, limit: r.cap13.limit }, { reason: 'reduce', limit: 150000 });
  assert.equal(r.cap12, true);
  assert.equal(r.big16, true, '16 x 12,000 = 192,000 is under the 300,000 ceiling');
  assert.equal(r.infographic, 'reduce');
  assert.equal(r.slides, 'reduce');
  assert.equal(r.listTools, true, 'flashcards and quiz have no last step');
});

t.test('plan: flashcards and quiz need 2 per part, with the request x 1.3 at most', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const pages = (n, tok = 149000) => [__mk('S1', n, tok)];
    const mixed = [__mk('S1', 1, 150000), __mk('S2', 1, 150000), __mk('S3', 1, 60000)];
    return {
      few11: __plan(pages(11), 'flashcards', { count: 15 }).reason, few10: __brief(__plan(pages(10), 'flashcards', { count: 15 })).counts,
      quiz6: __brief(__plan(pages(6), 'quiz', { count: 10 })).counts, quizFew: __plan(pages(8), 'quiz', { count: 10 }).reason,
      std: __brief(__plan(mixed, 'flashcards', {}, {}, 300000)).counts, stdQuiz: __brief(__plan(mixed, 'quiz', {}, {}, 300000)).counts,
      tiny: __brief(__plan([__mk('S1', 1, 150000), __mk('S2', 1, 150000), __mk('S3', 1, 150000), __mk('S4', 1, 150000), __mk('S5', 1, 1000)], 'quiz', { count: 10 })).counts,
      digestCounts: __brief(__plan(pages(4), 'mindmap')).counts,
    };`);
  assert.equal(r.few11, 'few', '11 parts x 2 is 22, more than 1.3 x 15 = 20');
  assert.deepEqual(r.few10, Array(10).fill(2));
  assert.equal(r.quiz6.reduce((x, y) => x + y, 0), 13, '1.3 x 10 questions');
  assert.ok(r.quiz6.every(x => x >= 2));
  assert.equal(r.quizFew, 'few');
  assert.deepEqual(r.std, [16, 16, 7], '39 = 1.3 x 30, shared by size, largest remainder first');
  assert.equal(r.stdQuiz.reduce((x, y) => x + y, 0), 26, '1.3 x 20');
  assert.ok(r.tiny.every(x => x >= 2) && r.tiny.reduce((x, y) => x + y, 0) <= 13, `a tiny part is lifted to 2 and the total stays at 13 or less: ${r.tiny}`);
  assert.deepEqual(r.digestCounts, [0, 0, 0, 0], 'digest parts carry no count');
});

// ── estimate ──
t.test('estimate: worked example, a 4-part mind map (units, rand, minutes)', async (h) => {
  const a = await app(h);
  const e = await run(a, `const plan = { reduce: true, parts: [1, 2, 3, 4].map(() => ({ tokens: 150000 })) }; return __t.studioMrEstimate(plan, 'mindmap', null);`);
  // low: 4 x (150,000 + 1,500 + 8.33 x (5,000 + 1,024)) + 4 x 5,000 + 2,500 + 8.33 x (12,000 + 1,024) = 937,710
  // high: 4 x (150,000 + 1,500 + 8.33 x (8,192 + 1,024)) + 4 x 8,192 + 2,500 + 8.33 x (32,768 + 1,024) = 1,229,832
  assert.deepEqual(e.units, { low: 937710, high: 1229832 });
  assert.deepEqual(e.rand, { low: 5, high: 6.5 });
  assert.deepEqual(e.minutes, { low: 4, high: 10 });
  assert.deepEqual({ n: e.n, todo: e.todo, cached: e.cached, exceeds: e.exceeds, mrMax: e.mrMax, tooLittle: e.tooLittle, pool: e.pool, share: e.share, canForce: e.canForce }, { n: 4, todo: 4, cached: 0, exceeds: false, mrMax: 2000000, tooLittle: false, pool: null, share: null, canForce: true });
});

t.test('estimate: worked example, flashcards in three parts (16, 16 and 7 cards)', async (h) => {
  const a = await app(h);
  const e = await run(a, `const plan = { reduce: false, parts: [{ tokens: 150000, count: 16 }, { tokens: 150000, count: 16 }, { tokens: 60000, count: 7 }] }; return __t.studioMrEstimate(plan, 'flashcards', null);`);
  // low: 2 x (150,000 + 2,500 + 8.33 x (16 x 120 + 1,024)) + (60,000 + 2,500 + 8.33 x (7 x 120 + 1,024)) = 432,074
  // high: the same with 1.3 x the answer: 443,769
  assert.deepEqual(e.units, { low: 432074, high: 443769 });
  assert.deepEqual(e.rand, { low: 2.5, high: 2.5 });
  assert.deepEqual(e.minutes, { low: 4, high: 10 });
});

t.test('estimate: parts already on this device are not counted; the per-run limit is checked on the high figure', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const mk = (cached) => ({ reduce: true, parts: [1, 2, 3, 4].map((x, i) => ({ tokens: 150000, cached: cached.includes(i) })) });
    const none = __t.studioMrEstimate(mk([]), 'mindmap', null), two = __t.studioMrEstimate(mk([0, 1]), 'mindmap', null);
    const lim = (units) => __t.studioMrEstimate(mk([]), 'mindmap', { mrMaxUnits: units, remaining: 9e9, ceiling: 9e9 });
    return { none: none.units, two: { units: two.units, todo: two.todo, cached: two.cached, n: two.n, minutes: two.minutes }, atHigh: lim(1229832).exceeds, below: lim(1229831).exceeds, def: __t.studioMrEstimate(mk([]), 'mindmap', null).mrMax };`);
  assert.ok(r.two.units.high < r.none.high);
  assert.deepEqual({ todo: r.two.todo, cached: r.two.cached, n: r.two.n }, { todo: 2, cached: 2, n: 4 });
  assert.deepEqual(r.two.minutes, { low: 2, high: 6 });
  assert.equal(r.atHigh, false, 'exactly the limit is allowed');
  assert.equal(r.below, true, 'one unit over is refused');
  assert.equal(r.def, 2000000, 'cfg:mr_max_units default when the server cannot be asked');
});

t.test('estimate: the 2,000,000 unit limit (a full mind map: 7 parts fit, 8 do not; 16 cards parts do not)', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const est = (tool, n, o = {}) => __t.studioMrEstimate(__plan([__mk('S1', n, 149000)], tool, o), tool, null);
    return { mind16: est('mindmap', 16), cards16: est('flashcards', 16, { count: 50 }), mind7: est('mindmap', 7), mind8: est('mindmap', 8), cards10: est('flashcards', 10, { count: 50 }), stu416: __t.ERRORS['STU-416'] };`);
  assert.equal(r.mind16.exceeds, true);
  assert.equal(r.cards16.exceeds, true, 'input alone is 16 x 149k = 2.4M units');
  assert.ok(r.mind16.units.high > 2000000);
  assert.equal(r.mind7.exceeds, false);
  assert.equal(r.mind8.exceeds, true, 'a mind map of 8 full parts is over: each part costs about 228,000 units at the high figure, and the last step 281,000');
  assert.equal(r.cards10.exceeds, false, 'flashcards cost less per part (a short answer)');
  assert.ok(r.stu416 && /big|large|limit|too/i.test(r.stu416.message), 'STU-416 has its own message');
});

t.test('estimate: today\'s capacity (budget): share, tooLittle and canForce', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const plan = { reduce: true, parts: [1, 2, 3, 4].map(() => ({ tokens: 150000 })) };
    const b = (o) => __t.studioMrEstimate(plan, 'mindmap', { mrMaxUnits: 5000000, remaining: 0, ceiling: 0, bulkRemaining: null, bulkCeiling: null, ...o });
    return { plenty: b({ bulkRemaining: 12298360, bulkCeiling: 20000000 }), low: b({ bulkRemaining: 500000, bulkCeiling: 2000000 }), never: b({ bulkRemaining: 500000, bulkCeiling: 800000 }), noBulk: b({ remaining: 400000, ceiling: 5000000 }) };`);
  assert.deepEqual({ share: r.plenty.share, tooLittle: r.plenty.tooLittle, pool: r.plenty.pool }, { share: 10, tooLittle: false, pool: 12298360 });
  assert.deepEqual({ tooLittle: r.low.tooLittle, canForce: r.low.canForce, share: r.low.share }, { tooLittle: true, canForce: true, share: 246 });
  assert.deepEqual({ tooLittle: r.never.tooLittle, canForce: r.never.canForce }, { tooLittle: true, canForce: false }, 'a run that can never fit today is not offered');
  assert.deepEqual({ pool: r.noBulk.pool, tooLittle: r.noBulk.tooLittle }, { pool: 400000, tooLittle: true }, 'without a bulk figure the whole pool is used');
});

// ── merge ──
const card = (front, back = 'a', n = 1) => ({ front, back, topic: 't', cites: [{ source: `S${n}`, page: 1 }] });
const list = (prefix, n, src = 1) => Array.from({ length: n }, (_, i) => card(`${prefix} question number ${i + 1} about topic ${prefix}${i}`, `${prefix}${i}`, src));

t.test('merge: drops repeats (case, punctuation, 90 % word overlap from 5 words), keeps short near-matches', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const d1 = { cards: [{ front: 'What is osmosis?', back: 'one' }, { front: 'the cell membrane controls what enters and leaves cells', back: 'two' }, { front: 'Define osmosis now', back: 'three' }] };
    const d2 = { cards: [{ front: 'WHAT IS OSMOSIS', back: 'x' }, { front: 'the cell membrane controls what enters and leaves cells today', back: 'y' }, { front: 'Define osmosis today', back: 'z' }, { front: 'A new one', back: 'n' }] };
    const m = __t.studioMrMerge('flashcards', [d1, d2], { count: 0, title: 'T' });
    return { fronts: m.data.cards.map(c => c.front), repairs: m.repairs };`);
  assert.deepEqual(r.fronts, ['What is osmosis?', 'the cell membrane controls what enters and leaves cells', 'Define osmosis now', 'Define osmosis today', 'A new one']);
  assert.deepEqual(r.repairs, ['joined 2 parts', 'dropped 2 cards that repeat an earlier one']);
});

t.test('merge: over the count, it takes from every part in turn; ids are renumbered; cites kept', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const mk = (prefix, n, src) => ({ cards: Array.from({ length: n }, (_, i) => ({ front: prefix + ' question number ' + (i + 1) + ' about topic ' + prefix + i, back: prefix + i, topic: 't', cites: [{ source: 'S' + src, page: i + 1 }] })) });
    const m = __t.studioMrMerge('flashcards', [mk('A', 10, 1), mk('B', 2, 2), mk('C', 10, 3)], { count: 9, title: 'Joined' });
    return { ok: m.ok, ids: m.data.cards.map(c => c.id), who: m.data.cards.map(c => c.front[0]).join(''), cites: m.data.cards.map(c => c.cites.map(x => x.source + ':' + x.page).join()), repairs: m.repairs, title: m.data.title, schema: m.data.schema };`);
  assert.deepEqual(r.ids, ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9']);
  assert.equal(r.who, 'AAAABBCCC', 'four from A, both of B, three from C: nobody is left out');
  assert.deepEqual(r.cites.slice(0, 2), ['S1:1', 'S1:2']);
  assert.deepEqual(r.cites.slice(4, 6), ['S2:1', 'S2:2']);
  assert.deepEqual(r.repairs, ['joined 3 parts', 'kept 9 of 22']);
  assert.equal(r.schema, 'sth.flashcards/1');
  assert.equal(r.title, 'Joined');
});

t.test('merge: quiz questions, notes first in the notices, hard caps (80 cards, 50 questions), empty and damaged parts', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const q = (prefix, n) => ({ questions: Array.from({ length: n }, (_, i) => ({ type: 'mcq', stem: prefix + ' stem number ' + (i + 1) + ' on theme ' + prefix + i, options: [{ id: 'A', text: 'r', correct: true }, { id: 'B', text: 'w1' }, { id: 'C', text: 'w2' }], cites: [] })) });
    const quiz = __t.studioMrMerge('quiz', [q('A', 30), q('B', 30)], { count: 0, notes: ['Part 2 of 3 (x.pdf) was left out.'] });
    const cards = __t.studioMrMerge('flashcards', [{ cards: Array.from({ length: 70 }, (_, i) => ({ front: 'alpha card ' + i + ' unique words ' + i, back: 'b' })) }, { cards: Array.from({ length: 70 }, (_, i) => ({ front: 'beta card ' + i + ' other words ' + i, back: 'b' })) }], { count: 0 });
    return { quizN: quiz.data.questions.length, quizIds: [quiz.data.questions[0].id, quiz.data.questions[49].id], notices: quiz.data.notices, answer: quiz.data.questions[0].answer, cardsN: cards.data.cards.length,
      empty: __t.studioMrMerge('flashcards', [], {}), damaged: __t.studioMrMerge('flashcards', [{ nothing: 1 }, null], {}), skips: __t.studioMrMerge('flashcards', [{ nope: 1 }, { cards: [{ front: 'only valid one here', back: 'b' }] }], {}).data.cards.length };`);
  assert.equal(r.quizN, 50);
  assert.deepEqual(r.quizIds, ['q1', 'q50']);
  assert.deepEqual(r.notices, ['Part 2 of 3 (x.pdf) was left out.']);
  assert.equal(r.answer, 'A');
  assert.equal(r.cardsN, 80);
  assert.deepEqual(r.empty, { ok: false, reason: 'empty' });
  assert.deepEqual(r.damaged, { ok: false, reason: 'empty' });
  assert.equal(r.skips, 1);
});

// ── hash ──
t.test('hash: names a part by tool, options, place in the run, language, topic and the text itself', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const S = () => [__mk('S1', 10, 40000), __mk('S2', 10, 40000)];
    const hs = (tool, options, ctx, sources) => __brief(__plan(sources || S(), tool, options, ctx)).hashes;
    const base = hs('flashcards', { count: 30 }, { language: 'en', topic: '' });
    const twin = [__mk('S1', 10, 40000), __mk('S1', 10, 40000)]; // identical text in two places
    return {
      again: JSON.stringify(base) === JSON.stringify(hs('flashcards', { count: 30 }, { language: 'en', topic: '' })),
      lang: hs('flashcards', { count: 30 }, { language: 'af', topic: '' }), topic: hs('flashcards', { count: 30 }, { language: 'en', topic: 'chapter 2' }), count: hs('flashcards', { count: 50 }, { language: 'en', topic: '' }),
      level: hs('flashcards', { count: 30, difficulty: 'hard' }, { language: 'en', topic: '' }),
      mmA: hs('mindmap', {}, { language: 'en' }), mmB: hs('mindmap', { layout: 'x', count: 9 }, { language: 'en' }), mmLang: hs('mindmap', {}, { language: 'zu' }),
      fcVsQz: hs('quiz', { count: 30 }, { language: 'en', topic: '' }), base,
      text: hs('flashcards', { count: 30 }, { language: 'en', topic: '' }, [__mk('S1', 10, 40000), __mk('S2', 10, 40001)]),
      twin: hs('mindmap', {}, {}, twin), moreParts: __brief(__plan([__mk('S1', 20, 40000), __mk('S2', 10, 40000)], 'flashcards', { count: 30 }, { language: 'en', topic: '' })).hashes,
      len: /[0-9a-f]{33,}$/.test(__t.studioMrHash('hello')) && __t.studioMrHash('hello') === __t.studioMrHash('hello') && __t.studioMrHash('hello') !== __t.studioMrHash('hellp') && __t.studioMrHash('') !== __t.studioMrHash(' '),
    };`);
  assert.equal(r.again, true, 'same input, same hashes');
  const differ = (x) => x.every((h, i) => h !== r.base[i]);
  assert.ok(differ(r.lang), 'language changes every part\'s hash');
  assert.ok(differ(r.topic), 'topic does');
  assert.ok(differ(r.count), 'the number of cards does (it changes what each part is asked for)');
  assert.ok(differ(r.level), 'a list tool\'s options do');
  assert.ok(differ(r.fcVsQz), 'the tool does');
  assert.equal(JSON.stringify(r.mmA), JSON.stringify(r.mmB), 'a digest does not depend on the options of the final step');
  assert.ok(r.mmA.every((x, i) => x !== r.mmLang[i]), 'but does on the language');
  assert.notEqual(r.text.join(), r.base.join(), 'one changed character changes the parts it touches');
  assert.ok(r.twin[0] !== r.twin[1], 'identical text in two places: the place in the run is part of the name');
  assert.notEqual(r.moreParts[0], r.base[0], 'a longer run (n changes) is a different job for part 1');
  assert.equal(r.len, true);
});

// ── answers of the server ──
const DG = `{ schema: 'sth.digest/1', topics: [{ heading: 'H', level: 1, points: [{ text: 'a point', source: 'S1', page: 2 }] }], figures: [{ value: '42', label: 'x', quote: 'it is 42', source: 'S1', page: 1 }] }`;
t.test('digest: only the known fields, clamped; sources of this part only; text stays text', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const n = (d, ids) => __t.studioMrNormalizeDigest(d, ids);
    const good = n(${DG}, ['S1']);
    const evil = '<img src=x onerror=alert(1)> ' + 'y'.repeat(300);
    const lots = { schema: 'sth.digest/1', topics: Array.from({ length: 80 }, (_, i) => ({ heading: 'Topic ' + i, points: Array.from({ length: 30 }, (_, k) => ({ text: 'p' + k, source: 'S1', page: k })) })), figures: [] };
    const clamped = n(lots, ['S1']);
    const huge = n({ schema: 'sth.digest/1', topics: Array.from({ length: 60 }, (_, i) => ({ heading: 'T' + i, points: Array.from({ length: 15 }, (_, k) => ({ text: 'x'.repeat(199) + k, source: 'S1', page: 1 })) })), figures: [] }, ['S1']);
    return {
      good: good.ok && good.data.topics[0].points[0], shape: [n(null), n([]), n({}), n({ schema: 'sth.digest/1' }), n({ schema: 'other', topics: [] })].map(x => x.reason), empty: n({ schema: 'sth.digest/1', topics: [{ heading: 'No points', points: [] }] }).reason,
      foreign: n({ schema: 'sth.digest/1', topics: [{ heading: 'H', points: [{ text: 'a', source: 'S1', page: 1 }, { text: 'b', source: 'S2', page: 1 }, { text: 'c', source: 'S99', page: 1 }, { text: 'd', source: 5, page: 1 }] }] }, ['S1']).data.topics[0].points.length,
      pages: n({ schema: 'sth.digest/1', topics: [{ heading: 'H', points: [{ text: 'a', source: 'S1', page: '7' }, { text: 'b', source: 'S1', page: -3 }, { text: 'c', source: 'S1', page: 1.5 }, { text: 'd', source: 'S1', page: 99999 }] }] }, ['S1']).data.topics[0].points.map(p => p.page),
      evil: n({ schema: 'sth.digest/1', topics: [{ heading: evil, points: [{ text: evil, source: 'S1', page: 1 }] }] }, ['S1']).data.topics[0].heading.startsWith('<img src=x onerror=alert(1)>'),
      topics: clamped.data.topics.length, points: clamped.data.topics[0].points.length, tooBig: huge.reason || (huge.ok ? 'ok' : '?'),
      level: n({ schema: 'sth.digest/1', topics: [{ heading: 'H', level: 9, points: [{ text: 'a', source: 'S1', page: 0 }] }] }, ['S1']).data.topics[0].level,
      figNoQuote: n({ schema: 'sth.digest/1', topics: [{ heading: 'H', points: [{ text: 'a', source: 'S1', page: 0 }] }], figures: [{ value: '1', quote: '', source: 'S1' }, { value: '', quote: 'q', source: 'S1' }, { value: '2', quote: 'two', source: 'S1', page: 3 }] }, ['S1']).data.figures.length,
    };`);
  assert.deepEqual(r.good, { text: 'a point', source: 'S1', page: 2 });
  assert.deepEqual(r.shape, ['shape', 'shape', 'shape', 'shape', 'shape']);
  assert.equal(r.empty, 'empty');
  assert.equal(r.foreign, 1, 'only S1 is a source of this part');
  assert.deepEqual(r.pages, [7, 0, 0, 0], 'a page number is a whole number up to 20,000, else 0');
  assert.equal(r.evil, true, 'markup is kept as plain text (it is only ever shown with textContent)');
  assert.equal(r.topics, 60);
  assert.equal(r.points, 15);
  assert.equal(r.tooBig, 'too_big');
  assert.equal(r.level, 1);
  assert.equal(r.figNoQuote, 1);
});

t.test('checkPart: tool, envelope and shape must match; usage and repairs are cleaned', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const env = (tool, data, extra = {}) => ({ envelope: 'sth.studio/1', tool, data, ...extra });
    const fc = { cards: [{ front: 'a question', back: 'an answer' }] };
    const ok = __t.studioMrCheckPart('digest', env('digest', ${DG}, { usage: { inputTokens: 100.4, outputTokens: -5, thinkingTokens: 'x', calls: 0 }, repairs: Array.from({ length: 30 }, (_, i) => 'r' + i) }), ['S1']);
    return {
      ok: ok && { usage: ok.usage, repairs: ok.repairs.length, topics: ok.data.topics.length },
      wrongTool: __t.studioMrCheckPart('digest', env('flashcards', fc), ['S1']), wrongEnv: __t.studioMrCheckPart('digest', { envelope: 'x', tool: 'digest', data: ${DG} }, ['S1']), none: __t.studioMrCheckPart('digest', null, ['S1']),
      foreignDigest: __t.studioMrCheckPart('digest', env('digest', { schema: 'sth.digest/1', topics: [{ heading: 'H', points: [{ text: 'a', source: 'S2', page: 1 }] }] }), ['S1']),
      fcOk: !!__t.studioMrCheckPart('flashcards', env('flashcards', fc), ['S1']), fcBad: __t.studioMrCheckPart('flashcards', env('flashcards', { cards: [] }), ['S1']), qzBad: __t.studioMrCheckPart('quiz', env('quiz', { questions: [{ stem: 'x', options: [{ text: 'a' }] }] }), ['S1']),
    };`);
  assert.deepEqual(r.ok, { usage: { inputTokens: 100, outputTokens: 0, thinkingTokens: 0, calls: 1 }, repairs: 20, topics: 1 });
  assert.deepEqual([r.wrongTool, r.wrongEnv, r.none, r.foreignDigest, r.fcBad, r.qzBad], [null, null, null, null, null, null]);
  assert.equal(r.fcOk, true);
});

t.test('reduceCites: a reduce answer may cite only what the digests cite', async (h) => {
  const a = await app(h);
  const r = await run(a, `
    const digests = [{ topics: [{ heading: 'H', points: [{ text: 'a', source: 'S1', page: 3 }] }], figures: [{ value: '1', quote: 'q', source: 'S2', page: 0 }] }];
    const data = { nodes: [{ cites: [{ source: 'S1', page: 3 }, { source: 'S1', page: 9 }, { source: 'S7', page: 1 }, { source: 'S1', page: 3 }, null] }], items: [{ cites: [{ source: 'S2', page: 0 }, { source: 'S2', page: 5 }] }], slides: [{ cites: 'no' }], figures: [{ source: 'S1', page: 99 }, { source: 'S5', page: 1 }] };
    __t.studioMrReduceCites(data, digests);
    return { nodes: data.nodes[0].cites, items: data.items[0].cites, slides: data.slides[0].cites, figures: data.figures.map(f => [f.source, f.page]) };`);
  assert.deepEqual(r.nodes, [{ source: 'S1', page: 3 }, { source: 'S1', page: 0 }], 'a page nobody cited becomes 0; an unknown source and a repeat go');
  assert.deepEqual(r.items, [{ source: 'S2', page: 0 }]);
  assert.deepEqual(r.slides, []);
  assert.deepEqual(r.figures, [['S1', 0], ['S5', 1]], 'a figure keeps its source, with the page reset');
});

t.run();
