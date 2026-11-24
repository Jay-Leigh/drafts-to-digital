// End-to-end checks of the Study Studio FLASHCARDS mode (v5) on the synchronous path, against a real n8n 2.29.7 running the
// imported v5 test copy (external HTTP -> mock; real Redis 7 on 6390). Needs the test copy built with STUDIO_TEST_TIMEOUT_MS=6000:
//   STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v5-flashcards && node e2e/run-flashcards.js
const path = require('path');
const NM = path.join(__dirname, '..', 'n8nrun', 'node_modules');
const jwt = require(path.join(NM, 'jsonwebtoken'));
const flatted = require(path.join(NM, 'flatted'));
const sqlite3 = require(path.join(NM, 'sqlite3'));
const B = 'http://127.0.0.1:5799/webhook';
const M = 'http://127.0.0.1:5801';
const ORIGIN = 'https://jay-leigh.github.io';
let pass = 0, fail = 0;
const SRC_OVER = process.env.WF_V7 ? 16 : 11; // v7 accepts 15 sources (v3..v6: 10)
const t = (cond, name, extra) => { if (cond) pass++; else { fail++; console.log('  FAIL:', name, extra !== undefined ? JSON.stringify(extra).slice(0, 600) : ''); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function post(p, body, headers = {}) {
  const t0 = Date.now();
  const res = await fetch(B + '/' + p, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, ...headers }, body: JSON.stringify(body) });
  const text = await res.text(); let json = null; try { json = JSON.parse(text); } catch (e) {}
  return { status: res.status, text, json, headers: res.headers, ms: Date.now() - t0 };
}
const state = async () => (await fetch(M + '/_state')).json();
const reset = async () => { await fetch(M + '/_reset'); await setKey('auth:code', 'letmein'); };
const setKey = (k, v) => fetch(`${M}/_set?k=${encodeURIComponent(k)}&v=${encodeURIComponent(v)}`);
const queue = (q, def = 'valid') => fetch(`${M}/_studio?q=${q}&def=${def}`);
const redis = (...a) => require('child_process').execFileSync('redis-cli', ['-p', '6390', ...a]).toString().trim();
const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const usageNow = () => Number(redis('GET', 'usage:' + today) || 0);
const gcalls = async () => (await state()).log.filter((l) => l.gemini);
function db() { return new sqlite3.Database(path.join(__dirname, '..', 'n8nrun/home/.n8n/database.sqlite'), sqlite3.OPEN_READONLY); }
function allRows(sql) { return new Promise((res, rej) => { const d = db(); d.all(sql, (e, rows) => { d.close(); e ? rej(e) : res(rows); }); }); }
async function execs() {
  const rows = await allRows('SELECT e.id, e.status, d.data FROM execution_entity e JOIN execution_data d ON d.executionId = e.id ORDER BY e.id');
  return rows.map((r) => { let run = {}; try { run = flatted.parse(r.data).resultData.runData; } catch (e) {} return { id: r.id, status: r.status, raw: r.data, run }; });
}
const UNITS = Math.round(5000 + 8.33 * 1200); // mock usage: prompt 5000, output 1000, thinking 200

const txt = (id, n, extra = {}) => ({ id, name: id + '.txt', kind: 'txt', markers: 'none', pages: 0, tokens: 1, text: 'lorem ipsum '.repeat(Math.ceil(n / 12)).slice(0, n), ...extra });
const img = (id) => ({ id, name: id + '.png', kind: 'image', tokens: 1600, image: { mime: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } });
const req = (extra = {}) => ({
  mode: 'studio_flashcards', v: 1, requestId: 'f_1761580000000_ab12cd', tool: 'flashcards', language: { code: 'en', name: 'English' }, options: { count: 30, difficulty: 'medium' }, description: 'Focus on Theme 1',
  sources: [{ id: 'S1', name: 'Book.pdf', kind: 'pdf', markers: 'page', pages: 3, tokens: 30, text: '[Page 1]\nalpha beta\n\n[Page 2]\ngamma delta\n\n[Page 3]\nepsilon' }], clientEstimate: 30, promptVersion: 'studio-2026-11-a', ...extra,
});
const mreq = (extra = {}) => req({ mode: 'studio_mindmap', tool: 'mindmap', options: {}, ...extra });

