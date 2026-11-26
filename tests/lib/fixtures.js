'use strict';
// Answers the fake server gives, and Knowledge Bay items the tests put on the page. All text is made up.

const ENVELOPE = 'sth.studio/1';
const SCHEMA = { mindmap: 'sth.mindmap/1', flashcards: 'sth.flashcards/1', quiz: 'sth.quiz/1', infographic: 'sth.infographic/1', slides: 'sth.slides/1', digest: 'sth.digest/1' };
const MODE_TOOL = { studio_mindmap: 'mindmap', studio_flashcards: 'flashcards', studio_quiz: 'quiz', studio_infographic: 'infographic', studio_slides: 'slides', studio_digest: 'digest' };

const usage = (o = {}) => ({ inputTokens: 1000, outputTokens: 500, thinkingTokens: 100, calls: 1, ...o });

function mindmap(tag = '') {
  return { schema: SCHEMA.mindmap, title: `Map ${tag}`.trim(), notices: [], nodes: [
    { id: 'r', parent: '', label: `Root ${tag}`.trim(), detail: 'The whole topic', cites: [{ source: 'S1', page: 1 }] },
    { id: 'a', parent: 'r', label: 'Branch A', detail: 'First idea', cites: [{ source: 'S1', page: 1 }] },
    { id: 'b', parent: 'r', label: 'Branch B', detail: 'Second idea', cites: [] },
    { id: 'a1', parent: 'a', label: 'Leaf A1', detail: '', cites: [] },
    { id: 'b1', parent: 'b', label: 'Leaf B1', detail: '', cites: [] },
  ] };
}
function flashcards(count = 6, tag = '') {
  return { schema: SCHEMA.flashcards, title: `Cards ${tag}`.trim(), notices: [], cards: Array.from({ length: count }, (_, i) => ({ topic: `T${i % 3}`, front: `Question ${tag} number ${i + 1} about subject alpha${tag}x${i}`, back: `Answer ${tag} ${i + 1}`, cites: [{ source: 'S1', page: 1 }] })) };
}
function quiz(count = 5, tag = '') {
  return { schema: SCHEMA.quiz, title: `Quiz ${tag}`.trim(), notices: [], questions: Array.from({ length: count }, (_, i) => ({ type: 'mcq', topic: `T${i % 2}`, stem: `Stem ${tag} number ${i + 1} on theme beta${tag}x${i}`, hint: 'Think', explanation: 'Because.', cites: [{ source: 'S1', page: 1 }],
    options: [{ id: 'A', text: 'Right', correct: true, rationale: 'yes' }, { id: 'B', text: 'Wrong one', correct: false, rationale: 'no' }, { id: 'C', text: 'Wrong two', correct: false, rationale: 'no' }, { id: 'D', text: 'Wrong three', correct: false, rationale: 'no' }] })) };
}
function infographic() {
  return { schema: SCHEMA.infographic, title: 'Steps of the process', subtitle: 'A short guide', layout: 'steps', notices: [], columns: [], figures: [],
    items: [1, 2, 3, 4].map(n => ({ heading: `Step ${n}`, text: `Do thing number ${n} carefully.`, icon: 'check', cites: [{ source: 'S1', page: 1 }] })), takeaway: 'Follow the steps in order.' };
}
function slides() {
  return { schema: SCHEMA.slides, title: 'Deck title', subtitle: 'Sub', notices: [], slides: [
    { layout: 'title', title: 'Deck title', subtitle: 'Sub' },
    { layout: 'bullets', title: 'Point one', bullets: ['First point', 'Second point'], notes: 'Say this.', cites: [{ source: 'S1', page: 1 }] },
    { layout: 'bullets', title: 'Point two', bullets: ['Third point', 'Fourth point'] },
    { layout: 'summary', title: 'Summary', bullets: ['Wrap up'] },
  ] };
}
// ids: the source ids of the part (S1.. as the page numbered them)
function digest(ids = ['S1'], n = 1) {
  const s = ids[0] || 'S1';
  return { schema: SCHEMA.digest, topics: [
    { heading: `Part ${n} theme`, level: 1, points: [{ text: `Point from part ${n} about alpha`, source: s, page: 1 }, { text: `Another point from part ${n}`, source: s, page: 2 }] },
    { heading: `Part ${n} second theme`, level: 2, points: [{ text: `Detail of part ${n}`, source: s, page: 2 }] },
  ], figures: [{ value: '42', label: 'The answer', quote: 'the answer is 42', source: s, page: 1 }] };
}

// body: the request the page sent (studio_* mode)
function studioAnswer(body) {
  const tool = body.tool || MODE_TOOL[body.mode];
  const part = body.part && body.part.i ? body.part : null;
  const tag = part ? `p${part.i}` : '';
  const ids = (body.sources || []).map(s => s.id);
  let data;
  if (body.strategy === 'reduce') {
    // a reduce answer cites what the digests cite
    const d = (body.digests && body.digests[0]) || digest(['S1']);
    const first = d.topics[0].points[0];
    const base = tool === 'mindmap' ? mindmap('reduced') : tool === 'infographic' ? infographic() : slides();
    const cite = [{ source: first.source, page: first.page }];
    for (const list of [base.nodes, base.items, base.slides]) for (const x of list || []) if (x.cites) x.cites = cite;
    data = base;
  } else if (tool === 'mindmap') data = mindmap(tag);
  else if (tool === 'flashcards') data = flashcards(part && part.count ? part.count : (body.options && body.options.count) || 6, tag);
  else if (tool === 'quiz') data = quiz(part && part.count ? part.count : (body.options && body.options.count) || 5, tag);
  else if (tool === 'infographic') data = infographic();
  else if (tool === 'slides') data = slides();
  else if (tool === 'digest') data = digest(ids, part ? part.i : 1);
  else return { ok: false, error: { code: 'STH-STU-400' } };
  return { ok: true, artifact: { envelope: ENVELOPE, tool, schema: SCHEMA[tool], promptVersion: body.promptVersion || 'x', generatedAt: new Date(1700000000000).toISOString(), usage: usage(), repairs: [], data } };
}

// a Knowledge Bay text item (type txt) of about `tokens` tokens; pages: write [Page n] markers (type pdf, schemaVersion 3)
// timestamp: fixed (Knowledge Bay lists newest first, and equal times keep the order they were added in), so two pages see the same source order
function kbItem(name, { tokens = 200, pages = 0, id = null, type = null, timestamp = 1700000000000 } = {}) {
  const chars = tokens * 4;
  let content = '';
  if (pages) {
    const per = Math.max(1, Math.floor(chars / pages));
    for (let p = 1; p <= pages; p++) content += `[Page ${p}]\n${('word' + p + ' ').repeat(Math.ceil(per / (String(p).length + 5))).slice(0, per)}\n`;
  } else content = ('lorem ipsum dolor sit amet ').repeat(Math.ceil(chars / 27)).slice(0, chars);
  const t = type || (pages ? 'pdf' : 'txt');
  return { id: id || `k_${name.replace(/\W+/g, '')}`, name, type: t, ext: t, mime: t === 'pdf' ? 'application/pdf' : 'text/plain', size: content.length, timestamp, content, ...(pages ? { schemaVersion: 3, pageCount: pages, contentHash: `h_${name}` } : {}) };
}

module.exports = { ENVELOPE, SCHEMA, MODE_TOOL, mindmap, flashcards, quiz, infographic, slides, digest, studioAnswer, kbItem, usage };
