// End-to-end checks of the slide deck (v7). Same set-up as run-infographic.js.
//   node e2e/run-slides.js   after: STUDIO_TEST_TIMEOUT_MS=6000 e2e/reload.sh v7-bundle
const L = require('./lib7');
const { t, post, reset, queue, usageNow, gcalls, login, mkJob, hdr, create, op, waitState, errOf, execs, sleep } = L;
const UNITS = Math.round(5000 + 8.33 * 1200);
const strip = (j) => { const c = JSON.parse(JSON.stringify(j)); if (c.artifact) delete c.artifact.generatedAt; return JSON.stringify(c); };
(async () => {
  const E0 = (await execs()).length;
  await reset(); const H = hdr(await login('73.1.1.1'));
  console.log('[slides: success path and options]');
  await queue('valid'); const u0 = usageNow(); let r = await post('student-tools-v2', L.slBody(), H); const a = r.json && r.json.artifact;
  t(r.status === 200 && r.json.ok === true && a.tool === 'slides' && a.schema === 'sth.slides/1' && a.strategy === 'direct' && a.promptVersion === 'studio-2026-12-a' && a.data.slides.length === 4 && a.data.slides[0].layout === 'title' && a.data.format === 'detailed' && a.data.slides.map((s) => s.id).join() === 'p1,p2,p3,p4' && a.repairs.length === 0, 'artifact: slides, title first, ids p1..p4, format detailed', r.text.slice(0, 300));
  t(usageNow() - u0 === UNITS, 'metered like the other tools');
  let g = (await gcalls()).at(-1).body; t(g.generationConfig.maxOutputTokens === 16384 && g.generationConfig.temperature === 0.4 && /format: detailed\nlength: default/.test(g.contents[0].parts.at(-1).text) && g.generationConfig.responseJsonSchema.properties.slides.items.properties.layout.enum.length === 10, 'Gemini request: 16384 output, 0.4, settings format and length, 10 layouts');
  r = await post('student-tools-v2', L.slBody({ options: { format: 'presenter', length: 'short' } }), H); g = (await gcalls()).at(-1).body; t(r.json.ok === true && r.json.artifact.data.format === 'presenter' && /format: presenter\nlength: short/.test(g.contents[0].parts.at(-1).text), 'presenter / short reach the prompt and the artifact');
  for (const bad of [{ format: 'long' }, { length: 'tiny' }, { format: 3 }]) { r = await post('student-tools-v2', L.slBody({ options: bad }), H); t(r.json.error.code === 'STH-INPUT-400' && r.json.error.reason === 'options', `options ${JSON.stringify(bad)} -> options`); }
  console.log('[slides: repairs]');
  const run = async (fx) => { await queue(fx); return (await post('student-tools-v2', L.slBody(), H)).json; };
  let j = await run('badfigure'); t(j.ok === true && !JSON.stringify(j.artifact.data).includes('1946') && j.artifact.repairs.some((x) => /removed 1 points with a number that could not be checked/.test(x)), 'a bullet with a number that is not in the source is removed', j.artifact && j.artifact.repairs);
  j = await run('badnumber'); t(j.ok === true && j.artifact.data.slides.length === 3 && j.artifact.repairs.some((x) => /dropped 1 empty slides/.test(x)), 'a slide whose only bullet had a bad number is dropped', j.artifact && j.artifact.repairs);
  j = await run('xss'); t(j.ok === true && j.artifact.data.slides[1].title === '"><img src=x onerror=alert(1)>', 'markup stays characters');
  j = await run('fewitems'); t(j.ok === false && j.error.reason === 'too_few_slides', '2 slides -> too_few_slides');
  j = await run('truncated'); t(j.error.reason === 'truncated', 'truncated'); j = await run('prose'); t(j.error.reason === 'parse', 'prose -> parse');
  j = await run('429,valid'); t(j.ok === true && j.artifact.usage.calls === 2, 'a 429 is repeated once');
  console.log('[slides: as a job]');
  await reset(); H.authorization = 'Bearer ' + (await login('73.1.2.2')); await queue('valid');
  const jf = mkJob('studio_slides'); await create(jf, L.slBody(), H); const s = await waitState(jf, H); const sync = await post('student-tools-v2', L.slBody(), H); r = await op('result', [jf], H);
  t(s.state === 'succeeded' && r.json.mode === 'studio_slides' && strip(r.json.result) === strip(sync.json), 'job succeeded; stored answer == the sync answer');
  t((await execs()).slice(E0).filter((e) => e.status === 'crashed').length === 0, 'no crashed execution');
  L.done('E2E slides');
})().catch((e) => { console.log('CRASH', e); process.exit(1); });