(async () => {
  await reset();
  const login = async (ip) => (await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, ' + ip })).json.token;
  const tok = await login('41.1.1.1'); const H = { authorization: 'Bearer ' + tok };
  const startExecs = (await execs()).length;

  console.log('[flashcards: authentication]');
  let r = await post('student-tools-v2', req()); t(r.status === 401, 'no token -> 401', r.status);
  r = await post('student-tools-v2', req(), { authorization: 'Bearer garbage' }); t(r.status === 403, 'garbage token -> 403', r.status);
  r = await post('student-tools-v2', req(), { authorization: 'Bearer ' + jwt.sign({ sub: 'sth' }, 'other-secret-xxxxxxxxxxxxxxxxxxxx') }); t(r.status === 403, 'wrong-secret token -> 403', r.status);
  t((await gcalls()).length === 0 && usageNow() === 0, 'unauthenticated requests: no Gemini call, no usage');

  console.log('[flashcards: success path]');
  await reset();
  r = await post('student-tools-v2', req(), H);
  const a = r.json && r.json.artifact;
  t(r.status === 200 && r.json.ok === true && Object.keys(r.json).join() === 'ok,artifact', 'HTTP 200 {ok:true, artifact}', r.text.slice(0, 300));
  t(a && a.envelope === 'sth.studio/1' && a.tool === 'flashcards' && a.schema === 'sth.flashcards/1' && a.promptVersion === 'studio-2026-11-a' && a.model === 'gemini-2.5-flash' && a.strategy === 'direct' && /^\d{4}-\d\d-\d\dT/.test(a.generatedAt), 'envelope fields', a && Object.keys(a));
  t(a && JSON.stringify(a.usage) === JSON.stringify({ inputTokens: 5000, outputTokens: 1000, thinkingTokens: 200, calls: 1 }) && Array.isArray(a.repairs) && a.repairs.length === 0, 'usage summary (tokens only) + empty repairs[]', a && a.usage);
  t(a && a.data.schema === 'sth.flashcards/1' && a.data.title === 'Mock deck' && Array.isArray(a.data.notices) && a.data.cards.length === 30 && a.data.cards.every((c, i) => c.id === 'c' + (i + 1) && typeof c.front === 'string' && typeof c.back === 'string' && Array.isArray(c.cites)), 'validated deck: 30 cards, ids c1..c30, front/back/cites', a && a.data.cards.slice(0, 2));
  t(a && a.data.cards[0].topic === 'Topic 1' && a.data.cards[0].cites[0].source === 'S1' && Number.isInteger(a.data.cards[0].cites[0].page), 'card carries topic and {source, page} citations');
  t(r.headers.get('access-control-allow-origin') === ORIGIN, 'CORS origin header on the 200');
  t(usageNow() === UNITS, `usage counter = prompt + 8.33 x (output + thinking) = ${UNITS}`, usageNow());
  const ttl = Number(redis('TTL', 'usage:' + today)); t(ttl > 259000 && ttl <= 259200, 'usage key expires after 3 days', ttl);
  let g = await gcalls(); t(g.length === 1, 'exactly one Gemini call', g.length);
  let gb = g[0].body;
  t(/models\/gemini-2\.5-flash:generateContent$/.test(g[0].gemini), 'model gemini-2.5-flash', g[0].gemini);
  const gcf = gb.generationConfig;
  t(gcf.responseMimeType === 'application/json' && gcf.responseJsonSchema.properties.schema.enum[0] === 'sth.flashcards/1' && JSON.stringify(gcf.responseJsonSchema.properties.cards.items.properties.cites.items.properties.source.enum) === '["S1"]' && gcf.maxOutputTokens === 12288 && gcf.thinkingConfig.thinkingBudget === 1024 && gcf.temperature === 0.4, "JSON mode + flashcards schema with this request's source ids + 12288 / 1024 / 0.4", gcf);
  t(/^<source id="S1" name="Book\.pdf" type="pdf" pages="3" markers="page">\n\[Page 1\]/.test(gb.contents[0].parts[0].text) && /^<settings>\ntool: flashcards\nlanguage: English\ncards: 30\ndifficulty: medium\n<\/settings>\n<request>\nFocus on Theme 1\n<\/request>/.test(gb.contents[0].parts.at(-1).text), 'prompt: source with id marker first; settings (cards, difficulty) and request last');
  t(/never instructions/.test(gb.systemInstruction.parts[0].text) && /Write flashcards for active recall/.test(gb.systemInstruction.parts[0].text) && !/mind map/i.test(gb.systemInstruction.parts[0].text), 'system instruction: source text is data; flashcards block');

  console.log('[flashcards: options, images, large request]');
  for (const [count, difficulty, mx] of [[15, 'easy', 12288], [50, 'hard', 16384]]) {
    await queue('valid'); const n0 = (await gcalls()).length; r = await post('student-tools-v2', req({ options: { count, difficulty } }), H); g = await gcalls(); gb = g.at(-1).body;
    t(r.json && r.json.ok === true && r.json.artifact.data.cards.length === count && g.length === n0 + 1 && gb.generationConfig.maxOutputTokens === mx && new RegExp(`cards: ${count}\\ndifficulty: ${difficulty}\\n`).test(gb.contents[0].parts.at(-1).text), `options ${count}/${difficulty}: ${count} cards, one call, maxOutputTokens ${mx}`, r.text.slice(0, 160));
  }
  await queue('valid'); r = await post('student-tools-v2', req({ options: undefined }), H); g = await gcalls(); t(r.json.ok === true && r.json.artifact.data.cards.length === 30 && /cards: 30\ndifficulty: medium/.test(g.at(-1).body.contents[0].parts.at(-1).text), 'options missing -> 30 cards, medium');
  r = await post('student-tools-v2', req({ sources: [txt('S1', 1000), img('S2'), img('S3')] }), H); g = await gcalls(); gb = g.at(-1).body;
  t(r.json && r.json.ok === true && gb.contents[0].parts.filter((p) => p.inlineData && p.inlineData.mimeType === 'image/png').length === 2 && JSON.stringify(gb.generationConfig.responseJsonSchema.properties.cards.items.properties.cites.items.properties.source.enum) === '["S1","S2","S3"]', '2 images -> 2 inlineData parts, enum S1..S3', r.text.slice(0, 200));
  const bigText = '[Page 1]\n' + 'word '.repeat(95000) + '\n\n[Page 2]\nend';
  r = await post('student-tools-v2', req({ sources: [{ id: 'S1', name: 'big.pdf', kind: 'pdf', markers: 'page', pages: 2, tokens: 1, text: bigText }] }), H);
  t(r.json && r.json.ok === true, 'a 475k-char source (~119k tokens) is accepted end to end', r.text.slice(0, 200));

  console.log('[flashcards: rejections (no Gemini call, no usage, HTTP 200 {ok:false})]');
  await reset();
  const rej = async (name, body, want, reason) => {
    const u0 = usageNow(); const c0 = (await gcalls()).length; const x = await post('student-tools-v2', body, H);
    t(x.status === 200 && x.json && x.json.ok === false && x.json.error && x.json.error.code === want && x.json.error.retryable === false && (!reason || x.json.error.reason === reason) && Object.keys(x.json).join() === 'ok,error', `${name} -> ${want}${reason ? ' (' + reason + ')' : ''}`, x.text.slice(0, 200));
    t((await gcalls()).length === c0 && usageNow() === u0, `${name}: no Gemini call, usage unchanged`);
    return x;
  };
  await rej('11 sources', req({ sources: Array.from({ length: SRC_OVER }, (_, i) => txt('S' + (i + 1), 100)) }), 'STH-STU-413', 'too_many_sources');
  await rej('6 images', req({ sources: Array.from({ length: 6 }, (_, i) => img('S' + (i + 1))) }), 'STH-STU-413', 'too_many_images');
  await rej('1.7M chars (425k tokens, default cap 400000)', req({ sources: [txt('S1', 1700000)] }), 'STH-STU-413', 'too_much_material');
  await rej('client tokens ignored (tokens:5 on 2.4M chars)', req({ sources: [{ ...txt('S1', 2400000), tokens: 5 }], clientEstimate: 5 }), 'STH-STU-413');
  await rej('description 1001 chars', req({ description: 'd'.repeat(1001) }), 'STH-STU-413', 'description_too_long');
  await rej('v 2', req({ v: 2 }), 'STH-INPUT-400');
  await rej('tool quiz', req({ tool: 'quiz' }), 'STH-INPUT-400');
  await rej('flashcards mode with the mind map tool', req({ tool: 'mindmap' }), 'STH-INPUT-400', 'version_or_tool');
  await rej('mind map mode with the flashcards tool', req({ mode: 'studio_mindmap' }), 'STH-INPUT-400', 'version_or_tool');
  await rej('count 20', req({ options: { count: 20, difficulty: 'easy' } }), 'STH-INPUT-400', 'options');
  await rej('count "30" (string)', req({ options: { count: '30', difficulty: 'easy' } }), 'STH-INPUT-400', 'options');
  await rej('difficulty expert', req({ options: { count: 30, difficulty: 'expert' } }), 'STH-INPUT-400', 'options');
  await rej('options is an array', req({ options: [30, 'easy'] }), 'STH-INPUT-400', 'options');
  await rej('language xx', req({ language: { code: 'xx', name: 'Klingon' } }), 'STH-INPUT-400');
  await rej('no sources', req({ sources: [] }), 'STH-INPUT-400');
  await rej('duplicate source ids', req({ sources: [txt('S1', 10), txt('S1', 10)] }), 'STH-INPUT-400');
  { const x = await post('student-tools-v2', { mode: 'studio_flashcards' }, H); t(x.status === 200 && x.json.ok === false && x.json.error.code === 'STH-INPUT-400', 'bare {mode} -> STH-INPUT-400 (no crash)', x.text.slice(0, 200)); }

  console.log('[flashcards: owner-set token cap cfg:studio_max_tokens]');
  { await reset();
    const capRej = async (name, body, wantMax) => { const c0 = (await gcalls()).length; const u0 = usageNow(); const x = await post('student-tools-v2', body, H);
      t(x.status === 200 && x.json && x.json.ok === false && x.json.error.code === 'STH-STU-413' && x.json.error.reason === 'too_much_material' && x.json.error.maxTokens === wantMax && Object.keys(x.json.error).join() === 'code,retryable,reason,maxTokens', `${name}: 413 too_much_material with maxTokens ${wantMax}`, x.text.slice(0, 220));
      t((await gcalls()).length === c0 && usageNow() === u0, `${name}: no Gemini call, usage unchanged`); };
    const capOk = async (name, body) => { await queue('valid'); const x = await post('student-tools-v2', body, H); t(x.json && x.json.ok === true, `${name}: accepted`, x.text.slice(0, 200)); };
    await capRej('key unset, 425k tokens', req({ sources: [txt('S1', 1700000)] }), 400000);
    await capOk('key unset, 390k tokens', req({ sources: [txt('S1', 1560000)] }));
    await setKey('cfg:studio_max_tokens', '800000');
    await capOk('key 800000, 700k tokens', req({ sources: [txt('S1', 2800000)] }));
    await capRej('key 800000, 820k tokens', req({ sources: [txt('S1', 3280000)] }), 800000);
    await setKey('cfg:studio_max_tokens', '2000000');
    await capRej('key 2000000 (clamped to 900000), 950k tokens', req({ sources: [txt('S1', 3800000)] }), 900000);
    await setKey('cfg:studio_max_tokens', '300');
    await capRej('key 300 (clamped up to 50000), 55k tokens', req({ sources: [txt('S1', 220000)] }), 50000);
    for (const junk of ['abc', '12.5', '-5']) { await setKey('cfg:studio_max_tokens', junk); await capRej(`key ${JSON.stringify(junk)} (invalid -> default)`, req({ sources: [txt('S1', 1700000)] }), 400000); }
    redis('DEL', 'cfg:studio_max_tokens');
    await fetch(M + '/_down?on=1'); const dn = await post('student-tools-v2', req({ sources: [txt('S1', 1700000)] }), H); await fetch(M + '/_down?on=0');
    t(dn.json && dn.json.ok === false && dn.json.error.maxTokens === 400000, 'Redis down: default cap 400000 applies', dn.text.slice(0, 200));
  }

  console.log('[flashcards: large requests (> 300000 tokens) are never retried on a timeout or 5xx; smaller ones still are]');
  { const big = () => req({ sources: [txt('S1', 1400000)] }); const small = () => req({ sources: [txt('S1', 1000000)] });
    const fresh = async () => { await reset(); await setKey('cfg:studio_max_tokens', '800000'); };
    for (const fx of ['503,valid', '500,valid', 'empty,valid']) {
      await fresh(); await queue(fx); r = await post('student-tools-v2', big(), H); let c = await gcalls();
      t(c.length === 1 && r.json && r.json.ok === false && (r.json.error.code === 'STH-STU-409' || r.json.error.code === 'STH-STU-422') && usageNow() === (fx.startsWith('empty') ? UNITS : 0), `350k tokens, ${fx.split(',')[0]} first: exactly ONE Gemini call (no retry)`, { n: c.length, r: r.text.slice(0, 160) });
      await fresh(); await queue(fx); r = await post('student-tools-v2', small(), H); c = await gcalls();
      t(c.length === 2 && r.json && r.json.ok === true, `250k tokens, ${fx.split(',')[0]} first: retried, second call succeeds`, { n: c.length, r: r.text.slice(0, 160) });
    }
    await fresh(); await queue('hang:20000,valid'); r = await post('student-tools-v2', big(), H); let c2 = await gcalls();
    t(c2.length === 1 && r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.ms < 19000 && usageNow() === 0, '350k tokens, Gemini timeout: ONE call only, STH-STU-409, nothing metered', { n: c2.length, ms: r.ms });
    await sleep(15000);
    await fresh(); await queue('429,valid'); r = await post('student-tools-v2', big(), H); c2 = await gcalls(); t(c2.length === 2 && r.json && r.json.ok === true, '350k tokens, 429 first: still retried once', { n: c2.length });
    await fresh(); await queue('429,429,valid'); r = await post('student-tools-v2', big(), H); c2 = await gcalls(); t(c2.length === 2 && r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409', '350k tokens, 429 twice: only one retry, then STH-STU-409', { n: c2.length });
  }

  console.log('[flashcards: model output problems]');
  await reset();
  const bad = async (fx, want, reasonWant, billed) => {
    await queue(fx); const u0 = usageNow(); const c0 = (await gcalls()).length; const x = await post('student-tools-v2', req(), H);
    t(x.status === 200 && x.json.ok === false && x.json.error.code === want && x.json.error.retryable === true && x.json.error.reason === reasonWant, `${fx} -> ${want} (${reasonWant})`, x.text.slice(0, 200));
    t((await gcalls()).length - c0 === 1, `${fx}: exactly one Gemini call (no blind retry of unusable output)`);
    t(usageNow() - u0 === (billed ? UNITS : 0), `${fx}: Gemini billed this call -> usage ${billed ? '+' + UNITS : 'unchanged'}`, usageNow() - u0);
  };
  await bad('truncated', 'STH-STU-422', 'truncated', true);
  await bad('cutstop', 'STH-STU-422', 'parse', true);
  await bad('prose', 'STH-STU-422', 'parse', true);
  await bad('invalid', 'STH-STU-422', 'too_few_cards', true);
  await bad('few', 'STH-STU-422', 'too_few_cards', true);
  await bad('alldupes', 'STH-STU-422', 'too_few_cards', true);
  await bad('allempty', 'STH-STU-422', 'too_few_cards', true);
  await bad('wrongschema', 'STH-STU-422', 'schema', true);
  const okFx = async (fx, check, name, body = req()) => { await queue(fx); const x = await post('student-tools-v2', body, H); const ar = x.json && x.json.artifact; t(x.json && x.json.ok === true && check(ar, x), name, x.text.slice(0, 300)); return ar; };
  await okFx('half', (ar) => ar.data.cards.length === 15, 'exactly half of the request (15 of 30) passes the hard check');
  await okFx('trunclate', (ar) => ar.data.cards.length === 25 && ar.repairs.some((x) => /cut-off/.test(x)), 'cut-off answer (MAX_TOKENS) with 25 of 30 cards complete is salvaged, repair listed');
  await okFx('dupes', (ar) => ar.data.cards.length === 15 && ar.repairs.some((x) => /repeats an earlier one/.test(x)) && ar.data.cards.every((c, i) => c.id === 'c' + (i + 1)), 'duplicate fronts dropped, ids renumbered, repair listed');
  await okFx('empties', (ar) => ar.data.cards.length === 20 && ar.repairs.some((x) => /empty front or back/.test(x)) && ar.data.cards[19].id === 'c20', 'empty fronts dropped');
  await okFx('many', (ar) => ar.data.cards.length === 80 && ar.data.cards[79].id === 'c80' && ar.repairs.some((x) => /80 card cap/.test(x)), '120 cards capped at 80');
  await okFx('huge', (ar) => ar.data.cards[0].front.length <= 160 && ar.data.cards[0].back.length <= 500 && /…$/.test(ar.data.cards[0].back), 'huge front / back trimmed to 160 / 500 characters');
  await okFx('html', (ar) => ar.data.cards[0].front === '<img src=x onerror=alert(1)>' && ar.data.cards[1].back === '<script>alert(1)</script>' && ar.data.cards[2].topic === '"><svg/onload=alert(1)>', 'markup in fronts / backs / topics is returned as plain text, unchanged');
  await okFx('wrongsrc', (ar) => ar.data.cards[0].cites.length === 1 && ar.data.cards[0].cites[0].source === 'S1' && ar.data.cards[0].cites[0].page === 0 && ar.repairs.some((x) => /unknown sources/.test(x)) && ar.repairs.some((x) => /page numbers/.test(x)), 'citation to a source not in the request dropped; page beyond the source reset to 0; repairs listed');
  console.log('[flashcards: blocked content]');
  await queue('safety'); r = await post('student-tools-v2', req(), H); t(r.json && r.json.ok === false && r.json.error.code === 'STH-AI-451' && r.json.error.retryable === false, 'SAFETY -> STH-AI-451', r.text.slice(0, 200));
  await queue('recitation'); r = await post('student-tools-v2', req(), H); t(r.json && r.json.ok === false && r.json.error.code === 'STH-AI-452', 'RECITATION -> STH-AI-452', r.text.slice(0, 200));

  console.log('[flashcards: retries, fallback model, schema fallback]');
  { await reset();
    await queue('429,valid'); let c; r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === true && c.length === 2 && r.json.artifact.usage.calls === 2 && r.json.artifact.model === 'gemini-2.5-flash', '429 then OK: second call succeeds on flash', { n: c.length });
    t(usageNow() === UNITS, 'only the answered attempt is metered (429 is not billed)', usageNow());
    await reset(); await queue('429,429,valid'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === true && c.length === 3 && /gemini-2\.5-flash:generateContent$/.test(c[1].gemini) && /gemini-2\.5-flash-lite:generateContent$/.test(c[2].gemini) && r.json.artifact.model === 'gemini-2.5-flash-lite' && r.json.artifact.usage.calls === 3, 'flash-lite fallback only on the third (last) attempt; envelope records the model used', c.map((x) => x.gemini));
    await reset(); await queue('500,500,500'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.status === 200 && r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.json.error.retryable === true && c.length === 3 && usageNow() === 0, '500 x3 -> STH-STU-409 after exactly 3 calls, nothing metered', { code: r.json && r.json.error, n: c.length });
    await reset(); await queue('429,429,429'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && c.length === 3 && usageNow() === 0, '429 x3 -> STH-STU-409, nothing metered');
    await reset(); await queue('empty,empty,empty'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-422' && r.json.error.reason === 'empty' && c.length === 3, 'empty replies are retried, then STH-STU-422', { n: c.length });
    await reset(); await queue('schema400'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === true && c.length === 2 && c[0].body.generationConfig.responseJsonSchema && c[1].body.generationConfig.responseSchema && !c[1].body.generationConfig.responseJsonSchema && c[1].body.generationConfig.responseSchema.type === 'OBJECT' && c[1].body.generationConfig.responseSchema.properties.cards && c[1].body.generationConfig.responseMimeType === 'application/json', 'HTTP 400 on responseJsonSchema -> retried with the flashcards responseSchema (OpenAPI subset)', c.map((x) => Object.keys(x.body.generationConfig)));
    await reset(); await queue('400,400'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-422' && c.length === 2, 'both schema variants rejected -> STH-STU-422 after 2 calls', { n: c.length });
    await reset(); await queue('slow:3000'); r = await post('student-tools-v2', req(), H);
    t(r.json && r.json.ok === true && r.ms >= 2900 && (await gcalls()).length === 1, 'a slow (3 s) Gemini answer is simply waited for', r.ms);
  }

  console.log('[flashcards: hanging Gemini (call timeout 6 s in this test copy)]');
  { await reset();
    await queue('hang:20000,valid'); r = await post('student-tools-v2', req(), H); const c = await gcalls();
    t(r.json && r.json.ok === true && r.ms >= 5800 && r.ms < 19000 && c.length === 2 && r.json.artifact.usage.calls === 2, 'node timeout from the item fires at ~6 s (not 20 s); the retry then succeeds', { ms: r.ms, n: c.length });
    t(usageNow() === UNITS, 'timed-out attempt not metered');
    await reset(); await queue('hang:20000,hang:20000,hang:20000'); r = await post('student-tools-v2', req(), H);
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.ms < 60000, 'three hangs -> STH-STU-409', { ms: r.ms });
    await sleep(15000);
  }

  console.log('[flashcards: daily ceiling (existing cost meter)]');
  { await reset();
    await queue('valid'); r = await post('student-tools-v2', req(), H); t(r.json.ok === true && usageNow() === UNITS, 'no cfg:daily_units -> allowed');
    await setKey('cfg:daily_units', String(UNITS + 1)); r = await post('student-tools-v2', req(), H); t(r.json.ok === true && usageNow() === 2 * UNITS, 'below the ceiling -> allowed (the call may overshoot it)');
    const c1 = (await gcalls()).length; r = await post('student-tools-v2', req(), H);
    t(r.status === 200 && JSON.stringify(r.json) === '{"ok":false,"error":{"code":"STH-QUOTA-430","retryable":false}}', 'ceiling reached -> {ok:false,error:{code:STH-QUOTA-430,retryable:false}} (same as the other modes)', r.text);
    t((await gcalls()).length === c1 && usageNow() === 2 * UNITS, 'ceiling reached: no Gemini call, usage unchanged');
    await setKey('cfg:daily_units', '0'); r = await post('student-tools-v2', req(), H); t(r.json.error && r.json.error.code === 'STH-QUOTA-430', 'cfg:daily_units 0 = kill switch for flashcards too');
    await setKey('cfg:daily_units', '1'); r = await post('student-tools-v2', req({ options: { count: 7 } }), H); t(r.json.error && r.json.error.code === 'STH-QUOTA-430', 'ceiling is checked before the request is looked at (same place as the other Gemini modes)');
    redis('DEL', 'cfg:daily_units'); r = await post('student-tools-v2', req(), H); t(r.json.ok === true, 'DEL cfg:daily_units lifts the ceiling');
    await fetch(M + '/_down?on=1'); r = await post('student-tools-v2', req(), H); await fetch(M + '/_down?on=0');
    t(r.json && r.json.ok === true, 'Redis down: the ceiling read and the meter are fail-open, the deck is still made', r.text.slice(0, 150));
  }

  console.log('[flashcards: no request text in errors, e-mails or error responses]');
  { await reset();
    const MARK = 'ZZSECRETSOURCEZZ' + 'q'.repeat(30); const e0 = (await execs()).length;
    const secret = (extra = {}) => req({ description: MARK + ' description', sources: [{ id: 'S1', name: MARK + '.pdf', kind: 'pdf', markers: 'page', pages: 1, tokens: 1, text: '[Page 1]\n' + MARK + ' body text of the student' }], ...extra });
    const bodies = [];
    for (const fx of ['500,500,500', '429,429,429', 'truncated', 'prose', 'few', 'safety', 'hang:20000,hang:20000,hang:20000', 'valid']) { await queue(fx); const x = await post('student-tools-v2', secret(), H); bodies.push(x.text); }
    for (const badReq of [secret({ v: 2 }), secret({ options: { count: MARK } }), secret({ sources: Array.from({ length: SRC_OVER + 1 }, (_, i) => txt('S' + (i + 1), 50, { text: MARK })) }), secret({ language: { code: MARK } })]) bodies.push((await post('student-tools-v2', badReq, H)).text);
    await sleep(2500);
    const ex = (await execs()).slice(e0);
    const failed = bodies.filter((b) => !b.includes('"artifact"'));
    t(failed.length === 11 && failed.every((b) => !b.includes('ZZSECRET')), 'no error response contains request text', failed.map((b) => b.slice(0, 80)));
    t(ex.length >= 12 && ex.every((e) => e.status !== 'error' && e.status !== 'crashed'), 'no flashcards execution ended in error', ex.map((e) => e.status));
    t(!ex.some((e) => e.run['Error Trigger'] || e.run['Format Workflow Error1'] || e.run['Send Workflow Error Email1'] || e.run['Handle Error Report1']), 'no error e-mail path was triggered by any flashcards failure');
    t(ex.filter((e) => e.run['Send Workflow Error Email1'] || e.run['Send Error Email1']).length === 0, 'no e-mail node ran');
    const noText = ex.filter((e) => e.run['Studio - Validate'] || e.run['Studio - Reject']).every((e) => ['Studio - Validate', 'Studio - Reject', 'Studio - Respond'].every((n) => !e.run[n] || !JSON.stringify(e.run[n]).includes('ZZSECRET')));
    t(noText, 'Studio - Validate / Reject / Respond outputs hold no request text');
    const st = await state(); t(!JSON.stringify(st.log.filter((l) => l.cmd)).includes('ZZSECRET'), 'no Redis command carried request text');
  }

  console.log('[mind map next to flashcards on the same workflow]');
  { await reset(); await queue('valid'); r = await post('student-tools-v2', mreq(), H);
    t(r.json && r.json.ok === true && r.json.artifact.tool === 'mindmap' && r.json.artifact.schema === 'sth.mindmap/1' && r.json.artifact.data.nodes.length === 13, 'a mind map request is still answered with a mind map (32768 tokens, own schema)', r.text.slice(0, 160));
    const gbm = (await gcalls()).at(-1).body; t(gbm.generationConfig.maxOutputTokens === 32768 && gbm.generationConfig.responseJsonSchema.properties.nodes && !gbm.generationConfig.responseJsonSchema.properties.cards, 'its Gemini call carries the mind map schema'); }

  const fin = (await execs()).slice(startExecs);
  const errs = fin.filter((e) => e.status === 'error' || e.status === 'crashed');
  t(errs.length === 0, 'no execution failed during the whole flashcards run', errs.map((e) => [e.id, e.status]));
  console.log(`\nE2E flashcards: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E flashcards crashed', e); process.exit(2); });
