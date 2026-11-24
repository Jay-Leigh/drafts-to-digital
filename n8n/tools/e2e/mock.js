// Mock of Upstash (Redis REST), Gemini, DNS-over-HTTPS and a "public" web site, for the local n8n run.
const http = require('http');
const net = require('net');
const REDIS_PORT = Number(process.env.REDIS_PORT || 6390);
function respCmd(args) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(REDIS_PORT, '127.0.0.1');
    let buf = Buffer.alloc(0);
    sock.on('error', reject);
    sock.on('data', (d) => { buf = Buffer.concat([buf, d]); try { const r = parse(buf, 0); if (r) { sock.end(); resolve(r.v); } } catch (e) { if (e.message !== 'incomplete') { sock.end(); reject(e); } } });
    sock.write('*' + args.length + '\r\n' + args.map((a) => { const b = Buffer.from(String(a)); return '$' + b.length + '\r\n' + b.toString('binary') + '\r\n'; }).join(''), 'binary');
  });
}
function parse(b, i) {
  if (i >= b.length) throw new Error('incomplete');
  const t = String.fromCharCode(b[i]); const e = b.indexOf('\r\n', i);
  if (e < 0) throw new Error('incomplete');
  const line = b.slice(i + 1, e).toString();
  if (t === '+') return { v: line, n: e + 2 };
  if (t === '-') throw new Error('redis: ' + line);
  if (t === ':') return { v: Number(line), n: e + 2 };
  if (t === '$') { const len = Number(line); if (len < 0) return { v: null, n: e + 2 }; if (b.length < e + 2 + len + 2) throw new Error('incomplete'); return { v: b.slice(e + 2, e + 2 + len).toString(), n: e + 2 + len + 2 }; }
  if (t === '*') { const len = Number(line); if (len < 0) return { v: null, n: e + 2 }; let p = e + 2; const out = []; for (let k = 0; k < len; k++) { const r = parse(b, p); out.push(r.v); p = r.n; } return { v: out, n: p }; }
  throw new Error('bad resp');
}

