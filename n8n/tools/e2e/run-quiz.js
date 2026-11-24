// End-to-end checks of the Study Studio QUIZ mode (v6) on the synchronous path, against a real n8n 2.29.7 running the
// imported v6 test copy (external HTTP -> mock; real Redis 7 on 6390). Needs the test copy built with STUDIO_TEST_TIMEOUT_MS=6000:
//   STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v6-quiz && node e2e/run-quiz.js
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
  mode: 'studio_quiz', v: 1, requestId: 'f_1761580000000_ab12cd', tool: 'quiz', language: { code: 'en', name: 'English' }, options: { count: 20, difficulty: 'medium' }, description: 'Focus on Theme 1',
  sources: [{ id: 'S1', name: 'Book.pdf', kind: 'pdf', markers: 'page', pages: 3, tokens: 30, text: '[Page 1]\nalpha beta\n\n[Page 2]\ngamma delta\n\n[Page 3]\nepsilon' }], clientEstimate: 30, promptVersion: 'studio-2026-11-a', ...extra,
});
const mreq = (extra = {}) => req({ mode: 'studio_mindmap', tool: 'mindmap', options: {}, ...extra });
const freq = (extra = {}) => req({ mode: 'studio_flashcards', tool: 'flashcards', options: { count: 30, difficulty: 'medium' }, ...extra });

