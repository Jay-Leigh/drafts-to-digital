// End-to-end checks for the Study Studio mind map branch against a real n8n 2.29.7 running the imported v3 test copy
// (external HTTP -> mock; real Redis on 6390). Needs the test copy built with STUDIO_TEST_TIMEOUT_MS=6000
// (reload.sh v3-studio): only the Gemini call timeout constant is shortened, so a hanging Gemini can be tested.
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
const reset = async () => { await fetch(M + '/_reset'); };
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
  mode: 'studio_mindmap', v: 1, requestId: 'f_1761580000000_ab12cd', tool: 'mindmap', language: { code: 'en', name: 'English' }, options: {}, description: 'Focus on Theme 1',
  sources: [{ id: 'S1', name: 'Book.pdf', kind: 'pdf', markers: 'page', pages: 3, tokens: 30, text: '[Page 1]\nalpha beta\n\n[Page 2]\ngamma delta\n\n[Page 3]\nepsilon' }], clientEstimate: 30, promptVersion: 'studio-2026-11-a', ...extra,
});

(async () => {
  await reset(); await setKey('auth:code', 'letmein');
  const login = async (ip) => (await post('student-tools-auth', { code: 'letmein' }, { 'x-forwarded-for': '6.6.6.6, ' + ip })).json.token;
  const tok = await login('21.1.1.1'); const H = { authorization: 'Bearer ' + tok };
  const startExecs = (await execs()).length;
  const S = (r) => r.json;

  console.log('[studio: authentication]');
  let r = await post('student-tools-v2', req()); t(r.status === 401, 'no token -> 401', r.status);
  r = await post('student-tools-v2', req(), { authorization: 'Bearer garbage' }); t(r.status === 403, 'garbage token -> 403', r.status);
  r = await post('student-tools-v2', req(), { authorization: 'Bearer ' + jwt.sign({ sub: 'sth' }, 'other-secret-xxxxxxxxxxxxxxxxxxxx') }); t(r.status === 403, 'wrong-secret token -> 403', r.status);
  t((await gcalls()).length === 0 && usageNow() === 0, 'unauthenticated requests: no Gemini call, no usage');

  console.log('[studio: success path]');
  await reset(); await setKey('auth:code', 'letmein');
  r = await post('student-tools-v2', req(), H);
  const a = r.json && r.json.artifact;
  t(r.status === 200 && r.json.ok === true && Object.keys(r.json).join() === 'ok,artifact', 'HTTP 200 {ok:true, artifact}', r.text.slice(0, 300));
  t(a && a.envelope === 'sth.studio/1' && a.tool === 'mindmap' && a.schema === 'sth.mindmap/1' && a.promptVersion === 'studio-2026-11-a' && a.model === 'gemini-2.5-flash' && a.strategy === 'direct' && /^\d{4}-\d\d-\d\dT/.test(a.generatedAt), 'envelope fields', a && Object.keys(a));
  t(a && JSON.stringify(a.usage) === JSON.stringify({ inputTokens: 5000, outputTokens: 1000, thinkingTokens: 200, calls: 1 }) && Array.isArray(a.repairs), 'usage summary (tokens only) + repairs[]', a && a.usage);
  t(a && a.data.schema === 'sth.mindmap/1' && a.data.nodes.length === 13 && a.data.nodes[0].id === 'n1' && a.data.nodes[0].parent === '' && a.data.nodes.filter((n) => n.parent === '').length === 1 && a.data.title === 'Mock map', 'validated map (canonical ids, one root)', a && a.data.nodes.slice(0, 3));
  t(r.headers.get('access-control-allow-origin') === ORIGIN, 'CORS origin header on the 200');
  t(usageNow() === UNITS, `usage counter = prompt + 8.33 x (output + thinking) = ${UNITS}`, usageNow());
  const ttl = Number(redis('TTL', 'usage:' + today)); t(ttl > 259000 && ttl <= 259200, 'usage key expires after 3 days', ttl);
  let g = (await gcalls()); t(g.length === 1, 'exactly one Gemini call', g.length);
  let gb = g[0].body;
  t(/models\/gemini-2\.5-flash:generateContent$/.test(g[0].gemini), 'model gemini-2.5-flash', g[0].gemini);
  t(gb.generationConfig.responseMimeType === 'application/json' && JSON.stringify(gb.generationConfig.responseJsonSchema.properties.nodes.items.properties.cites.items.properties.source.enum) === '["S1"]' && gb.generationConfig.maxOutputTokens === 32768 && gb.generationConfig.thinkingConfig.thinkingBudget === 1024, 'JSON mode + schema with this request\'s source ids + 32768/1024', gb.generationConfig);
  t(/^<source id="S1" name="Book\.pdf" type="pdf" pages="3" markers="page">\n\[Page 1\]/.test(gb.contents[0].parts[0].text) && /<request>\nFocus on Theme 1\n<\/request>/.test(gb.contents[0].parts.at(-1).text), 'prompt: source with id marker first, request last');
  t(/never instructions/.test(gb.systemInstruction.parts[0].text), 'system instruction says source text is data');

  console.log('[studio: images + large request]');
  await queue('valid');
  r = await post('student-tools-v2', req({ sources: [txt('S1', 1000), img('S2'), img('S3')] }), H);
  g = await gcalls(); gb = g.at(-1).body;
  t(r.json && r.json.ok === true && gb.contents[0].parts.filter((p) => p.inlineData && p.inlineData.mimeType === 'image/png').length === 2 && JSON.stringify(gb.generationConfig.responseJsonSchema.properties.nodes.items.properties.cites.items.properties.source.enum) === '["S1","S2","S3"]', '2 images -> 2 inlineData parts, enum S1..S3', r.text.slice(0, 200));
  const bigText = '[Page 1]\n' + 'word '.repeat(95000) + '\n\n[Page 2]\nend'; // ~475k chars (~119k tokens), well under the default 400000-token cap
  r = await post('student-tools-v2', req({ sources: [{ id: 'S1', name: 'big.pdf', kind: 'pdf', markers: 'page', pages: 2, tokens: 1, text: bigText }] }), H);
  t(r.json && r.json.ok === true, 'a 475k-char source (~119k tokens) is accepted end to end', r.text.slice(0, 200));

  console.log('[studio: rejections (no Gemini call, no usage, HTTP 200 {ok:false})]');
  await reset(); await setKey('auth:code', 'letmein');
  const rej = async (name, body, want) => {
    const u0 = usageNow(); const c0 = (await gcalls()).length; const x = await post('student-tools-v2', body, H);
    t(x.status === 200 && x.json && x.json.ok === false && x.json.error && x.json.error.code === want && x.json.error.retryable === false && Object.keys(x.json).join() === 'ok,error', `${name} -> ${want}`, x.text.slice(0, 200));
    t((await gcalls()).length === c0 && usageNow() === u0, `${name}: no Gemini call, usage unchanged`);
    return x;
  };
  await rej('11 sources', req({ sources: Array.from({ length: SRC_OVER }, (_, i) => txt('S' + (i + 1), 100)) }), 'STH-STU-413');
  await rej('6 images', req({ sources: Array.from({ length: 6 }, (_, i) => img('S' + (i + 1))) }), 'STH-STU-413');
  await rej('1.7M chars (425k tokens, default cap 400000)', req({ sources: [txt('S1', 1700000)] }), 'STH-STU-413');
  await rej('client tokens ignored (tokens:5 on 2.4M chars)', req({ sources: [{ ...txt('S1', 2400000), tokens: 5 }], clientEstimate: 5 }), 'STH-STU-413');
  await rej('description 1001 chars', req({ description: 'd'.repeat(1001) }), 'STH-STU-413');
  await rej('v 2', req({ v: 2 }), 'STH-INPUT-400');
  await rej('tool quiz', req({ tool: 'quiz' }), 'STH-INPUT-400');
  await rej('language xx', req({ language: { code: 'xx', name: 'Klingon' } }), 'STH-INPUT-400');
  await rej('no sources', req({ sources: [] }), 'STH-INPUT-400');
  await rej('duplicate source ids', req({ sources: [txt('S1', 10), txt('S1', 10)] }), 'STH-INPUT-400');
  { const x = await post('student-tools-v2', { mode: 'studio_mindmap' }, H); t(x.status === 200 && x.json.ok === false && x.json.error.code === 'STH-INPUT-400', 'bare {mode} -> STH-INPUT-400 (no crash)', x.text.slice(0, 200)); }

  console.log('[studio: owner-set token cap cfg:studio_max_tokens]');
  { await reset(); await setKey('auth:code', 'letmein');
    const capRej = async (name, body, wantMax) => { const c0 = (await gcalls()).length; const u0 = usageNow(); const x = await post('student-tools-v2', body, H);
      t(x.status === 200 && x.json && x.json.ok === false && x.json.error.code === 'STH-STU-413' && x.json.error.reason === 'too_much_material' && x.json.error.retryable === false && x.json.error.maxTokens === wantMax && Object.keys(x.json.error).join() === 'code,retryable,reason,maxTokens', `${name}: 413 too_much_material with maxTokens ${wantMax}`, x.text.slice(0, 220));
      t((await gcalls()).length === c0 && usageNow() === u0, `${name}: no Gemini call, usage unchanged`); };
    const capOk = async (name, body) => { await queue('valid'); const x = await post('student-tools-v2', body, H); t(x.json && x.json.ok === true, `${name}: accepted`, x.text.slice(0, 200)); return x; };
    await capRej('key unset, 425k tokens', req({ sources: [txt('S1', 1700000)] }), 400000);
    await capOk('key unset, 390k tokens', req({ sources: [txt('S1', 1560000)] }));
    await setKey('cfg:studio_max_tokens', '800000');
    await capOk('key 800000, 700k tokens', req({ sources: [txt('S1', 2800000)] }));
    await capRej('key 800000, 820k tokens', req({ sources: [txt('S1', 3280000)] }), 800000);
    await setKey('cfg:studio_max_tokens', '2000000');
    await capRej('key 2000000 (clamped to 900000), 950k tokens', req({ sources: [txt('S1', 3800000)] }), 900000);
    await setKey('cfg:studio_max_tokens', '300');
    await capRej('key 300 (clamped up to 50000), 55k tokens', req({ sources: [txt('S1', 220000)] }), 50000);
    await capOk('key 300, 45k tokens', req({ sources: [txt('S1', 180000)] }));
    for (const junk of ['abc', '12.5', '-5', '']) { await setKey('cfg:studio_max_tokens', junk); await capRej(`key ${JSON.stringify(junk)} (invalid -> default)`, req({ sources: [txt('S1', 1700000)] }), 400000); }
    redis('DEL', 'cfg:studio_max_tokens');
    await capRej('key deleted again', req({ sources: [txt('S1', 1700000)] }), 400000);
    const x = await post('student-tools-v2', req({ description: 'd'.repeat(1001) }), H); t(x.json && x.json.error.reason === 'description_too_long' && !('maxTokens' in x.json.error), 'maxTokens only on too_much_material');
    // Redis down: the cap read fails open to the default
    await fetch(M + '/_down?on=1'); const dn = await post('student-tools-v2', req({ sources: [txt('S1', 1700000)] }), H); await fetch(M + '/_down?on=0');
    t(dn.json && dn.json.ok === false && dn.json.error.maxTokens === 400000, 'Redis down: default cap 400000 applies', dn.text.slice(0, 200));
  }

  console.log('[studio: large requests (> 300000 tokens) are never retried on a timeout or 5xx; smaller ones still are]');
  { await reset(); await setKey('auth:code', 'letmein'); await setKey('cfg:studio_max_tokens', '800000');
    const big = () => req({ sources: [txt('S1', 1400000)] }); // 350000 tokens
    const small = () => req({ sources: [txt('S1', 1000000)] }); // 250000 tokens
    for (const fx of ['503,valid', '500,valid', '504,valid', 'empty,valid']) {
      await reset(); await setKey('auth:code', 'letmein'); await setKey('cfg:studio_max_tokens', '800000');
      await queue(fx); r = await post('student-tools-v2', big(), H); let c = await gcalls();
      t(c.length === 1 && r.json && r.json.ok === false && (r.json.error.code === 'STH-STU-409' || r.json.error.code === 'STH-STU-422') && usageNow() === (fx.startsWith('empty') ? UNITS : 0), `350k tokens, ${fx.split(',')[0]} first: exactly ONE Gemini call (no retry)`, { n: c.length, r: r.text.slice(0, 160) });
      await reset(); await setKey('auth:code', 'letmein'); await setKey('cfg:studio_max_tokens', '800000');
      await queue(fx); r = await post('student-tools-v2', small(), H); c = await gcalls();
      t(c.length === 2 && r.json && r.json.ok === true, `250k tokens, ${fx.split(',')[0]} first: retried, second call succeeds`, { n: c.length, r: r.text.slice(0, 160) });
    }
    await reset(); await setKey('auth:code', 'letmein'); await setKey('cfg:studio_max_tokens', '800000');
    await queue('hang:20000,valid'); r = await post('student-tools-v2', big(), H); let c2 = await gcalls();
    t(c2.length === 1 && r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.ms < 19000 && usageNow() === 0, '350k tokens, Gemini timeout: ONE call only, STH-STU-409, nothing metered', { n: c2.length, ms: r.ms, r: r.text.slice(0, 160) });
    await sleep(15000);
    await reset(); await setKey('auth:code', 'letmein'); await setKey('cfg:studio_max_tokens', '800000');
    await queue('429,valid'); r = await post('student-tools-v2', big(), H); c2 = await gcalls();
    t(c2.length === 2 && r.json && r.json.ok === true, '350k tokens, 429 first: still retried once', { n: c2.length, r: r.text.slice(0, 160) });
    await reset(); await setKey('auth:code', 'letmein'); await setKey('cfg:studio_max_tokens', '800000');
    await queue('429,429,valid'); r = await post('student-tools-v2', big(), H); c2 = await gcalls();
    t(c2.length === 2 && r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409', '350k tokens, 429 twice: only one retry, then STH-STU-409', { n: c2.length, r: r.text.slice(0, 160) });
    await reset(); await setKey('auth:code', 'letmein'); await setKey('cfg:studio_max_tokens', '800000');
    await queue('valid'); r = await post('student-tools-v2', req({ sources: [txt('S1', 3000000)] }), H);
    t(r.json && r.json.ok === true && usageNow() === UNITS && r.json.artifact.usage.calls === 1, '750k tokens: one call, metering formula unchanged', usageNow());
  }

  console.log('[studio: model output problems -> STH-STU-422]');
  const bad = async (fx, reasonWant, billed) => {
    await queue(fx); const u0 = usageNow(); const c0 = (await gcalls()).length; const x = await post('student-tools-v2', req(), H);
    t(x.status === 200 && x.json.ok === false && x.json.error.code === 'STH-STU-422' && x.json.error.retryable === true && x.json.error.reason === reasonWant, `${fx} -> STH-STU-422 (${reasonWant})`, x.text.slice(0, 200));
    t((await gcalls()).length - c0 === 1, `${fx}: exactly one Gemini call (no blind retry of unusable output)`);
    t(usageNow() - u0 === (billed ? UNITS : 0), `${fx}: Gemini billed this call -> usage ${billed ? '+' + UNITS : 'unchanged'}`, usageNow() - u0);
  };
  await bad('truncated', 'truncated', true);
  await bad('cutstop', 'parse', true);
  await bad('prose', 'parse', true);
  await bad('invalid', 'too_few_nodes', true);

  console.log('[studio: blocked content, repairs, plain-text labels]');
  await queue('safety'); r = await post('student-tools-v2', req(), H); t(r.json && r.json.ok === false && r.json.error.code === 'STH-AI-451' && r.json.error.retryable === false, 'SAFETY -> STH-AI-451', r.text.slice(0, 200));
  await queue('recitation'); r = await post('student-tools-v2', req(), H); t(r.json && r.json.ok === false && r.json.error.code === 'STH-AI-452', 'RECITATION -> STH-AI-452', r.text.slice(0, 200));
  await queue('html'); r = await post('student-tools-v2', req(), H);
  t(r.json && r.json.ok === true && r.json.artifact.data.nodes.some((n) => n.label === '<img src=x onerror=alert(1)>') && r.json.artifact.data.nodes.some((n) => n.label === '<script>alert(1)</script>'), 'markup in labels is returned as plain text, unchanged', r.text.slice(0, 200));
  await queue('wrongsrc'); r = await post('student-tools-v2', req(), H);
  { const th = r.json && r.json.artifact && r.json.artifact.data.nodes.find((n) => n.label === 'Theme 1');
    t(th && th.cites.length === 1 && th.cites[0].source === 'S1' && th.cites[0].page === 0 && r.json.artifact.repairs.some((x) => /unknown sources/.test(x)) && r.json.artifact.repairs.some((x) => /page numbers/.test(x)), 'citation to a source that is not in the request dropped; page beyond the source reset to 0; repairs listed', th && th.cites); }

  console.log('[studio: retries, fallback model, schema fallback]');
  { await reset(); await setKey('auth:code', 'letmein');
    await queue('429,valid'); let t0 = Date.now(); r = await post('student-tools-v2', req(), H); let c = await gcalls();
    t(r.json && r.json.ok === true && c.length === 2 && r.json.artifact.usage.calls === 2 && r.json.artifact.model === 'gemini-2.5-flash', '429 then OK: second call succeeds on flash', { n: c.length, m: r.json && r.json.artifact && r.json.artifact.model });
    t(usageNow() === UNITS, 'only the answered attempt is metered (429 is not billed)', usageNow());
    await reset(); await setKey('auth:code', 'letmein');
    await queue('429,429,valid'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === true && c.length === 3 && /gemini-2\.5-flash:generateContent$/.test(c[0].gemini) && /gemini-2\.5-flash:generateContent$/.test(c[1].gemini) && /gemini-2\.5-flash-lite:generateContent$/.test(c[2].gemini) && r.json.artifact.model === 'gemini-2.5-flash-lite' && r.json.artifact.usage.calls === 3, 'flash-lite fallback only on the third (last) attempt; envelope records the model used', c.map((x) => x.gemini));
    await reset(); await setKey('auth:code', 'letmein');
    await queue('500,500,500'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.status === 200 && r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.json.error.retryable === true && c.length === 3 && usageNow() === 0, '500 x3 -> STH-STU-409 after exactly 3 calls, nothing metered', { code: r.json && r.json.error, n: c.length });
    await reset(); await setKey('auth:code', 'letmein');
    await queue('429,429,429'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && c.length === 3 && usageNow() === 0, '429 x3 -> STH-STU-409, nothing metered', r.text.slice(0, 200));
    await reset(); await setKey('auth:code', 'letmein');
    await queue('empty,empty,empty'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-422' && r.json.error.reason === 'empty' && c.length === 3, 'empty replies are retried, then STH-STU-422', { n: c.length, r: r.text.slice(0, 120) });
    await reset(); await setKey('auth:code', 'letmein');
    await queue('schema400'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === true && c.length === 2 && c[0].body.generationConfig.responseJsonSchema && !c[0].body.generationConfig.responseSchema && c[1].body.generationConfig.responseSchema && !c[1].body.generationConfig.responseJsonSchema && c[1].body.generationConfig.responseSchema.type === 'OBJECT' && c[1].body.generationConfig.responseMimeType === 'application/json', 'HTTP 400 on responseJsonSchema -> retried with responseSchema (OpenAPI subset)', c.map((x) => Object.keys(x.body.generationConfig)));
    await reset(); await setKey('auth:code', 'letmein');
    await queue('400,400'); r = await post('student-tools-v2', req(), H); c = await gcalls();
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-422' && c.length === 2, 'both schema variants rejected -> STH-STU-422 after 2 calls', { n: c.length, r: r.text.slice(0, 150) });
    await reset(); await setKey('auth:code', 'letmein');
    await queue('slow:3000'); t0 = Date.now(); r = await post('student-tools-v2', req(), H);
    t(r.json && r.json.ok === true && r.ms >= 2900 && (await gcalls()).length === 1, 'a slow (3 s) Gemini answer is simply waited for', r.ms);
  }

  console.log('[studio: hanging Gemini (call timeout 6 s in this test copy)]');
  { await reset(); await setKey('auth:code', 'letmein');
    await queue('hang:20000,valid'); const t0 = Date.now(); r = await post('student-tools-v2', req(), H); const c = await gcalls();
    t(r.json && r.json.ok === true && r.ms >= 5800 && r.ms < 19000 && c.length === 2 && r.json.artifact.usage.calls === 2, 'node timeout from the item fires at ~6 s (not 20 s); the retry then succeeds', { ms: r.ms, n: c.length });
    t(usageNow() === UNITS, 'timed-out attempt not metered');
    await reset(); await setKey('auth:code', 'letmein');
    await queue('hang:20000,hang:20000,hang:20000'); r = await post('student-tools-v2', req(), H);
    t(r.json && r.json.ok === false && r.json.error.code === 'STH-STU-409' && r.ms < 60000, 'three hangs -> STH-STU-409', { ms: r.ms, r: r.text.slice(0, 150) });
    await sleep(15000); // let the mock's late replies drain
  }

  console.log('[studio: daily ceiling (existing cost meter)]');
  { await reset(); await setKey('auth:code', 'letmein');
    await queue('valid'); r = await post('student-tools-v2', req(), H); t(r.json.ok === true && usageNow() === UNITS, 'no cfg:daily_units -> allowed');
    await setKey('cfg:daily_units', String(UNITS + 1)); const c0 = (await gcalls()).length;
    r = await post('student-tools-v2', req(), H); t(r.json.ok === true, 'usage below the ceiling -> allowed (the call may overshoot it)', r.text.slice(0, 150));
    t(usageNow() === 2 * UNITS && usageNow() >= UNITS + 1, 'second call metered too (overshoot is possible by one call)', usageNow());
    const c1 = (await gcalls()).length; r = await post('student-tools-v2', req(), H);
    t(r.status === 200 && JSON.stringify(r.json) === '{"ok":false,"error":{"code":"STH-QUOTA-430","retryable":false}}', 'ceiling reached -> {ok:false,error:{code:STH-QUOTA-430,retryable:false}} (same as the other modes)', r.text);
    t((await gcalls()).length === c1 && usageNow() === 2 * UNITS, 'ceiling reached: no Gemini call, usage unchanged');
    await setKey('cfg:daily_units', '0'); r = await post('student-tools-v2', req(), H); t(r.json.error && r.json.error.code === 'STH-QUOTA-430', 'cfg:daily_units 0 = kill switch for Studio too');
    redis('DEL', 'cfg:daily_units'); r = await post('student-tools-v2', req(), H); t(r.json.ok === true, 'DEL cfg:daily_units lifts the ceiling');
    await setKey('cfg:daily_units', '1'); const e0 = (await execs()).length; r = await post('student-tools-v2', req({ v: 9 }), H); t(r.json.error && (r.json.error.code === 'STH-QUOTA-430'), 'ceiling is checked before the request is looked at (same place as the other Gemini modes)', r.text.slice(0, 100));
    redis('DEL', 'cfg:daily_units');
    await fetch(M + '/_down?on=1'); r = await post('student-tools-v2', req(), H); await fetch(M + '/_down?on=0');
    t(r.json && r.json.ok === true, 'Redis down: the ceiling read and the meter are fail-open, the map is still made', r.text.slice(0, 150));
  }

  console.log('[studio: no request text in errors, e-mails or error responses]');
  { await reset(); await setKey('auth:code', 'letmein');
    const MARK = 'ZZSECRETSOURCEZZ' + 'q'.repeat(30); const e0 = (await execs()).length;
    const secret = (extra = {}) => req({ description: MARK + ' description', sources: [{ id: 'S1', name: MARK + '.pdf', kind: 'pdf', markers: 'page', pages: 1, tokens: 1, text: '[Page 1]\n' + MARK + ' body text of the student' }], ...extra });
    const bodies = [];
    for (const fx of ['500,500,500', '429,429,429', 'truncated', 'prose', 'safety', 'hang:20000,hang:20000,hang:20000', 'valid']) { await queue(fx); const x = await post('student-tools-v2', secret(), H); bodies.push(x.text); }
    for (const bad of [secret({ v: 2 }), secret({ sources: Array.from({ length: SRC_OVER + 1 }, (_, i) => txt('S' + (i + 1), 50, { text: MARK })) }), secret({ language: { code: MARK } })]) bodies.push((await post('student-tools-v2', bad, H)).text);
    await sleep(2500);
    const ex = (await execs()).slice(e0);
    const failed = bodies.filter((b) => !b.includes('"artifact"'));
    t(failed.length === 9 && failed.every((b) => !b.includes('ZZSECRET')), 'no error response contains request text', failed.map((b) => b.slice(0, 80)));
    t(ex.length >= 10 && ex.every((e) => e.status !== 'error' && e.status !== 'crashed'), 'no Studio execution ended in error', ex.map((e) => e.status));
    t(!ex.some((e) => e.run['Error Trigger'] || e.run['Format Workflow Error1'] || e.run['Send Workflow Error Email1'] || e.run['Handle Error Report1']), 'no error e-mail path was triggered by any Studio failure');
    const mails = ex.filter((e) => e.run['Send Workflow Error Email1'] || e.run['Send Error Email1']); t(mails.length === 0, 'no e-mail node ran');
    // the saved data of the Studio nodes that handle failures holds no text from the request (test copy saves everything)
    const noText = ex.filter((e) => e.run['Studio - Validate'] || e.run['Studio - Reject']).every((e) => ['Studio - Validate', 'Studio - Reject', 'Studio - Respond', 'Studio - Retry Check'].every((n) => !e.run[n] || !JSON.stringify(e.run[n]).includes('ZZSECRET') || n === 'Studio - Retry Check'));
    t(noText, 'Studio - Validate / Reject / Respond outputs hold no request text');
    const st = await state(); t(!JSON.stringify(st.log.filter((l) => l.cmd)).includes('ZZSECRET'), 'no Redis command carried request text');
  }

  console.log('[tutor: [Page N] markers in the chunker (v3)]');
  { await reset(); await setKey('auth:code', 'letmein');
    for (const [label, mk] of [['[Page N]', (n) => `[Page ${n}]`], ['[Scan page N]', (n) => `[Scan page ${n}]`]]) {
      let doc = ''; for (let p = 1; p <= 60; p++) doc += `${mk(p)}\n\n` + ('filler words about nothing in particular. '.repeat(120)).slice(0, 4900) + (p === 7 ? ' The zebra migration happens in March.' : '') + '\n\n';
      const x = await post('student-tools-v2', { mode: 'tutor', chatId: 'pg-' + label.length, messages: [{ role: 'user', text: 'Tell me about the zebra migration' }], cachableContext: [{ name: 'book.pdf', content: doc }], attachedContext: [], documentFingerprints: [] }, H);
      const gb = (await gcalls()).at(-1).body; const txtAll = gb.contents[0].parts.map((p) => p.text || '').join('\n');
      t(x.json && x.json.result === 'MOCK GEMINI REPLY' && /### book\.pdf \(scan page \d+\)/.test(txtAll) && /zebra migration/.test(txtAll), `tutor retrieval labels excerpts with a page from ${label} markers`, txtAll.slice(0, 200));
    }
    const sys = (await gcalls()).at(-1).body.system_instruction.parts[0].text;
    t(/Study Studio, use the path to understand the scope, answer from the attached material, and cite pages as "p\. N"\. For a hint request, do not reveal the answer\./.test(sys) && /chill upperclassman/.test(sys), 'server tutor persona carries the study-aid handoff sentence');
  }

  const fin = (await execs()).slice(startExecs);
  const errs = fin.filter((e) => e.status === 'error' || e.status === 'crashed');
  t(errs.length === 0, 'no execution failed during the whole Studio run', errs.map((e) => [e.id, e.status]));
  console.log(`\nE2E studio: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('E2E studio crashed', e); process.exit(2); });