const PORT = Number(process.env.MOCK_PORT || 5801);
const SITE_PORT = Number(process.env.SITE_PORT || 80);
const store = new Map(); // key -> {v, exp}
const log = [];
let down = false;
let geminiFail = 0, geminiFailCode = 503;
let studioQueue = [], studioDefault = 'valid';
const directiveCount = {};
const now = () => Date.now();
function get(k) { const e = store.get(k); if (!e) return null; if (e.exp && e.exp < now()) { store.delete(k); return null; } return e.v; }
function incr(k, ttl) { const cur = get(k); const n = (cur == null ? 0 : parseInt(cur, 10)) + 1; const e = store.get(k); store.set(k, { v: String(n), exp: cur == null && ttl ? now() + ttl * 1000 : e ? e.exp : null }); return n; }
function redis(cmd) {
  const op = String(cmd[0]).toUpperCase(); const a = cmd.slice(1);
  switch (op) {
    case 'GET': return get(a[0]);
    case 'MGET': return a.map(get);
    case 'DEL': { let n = 0; for (const k of a) if (store.delete(k)) n++; return n; }
    case 'INCR': return incr(a[0], 0);
    case 'SET': { let exp = null; const i = a.findIndex((x) => String(x).toUpperCase() === 'EX'); if (i > 0) exp = now() + Number(a[i + 1]) * 1000; store.set(a[0], { v: String(a[1]), exp }); return 'OK'; }
    case 'EVAL': {
      const script = a[0]; const nk = Number(a[1]); const keys = a.slice(2, 2 + nk); const argv = a.slice(2 + nk);
      if (script.includes("return {redis.call('GET'")) { const code = get(keys[0]); const c = incr(keys[1], Number(argv[0])); return [code, c]; }
      if (script.startsWith("local c = redis.call('INCR'")) return incr(keys[0], Number(argv[0]));
      throw new Error('unknown script');
    }
    default: throw new Error('unsupported ' + op);
  }
}
// DoH: names under *.pub.test resolve to a public-looking IP; *.priv.test resolve to private; others NXDOMAIN
function doh(name, type) {
  const n = name.replace(/\.$/, '');
  if (n.endsWith('.pub.test')) return { Status: 0, Answer: type === 'A' ? [{ name: n + '.', type: 1, TTL: 60, data: '93.184.216.34' }] : [] };
  if (n.endsWith('.priv.test')) return { Status: 0, Answer: type === 'A' ? [{ name: n + '.', type: 1, TTL: 60, data: '10.0.0.5' }] : [] };
  if (n.endsWith('.v6priv.test')) return { Status: 0, Answer: type === 'AAAA' ? [{ name: n + '.', type: 28, TTL: 60, data: '::ffff:7f00:1' }] : [] };
  return { Status: 3 };
}
function body(req) { return new Promise((r) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => r(Buffer.concat(c).toString())); }); }
const api = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const raw = await body(req);
  const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (u.pathname === '/upstash') {
    let cmd; try { cmd = JSON.parse(raw); } catch (e) { return send(400, { error: 'bad json' }); }
    log.push({ t: now(), cmd: cmd.map((x) => String(x).slice(0, 60)), auth: !!req.headers.authorization });
    if (down) return send(500, { error: 'down' });
    try { return send(200, { result: await respCmd(cmd) }); } catch (e) { return send(400, { error: e.message }); }
  }
  if (u.pathname === '/upstash/pipeline') {
    // Upstash /pipeline: an array of commands, answered by an array of {result} | {error} (each command goes to the real Redis)
    let cmds; try { cmds = JSON.parse(raw); } catch (e) { return send(400, { error: 'bad json' }); }
    if (!Array.isArray(cmds) || !cmds.every(Array.isArray)) return send(400, { error: 'bad pipeline' });
    for (const cmd of cmds) log.push({ t: now(), pipe: true, cmd: cmd.map((x) => String(x).slice(0, 60)), auth: !!req.headers.authorization });
    if (down) return send(500, { error: 'down' });
    const out = [];
    for (const cmd of cmds) { try { out.push({ result: await respCmd(cmd) }); } catch (e) { out.push({ error: e.message }); } }
    return send(200, out);
  }
  if (u.pathname.startsWith('/gemini')) {
    let b = null; try { b = JSON.parse(raw); } catch (e) {}
    log.push({ t: now(), gemini: u.pathname, body: b });
    // Study Studio calls (JSON mode): fixtures from a queue set with /_studio?q=429,valid,... (default 'valid')
    if (b && b.generationConfig && b.generationConfig.responseMimeType === 'application/json') {
      const fx = studioQueue.length ? studioQueue.shift() : studioDefault;
      const [name, arg] = fx.split(':');
      const usage = { promptTokenCount: 5000, candidatesTokenCount: 1000, thoughtsTokenCount: 200, totalTokenCount: 6200 };
      const reply = (text, finishReason = 'STOP') => send(200, { candidates: [{ content: { parts: [{ text }] }, finishReason }], usageMetadata: usage });
      const schema = b.generationConfig.responseJsonSchema || b.generationConfig.responseSchema;
      const isFc = !!(schema && schema.properties && schema.properties.cards); // flashcards request (v5)
      const isQz = !!(schema && schema.properties && schema.properties.questions); // quiz request (v6); everything else is a mind map
      const cites = isQz ? schema.properties.questions.items.properties.cites.items.properties.source.enum : isFc ? schema.properties.cards.items.properties.cites.items.properties.source.enum : schema && schema.properties.nodes && schema.properties.nodes.items.properties.cites.items.properties.source.enum;
      const src = (cites && cites[0]) || 'S1';
      const lastText = (b.contents && b.contents[0].parts.at(-1).text) || '';
      const N = Number((lastText.match(/(?:cards|questions): (\d+)/) || [])[1] || (isQz ? 20 : 30)); // the number of cards / questions the request asked for
      const mapJson = (mut) => {
        const nodes = [{ id: 'n1', parent: '', label: 'Course title', detail: '', cites: [] }];
        for (let i = 1; i <= 3; i++) { nodes.push({ id: 'T' + i, parent: 'n1', label: 'Theme ' + i, detail: '', cites: [{ source: src, page: i }] }); for (let j = 1; j <= 3; j++) nodes.push({ id: 'T' + i + 'L' + j, parent: 'T' + i, label: 'Term ' + i + '.' + j + ': a fact', detail: j === 1 ? 'More about it.' : '', cites: [{ source: src, page: i }] }); }
        if (mut) mut(nodes);
        return JSON.stringify({ schema: 'sth.mindmap/1', title: 'Mock map', notices: [], nodes });
      };
      // flashcards fixtures: a deck of n cards (default: the requested number); mut may change the array
      const fcJson = (mut, n = N) => {
        const cards = Array.from({ length: n }, (_, k) => ({ id: 'c' + (k + 1), topic: 'Topic ' + (1 + (k % 3)), front: 'Term ' + (k + 1) + ' of the course', back: 'Answer for term ' + (k + 1) + '.', cites: [{ source: src, page: 1 + (k % 3) }] }));
        if (mut) mut(cards);
        return JSON.stringify({ schema: 'sth.flashcards/1', title: 'Mock deck', notices: [], cards });
      };
      // quiz fixtures: n questions (default: the requested number), every 5th a true/false; mut may change the array
      const qzJson = (mut, n = N) => {
        const qs = Array.from({ length: n }, (_, k) => {
          const i = k + 1;
          if (i % 5 === 0) return { id: 'q' + i, topic: 'Topic ' + (1 + (k % 3)), type: 'true_false', stem: 'Statement number ' + i + ' about the course is true.', options: [{ id: 'A', text: 'True', rationale: 'It is stated.' }, { id: 'B', text: 'False', rationale: 'It is not.' }], answer: 'A', hint: 'Recall the lecture.', explanation: 'It is stated in the notes.', cites: [{ source: src, page: 1 + (k % 3) }] };
          return { id: 'q' + i, topic: 'Topic ' + (1 + (k % 3)), type: 'mcq', stem: 'Which statement about term ' + i + ' of the course is correct?', options: ['A', 'B', 'C', 'D'].map((l, j) => ({ id: l, text: ['Alpha', 'Beta', 'Gamma', 'Delta'][j] + ' result ' + i, rationale: 'Because of ' + l + '.' })), answer: 'B', hint: 'Think about the lecture on term ' + i + '.', explanation: 'Beta is right for term ' + i + '.', cites: [{ source: src, page: 1 + (k % 3) }] };
        });
        if (mut) mut(qs);
        return JSON.stringify({ schema: 'sth.quiz/1', title: 'Mock quiz', notices: [], questions: qs });
      };
      // v7 fixtures: infographic, slides, digest (told apart by the schema); the quoted source sentence is the one the tests put in their source text
      const isIg = !!(schema && schema.properties && schema.properties.items && schema.properties.layout);
      const isSl = !!(schema && schema.properties && schema.properties.slides);
      const isDg = !!(schema && schema.properties && schema.properties.topics && !schema.properties.nodes);
      if (isIg || isSl || isDg) {
        const src7 = isIg ? schema.properties.items.items.properties.cites.items.properties.source.enum[0] : isSl ? schema.properties.slides.items.properties.cites.items.properties.source.enum[0] : schema.properties.topics.items.properties.points.items.properties.source.enum[0];
        const lay = isIg && schema.properties.layout.enum.length === 1 ? schema.properties.layout.enum[0] : 'steps';
        const igJson = (mut) => {
          const o = { schema: 'sth.infographic/1', title: 'The war', subtitle: 'A short story', layout: lay, notices: [], columns: lay === 'comparison' ? ['Before', 'After'] : [], items: Array.from({ length: 5 }, (_, k) => ({ heading: 'Step ' + String.fromCharCode(65 + k), text: 'Something happens in step ' + String.fromCharCode(65 + k), when: lay === 'timeline' ? '1939' : '', left: lay === 'comparison' ? 'Left ' + k : '', right: lay === 'comparison' ? 'Right ' + k : '', icon: 'book', cites: [{ source: src7, page: 1 }] })), figures: [{ value: '1945', label: 'End of the war', quote: 'began in 1939 and ended in 1945', source: src7, page: 1 }], takeaway: 'It ended.' };
          if (mut) mut(o);
          return JSON.stringify(o);
        };
        const slJson = (mut) => {
          const sl = (i, o = {}) => ({ id: 'p' + i, layout: 'bullets', title: 'Slide ' + i, subtitle: '', bullets: [{ text: 'The war began in 1939', level: 0 }, { text: 'It ended in 1945', level: 1 }], columns: [], quote: '', notes: 'Notes', cites: [{ source: src7, page: 1 }], ...o });
          const o = { schema: 'sth.slides/1', title: 'The war', subtitle: 'A course', notices: [], slides: [sl(1, { layout: 'title', bullets: [], cites: [] }), sl(2), sl(3), sl(4, { layout: 'summary' })] };
          if (mut) mut(o);
          return JSON.stringify(o);
        };
        const dgJson = (mut) => {
          const o = { schema: 'sth.digest/1', topics: [{ heading: 'The war', level: 1, points: [{ text: 'The war began in 1939 and ended in 1945', source: src7, page: 1 }] }], figures: [{ value: '1945', label: 'End of the war', quote: 'began in 1939 and ended in 1945', source: src7, page: 1 }] };
          if (mut) mut(o);
          return JSON.stringify(o);
        };
        const mk7 = isIg ? igJson : isSl ? slJson : dgJson;
        const w7 = (ms) => new Promise((r) => setTimeout(r, ms));
        if (name === 'valid') return reply(mk7());
        if (name === 'slow' || name === 'hang') { await w7(Number(arg || 3000)); return reply(mk7()); }
        if (name === 'badfigure') return reply(mk7((o) => { if (isIg) o.figures[0].value = '1946'; if (isDg) o.figures[0].value = '1946'; if (isSl) o.slides[1].bullets[0].text = 'It ended in 1946'; }));
        if (name === 'badnumber') return reply(mk7((o) => { if (isIg) o.items[0].text = 'About 80 million people died'; if (isSl) o.slides[1].bullets = [{ text: 'About 80 million people died', level: 0 }]; if (isDg) o.topics[0].points[0].text = 'About 80 million people died'; }));
        if (name === 'xss') return reply(mk7((o) => { if (isIg) { o.items[0].heading = '<svg onload=alert(1)>'; o.items[0].icon = '<script>'; } if (isSl) o.slides[1].title = '"><img src=x onerror=alert(1)>'; if (isDg) o.topics[0].heading = '<script>alert(1)</script>'; }));
        if (name === 'truncated') return reply(mk7().slice(0, 300), 'MAX_TOKENS');
        if (name === 'prose') return reply('Sorry, I cannot do that.');
        if (name === 'fewitems') return reply(mk7((o) => { if (isIg) o.items = o.items.slice(0, 2); if (isSl) o.slides = o.slides.slice(0, 2); if (isDg) o.topics = []; }));
        if (name === 'safety') return send(200, { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: usage });
        if (name === 'recitation') return send(200, { candidates: [{ finishReason: 'RECITATION' }], usageMetadata: usage });
        if (name === 'empty') return send(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: usage });
        if (name === 'schema400') { if (b.generationConfig.responseJsonSchema) return send(400, { error: { message: 'invalid schema' } }); return reply(mk7()); }
        if (name === '400') return send(400, { error: { message: 'bad request' } });
        if (name === '429') return send(429, { error: { message: 'Resource exhausted. Please retry in 1s' } });
        if (name === '500') return send(500, { error: { message: 'internal' } });
        if (name === '503') return send(503, { error: { message: 'unavailable' } });
        return send(500, { error: { message: 'unknown fixture' } });
      }
      const body0 = isQz ? qzJson : isFc ? fcJson : mapJson;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (name === 'valid') return reply(body0());
      if (name === 'slow' || name === 'hang') { await wait(Number(arg || 3000)); return reply(body0()); }
      if (name === 'truncated') return reply(body0().slice(0, 300), 'MAX_TOKENS');
      if (name === 'cutstop') return reply(body0().slice(0, 300));
      if (isQz && name === 'trunclate') { const full = qzJson(); return reply(full.slice(0, full.indexOf('{"id":"q' + Math.ceil(N * 0.85) + '"') + 20), 'MAX_TOKENS'); } // cut after ~85% of the questions
      if (isQz && name === 'dupes') return reply(qzJson((c) => { const h = Math.floor(c.length / 2); for (let k = h; k < c.length; k++) c[k].stem = c[k - h].stem.toUpperCase() + '!'; })); // second half repeats the first half's stems
      if (isQz && name === 'twocorrect') return reply(qzJson((c) => { for (let k = 0; k < c.length; k += 4) { if (c[k].type === 'mcq') c[k].answer = 'A, B'; } })); // every 4th mcq names two answers
      if (isQz && name === 'ansnotin') return reply(qzJson((c) => { for (let k = 1; k < c.length; k += 4) c[k].answer = 'E'; })); // every 4th answer is not an option
      if (isQz && name === 'allbad') return reply(qzJson((c) => { for (const x of c) x.answer = 'E'; }));
      if (isQz && name === 'hintleak') return reply(qzJson((c) => { for (let k = 0; k < c.length; k += 3) if (c[k].type === 'mcq') c[k].hint = 'It is ' + c[k].options[1].text.toLowerCase() + ', isn\'t it?'; }));
      if (isQz && name === 'few') return reply(qzJson(null, Math.max(1, Math.floor(N * 0.4))));
      if (isQz && name === 'half') return reply(qzJson(null, Math.ceil(N * 0.5)));
      if (isQz && name === 'many') return reply(qzJson((c) => { for (let k = 0; k < c.length; k++) c[k].stem = 'Distinct stem about topic number ' + k; }, 120));
      if (isQz && name === 'huge') return reply(qzJson((c) => { c[0].stem = 'S'.repeat(3000); c[0].explanation = 'word '.repeat(5000); c[0].options[0].text = 'O'.repeat(900); c[0].options[0].rationale = 'r '.repeat(900); }));
      if (isQz && name === 'wrongschema') return reply(mapJson());
      if (isQz && name === 'invalid') return reply(JSON.stringify({ schema: 'sth.quiz/1', title: 'x', questions: [{ id: 'q1' }, { id: 'q2', stem: 'only a stem' }] }));
      if (isQz && name === 'html') return reply(qzJson((c) => { c[0].stem = '<img src=x onerror=alert(1)>'; c[0].explanation = '<script>alert(1)</script>'; c[1].topic = '"><svg/onload=alert(1)>'; c[1].options[0].text = '<b>bold</b>'; }));
      if (isQz && name === 'wrongsrc') return reply(qzJson((c) => { c[0].cites = [{ source: 'S9', page: 1 }, { source: src, page: 9999 }]; }));
      if (isFc && name === 'trunclate') { const full = fcJson(); return reply(full.slice(0, full.indexOf('{"id":"c' + Math.ceil(N * 0.85) + '"') + 20), 'MAX_TOKENS'); } // cut after ~85% of the cards
      if (isFc && name === 'dupes') return reply(fcJson((c) => { for (let k = Math.floor(c.length / 2); k < c.length; k++) c[k].front = 'TERM ' + (k - Math.floor(c.length / 2) + 1) + ' of the course!'; })); // second half repeats the first half's fronts
      if (isFc && name === 'alldupes') return reply(fcJson((c) => { for (const x of c) x.front = 'The same front'; }));
      if (isFc && name === 'few') return reply(fcJson(null, Math.max(1, Math.floor(N * 0.4))));
      if (isFc && name === 'half') return reply(fcJson(null, Math.ceil(N * 0.5)));
      if (isFc && name === 'many') return reply(fcJson(null, 120));
      if (isFc && name === 'empties') return reply(fcJson((c) => { for (let k = 0; k < c.length; k += 3) c[k].front = '   '; }));
      if (isFc && name === 'allempty') return reply(fcJson((c) => { for (const x of c) x.back = ''; }));
      if (isFc && name === 'huge') return reply(fcJson((c) => { c[0].front = 'F'.repeat(3000); c[0].back = 'word '.repeat(5000); }));
      if (isFc && name === 'wrongschema') return reply(mapJson());
      if (name === 'prose') return reply('Sorry, I cannot make a mind map of that.');
      if (isFc && name === 'invalid') return reply(JSON.stringify({ schema: 'sth.flashcards/1', title: 'x', cards: [{ id: 'c1' }, { id: 'c2', front: 'only a front' }] }));
      if (name === 'invalid') return reply(JSON.stringify({ schema: 'sth.mindmap/1', title: 'x', nodes: [{ id: 'n1' }, { id: 'n2', parent: 'n1' }] }));
      if (isFc && name === 'html') return reply(fcJson((c) => { c[0].front = '<img src=x onerror=alert(1)>'; c[1].back = '<script>alert(1)</script>'; c[2].topic = '"><svg/onload=alert(1)>'; }));
      if (name === 'html') return reply(mapJson((n) => { n[1].label = '<img src=x onerror=alert(1)>'; n[2].label = '<script>alert(1)</script>'; }));
      if (isFc && name === 'wrongsrc') return reply(fcJson((c) => { c[0].cites = [{ source: 'S9', page: 1 }, { source: src, page: 9999 }]; }));
      if (name === 'wrongsrc') return reply(mapJson((n) => { n[1].cites = [{ source: 'S9', page: 1 }, { source: src, page: 9999 }]; }));
      if (name === 'safety') return send(200, { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: usage });
      if (name === 'recitation') return send(200, { candidates: [{ finishReason: 'RECITATION' }], usageMetadata: usage });
      if (name === 'empty') return send(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: usage });
      if (name === 'schema400') { if (b.generationConfig.responseJsonSchema) return send(400, { error: { message: 'invalid schema' } }); return reply(body0()); }
      if (name === '400') return send(400, { error: { message: 'bad request' } });
      if (name === '429') return send(429, { error: { message: 'Resource exhausted. Please retry in 1s' } });
      if (name === '500') return send(500, { error: { message: 'internal' } });
      if (name === '503') return send(503, { error: { message: 'unavailable' } });
      return send(500, { error: { message: 'unknown fixture' } });
    }
    // Per-request directives for the tutor (parallel-safe): put [[mock:KIND]] in the message text.
    // KIND: 500|503|429|400 (always that status), hangMS (answer late), safety, recite, empty, failN-STATUS-TAG (first N calls with that tag fail, then ok)
    const dm = raw.match(/\[\[mock:([A-Za-z0-9_-]+)\]\]/);
    if (dm) {
      const k = dm[1]; const send2 = (code, msg) => send(code, { error: { message: msg } });
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      if (/^\d{3}$/.test(k)) return send2(Number(k), k === '429' ? 'Resource exhausted. Please retry in 1s' : 'mock failure');
      if (/^hang\d+$/.test(k)) { await wait(Number(k.slice(4))); }
      else if (k === 'big') return send(200, { candidates: [{ content: { parts: [{ text: 'y'.repeat(600000) }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } });
      else if (k === 'safety') return send(200, { candidates: [{ finishReason: 'SAFETY' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0, totalTokenCount: 100 } });
      else if (k === 'recite') return send(200, { candidates: [{ finishReason: 'RECITATION' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0, totalTokenCount: 100 } });
      else if (k === 'empty') return send(200, { candidates: [{ content: { parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 0, totalTokenCount: 100 } });
      else if (/^fail\d+-\d{3}-/.test(k)) { const [, n, st] = k.match(/^fail(\d+)-(\d{3})-/); const c = (directiveCount[k] = (directiveCount[k] || 0) + 1); if (c <= Number(n)) return send2(Number(st), st === '429' ? 'Resource exhausted. Please retry in 1s' : 'mock failure'); }
    }
    if (geminiFail > 0) { geminiFail--; return send(geminiFailCode, { error: { message: 'mock failure' } }); }
    return send(200, { candidates: [{ content: { parts: [{ text: 'MOCK GEMINI REPLY' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 25, totalTokenCount: 175 } });
  }
  if (u.pathname === '/_studio') { studioQueue = (u.searchParams.get('q') || '').split(',').filter(Boolean); studioDefault = u.searchParams.get('def') || 'valid'; return send(200, { ok: true }); }
  if (u.pathname === '/_gemini') { geminiFail = Number(u.searchParams.get('fail') || 0); geminiFailCode = Number(u.searchParams.get('code') || 503); return send(200, { ok: true }); }
  if (u.pathname === '/doh') { log.push({ t: now(), doh: u.searchParams.get('name') + ' ' + u.searchParams.get('type') }); return send(200, doh(u.searchParams.get('name'), u.searchParams.get('type'))); }
  if (u.pathname === '/_state') {
    const keys = await respCmd(['KEYS', '*']); const st = {}; const ttl = {};
    for (const k of keys) {
      if (k === '__down') continue;
      const ty = await respCmd(['TYPE', k]);
      st[k] = ty === 'string' ? await respCmd(['GET', k]) : ty === 'hash' ? await respCmd(['HGETALL', k]) : ty === 'zset' ? await respCmd(['ZRANGE', k, '0', '-1', 'WITHSCORES']) : ty;
      ttl[k] = await respCmd(['TTL', k]);
    }
    return send(200, { store: st, ttl, log });
  }
  if (u.pathname === '/_reset') { await respCmd(['FLUSHALL']); for (const k of Object.keys(directiveCount)) delete directiveCount[k]; down = false; geminiFail = 0; studioQueue = []; studioDefault = 'valid'; log.length = 0; return send(200, { ok: true }); }
  if (u.pathname === '/_set') { await respCmd(['SET', u.searchParams.get('k'), u.searchParams.get('v')]); return send(200, { ok: true }); }
  if (u.pathname === '/_down') { down = u.searchParams.get('on') === '1'; return send(200, { ok: true }); }
  send(404, { error: 'nf' });
});
api.keepAliveTimeout = 65000; // the test clients reuse connections (undici); avoid the idle-socket race
api.listen(PORT, '127.0.0.1', () => console.log('api on', PORT));
// "public" site reached by Host header via /etc/hosts alias (simulates a DNS-rebinding attacker too)
const site = http.createServer((req, res) => {
  const host = (req.headers.host || '').split(':')[0];
  log.push({ t: now(), site: host + req.url });
  if (req.url === '/page') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<html><body><h1>Hello Safe Fetch</h1><p>' + 'lorem ipsum dolor sit amet '.repeat(30) + '</p></body></html>'); }
  if (req.url === '/redir-local') { res.writeHead(302, { location: 'http://127.0.0.1/page' }); return res.end(); }
  if (req.url === '/redir-ok') { res.writeHead(301, { location: '/page' }); return res.end(); }
  if (req.url === '/redir-priv') { res.writeHead(302, { location: 'http://x.priv.test/page' }); return res.end(); }
  if (req.url === '/big') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('A'.repeat(6 * 1024 * 1024)); }
  if (req.url === '/404') { res.writeHead(404, { 'content-type': 'text/html' }); return res.end('nope'); }
  if (req.url === '/loop') { res.writeHead(302, { location: '/loop' }); return res.end(); }
  res.writeHead(404); res.end('nf');
});
site.listen(SITE_PORT, '127.0.0.1', () => console.log('site on', SITE_PORT));