(async () => {
  await reset();
  const login = async (ip) => (await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, ' + ip })).json.token;
  const tok = await login('41.1.1.1'); const H = { authorization: 'Bearer ' + tok };
  const startExecs = (await execs()).length;

  console.log('[quiz: authentication]');
  let r = await post('student-tools-v2', req()); t(r.status === 401, 'no token -> 401', r.status);
  r = await post('student-tools-v2', req(), { authorization: 'Bearer garbage' }); t(r.status === 403, 'garbage token -> 403', r.status);
  r = await post('student-tools-v2', req(), { authorization: 'Bearer ' + jwt.sign({ sub: 'sth' }, 'other-secret-xxxxxxxxxxxxxxxxxxxx') }); t(r.status === 403, 'wrong-secret token -> 403', r.status);
  t((await gcalls()).length === 0 && usageNow() === 0, 'unauthenticated requests: no Gemini call, no usage');

  console.log('[quiz: success path]');
  await reset();
  r = await post('student-tools-v2', req(), H);
  const a = r.json && r.json.artifact;
  t(r.status === 200 && r.json.ok === true && Object.keys(r.json).join() === 'ok,artifact', 'HTTP 200 {ok:true, artifact}', r.text.slice(0, 300));
  t(a && a.envelope === 'sth.studio/1' && a.tool === 'quiz' && a.schema === 'sth.quiz/1' && a.promptVersion === 'studio-2026-11-a' && a.model === 'gemini-2.5-flash' && a.strategy === 'direct' && /^\d{4}-\d\d-\d\dT/.test(a.generatedAt), 'envelope fields', a && Object.keys(a));
  t(a && JSON.stringify(a.usage) === JSON.stringify({ inputTokens: 5000, outputTokens: 1000, thinkingTokens: 200, calls: 1 }) && Array.isArray(a.repairs) && a.repairs.length === 0, 'usage summary (tokens only) + empty repairs[]', a && a.usage);
  t(a && a.data.schema === 'sth.quiz/1' && a.data.title === 'Mock quiz' && Array.isArray(a.data.notices) && a.data.questions.length === 20 && a.data.questions.every((c, i) => c.id === 'q' + (i + 1) && typeof c.stem === 'string' && typeof c.answer === 'string' && Array.isArray(c.options) && Array.isArray(c.cites)), 'validated quiz: 20 questions, ids q1..q20, stem/options/answer/cites', a && a.data.questions.slice(0, 1));
  { const q0 = a && a.data.questions[0]; const q4 = a && a.data.questions[4];
    t(q0 && q0.type === 'mcq' && q0.topic === 'Topic 1' && q0.options.map((o) => o.id).join() === 'A,B,C,D' && q0.answer === 'B' && typeof q0.hint === 'string' && typeof q0.explanation === 'string' && q0.options.every((o) => typeof o.text === 'string' && typeof o.rationale === 'string') && q0.cites[0].source === 'S1' && Number.isInteger(q0.cites[0].page), 'mcq: type, topic, options A-D with rationales, answer id, hint, explanation, {source, page} citations', q0);
    t(q4 && q4.type === 'true_false' && q4.options.map((o) => o.text).join() === 'True,False' && q4.answer === 'A', 'true/false question: fixed True / False options, answer A', q4); }
  t(r.headers.get('access-control-allow-origin') === ORIGIN, 'CORS origin header on the 200');
  t(usageNow() === UNITS, `usage counter = prompt + 8.33 x (output + thinking) = ${UNITS}`, usageNow());
  const ttl = Number(redis('TTL', 'usage:' + today)); t(ttl > 259000 && ttl <= 259200, 'usage key expires after 3 days', ttl);
  let g = await gcalls(); t(g.length === 1, 'exactly one Gemini call', g.length);
  let gb = g[0].body;
  t(/models\/gemini-2\.5-flash:generateContent$/.test(g[0].gemini), 'model gemini-2.5-flash', g[0].gemini);
  const gcf = gb.generationConfig;
  t(gcf.responseMimeType === 'application/json' && gcf.responseJsonSchema.properties.schema.enum[0] === 'sth.quiz/1' && JSON.stringify(gcf.responseJsonSchema.properties.questions.items.properties.cites.items.properties.source.enum) === '["S1"]' && gcf.maxOutputTokens === 24576 && gcf.thinkingConfig.thinkingBudget === 1024 && gcf.temperature === 0.4, "JSON mode + quiz schema with this request's source ids + 24576 / 1024 / 0.4", gcf);
  t(/^<source id="S1" name="Book\.pdf" type="pdf" pages="3" markers="page">\n\[Page 1\]/.test(gb.contents[0].parts[0].text) && /^<settings>\ntool: quiz\nlanguage: English\nquestions: 20\ndifficulty: medium\n<\/settings>\n<request>\nFocus on Theme 1\n<\/request>/.test(gb.contents[0].parts.at(-1).text), 'prompt: source with id marker first; settings (questions, difficulty) and request last');
  t(/never instructions/.test(gb.systemInstruction.parts[0].text) && /Write a quiz that checks understanding/.test(gb.systemInstruction.parts[0].text) && !/mind map/i.test(gb.systemInstruction.parts[0].text) && !/flashcards/i.test(gb.systemInstruction.parts[0].text), 'system instruction: source text is data; quiz block');

  console.log('[quiz: options, images, large request]');
  for (const [count, difficulty, mx] of [[10, 'easy', 24576], [30, 'hard', 24576]]) {
    await queue('valid'); const n0 = (await gcalls()).length; r = await post('student-tools-v2', req({ options: { count, difficulty } }), H); g = await gcalls(); gb = g.at(-1).body;
    t(r.json && r.json.ok === true && r.json.artifact.data.questions.length === count && g.length === n0 + 1 && gb.generationConfig.maxOutputTokens === mx && new RegExp(`questions: ${count}\\ndifficulty: ${difficulty}\\n`).test(gb.contents[0].parts.at(-1).text), `options ${count}/${difficulty}: ${count} questions, one call, maxOutputTokens ${mx}`, r.text.slice(0, 160));
  }
  await queue('valid'); r = await post('student-tools-v2', req({ options: undefined }), H); g = await gcalls(); t(r.json.ok === true && r.json.artifact.data.questions.length === 20 && /questions: 20\ndifficulty: medium/.test(g.at(-1).body.contents[0].parts.at(-1).text), 'options missing -> 20 questions, medium');
  await queue('valid'); r = await post('student-tools-v2', req({ description: 'Make 40 questions please' }), H); g = await gcalls(); t(r.json.ok === true && r.json.artifact.data.questions.length === 20 && /questions: 20\n/.test(g.at(-1).body.contents[0].parts.at(-1).text), 'an explicit number in the description does not change the count (not supported)');
  r = await post('student-tools-v2', req({ sources: [txt('S1', 1000), img('S2'), img('S3')] }), H); g = await gcalls(); gb = g.at(-1).body;
  t(r.json && r.json.ok === true && gb.contents[0].parts.filter((p) => p.inlineData && p.inlineData.mimeType === 'image/png').length === 2 && JSON.stringify(gb.generationConfig.responseJsonSchema.properties.questions.items.properties.cites.items.properties.source.enum) === '["S1","S2","S3"]', '2 images -> 2 inlineData parts, enum S1..S3', r.text.slice(0, 200));
  const bigText = '[Page 1]\n' + 'word '.repeat(95000) + '\n\n[Page 2]\nend';
  r = await post('student-tools-v2', req({ sources: [{ id: 'S1', name: 'big.pdf', kind: 'pdf', markers: 'page', pages: 2, tokens: 1, text: bigText }] }), H);
  t(r.json && r.json.ok === true, 'a 475k-char source (~119k tokens) is accepted end to end', r.text.slice(0, 200));

  console.log('[quiz: rejections (no Gemini call, no usage, HTTP 200 {ok:false})]');
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
  await rej('tool flashcards in the quiz mode', req({ tool: 'flashcards' }), 'STH-INPUT-400', 'version_or_tool');
  await rej('quiz mode with the mind map tool', req({ tool: 'mindmap' }), 'STH-INPUT-400', 'version_or_tool');
  await rej('mind map mode with the quiz tool', req({ mode: 'studio_mindmap' }), 'STH-INPUT-400', 'version_or_tool');
  await rej('flashcards mode with the quiz tool', req({ mode: 'studio_flashcards' }), 'STH-INPUT-400', 'version_or_tool');
  await rej('count 15 (a flashcards value)', req({ options: { count: 15, difficulty: 'easy' } }), 'STH-INPUT-400', 'options');
  await rej('count 50', req({ options: { count: 50 } }), 'STH-INPUT-400', 'options');
  await rej('count "20" (string)', req({ options: { count: '20', difficulty: 'easy' } }), 'STH-INPUT-400', 'options');
  await rej('difficulty expert', req({ options: { count: 20, difficulty: 'expert' } }), 'STH-INPUT-400', 'options');
  await rej('options is an array', req({ options: [20, 'easy'] }), 'STH-INPUT-400', 'options');
  await rej('language xx', req({ language: { code: 'xx', name: 'Klingon' } }), 'STH-INPUT-400');
  await rej('no sources', req({ sources: [] }), 'STH-INPUT-400');
  await rej('duplicate source ids', req({ sources: [txt('S1', 10), txt('S1', 10)] }), 'STH-INPUT-400');
  { const x = await post('student-tools-v2', { mode: 'studio_quiz' }, H); t(x.status === 200 && x.json.ok === false && x.json.error.code === 'STH-INPUT-400', 'bare {mode} -> STH-INPUT-400 (no crash)', x.text.slice(0, 200)); }

  console.log('[quiz: owner-set token cap cfg:studio_max_tokens]');
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

  console.log('[quiz: large requests (> 300000 tokens) are never retried on a timeout or 5xx; smaller ones still are]');
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

  console.log('[quiz: model output problems]');
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
  await bad('invalid', 'STH-STU-422', 'too_few_questions', true);
  await bad('few', 'STH-STU-422', 'too_few_questions', true);
  await bad('allbad', 'STH-STU-422', 'too_few_questions', true);
  await bad('wrongschema', 'STH-STU-422', 'schema', true);
  const okFx = async (fx, check, name, body = req()) => { await queue(fx); const x = await post('student-tools-v2', body, H); const ar = x.json && x.json.artifact; t(x.json && x.json.ok === true && check(ar, x), name, x.text.slice(0, 300)); return ar; };
  await okFx('half', (ar) => ar.data.questions.length === 10, 'exactly half of the request (10 of 20) passes the hard check');
  await okFx('trunclate', (ar) => ar.data.questions.length === 16 && ar.repairs.some((x) => /cut-off/.test(x)), 'cut-off answer (MAX_TOKENS) with 16 of 20 questions complete is salvaged, repair listed');
  await okFx('dupes', (ar) => ar.data.questions.length === 10 && ar.repairs.some((x) => /repeats an earlier one/.test(x)) && ar.data.questions.every((c, i) => c.id === 'q' + (i + 1)), 'duplicate stems dropped, ids renumbered, repair listed');
  await okFx('twocorrect', (ar) => ar.data.questions.length === 16 && ar.repairs.some((x) => /dropped 4 questions without exactly one correct answer/.test(x)) && ar.data.questions.every((c) => c.options.some((o) => o.id === c.answer)), 'questions naming two correct answers dropped (4 of 20), every remaining answer is an option');
  await okFx('ansnotin', (ar) => ar.data.questions.length === 15 && ar.repairs.some((x) => /dropped 5 questions without exactly one correct answer/.test(x)) && ar.data.questions.every((c) => c.options.some((o) => o.id === c.answer)), 'questions whose answer is not among the options dropped (5 of 20, true/false included)');
  await okFx('hintleak', (ar) => ar.data.questions.length === 20 && ar.repairs.some((x) => /blanked 6 hints that contained the correct answer/.test(x)) && ar.data.questions[0].hint === '' && ar.data.questions[1].hint !== '', 'hints that contain the correct option are blanked (6), the question is kept');
  await okFx('many', (ar) => ar.data.questions.length === 50 && ar.data.questions[49].id === 'q50' && ar.repairs.some((x) => /50 question cap/.test(x)), '120 questions capped at 50');
  await okFx('huge', (ar) => ar.data.questions[0].stem.length <= 300 && ar.data.questions[0].explanation.length <= 500 && ar.data.questions[0].options[0].text.length <= 160 && ar.data.questions[0].options[0].rationale.length <= 200 && /…$/.test(ar.data.questions[0].explanation), 'huge stem / explanation / option / rationale trimmed to 300 / 500 / 160 / 200 characters');
  await okFx('html', (ar) => ar.data.questions[0].stem === '<img src=x onerror=alert(1)>' && ar.data.questions[0].explanation === '<script>alert(1)</script>' && ar.data.questions[1].topic === '"><svg/onload=alert(1)>' && ar.data.questions[1].options[0].text === '<b>bold</b>', 'markup in stems / explanations / topics / options is returned as plain text, unchanged');
  await okFx('wrongsrc', (ar) => ar.data.questions[0].cites.length === 1 && ar.data.questions[0].cites[0].source === 'S1' && ar.data.questions[0].cites[0].page === 0 && ar.repairs.some((x) => /unknown sources/.test(x)) && ar.repairs.some((x) => /page numbers/.test(x)), 'citation to a source not in the request dropped; page beyond the source reset to 0; repairs listed');
  console.log('[quiz: blocked content]');
  await queue('safety'); r = await post('student-tools-v2', req(), H); t(r.json && r.json.ok === false && r.json.error.code === 'STH-AI-451' && r.json.error.retryable === false, 'SAFETY -> STH-AI-451', r.text.slice(0, 200));
  await queue('recitation'); r = await post('student-tools-v2', req(), H); t(r.json && r.json.ok === false && r.json.error.code === 'STH-AI-452', 'RECITATION -> STH-AI-452', r.text.slice(0, 200));

  console.log('[quiz: retries, fallback model, schema fallback]');
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
    t(r.json && r.json.ok === true && c.length === 2 && c[0].body.generationConfig.responseJsonSchema && c[1].body.generationConfig.responseSchema && !c[1].body.generationConfig.responseJsonSchema && c[1].body.generationConfig.responseSchema.type === 'OBJECT' && c[1].body.generationConfig.responseSchema.properties.questions && c[1].body.generationConfig.responseMimeType === 'application/json', 'HTTP 400 on responseJsonSchema -> retried with the quiz responseSchema (OpenAPI subset)', c.map((x) => Object.keys(x.body.generationConfig)));
    await reset(); await queue('400,400'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-422' && c.length === 2, 'both schema variants rejected -> STH-STU-422 after 2 calls', { n: c.length });
    await reset(); await queue('slow:3000'); r = await post('student-tools-v2', req(), H);
    t(r.json && r.json.ok === true && r.ms >= 2900 && (await gcalls()).length === 1, 'a slow (3 s) Gemini answer is simply waited for', r.ms);
  }

  console.log('[quiz: hanging Gemini (call timeout 6 s in this test copy)]');
  { await reset();
    await queue('hang:20000,valid'); r = await post('student-tools-v2', req(), H); const c = await gcalls();
    t(r.json && r.json.ok === true && r.ms >= 5800 && r.ms < 19000 && c.length === 2 && r.json.artifact.usage.calls === 2, 'node timeout from the item fires at ~6 s (not 20 s); the retry then succeeds', { ms: r.ms, n: c.length });
    t(usageNow() === UNITS, 'timed-out attempt not metered');
    await reset(); await queue('hang:20000,hang:20000,hang:20000'); r = await post('student-tools-v2', req(), H);
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.ms < 60000, 'three hangs -> STH-STU-409', { ms: r.ms });
    await sleep(15000);
  }

  console.log('[quiz: daily ceiling (existing cost meter)]');
  { await reset();
    await queue('valid'); r = await post('student-tools-v2', req(), H); t(r.json.ok === true && usageNow() === UNITS, 'no cfg:daily_units -> allowed');
    await setKey('cfg:daily_units', String(UNITS + 1)); r = await post('student-tools-v2', req(), H); t(r.json.ok === true && usageNow() === 2 * UNITS, 'below the ceiling -> allowed (the call may overshoot it)');
    const c1 = (await gcalls()).length; r = await post('student-tools-v2', req(), H);
    t(r.status === 200 && JSON.stringify(r.json) === '{"ok":false,"error":{"code":"STH-QUOTA-430","retryable":false}}', 'ceiling reached -> {ok:false,error:{code:STH-QUOTA-430,retryable:false}} (same as the other modes)', r.text);
    t((await gcalls()).length === c1 && usageNow() === 2 * UNITS, 'ceiling reached: no Gemini call, usage unchanged');
    await setKey('cfg:daily_units', '0'); r = await post('student-tools-v2', req(), H); t(r.json.error && r.json.error.code === 'STH-QUOTA-430', 'cfg:daily_units 0 = kill switch for the quiz too');
    await setKey('cfg:daily_units', '1'); r = await post('student-tools-v2', req({ options: { count: 7 } }), H); t(r.json.error && r.json.error.code === 'STH-QUOTA-430', 'ceiling is checked before the request is looked at (same place as the other Gemini modes)');
    redis('DEL', 'cfg:daily_units'); r = await post('student-tools-v2', req(), H); t(r.json.ok === true, 'DEL cfg:daily_units lifts the ceiling');
    await fetch(M + '/_down?on=1'); r = await post('student-tools-v2', req(), H); await fetch(M + '/_down?on=0');
    t(r.json && r.json.ok === true, 'Redis down: the ceiling read and the meter are fail-open, the quiz is still made', r.text.slice(0, 150));
  }

  console.log('[quiz: no request text in errors, e-mails or error responses]');
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
    t(ex.length >= 12 && ex.every((e) => e.status !== 'error' && e.status !== 'crashed'), 'no quiz execution ended in error', ex.map((e) => e.status));
    t(!ex.some((e) => e.run['Error Trigger'] || e.run['Format Workflow Error1'] || e.run['Send Workflow Error Email1'] || e.run['Handle Error Report1']), 'no error e-mail path was triggered by any quiz failure');
    t(ex.filter((e) => e.run['Send Workflow Error Email1'] || e.run['Send Error Email1']).length === 0, 'no e-mail node ran');
    const noText = ex.filter((e) => e.run['Studio - Validate'] || e.run['Studio - Reject']).every((e) => ['Studio - Validate', 'Studio - Reject', 'Studio - Respond'].every((n) => !e.run[n] || !JSON.stringify(e.run[n]).includes('ZZSECRET')));
    t(noText, 'Studio - Validate / Reject / Respond outputs hold no request text');
    const st = await state(); t(!JSON.stringify(st.log.filter((l) => l.cmd)).includes('ZZSECRET'), 'no Redis command carried request text');
  }

  console.log('[mind map and flashcards next to the quiz on the same workflow]');
  { await reset(); await queue('valid'); r = await post('student-tools-v2', mreq(), H);
    t(r.json && r.json.ok === true && r.json.artifact.tool === 'mindmap' && r.json.artifact.schema === 'sth.mindmap/1' && r.json.artifact.data.nodes.length === 13, 'a mind map request is still answered with a mind map (32768 tokens, own schema)', r.text.slice(0, 160));
    const gbm = (await gcalls()).at(-1).body; t(gbm.generationConfig.maxOutputTokens === 32768 && gbm.generationConfig.responseJsonSchema.properties.nodes && !gbm.generationConfig.responseJsonSchema.properties.questions, 'its Gemini call carries the mind map schema');
    await queue('valid'); r = await post('student-tools-v2', freq(), H);
    t(r.json && r.json.ok === true && r.json.artifact.tool === 'flashcards' && r.json.artifact.data.cards.length === 30, 'a flashcards request is still answered with a deck (12288 tokens, own schema)', r.text.slice(0, 160));
    const gbf = (await gcalls()).at(-1).body; t(gbf.generationConfig.maxOutputTokens === 12288 && gbf.generationConfig.responseJsonSchema.properties.cards && !gbf.generationConfig.responseJsonSchema.properties.questions, 'its Gemini call carries the flashcards schema'); }

  const fin = (await execs()).slice(startExecs);
  const errs = fin.filter((e) => e.status === 'error' || e.status === 'crashed');
  t(errs.length === 0, 'no execution failed during the whole quiz run', errs.map((e) => [e.id, e.status]));
  console.log(`\nE2E quiz: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E quiz crashed', e); process.exit(2); });
