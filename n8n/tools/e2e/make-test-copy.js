// Creates test-<name>.json: external endpoints -> local mock; Gmail nodes -> NoOp; execution data kept for debugging.
const fs = require('fs');
const [,, inFile, outFile, mockPort] = process.argv;
const wf = JSON.parse(fs.readFileSync(inFile, 'utf8'));
let s = JSON.stringify(wf);
s = s.split('https://sweeping-jennet-172408.upstash.io').join(`http://127.0.0.1:${mockPort}/upstash`);
s = s.split('https://generativelanguage.googleapis.com').join(`http://127.0.0.1:${mockPort}/gemini`);
s = s.split('https://vision.googleapis.com').join(`http://127.0.0.1:${mockPort}/vision`);
if (!process.env.KEEP_DOH) s = s.split('https://dns.google/resolve').join(`http://127.0.0.1:${mockPort}/doh`);
const t = JSON.parse(s);
for (const n of t.nodes) {
  if (n.type === 'n8n-nodes-base.gmail') { n.type = 'n8n-nodes-base.noOp'; n.typeVersion = 1; n.parameters = {}; delete n.credentials; delete n.webhookId; }
}
// Test-only: shorten the Studio Gemini call timeout so a hanging Gemini can be exercised in seconds (the shipped value is 240000 ms)
if (process.env.STUDIO_TEST_TIMEOUT_MS) {
  for (const n of t.nodes) {
    if (n.name === 'Studio - Validate Request') n.parameters.jsCode = n.parameters.jsCode.replace('const STUDIO_CALL_TIMEOUT_MS = 240000;', `const STUDIO_CALL_TIMEOUT_MS = ${Number(process.env.STUDIO_TEST_TIMEOUT_MS)};`);
    if (n.name === 'Studio - Retry Check') n.parameters.jsCode = n.parameters.jsCode.replace('const CALL_TIMEOUT_MS = 240000;', `const CALL_TIMEOUT_MS = ${Number(process.env.STUDIO_TEST_TIMEOUT_MS)};`);
  }
}
// Test-only knobs for the background jobs (v4): short deadlines / grace so a stalled run can be exercised in seconds,
// and a short Gemini timeout for the tutor so a hanging Gemini throws (the shipped value is 300000 ms).
//   JOB_TEST_DEADLINES="tutor=8,studio_mindmap=10"   JOB_TEST_GRACE=2   JOB_TEST_TUTOR_TIMEOUT_MS=3000
if (process.env.JOB_TEST_DEADLINES || process.env.JOB_TEST_GRACE) {
  const rr = t.nodes.find((n) => n.name === 'Job - Read Request');
  if (!rr) throw new Error('no Job - Read Request in this workflow');
  for (const kv of (process.env.JOB_TEST_DEADLINES || '').split(',').filter(Boolean)) {
    const [m, sec] = kv.split('=');
    const re = new RegExp(`(${m}: \\{ deadlineS: )\\d+`);
    if (!re.test(rr.parameters.jsCode)) throw new Error('deadline constant not found for ' + m);
    rr.parameters.jsCode = rr.parameters.jsCode.replace(re, (_, a) => a + Number(sec));
  }
  if (process.env.JOB_TEST_GRACE) {
    if (!rr.parameters.jsCode.includes('const GRACE_S = 60;')) throw new Error('grace constant not found');
    rr.parameters.jsCode = rr.parameters.jsCode.replace('const GRACE_S = 60;', `const GRACE_S = ${Number(process.env.JOB_TEST_GRACE)};`);
  }
}
if (process.env.JOB_TEST_TUTOR_TIMEOUT_MS) t.nodes.find((n) => n.name === 'Gemini — Tutor').parameters.options.timeout = Number(process.env.JOB_TEST_TUTOR_TIMEOUT_MS);
// v7: a short Gemini time-out for the three background J4 calls (the shipped value is 280000 ms)
if (process.env.J4_TEST_TIMEOUT_MS) for (const n of t.nodes) if (/^Call Gemini \((Transcription|Template|Reviewer), job\)$/.test(n.name)) n.parameters.options.timeout = Number(process.env.J4_TEST_TIMEOUT_MS);
t.settings.saveDataSuccessExecution = 'all';
t.settings.saveDataErrorExecution = 'all';
t.active = true;
t.settings.errorWorkflow = 'dT6ZBofuwIcBjAUS'; // self, as the runbook tells the owner to do in the UI
fs.writeFileSync(outFile, JSON.stringify(t, null, 2));
