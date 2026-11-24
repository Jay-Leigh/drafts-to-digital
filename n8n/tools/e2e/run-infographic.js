// End-to-end checks of the infographic (v7) against a real n8n 2.29.7 running the imported v7 test copy (external HTTP -> mock; real Redis on 6390).
//   node e2e/run-infographic.js   after: STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v7-bundle
const L = require('./lib7');
const { t, post, reset, queue, redis, usageNow, gcalls, login, mkJob, hdr, create, op, waitState, errOf, execs, sleep } = L;
const UNITS = Math.round(5000 + 8.33 * 1200); // mock usage: prompt 5000, output 1000, thinking 200
const strip = (j) => { const c = JSON.parse(JSON.stringify(j)); if (c.artifact) delete c.artifact.generatedAt; return JSON.stringify(c); };
const txt = (id, n, extra = {}) => ({ id, name: id + '.txt', kind: 'txt', markers: 'none', tokens: 1, text: 'lorem ipsum '.repeat(Math.ceil(n / 12)).slice(0, n), ...extra });

(async () => {
  await reset(); const H = hdr(await login('72.1.1.1'));
  console.log('[infographic: auth and success path]');
  let r = await post('student-tools-v2', L.igBody()); t(r.status === 401, 'no token -> 401');
  await queue('valid'); const u0 = usageNow(); r = await post('student-tools-v2', L.igBody(), H);
  const a = r.json && r.json.artifact;
  t(r.status === 200 && r.json.ok === true && a.envelope === 'sth.studio/1' && a.tool === 'infographic' && a.schema === 'sth.infographic/1' && a.strategy === 'direct' && a.promptVersion === 'studio-2026-12-a' && a.model === 'gemini-2.5-flash' && a.usage.calls === 1 && a.repairs.length === 0, 'artifact envelope: tool, schema, strategy direct, promptVersion 2026-12, 1 call, no repairs', r.text.slice(0, 300));
  t(a.data.layout === 'steps' && a.data.items.length === 5 && a.data.items[0].icon === 'book' && a.data.figures.length === 1 && a.data.figures[0].verified === true && a.data.figures[0].value === '1945' && a.data.schema === 'sth.infographic/1', 'data: 5 items, icon, one verified figure');
  t(usageNow() - u0 === UNITS, `metered ${UNITS} units (prompt + 8.33 x (output + thinking))`, usageNow() - u0);
  const gb = (await gcalls()).at(-1).body; const gcfg = gb.generationConfig;
  t(gcfg.responseMimeType === 'application/json' && gcfg.maxOutputTokens === 8192 && gcfg.temperature === 0.3 && gcfg.responseJsonSchema.properties.layout.enum.length === 4 && gcfg.responseJsonSchema.properties.items.items.properties.icon.enum.length === 32, 'Gemini request: JSON mode, 8192 output, 4 layouts, 32 icons');
  t(/layout: auto/.test(gb.contents[0].parts.at(-1).text) && gb.contents[0].parts[0].text.includes('The war began in 1939'), 'prompt: layout auto in the settings, the source text as data');
  console.log('[infographic: options, sources]');
  for (const lay of ['timeline', 'comparison', 'facts', 'steps']) { r = await post('student-tools-v2', L.igBody({ options: { layout: lay } }), H); const g = (await gcalls()).at(-1).body.generationConfig.responseJsonSchema.properties.layout.enum; t(r.json.ok === true && g.join() === lay && r.json.artifact.data.layout === lay, `layout ${lay}: the schema enum is narrowed to it, the answer uses it`, r.text.slice(0, 160)); }
  r = await post('student-tools-v2', L.igBody({ options: { layout: 'circle' } }), H); t(r.json.ok === false && r.json.error.code === 'STH-INPUT-400' && r.json.error.reason === 'options', 'wrong layout -> STH-INPUT-400 options');
  r = await post('student-tools-v2', L.igBody({ mode: 'studio_slides' }), H); t(r.json.error.reason === 'version_or_tool', 'mode / tool mismatch');
  r = await post('student-tools-v2', L.igBody({ sources: Array.from({ length: 16 }, (_, i) => txt('S' + (i + 1), 100)) }), H); t(r.json.error.code === 'STH-STU-413' && r.json.error.reason === 'too_many_sources', '16 sources -> too_many_sources');
  r = await post('student-tools-v2', L.igBody({ sources: Array.from({ length: 15 }, (_, i) => txt('S' + (i + 1), 100)) }), H); t(r.json.ok === true && (await gcalls()).at(-1).body.generationConfig.responseJsonSchema.properties.items.items.properties.cites.items.properties.source.enum.length === 15, '15 sources accepted; the citation enum has 15 ids');
  r = await post('student-tools-v2', L.igBody({ sources: [txt('S1', 1700000)] }), H); t(r.json.error.reason === 'too_much_material' && r.json.error.maxTokens === 400000, 'above the cap: too_much_material with maxTokens');
  console.log('[infographic: repairs by the number check]');
  const run = async (fx, body = L.igBody()) => { await queue(fx); return (await post('student-tools-v2', body, H)).json; };
  let j = await run('badfigure'); t(j.ok === true && j.artifact.data.figures.length === 0 && j.artifact.repairs.some((x) => /removed 1 numbers that could not be checked/.test(x)), 'a figure whose number is not in its quote is removed (and listed)', j.artifact && j.artifact.repairs);
  j = await run('badnumber'); t(j.ok === true && j.artifact.data.items.length === 4 && !JSON.stringify(j.artifact.data).includes('80 million') && j.artifact.repairs.some((x) => /removed 1 items with a number that could not be checked/.test(x)), 'an item with a number that is not in the source is removed', j.artifact && j.artifact.repairs);
  j = await run('xss'); t(j.ok === true && j.artifact.data.items[0].heading === '<svg onload=alert(1)>' && j.artifact.data.items[0].icon === 'dot' && j.artifact.repairs.some((x) => /replaced 1 unknown icons/.test(x)), 'markup stays characters; an unknown icon becomes dot', j.artifact && j.artifact.data.items[0]);
  j = await run('fewitems'); t(j.ok === false && j.error.code === 'STH-STU-422' && j.error.reason === 'too_few_items' && j.error.retryable === true, '2 items -> STH-STU-422 too_few_items');
  j = await run('truncated'); t(j.error.code === 'STH-STU-422' && j.error.reason === 'truncated', 'cut-off answer -> truncated (no salvage)');
  j = await run('prose'); t(j.error.reason === 'parse', 'prose -> parse');
  j = await run('safety'); t(j.error.code === 'STH-AI-451', 'safety -> STH-AI-451'); j = await run('recitation'); t(j.error.code === 'STH-AI-452', 'recitation -> STH-AI-452');
  const gc0 = (await gcalls()).length; j = await run('schema400,valid'); t(j.ok === true && (await gcalls()).length - gc0 === 2 && (await gcalls()).at(-1).body.generationConfig.responseSchema.properties.items && !(await gcalls()).at(-1).body.generationConfig.responseJsonSchema, 'HTTP 400 -> the same request with the OpenAPI schema variant');
  j = await run('429,valid'); t(j.ok === true && j.artifact.usage.calls === 2, 'a 429 is repeated once');
  // no request text in errors
  { const MARK = 'ZZSECRETSOURCEZZ' + 'q'.repeat(30); const e0 = (await execs()).length; const bodies = [];
    const secret = (extra = {}) => L.igBody({ description: MARK + ' d', sources: [{ id: 'S1', name: MARK + '.pdf', kind: 'pdf', markers: 'page', text: '[Page 1]\n' + MARK + ' body' }], ...extra });
    for (const fx of ['500', '429,429', 'truncated', 'prose', 'safety', 'fewitems']) { await queue(fx); bodies.push((await post('student-tools-v2', secret(), H)).text); }
    for (const bad of [secret({ v: 2 }), secret({ options: { layout: MARK } })]) bodies.push((await post('student-tools-v2', bad, H)).text);
    await sleep(1500); const ex = (await execs()).slice(e0);
    t(bodies.every((b) => !b.includes('ZZSECRET')) && ex.every((e) => e.status !== 'error' && e.status !== 'crashed') && !ex.some((e) => e.run['Error Trigger']), 'no error response or execution carries request text; no error path triggered'); }
  console.log('[infographic: as a job]');
  await reset(); H.authorization = 'Bearer ' + (await login('72.1.2.2')); await queue('valid');
  const jf = mkJob('studio_infographic'); const t0 = Date.now(); r = await create(jf, L.igBody(), H);
  t(r.status === 200 && r.text === '{"ok":true,"accepted":true}' && Date.now() - t0 < 3000, 'create answers at once');
  let s = await waitState(jf, H); t(s.state === 'succeeded' && s.attempt === 1 && s.resultBytes > 500, 'job succeeded', s);
  const sync = await post('student-tools-v2', L.igBody(), H); r = await op('result', [jf], H);
  t(r.json.ok === true && r.json.mode === 'studio_infographic' && strip(r.json.result) === strip(sync.json), 'stored answer == the sync answer (except generatedAt)');
  const rec = L.hgetall('sth:job:' + jf.id); t(rec.m === 'studio_infographic' && rec.st === 'succeeded' && Number(redis('TTL', 'sth:job:' + jf.id)) > 259000, 'record: mode, state, 72 h');
  await op('ack', [jf], H);
  await queue('truncated'); const jx = mkJob('studio_infographic'); await create(jx, L.igBody(), H); s = await waitState(jx, H); t(s.state === 'failed' && errOf(s) === 'STH-STU-422' && s.error.reason === 'truncated', 'a failed answer is stored as a failed job with its code and reason', s);
  await queue('valid'); const jr = mkJob('studio_infographic'); await create(jr, { ...L.igBody(), mode: 'studio_slides', tool: 'slides' }, H); s = await waitState(jr, H); t(s.state === 'failed' && errOf(s) === 'STH-INPUT-400', 'mode in the body must equal the job mode', s);
  const jq = mkJob('studio_infographic'), jq2 = mkJob('studio_infographic'); await queue('', 'slow:3000'); await create(jq, L.igBody(), H); await create(jq2, L.igBody(), H); await sleep(800);
  s = await waitState(jq2, H, ['rejected', 'running', 'succeeded'], 8000); t(s.state === 'rejected' && errOf(s) === 'STH-JOB-429', 'cap 1 per mode: a 2nd infographic job is busy (STH-JOB-429)', s); await waitState(jq, H); await queue('', 'valid');
  const bad = (await execs()).filter((e) => e.status === 'crashed'); t(bad.length === 0, 'no crashed execution');
  L.done('E2E infographic');
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
