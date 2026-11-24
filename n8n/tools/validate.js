// Structural validation + diff of v1/v2 against the live workflow.
const fs = require('fs');
const path = require('path');
const live = JSON.parse(fs.readFileSync(path.join(__dirname, 'live.json'), 'utf8'));
let failures = 0;
let checks = 0;
function ok(cond, msg) {
  checks++;
  if (!cond) {
    failures++;
    console.log('  FAIL: ' + msg);
  }
}

function validate(file, expect) {
  console.log('== ' + file);
  const raw = fs.readFileSync(path.join(__dirname, file), 'utf8');
  let wf;
  try { wf = JSON.parse(raw); ok(true); } catch (e) { ok(false, 'not valid JSON ' + e.message); return; }
  const names = wf.nodes.map((n) => n.name);
  ok(new Set(names).size === names.length, 'node names unique');
  const ids = wf.nodes.map((n) => n.id);
  ok(new Set(ids).size === ids.length, 'node ids unique');
  const nameSet = new Set(names);
  // connections reference existing nodes
  const targets = new Set();
  for (const [from, v] of Object.entries(wf.connections)) {
    ok(nameSet.has(from), `connection source exists: ${from}`);
    for (const [type, outs] of Object.entries(v)) {
      ok(type === 'main', `connection type main: ${from} ${type}`);
      for (const arr of outs) for (const c of arr || []) {
        ok(nameSet.has(c.node), `connection target exists: ${from} -> ${c.node}`);
        ok(c.type === 'main' && c.index === 0, `connection shape ${from}->${c.node}`);
        targets.add(c.node);
      }
    }
  }
  // orphans: every node must have an inbound connection or be a trigger
  const triggers = new Set(wf.nodes.filter((n) => /webhook$|errorTrigger$/.test(n.type) && !/respondToWebhook/.test(n.type)).map((n) => n.name));
  for (const n of wf.nodes) {
    const hasIn = targets.has(n.name);
    const hasOut = !!wf.connections[n.name] && wf.connections[n.name].main.some((a) => a && a.length);
    ok(hasIn || triggers.has(n.name), `no orphan (no inbound, not a trigger): ${n.name}`);
    if (!hasIn && !triggers.has(n.name)) console.log('     orphan:', n.name);
    void hasOut;
  }
  // reachability from triggers
  const seen = new Set();
  const stack = [...triggers];
  while (stack.length) {
    const x = stack.pop();
    if (seen.has(x)) continue;
    seen.add(x);
    const v = wf.connections[x];
    if (v) for (const arr of v.main) for (const c of arr || []) stack.push(c.node);
  }
  for (const n of names) ok(seen.has(n), `reachable from a trigger: ${n}`);
  // credentials preserved
  const liveByName = new Map(live.nodes.map((n) => [n.name, n]));
  for (const n of wf.nodes) {
    const l = liveByName.get(n.name);
    if (l && l.credentials) {
      ok(JSON.stringify(l.credentials) === JSON.stringify(n.credentials), `credentials preserved: ${n.name}`);
    }
    if (n.credentials) {
      for (const [t, c] of Object.entries(n.credentials)) ok(c && c.id && c.name, `credential has id+name: ${n.name}.${t}`);
    }
  }
  // webhook checks
  const wh = wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook');
  console.log('  webhooks:', wh.map((w) => `${w.name} [${w.parameters.path}, auth=${w.parameters.authentication || 'none'}, ${w.parameters.responseMode}]`).join('; '));
  const paths = wh.map((w) => w.parameters.path);
  ok(new Set(paths).size === paths.length, 'webhook paths unique');
  // settings
  ok(wf.settings.saveDataSuccessExecution === 'none' && wf.settings.saveDataErrorExecution === 'none', 'execution data saving off');
  ok(wf.settings.executionOrder === live.settings.executionOrder && wf.settings.binaryMode === live.settings.binaryMode, 'other settings kept');
  // no allowUnauthorizedCerts true anywhere
  ok(!JSON.stringify(wf.nodes).includes('"allowUnauthorizedCerts":true'), 'no allowUnauthorizedCerts:true');
  ok(!/driveAccessToken/.test(JSON.stringify(wf.nodes)) || !expect.noDrive, 'drive token gone (v2)');
  // Code nodes compile
  for (const n of wf.nodes) {
    if (n.type === 'n8n-nodes-base.code') {
      try {
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        new AsyncFunction('$input', '$json', '$', 'require', n.parameters.jsCode);
        ok(true);
      } catch (e) { ok(false, `code node compiles: ${n.name}: ${e.message}`); }
    }
  }
  // n8n expressions: the first '}}' must be the closing one
  (function walk(o, where) {
    if (typeof o === 'string') { if (o.startsWith('={{') && o.indexOf('}}') !== o.length - 2 && o.endsWith('}}')) ok(false, `expression has an early '}}' in ${where}: ${o.slice(0, 80)}`); else if (o.startsWith('={{')) ok(true); }
    else if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) walk(v, where);
  })(wf.nodes.map((n) => [n.name, n.parameters]), 'node');
  // secrets
  ok(!/AIza[0-9A-Za-z_-]{30,}|ya29\.[A-Za-z0-9._-]{20,}/.test(raw), 'no embedded keys');
  console.log(`  nodes: ${wf.nodes.length}, connections sources: ${Object.keys(wf.connections).length}`);

  // diff
  const wmap = new Map(wf.nodes.map((n) => [n.name, n]));
  const added = names.filter((n) => !liveByName.has(n));
  const removed = live.nodes.map((n) => n.name).filter((n) => !wmap.has(n));
  const changed = [];
  for (const [name, l] of liveByName) {
    const n = wmap.get(name);
    if (!n) continue;
    const a = JSON.stringify({ p: l.parameters, t: l.type, v: l.typeVersion, c: l.credentials, e: l.onError, d: l.disabled });
    const b = JSON.stringify({ p: n.parameters, t: n.type, v: n.typeVersion, c: n.credentials, e: n.onError, d: n.disabled });
    if (a !== b) changed.push(name + (l.type !== n.type ? ` (type ${l.type.replace('n8n-nodes-base.', '')} -> ${n.type.replace('n8n-nodes-base.', '')})` : ''));
  }
  const movedOnly = [];
  for (const [name, l] of liveByName) {
    const n = wmap.get(name);
    if (n && !changed.some((c) => c.startsWith(name)) && JSON.stringify(l.position) !== JSON.stringify(n.position)) movedOnly.push(name);
  }
  // connection diff
  const edges = (w) => {
    const s = new Set();
    for (const [f, v] of Object.entries(w.connections)) v.main.forEach((arr, i) => (arr || []).forEach((c) => s.add(`${f}[${i}] -> ${c.node}`)));
    return s;
  };
  const le = edges(live), ne = edges(wf);
  const addedEdges = [...ne].filter((e) => !le.has(e));
  const removedEdges = [...le].filter((e) => !ne.has(e));
  console.log('  ADDED nodes (' + added.length + '): ' + added.join(' | '));
  console.log('  REMOVED nodes (' + removed.length + '): ' + removed.join(' | '));
  console.log('  CHANGED nodes (' + changed.length + '): ' + changed.join(' | '));
  console.log('  MOVED only (' + movedOnly.length + '): ' + movedOnly.join(' | '));
  console.log('  Edges added (' + addedEdges.length + ') / removed (' + removedEdges.length + ')');
  if (process.env.VERBOSE) { addedEdges.forEach((e) => console.log('    + ' + e)); removedEdges.forEach((e) => console.log('    - ' + e)); }
  expect.check && expect.check({ added, removed, changed, wf });
}

validate('sth-workflow-v1-additive.json', {
  check: ({ removed, wf }) => {
    ok(removed.length === 0, 'v1 removes nothing');
    ok(wf.nodes.some((n) => n.name === 'Student Hub Endpoint') && wf.nodes.some((n) => n.name === 'Student Hub Endpoint (JWT)'), 'v1 has both webhooks');
  },
});
validate('sth-workflow-v2-enforce.json', {
  noDrive: true,
  check: ({ removed, wf }) => {
    const want = ['Student Hub Endpoint', 'Needs DOC Conversion?', 'Convert DOC Base64 To Binary', 'Init Drive Import Upload', 'Extract Drive Upload URL', 'Drive Upload DOC Bytes', 'Extract Drive Temp File ID', 'Drive Export As PDF', 'Drive Delete Temp File', 'Finalize Converted PDF'];
    ok(want.every((w) => removed.includes(w)) && removed.length === want.length, 'v2 removed exactly the expected nodes');
    ok(!wf.nodes.some((n) => /Legacy/.test(n.name)), 'v2 has no legacy counter nodes');
    ok(!/driveFileId|driveAccessToken|needsDocConversion/.test(JSON.stringify(wf)), 'v2 has no drive refs');
  },
});
validate('sth-workflow-v3-studio.json', {
  noDrive: true,
  check: ({ removed, wf }) => {
    const v2 = JSON.parse(fs.readFileSync(path.join(__dirname, 'sth-workflow-v2-enforce.json'), 'utf8'));
    const v2by = new Map(v2.nodes.map((n) => [n.name, n]));
    const STUDIO = ['Studio - Validate Request', 'Studio - Request Ok?', 'Studio - Reject', 'Studio - Call Gemini', 'Studio - Retry Check', 'Studio - Retry?', 'Studio - Wait Retry', 'Studio - Validate', 'Studio - Metered?', 'Studio - Meter Usage', 'Studio - Respond'];
    const names = wf.nodes.map((n) => n.name);
    const add3 = names.filter((n) => !v2by.has(n));
    ok(add3.slice().sort().join('|') === STUDIO.slice().sort().join('|'), 'v3 adds exactly the 11 Studio nodes to v2', add3);
    ok(v2.nodes.every((n) => names.includes(n.name)), 'v3 removes nothing from v2');
    const changed3 = wf.nodes.filter((n) => v2by.has(n.name) && JSON.stringify({ p: v2by.get(n.name).parameters, c: v2by.get(n.name).credentials, e: v2by.get(n.name).onError, t: v2by.get(n.name).type }) !== JSON.stringify({ p: n.parameters, c: n.credentials, e: n.onError, t: n.type })).map((n) => n.name);
    ok(changed3.slice().sort().join('|') === ['Prep — Tutor', 'Quota Prep', 'Quota Read', 'Route by Mode'].sort().join('|'), 'v3 changes only Route by Mode, Quota Prep, Quota Read and Prep — Tutor', changed3);
    { const q2 = v2by.get('Quota Read'), q3 = wf.nodes.find((n) => n.name === 'Quota Read');
      ok(q3.parameters.jsonBody === q2.parameters.jsonBody.replace('"cfg:daily_units"]', '"cfg:daily_units", "cfg:studio_max_tokens"]') && q3.parameters.jsonBody.includes('"cfg:studio_max_tokens"') && JSON.stringify(q3.credentials) === JSON.stringify(q2.credentials) && q3.parameters.options.timeout === 5000 && q3.onError === 'continueRegularOutput', 'v3 Quota Read: only the third key cfg:studio_max_tokens is added to the MGET (fail-open, 5 s)', q3.parameters.jsonBody); }
    ok(removed.every((r) => !r.startsWith('Studio')), 'no Studio node removed');
    ok(!wf.nodes.some((n) => /Legacy/.test(n.name)) && !wf.nodes.some((n) => n.name === 'Student Hub Endpoint') && wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').length === 2, 'v3 keeps the v2 webhooks only (JWT + auth)');
    const edges = (w) => { const s = new Set(); for (const [f, v] of Object.entries(w.connections)) v.main.forEach((arr, i) => (arr || []).forEach((c) => s.add(`${f}[${i}] -> ${c.node}`))); return s; };
    const e2 = edges(v2), e3 = edges(wf);
    ok([...e2].every((e) => e3.has(e)), 'every v2 connection is still in v3');
    const newEdges = [...e3].filter((e) => !e2.has(e)).sort();
    const want = ['Route by Mode[8] -> Studio - Validate Request', 'Studio - Validate Request[0] -> Studio - Request Ok?', 'Studio - Request Ok?[0] -> Studio - Call Gemini', 'Studio - Request Ok?[1] -> Studio - Reject', 'Studio - Call Gemini[0] -> Studio - Retry Check', 'Studio - Retry Check[0] -> Studio - Retry?', 'Studio - Retry?[0] -> Studio - Wait Retry', 'Studio - Retry?[1] -> Studio - Validate', 'Studio - Wait Retry[0] -> Studio - Call Gemini', 'Studio - Validate[0] -> Studio - Metered?', 'Studio - Metered?[0] -> Studio - Meter Usage', 'Studio - Metered?[1] -> Studio - Respond', 'Studio - Meter Usage[0] -> Studio - Respond'].sort();
    ok(JSON.stringify(newEdges) === JSON.stringify(want), 'new connections are exactly the Studio branch', newEdges);
    // every Studio path ends at Studio - Reject or Studio - Respond (those are the only terminal nodes: the webhook answers with the last node)
    const terminal = names.filter((n) => n.startsWith('Studio') && !(wf.connections[n] && wf.connections[n].main.some((a) => a && a.length)));
    ok(terminal.slice().sort().join('|') === ['Studio - Reject', 'Studio - Respond'].join('|'), 'Studio branch ends only at Reject / Respond', terminal);
    const by = new Map(wf.nodes.map((n) => [n.name, n]));
    const rt = by.get('Route by Mode');
    ok(rt.parameters.rules.values.length === 9 && rt.parameters.rules.values[8].conditions.conditions[0].rightValue === 'studio_mindmap', 'Route by Mode has the studio_mindmap rule as output 8');
    ok(JSON.stringify(rt.parameters.rules.values.slice(0, 8)) === JSON.stringify(v2by.get('Route by Mode').parameters.rules.values), 'the 8 existing routing rules are untouched');
    const gem = by.get('Studio - Call Gemini');
    ok(JSON.stringify(gem.credentials) === JSON.stringify(by.get('Gemini — Tutor').credentials), 'Studio Gemini call uses the existing Gemini credential');
    ok(gem.parameters.options.timeout === '={{ $json.timeoutMs }}' && gem.parameters.options.response.response.neverError === true && gem.onError === 'continueRegularOutput', 'Gemini call: timeout from the item (240000 ms), never errors');
    ok(/generativelanguage\.googleapis\.com\/v1beta\/models\/\{\{ \$json\.model \}\}:generateContent$/.test(gem.parameters.url), 'Gemini URL pattern as the other Gemini nodes');
    for (const nm of ['Studio - Validate Request', 'Studio - Retry Check', 'Studio - Validate', 'Studio - Respond', 'Studio - Reject']) ok(!/\bthrow\b/.test(by.get(nm).parameters.jsCode), `${nm} never throws (no error mail can carry request text)`);
    ok(/STUDIO_CALL_TIMEOUT_MS = 240000/.test(by.get('Studio - Validate Request').parameters.jsCode) && /CALL_TIMEOUT_MS = 240000/.test(by.get('Studio - Retry Check').parameters.jsCode), 'call timeout 240000 ms in both nodes');
    ok(!/require\(|process\.|fetch\(|new URL|crypto/.test(by.get('Studio - Validate').parameters.jsCode.replace(/\/\/.*$/gm, '')), 'Studio - Validate (inlined library) uses no require/process/fetch/URL/crypto');
    ok(/EVAL/.test(by.get('Studio - Meter Usage').parameters.jsonBody) && /usage:/.test(by.get('Studio - Meter Usage').parameters.jsonBody) && by.get('Studio - Meter Usage').onError === 'continueRegularOutput', 'meter writes usage:YYYYMMDD and is fail-open');
    ok(/studio_mindmap/.test(by.get('Quota Prep').parameters.jsCode), 'Quota Prep covers studio_mindmap');
    ok(by.get('Studio - Wait Retry').webhookId && by.get('Studio - Wait Retry').typeVersion === 1.1, 'Wait node has a webhookId');
  },
});

validate('sth-workflow-v4-jobs.json', {
  noDrive: true,
  check: ({ removed, wf }) => {
    const v3 = JSON.parse(fs.readFileSync(path.join(__dirname, 'sth-workflow-v3-studio.json'), 'utf8'));
    const v3by = new Map(v3.nodes.map((n) => [n.name, n]));
    const by = new Map(wf.nodes.map((n) => [n.name, n]));
    const names = wf.nodes.map((n) => n.name);
    const JOB = ['Job Start Endpoint', 'Job Endpoint', 'Job - Pick Envelope', 'Job - Read Request', 'Job - Hash Key', 'Job - Plan', 'Job - Route Op', 'Job - Admit', 'Job - Admit Result', 'Job - Admitted?', 'Job - Record Rejection', 'Job - Status Read', 'Job - Status Reply', 'Job - Result Read', 'Job - Result Reply', 'Job - Ack', 'Job - Ack Reply', 'Job - Cancel', 'Job - Cancel Reply', 'Job - Reply', 'Job - Sync?', 'Job - Classify Outcome', 'Job - Store Outcome', 'Job - Error Lookup', 'Job - Error Is Job?', 'Job - Error Outcome'];
    const add4 = names.filter((n) => !v3by.has(n));
    ok(add4.slice().sort().join('|') === JOB.slice().sort().join('|') && JOB.length === 26, 'v4 adds exactly the 26 job nodes to v3', add4);
    ok(v3.nodes.every((n) => names.includes(n.name)), 'v4 removes nothing from v3');
    const sig = (n) => JSON.stringify({ p: n.parameters, c: n.credentials, e: n.onError, t: n.type, v: n.typeVersion, d: n.disabled });
    const changed4 = wf.nodes.filter((n) => v3by.has(n.name) && sig(v3by.get(n.name)) !== sig(n)).map((n) => n.name);
    ok(changed4.slice().sort().join('|') === ['Normalize Multipart Body', 'Prep — Tutor', 'Save Session Builder', 'Studio - Retry Check', 'Tutor Retry Check'].sort().join('|'), 'v4 changes only 5 existing nodes (Normalize, Prep — Tutor, Save Session Builder, Tutor Retry Check, Studio - Retry Check)', changed4);
    ok(Object.keys(wf.settings).sort().join() === Object.keys(v3.settings).concat('executionTimeout').sort().join() && wf.settings.executionTimeout === 720, 'settings: v3 plus executionTimeout 720');
    const edges = (w) => { const s2 = new Set(); for (const [f, v] of Object.entries(w.connections)) v.main.forEach((arr, i) => (arr || []).forEach((c) => s2.add(`${f}[${i}] -> ${c.node}`))); return s2; };
    const e3 = edges(v3), e4 = edges(wf);
    ok([...e3].every((e) => e4.has(e)), 'every v3 connection is still in v4');
    const newEdges = [...e4].filter((e) => !e3.has(e)).sort();
    const want = ['Job Start Endpoint[0] -> Job - Pick Envelope', 'Job Endpoint[0] -> Job - Pick Envelope', 'Job - Pick Envelope[0] -> Job - Read Request', 'Job - Read Request[0] -> Job - Hash Key', 'Job - Hash Key[0] -> Job - Plan', 'Job - Plan[0] -> Job - Route Op',
      'Job - Route Op[0] -> Job - Admit', 'Job - Route Op[1] -> Job - Record Rejection', 'Job - Route Op[2] -> Job - Status Read', 'Job - Route Op[3] -> Job - Result Read', 'Job - Route Op[4] -> Job - Ack', 'Job - Route Op[5] -> Job - Cancel', 'Job - Route Op[6] -> Job - Reply',
      'Job - Admit[0] -> Job - Admit Result', 'Job - Admit Result[0] -> Job - Admitted?', 'Job - Admitted?[0] -> Normalize Multipart Body', 'Job - Status Read[0] -> Job - Status Reply', 'Job - Result Read[0] -> Job - Result Reply', 'Job - Ack[0] -> Job - Ack Reply', 'Job - Cancel[0] -> Job - Cancel Reply',
      'Build Response[0] -> Job - Sync?', 'Studio - Respond[0] -> Job - Sync?', 'Studio - Reject[0] -> Job - Sync?', 'Quota Exceeded[0] -> Job - Sync?', 'Job - Sync?[1] -> Job - Classify Outcome', 'Job - Classify Outcome[0] -> Job - Store Outcome',
      'Error Trigger[0] -> Job - Error Lookup', 'Job - Error Lookup[0] -> Job - Error Is Job?', 'Job - Error Is Job?[0] -> Job - Error Outcome', 'Job - Error Outcome[0] -> Job - Store Outcome'].sort();
    ok(JSON.stringify(newEdges) === JSON.stringify(want), 'new connections are exactly the job gateway, the exit funnel and the error branch', newEdges.filter((e) => !want.includes(e)).concat(want.filter((e) => !newEdges.includes(e))));
    // sync output: Job - Sync? output 0 stays unconnected; the four terminals feed only that node
    ok(!(wf.connections['Job - Sync?'].main[0] || []).length, 'Job - Sync? output 0 (synchronous answer) is unconnected');
    for (const tnode of ['Build Response', 'Studio - Respond', 'Studio - Reject', 'Quota Exceeded']) ok(wf.connections[tnode].main[0].length === 1 && wf.connections[tnode].main[0][0].node === 'Job - Sync?', `${tnode} feeds only Job - Sync?`);
    ok(by.get('Job - Sync?').parameters.conditions.conditions[0].leftValue === "={{ !$('Normalize Multipart Body').first().json._job }}", 'Job - Sync? is true when the run has no _job');
    ok((wf.connections['Error Trigger'].main[0] || []).map((c) => c.node).join() === 'Workflow Error Rate Limit,Job - Error Lookup', 'Error Trigger keeps the mail branch and gains the job branch');
    // webhooks
    for (const [nm, p, mode] of [['Job Start Endpoint', 'sth-job-start', 'onReceived'], ['Job Endpoint', 'sth-job', 'lastNode']]) {
      const w = by.get(nm);
      ok(w.type === 'n8n-nodes-base.webhook' && w.parameters.httpMethod === 'POST' && w.parameters.path === p && w.parameters.authentication === 'jwtAuth' && w.parameters.responseMode === mode && JSON.stringify(w.credentials) === JSON.stringify({ jwtAuth: { id: 'SELECT-STH-JWT', name: 'STH JWT' } }) && w.parameters.options.allowedOrigins === 'https://jay-leigh.github.io' && w.webhookId, `${nm}: POST ${p}, JWT with the STH JWT credential, ${mode}, CORS origin`);
    }
    ok(by.get('Job Start Endpoint').parameters.options.responseData === '{"ok":true,"accepted":true}', 'Job Start Endpoint answers {"ok":true,"accepted":true}');
    ok(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').length === 4, 'v4 webhooks: JWT, auth, job start, job');
    // Redis nodes: timeout 5000, fail-soft, store retried
    const jobRedis = JOB.filter((n) => by.get(n).type === 'n8n-nodes-base.httpRequest');
    ok(jobRedis.length === 8, 'eight job Redis nodes', jobRedis);
    for (const n of jobRedis) {
      const x = by.get(n);
      ok(x.parameters.options.timeout === 5000 && x.onError === 'continueRegularOutput' && JSON.stringify(x.credentials) === JSON.stringify(by.get('Quota Read').credentials) && x.parameters.url.startsWith('https://sweeping-jennet-172408.upstash.io'), `${n}: timeout 5000, onError continueRegularOutput, Upstash credential`);
    }
    ok(['Job - Status Read', 'Job - Result Read', 'Job - Ack', 'Job - Cancel'].every((n) => by.get(n).parameters.url.endsWith('/pipeline')) && ['Job - Admit', 'Job - Record Rejection', 'Job - Store Outcome', 'Job - Error Lookup'].every((n) => by.get(n).parameters.url === 'https://sweeping-jennet-172408.upstash.io'), 'pipeline nodes use /pipeline, the others the single-command endpoint');
    const so = by.get('Job - Store Outcome');
    ok(so.retryOnFail === true && so.maxTries === 3 && so.waitBetweenTries === 2000, 'Store Outcome retries 3 times, 2 s apart');
    // Lua: the node expressions embed the source files; every key family has a TTL; nothing outside the scripts writes sth: keys
    const luaSrc = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8').replace(/\n+$/, '');
    for (const [nm, f] of [['Job - Admit', 'job-admit.lua'], ['Job - Record Rejection', 'job-reject.lua'], ['Job - Store Outcome', 'job-store.lua'], ['Job - Ack', 'job-ack.lua'], ['Job - Cancel', 'job-cancel.lua']]) {
      ok(by.get(nm).parameters.jsonBody.includes(JSON.stringify(luaSrc(f))), `${nm} embeds ${f} verbatim`);
    }
    const admit = luaSrc('job-admit.lua'), store = luaSrc('job-store.lua'), cancel = luaSrc('job-cancel.lua'), reject = luaSrc('job-reject.lua');
    ok(/EXPIRE',KEYS\[1\],ARGV\[6\]/.test(admit) && /EXPIRE',KEYS\[1\],ARGV\[13\]/.test(admit) && /EXPIRE',KEYS\[5\],86400/.test(admit) && /'SET',KEYS\[2\],[^\n]*'EX',ARGV\[12\]/.test(admit) && /EXPIRE',KEYS\[3\],2592000/.test(admit), 'ADMIT: an expiry on the record, the rejected record, the run-set, jobx and the stats');
    ok(/'SET',KEYS\[2\],ARGV\[4\],'EX',ARGV\[6\]/.test(store) && /EXPIRE',KEYS\[1\],ARGV\[6\]/.test(store) && /EXPIRE',KEYS\[4\],2592000/.test(store), 'STORE: an expiry on the result, the record and the stats');
    ok(/EXPIRE',KEYS\[1\],ARGV\[3\]/.test(cancel) && /EXPIRE',KEYS\[1\],ARGV\[6\]/.test(reject), 'CANCEL and REJECT: expiry kept');
    const writers = JOB.filter((n) => /redis\.call\('(HSET|SET|ZADD|HINCRBY|INCR)|"(SET|HSET|ZADD|INCR|HINCRBY)"/.test(JSON.stringify(by.get(n).parameters)));
    ok(writers.slice().sort().join('|') === ['Job - Admit', 'Job - Cancel', 'Job - Record Rejection', 'Job - Store Outcome'].sort().join('|'), 'only the four script nodes write to Redis', writers);
    ok(!JOB.some((n) => by.get(n).type === 'n8n-nodes-base.code' && /\b(SET|HSET|ZADD|INCR|EXPIRE|DEL)\b/.test(by.get(n).parameters.jsCode.replace(/\/\/.*$/gm, '').replace(/'[^']*'|"[^"]*"/g, ''))), 'no job Code node issues a write itself');
    // settings in Read Request
    const rr = by.get('Job - Read Request').parameters.jsCode;
    ok(rr.includes('const JOBS_ENABLED = true;') && rr.includes('tutor: { deadlineS: 420, cap: 3 }') && rr.includes('studio_mindmap: { deadlineS: 600, cap: 1 }') && rr.includes('const JOB_CAP_TOTAL = 4;') && rr.includes('const GRACE_S = 60;') && rr.includes('const RESULT_TTL_S = 259200;') && rr.includes('const REJECT_TTL_S = 3600;') && rr.includes('const RESULT_MAX_BYTES = 524288;') && rr.includes('const MAX_BATCH = 10;'), 'Read Request holds the settings (tutor 420 s cap 3, mind map 600 s cap 1, total 4, grace 60 s, 72 h, 1 h, 512 KB, batch 10)');
    { const dl = [...rr.matchAll(/(\w+): \{ deadlineS: (\d+)/g)].map((x) => [x[1], Number(x[2])]); ok(dl.length === 2, 'two job modes declared'); for (const [m, secs] of dl) ok(secs <= 600, `deadline of ${m} is at most 600 s`); }
    ok(/ID_RE = \/\^j_\[A-Za-z0-9_-\]\{22\}\$\//.test(rr) && /KEY_RE = \/\^\[A-Za-z0-9_-\]\{43\}\$\//.test(rr), 'id and key shapes are validated');
    for (const n of ['Job - Read Request', 'Job - Plan', 'Job - Admit Result', 'Job - Status Reply', 'Job - Result Reply', 'Job - Ack Reply', 'Job - Cancel Reply', 'Job - Reply', 'Job - Classify Outcome']) ok(!/\bthrow\b/.test(by.get(n).parameters.jsCode), `${n} never throws`);
    ok(by.get('Job - Hash Key').type === 'n8n-nodes-base.crypto' && by.get('Job - Hash Key').parameters.type === 'SHA256' && by.get('Job - Hash Key').parameters.encoding === 'hex', 'the key is hashed by the Crypto node (SHA-256, hex)');
    ok(by.get('Job - Pick Envelope').parameters.includeOtherFields === false, 'Pick Envelope drops everything but the envelope');
    ok(!/\bthrow\b/.test(by.get('Job - Error Outcome').parameters.jsCode) && !/message\b[^;\n]*(JSON|argv|keys)/.test(by.get('Job - Error Outcome').parameters.jsCode.replace(/\/\/.*$/gm, '')), 'Error Outcome never stores the error message');
    // sync edits are small and only branch on _job
    for (const [nm, token] of [['Prep — Tutor', 'jobId'], ['Save Session Builder', 'jobId'], ['Tutor Retry Check', 'job'], ['Studio - Retry Check', 'inJob'], ['Normalize Multipart Body', 'fromJob']]) ok(by.get(nm).parameters.jsCode.includes(token), `${nm}: job branch present`);
    // v1..v3 files are not touched by this PR (checked against the committed copies when run from the repo checkout)
    const repoDir = path.join(__dirname, '..');
    if (fs.existsSync(repoDir)) for (const f of ['sth-workflow-v1-additive.json', 'sth-workflow-v2-enforce.json', 'sth-workflow-v3-studio.json']) ok(fs.readFileSync(path.join(repoDir, f), 'utf8') === fs.readFileSync(path.join(__dirname, f), 'utf8'), `${f} is byte-identical to the committed file`);
  },
});
validate('sth-workflow-v5-flashcards.json', {
  noDrive: true,
  check: ({ removed, wf }) => {
    const v4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'sth-workflow-v4-jobs.json'), 'utf8'));
    const v4by = new Map(v4.nodes.map((n) => [n.name, n]));
    const by = new Map(wf.nodes.map((n) => [n.name, n]));
    const names = wf.nodes.map((n) => n.name);
    ok(names.length === v4.nodes.length && names.every((n) => v4by.has(n)) && removed.every((r) => !r.startsWith('Studio')), 'v5 adds and removes no node: the Studio chain branches on `tool`');
    const sig = (n) => JSON.stringify({ p: n.parameters, c: n.credentials, e: n.onError, t: n.type, v: n.typeVersion, d: n.disabled, pos: n.position, id: n.id, w: n.webhookId, r: n.retryOnFail, m: n.maxTries });
    const changed5 = wf.nodes.filter((n) => sig(v4by.get(n.name)) !== sig(n)).map((n) => n.name);
    ok(changed5.slice().sort().join('|') === ['Job - Read Request', 'Quota Prep', 'Route by Mode', 'Studio - Retry Check', 'Studio - Validate', 'Studio - Validate Request'].sort().join('|'), 'v5 changes exactly 6 v4 nodes (Route by Mode, Quota Prep, Studio - Validate Request, Studio - Retry Check, Studio - Validate, Job - Read Request); every other node is byte-identical to v4', changed5);
    ok(JSON.stringify(wf.settings) === JSON.stringify(v4.settings) && wf.settings.executionTimeout === 720 && wf.settings.saveDataSuccessExecution === 'none' && wf.settings.saveDataErrorExecution === 'none', 'settings identical to v4 (Timeout Workflow 720, no execution data saved)');
    ok(wf.id === v4.id && wf.name === v4.name && JSON.stringify(wf.tags) === JSON.stringify(v4.tags), 'same workflow id and name as v4 (an import replaces it)');
    const edges = (w) => { const s2 = new Set(); for (const [f, v] of Object.entries(w.connections)) v.main.forEach((arr, i) => (arr || []).forEach((c) => s2.add(`${f}[${i}] -> ${c.node}`))); return s2; };
    const e4 = edges(v4), e5 = edges(wf);
    ok([...e4].every((e) => e5.has(e)), 'every v4 connection is still in v5');
    ok(JSON.stringify([...e5].filter((e) => !e4.has(e))) === JSON.stringify(['Route by Mode[9] -> Studio - Validate Request']), 'the only new connection is Route by Mode[9] -> Studio - Validate Request', [...e5].filter((e) => !e4.has(e)));
    const rt = by.get('Route by Mode');
    ok(rt.parameters.rules.values.length === 10 && rt.parameters.rules.values[9].conditions.conditions[0].rightValue === 'studio_flashcards' && JSON.stringify(rt.parameters.rules.values.slice(0, 9)) === JSON.stringify(v4by.get('Route by Mode').parameters.rules.values), 'Route by Mode: studio_flashcards is output 9, the nine v4 rules are untouched');
    ok(/'studio_mindmap', 'studio_flashcards'\]/.test(by.get('Quota Prep').parameters.jsCode), 'Quota Prep covers studio_flashcards (same ceiling and meter as the other Gemini modes)');
    ok(by.get('Quota Prep').parameters.jsCode.replace(", 'studio_flashcards'", '') === v4by.get('Quota Prep').parameters.jsCode && by.get('Quota Read').parameters.jsonBody === v4by.get('Quota Read').parameters.jsonBody, 'Quota Prep differs from v4 only by the mode; Quota Read (cfg:studio_max_tokens) unchanged');
    // job mode
    const rr = by.get('Job - Read Request').parameters.jsCode;
    ok(rr.includes('studio_flashcards: { deadlineS: 420, cap: 1 }') && rr.includes('tutor: { deadlineS: 420, cap: 3 }') && rr.includes('studio_mindmap: { deadlineS: 600, cap: 1 }') && rr.includes('const JOB_CAP_TOTAL = 4;') && rr.includes('const GRACE_S = 60;') && rr.includes('const JOBS_ENABLED = true;'), 'Job - Read Request: three modes (flashcards 420 s, cap 1), total cap 4, grace 60 s, jobs on');
    ok(rr.replace(', studio_flashcards: { deadlineS: 420, cap: 1 }', '') === v4by.get('Job - Read Request').parameters.jsCode, 'Job - Read Request differs from v4 only by the mode entry');
    { const dl = [...rr.matchAll(/(\w+): \{ deadlineS: (\d+)/g)].map((x) => [x[1], Number(x[2])]); ok(dl.length === 3, 'three job modes declared'); for (const [m, secs] of dl) ok(secs <= 600, `deadline of ${m} is at most 600 s`); }
    // Studio nodes
    const vr = by.get('Studio - Validate Request').parameters.jsCode, rc = by.get('Studio - Retry Check').parameters.jsCode, val = by.get('Studio - Validate').parameters.jsCode;
    for (const nm of ['Studio - Validate Request', 'Studio - Retry Check', 'Studio - Validate', 'Studio - Respond', 'Studio - Reject']) ok(!/\bthrow\b/.test(by.get(nm).parameters.jsCode), `${nm} never throws (no error mail can carry request text)`);
    ok(/STUDIO_CALL_TIMEOUT_MS = 240000;/.test(vr) && /const CALL_TIMEOUT_MS = 240000;/.test(rc), 'call timeout 240000 ms in both nodes');
    ok(/const FC_COUNTS = \[15, 30, 50\];/.test(vr) && /const FC_DIFFICULTIES = \['easy', 'medium', 'hard'\];/.test(vr) && /maxOutputTokens: tool === 'flashcards' \? \(count > 30 \? 16384 : 12288\) : 32768/.test(vr) && /sth\.flashcards\/1/.test(vr) && /const FLASHCARDS =/.test(vr), 'Validate Request: flashcards options (15/30/50, easy/medium/hard), call settings 12288/16384 (mind map 32768), schema, prompt');
    ok(vr.includes("const CAP_TOKENS_DEFAULT = 400000;") && vr.includes('const CAP_TOKENS_MIN = 50000;') && vr.includes('const CAP_TOKENS_MAX = 900000;') && vr.includes('const CAP_SOURCES = 10;') && vr.includes('const CAP_IMAGES = 5;') && vr.includes('const CAP_DESCRIPTION = 1000;') && vr.includes('const IMAGE_TOKENS = 1600;'), 'the caps (10 sources, 5 images, 1000 characters, token cap 400000 within 50000..900000, 1600 per image) are unchanged');
    ok(/LARGE_ESTIMATE = 300000;/.test(rc) && /LARGE_MAX_ATTEMPTS = 2;/.test(rc) && /FALLBACK_FROM_ATTEMPT = 3;/.test(rc) && /flashJob/.test(rc), 'Retry Check: large-request rule 300000, flash-lite on attempt 3, flashcards job budget from the job deadline');
    ok(!/require\(|process\.|fetch\(|new URL|crypto/.test(val.replace(/\/\/.*$/gm, '')), 'Studio - Validate (inlined library) uses no require/process/fetch/URL/crypto');
    ok(/function studioValidateFlashcards/.test(val) && /function studioValidateMindmap/.test(val) && /MAX_CARDS: 80/.test(val) && /FRONT: 160/.test(val) && /BACK: 500/.test(val) && /MIN_SHARE: 0\.5/.test(val), 'Studio - Validate holds both validators; flashcards limits 80 cards, front 160, back 500, hard check 50%');
    ok(by.get('Studio - Respond').parameters.jsCode === v4by.get('Studio - Respond').parameters.jsCode && by.get('Studio - Reject').parameters.jsCode === v4by.get('Studio - Reject').parameters.jsCode && by.get('Job - Classify Outcome').parameters.jsCode === v4by.get('Job - Classify Outcome').parameters.jsCode, 'Respond / Reject / Classify Outcome unchanged: a flashcards answer leaves through the same exits and the same job funnel');
    const gem = by.get('Studio - Call Gemini');
    ok(JSON.stringify(gem.parameters) === JSON.stringify(v4by.get('Studio - Call Gemini').parameters) && JSON.stringify(gem.credentials) === JSON.stringify(by.get('Gemini — Tutor').credentials), 'Studio - Call Gemini unchanged (same credential, timeout from the item, never errors)');
    ok(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').length === 4 && by.get('Job Start Endpoint').parameters.authentication === 'jwtAuth' && by.get('Job Endpoint').parameters.authentication === 'jwtAuth', 'v5 webhooks as v4: JWT, auth, job start, job (both job paths need the JWT)');
    // every Studio exit (mind map and flashcards) still feeds the job funnel
    for (const tnode of ['Build Response', 'Studio - Respond', 'Studio - Reject', 'Quota Exceeded']) ok(wf.connections[tnode].main[0].length === 1 && wf.connections[tnode].main[0][0].node === 'Job - Sync?', `${tnode} feeds only Job - Sync?`);
    // v1..v4 files are not touched by this PR (checked against the committed copies when run from the repo checkout)
    const repoDir = path.join(__dirname, '..');
    if (fs.existsSync(repoDir)) for (const f of ['sth-workflow-v1-additive.json', 'sth-workflow-v2-enforce.json', 'sth-workflow-v3-studio.json', 'sth-workflow-v4-jobs.json']) ok(fs.readFileSync(path.join(repoDir, f), 'utf8') === fs.readFileSync(path.join(__dirname, f), 'utf8'), `${f} is byte-identical to the committed copy`);
  },
});
validate('sth-workflow-v6-quiz.json', {
  noDrive: true,
  check: ({ removed, wf }) => {
    const v5 = JSON.parse(fs.readFileSync(path.join(__dirname, 'sth-workflow-v5-flashcards.json'), 'utf8'));
    const v4 = JSON.parse(fs.readFileSync(path.join(__dirname, 'sth-workflow-v4-jobs.json'), 'utf8'));
    const v5by = new Map(v5.nodes.map((n) => [n.name, n]));
    const v4by = new Map(v4.nodes.map((n) => [n.name, n]));
    const by = new Map(wf.nodes.map((n) => [n.name, n]));
    const names = wf.nodes.map((n) => n.name);
    ok(names.length === v5.nodes.length && names.every((n) => v5by.has(n)) && removed.every((r) => !r.startsWith('Studio')), 'v6 adds and removes no node: the Studio chain branches on `tool`');
    const sig = (n) => JSON.stringify({ p: n.parameters, c: n.credentials, e: n.onError, t: n.type, v: n.typeVersion, d: n.disabled, pos: n.position, id: n.id, w: n.webhookId, r: n.retryOnFail, m: n.maxTries });
    const changed6 = wf.nodes.filter((n) => sig(v5by.get(n.name)) !== sig(n)).map((n) => n.name);
    ok(changed6.slice().sort().join('|') === ['Job - Read Request', 'Quota Prep', 'Route by Mode', 'Studio - Retry Check', 'Studio - Validate', 'Studio - Validate Request'].sort().join('|'), 'v6 changes exactly 6 v5 nodes (Route by Mode, Quota Prep, Studio - Validate Request, Studio - Retry Check, Studio - Validate, Job - Read Request); every other node is byte-identical to v5', changed6);
    ok(wf.nodes.filter((n) => JSON.stringify(n) !== JSON.stringify(v5by.get(n.name))).map((n) => n.name).sort().join('|') === [...changed6, 'Studio - Call Gemini'].sort().join('|'), 'the only other difference to v5 is the note text of Studio - Call Gemini');
    ok(JSON.stringify(wf.settings) === JSON.stringify(v5.settings) && wf.settings.executionTimeout === 720 && wf.settings.saveDataSuccessExecution === 'none' && wf.settings.saveDataErrorExecution === 'none', 'settings identical to v5 (Timeout Workflow 720, no execution data saved)');
    ok(wf.id === v5.id && wf.name === v5.name && JSON.stringify(wf.tags) === JSON.stringify(v5.tags), 'same workflow id and name as v5 (an import replaces it)');
    const edges = (w) => { const s2 = new Set(); for (const [f, v] of Object.entries(w.connections)) v.main.forEach((arr, i) => (arr || []).forEach((c) => s2.add(`${f}[${i}] -> ${c.node}`))); return s2; };
    const e5 = edges(v5), e6 = edges(wf);
    ok([...e5].every((e) => e6.has(e)), 'every v5 connection is still in v6');
    ok(JSON.stringify([...e6].filter((e) => !e5.has(e))) === JSON.stringify(['Route by Mode[10] -> Studio - Validate Request']), 'the only new connection is Route by Mode[10] -> Studio - Validate Request', [...e6].filter((e) => !e5.has(e)));
    const rt = by.get('Route by Mode');
    ok(rt.parameters.rules.values.length === 11 && rt.parameters.rules.values[10].conditions.conditions[0].rightValue === 'studio_quiz' && JSON.stringify(rt.parameters.rules.values.slice(0, 10)) === JSON.stringify(v5by.get('Route by Mode').parameters.rules.values), 'Route by Mode: studio_quiz is output 10, the ten v5 rules are untouched');
    ok(/'studio_mindmap', 'studio_flashcards', 'studio_quiz'\]/.test(by.get('Quota Prep').parameters.jsCode) && by.get('Quota Prep').parameters.jsCode.replace(", 'studio_quiz'", '') === v5by.get('Quota Prep').parameters.jsCode && by.get('Quota Read').parameters.jsonBody === v5by.get('Quota Read').parameters.jsonBody, 'Quota Prep covers studio_quiz and differs from v5 only by the mode; Quota Read (cfg:studio_max_tokens) unchanged');
    // job mode
    const rr = by.get('Job - Read Request').parameters.jsCode;
    ok(rr.includes('studio_quiz: { deadlineS: 420, cap: 1 }') && rr.includes('studio_flashcards: { deadlineS: 420, cap: 1 }') && rr.includes('tutor: { deadlineS: 420, cap: 3 }') && rr.includes('studio_mindmap: { deadlineS: 600, cap: 1 }') && rr.includes('const JOB_CAP_TOTAL = 4;') && rr.includes('const GRACE_S = 60;') && rr.includes('const JOBS_ENABLED = true;'), 'Job - Read Request: four modes (quiz 420 s, cap 1), total cap 4, grace 60 s, jobs on');
    ok(rr.replace(', studio_quiz: { deadlineS: 420, cap: 1 }', '') === v5by.get('Job - Read Request').parameters.jsCode, 'Job - Read Request differs from v5 only by the mode entry');
    { const dl = [...rr.matchAll(/(\w+): \{ deadlineS: (\d+)/g)].map((x) => [x[1], Number(x[2])]); ok(dl.length === 4, 'four job modes declared'); for (const [m, secs] of dl) ok(secs <= 600, `deadline of ${m} is at most 600 s`); }
    // Studio nodes
    const vr = by.get('Studio - Validate Request').parameters.jsCode, rc = by.get('Studio - Retry Check').parameters.jsCode, val = by.get('Studio - Validate').parameters.jsCode;
    for (const nm of ['Studio - Validate Request', 'Studio - Retry Check', 'Studio - Validate', 'Studio - Respond', 'Studio - Reject']) ok(!/\bthrow\b/.test(by.get(nm).parameters.jsCode), `${nm} never throws (no error mail can carry request text)`);
    ok(/STUDIO_CALL_TIMEOUT_MS = 240000;/.test(vr) && /const CALL_TIMEOUT_MS = 240000;/.test(rc), 'call timeout 240000 ms in both nodes');
    ok(/const QZ_COUNTS = \[10, 20, 30\];/.test(vr) && /const QZ_DEFAULT_COUNT = 20;/.test(vr) && /const FC_DIFFICULTIES = \['easy', 'medium', 'hard'\];/.test(vr) && /const FC_COUNTS = \[15, 30, 50\];/.test(vr) && /tool === 'quiz' \? 24576 : 32768/.test(vr) && /sth\.quiz\/1/.test(vr) && /const QUIZ =/.test(vr) && /temperature: tool === 'mindmap' \? 0\.3 : 0\.4/.test(vr) && /thinkingBudget: 1024/.test(vr), 'Validate Request: quiz options (10/20/30 default 20, easy/medium/hard), maxOutputTokens 24576 (flashcards 12288/16384, mind map 32768), temperature 0.4, thinking 1024, schema, prompt');
    ok(vr.includes("const CAP_TOKENS_DEFAULT = 400000;") && vr.includes('const CAP_TOKENS_MIN = 50000;') && vr.includes('const CAP_TOKENS_MAX = 900000;') && vr.includes('const CAP_SOURCES = 10;') && vr.includes('const CAP_IMAGES = 5;') && vr.includes('const CAP_DESCRIPTION = 1000;') && vr.includes('const IMAGE_TOKENS = 1600;'), 'the caps (10 sources, 5 images, 1000 characters, token cap 400000 within 50000..900000, 1600 per image) are unchanged');
    ok(/LARGE_ESTIMATE = 300000;/.test(rc) && /LARGE_MAX_ATTEMPTS = 2;/.test(rc) && /FALLBACK_FROM_ATTEMPT = 3;/.test(rc) && /flashJob/.test(rc) && /st\.tool === 'quiz'/.test(rc), 'Retry Check: large-request rule 300000, flash-lite on attempt 3, quiz job budget from the job deadline');
    ok(!/require\(|process\.|fetch\(|new URL|crypto/.test(val.replace(/\/\/.*$/gm, '')), 'Studio - Validate (inlined library) uses no require/process/fetch/URL/crypto');
    ok(/function studioValidateQuiz/.test(val) && /function studioValidateFlashcards/.test(val) && /function studioValidateMindmap/.test(val) && /MAX_QUESTIONS: 50/.test(val) && /STEM: 300/.test(val) && /OPTION: 160/.test(val) && /RATIONALE: 200/.test(val) && /EXPLANATION: 500/.test(val) && /HINT: 200/.test(val) && /TOPIC: 40/.test(val) && /CITES: 2/.test(val) && /MIN_SHARE: 0\.5/.test(val) && /SALVAGE_SHARE: 0\.7/.test(val), 'Studio - Validate holds the three validators; quiz limits 50 questions, stem 300, option 160, rationale 200, explanation 500, hint 200, topic 40, 2 citations, hard check 50%, salvage 70%');
    ok(by.get('Studio - Respond').parameters.jsCode === v4by.get('Studio - Respond').parameters.jsCode && by.get('Studio - Reject').parameters.jsCode === v4by.get('Studio - Reject').parameters.jsCode && by.get('Job - Classify Outcome').parameters.jsCode === v4by.get('Job - Classify Outcome').parameters.jsCode, 'Respond / Reject / Classify Outcome unchanged: a quiz answer leaves through the same exits and the same job funnel');
    const gem = by.get('Studio - Call Gemini');
    ok(JSON.stringify(gem.parameters) === JSON.stringify(v4by.get('Studio - Call Gemini').parameters) && JSON.stringify(gem.credentials) === JSON.stringify(by.get('Gemini — Tutor').credentials), 'Studio - Call Gemini parameters unchanged (same credential, timeout from the item, never errors)');
    ok(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').length === 4 && by.get('Job Start Endpoint').parameters.authentication === 'jwtAuth' && by.get('Job Endpoint').parameters.authentication === 'jwtAuth', 'v6 webhooks as v4: JWT, auth, job start, job (both job paths need the JWT)');
    for (const tnode of ['Build Response', 'Studio - Respond', 'Studio - Reject', 'Quota Exceeded']) ok(wf.connections[tnode].main[0].length === 1 && wf.connections[tnode].main[0][0].node === 'Job - Sync?', `${tnode} feeds only Job - Sync?`);
    // v1..v5 files are not touched by this PR (checked against the committed copies when run from the repo checkout)
    const repoDir = path.join(__dirname, '..');
    if (fs.existsSync(repoDir)) for (const f of ['sth-workflow-v1-additive.json', 'sth-workflow-v2-enforce.json', 'sth-workflow-v3-studio.json', 'sth-workflow-v4-jobs.json', 'sth-workflow-v5-flashcards.json']) ok(fs.readFileSync(path.join(repoDir, f), 'utf8') === fs.readFileSync(path.join(__dirname, f), 'utf8'), `${f} is byte-identical to the committed copy`);
  },
});
validate('sth-workflow-v7-bundle.json', {
  noDrive: true,
  check: ({ wf }) => {
    const v6 = JSON.parse(fs.readFileSync(path.join(__dirname, 'sth-workflow-v6-quiz.json'), 'utf8'));
    const v6by = new Map(v6.nodes.map((n) => [n.name, n]));
    const by = new Map(wf.nodes.map((n) => [n.name, n]));
    const raw = JSON.stringify(wf);
    const liveByNameV7 = new Set(live.nodes.map((n) => n.name));
    // settings (the owner re-checks them in the UI after every import: runbook 6, 6b, 22)
    ok(JSON.stringify(wf.settings) === JSON.stringify(v6.settings) && wf.settings.executionTimeout === 720 && wf.settings.saveDataSuccessExecution === 'none' && wf.settings.saveDataErrorExecution === 'none', 'settings as v6: Timeout Workflow 720, Do not save for successful and failed executions');
    // the error workflow is the workflow itself and is chosen in the UI (its id exists only after the import), so the file must not name one; the path it serves must be wired
    ok(wf.settings.errorWorkflow === undefined && wf.nodes.some((n) => n.type === 'n8n-nodes-base.errorTrigger') && wf.connections['Error Trigger'].main[0].map((c) => c.node).sort().join('|') === ['Job - Error Lookup', 'Workflow Error Rate Limit'].sort().join('|'), 'Error Trigger present and wired to the mail path and to Job - Error Lookup (the job error path); the error workflow itself is set in the UI');
    // no secrets, only credential references
    ok(!/AIza[0-9A-Za-z_-]{30,}|ya29\.|ghp_[A-Za-z0-9]{20,}|-----BEGIN|upstash-test-token|gemini-test-key|test-secret-0123/.test(raw) && !/Bearer [A-Za-z0-9._-]{20,}/.test(raw), 'no embedded keys or tokens');
    const credKey = (n) => Object.values(n.credentials || {}).map((c) => c.name + '|' + c.id);
    const liveCreds = new Set(live.nodes.flatMap(credKey));
    liveCreds.add('STH JWT|SELECT-STH-JWT');
    ok(wf.nodes.flatMap(credKey).every((k) => liveCreds.has(k)), 'only credential references that the live workflow already uses (plus the STH JWT placeholder): no new credential, no secret value', wf.nodes.flatMap(credKey).filter((k) => !liveCreds.has(k)));
    // every connection target exists, and Route by Mode: 14 rules + the fallback, all 15 outputs wired
    const nameSet = new Set(wf.nodes.map((n) => n.name));
    ok(Object.values(wf.connections).every((v) => v.main.every((a) => (a || []).every((c) => nameSet.has(c.node)))), 'every connection target exists');
    const rb = by.get('Route by Mode');
    ok(rb.parameters.rules.values.length === 14 && rb.parameters.options.fallbackOutput === 'extra' && wf.connections['Route by Mode'].main.length === 15 && wf.connections['Route by Mode'].main.every((a) => a && a.length === 1), 'Route by Mode: 14 rules + the fallback output, all 15 outputs wired to exactly one node');
    ok(wf.connections['Route - Unknown Mode'].main[0][0].node === 'Job - Sync?', 'the fallback answer also feeds Job - Sync?');
    // Redis nodes: time-outs, fail behaviour; every sth: write has an expiry
    for (const n of wf.nodes.filter((x) => /upstash/.test(JSON.stringify(x.parameters.url || '')) && !liveByNameV7.has(x.name))) ok(n.parameters.options && n.parameters.options.timeout > 0 && n.parameters.options.timeout <= 8000, `Redis node has a time-out <= 8 s: ${n.name}`);
    for (const nm of ['Job - Budget Read']) ok(by.get(nm).onError === 'continueRegularOutput' && by.get(nm).parameters.options.timeout === 5000 && by.get(nm).credentials.httpHeaderAuth.name === 'Upstash Redis REST', `${nm}: fail-open, 5 s, Upstash credential`);
    for (const f of ['src/job7-admit.lua', 'src/job7-store.lua']) { const lua = fs.readFileSync(path.join(__dirname, f), 'utf8'); ok(/EXPIRE|'EX'/.test(lua) && !/cjson/.test(lua), `${f}: expiry on every write`); }
    const writes = wf.nodes.filter((n) => /redis\.call\('(SET|HSET|ZADD|INCR|HINCRBY|INCRBY)/.test(JSON.stringify(n.parameters.jsonBody || '')));
    ok(writes.every((n) => /EXPIRE|'EX'|"EX"/.test(n.parameters.jsonBody)), 'every Redis write node sets an expiry: ' + writes.map((n) => n.name).join(', '));
    // Gemini calls: the job calls never repeat; the direct calls keep their v6 settings; no node retries on a job node
    for (const nm of ['Transcription', 'Template', 'Reviewer']) {
      const jc = by.get(`Call Gemini (${nm}, job)`);
      ok(!jc.retryOnFail && !jc.maxTries && jc.parameters.options.timeout === 280000 && jc.onError === 'continueRegularOutput', `Call Gemini (${nm}, job): no node retry, 280 s, never errors`);
      ok(JSON.stringify(by.get(`Call Gemini (${nm})`)) === JSON.stringify(v6by.get(`Call Gemini (${nm})`)) || JSON.stringify({ ...by.get(`Call Gemini (${nm})`), notes: 0 }) === JSON.stringify({ ...v6by.get(`Call Gemini (${nm})`), notes: 0 }), `Call Gemini (${nm}): the direct call is unchanged`);
    }
    ok(wf.nodes.every((n) => !/Gemini|Studio - Call/.test(n.name) || n.name === 'Studio - Call Gemini' || !n.retryOnFail || !/job/.test(n.name)), 'no retrying Gemini node has "job" in its name');
    ok(by.get('Studio - Call Gemini').retryOnFail === undefined && JSON.stringify(by.get('Studio - Call Gemini').parameters) === JSON.stringify(v6by.get('Studio - Call Gemini').parameters), 'Studio - Call Gemini unchanged (retries decided by Studio - Retry Check)');
    // J4 terminals feed Job - Sync?; the three Extract nodes and Meter nodes
    for (const e of ['Extract Transcription Text', 'Extract Template Text', 'Extract Reviewer Text']) ok(wf.connections[e].main[0].length === 1 && wf.connections[e].main[0][0].node === 'Job - Sync?', `${e} feeds only Job - Sync?`);
    // webhooks unchanged (four, JWT)
    ok(wf.nodes.filter((n) => n.type === 'n8n-nodes-base.webhook').length === 4 && by.get('Job Endpoint').parameters.authentication === 'jwtAuth' && by.get('Job Start Endpoint').parameters.authentication === 'jwtAuth' && by.get('Student Hub Endpoint (JWT)').parameters.authentication === 'jwtAuth', 'webhooks as v6: four, the three job / studio webhooks need the JWT');
    // hello + constants of the job gateway
    const rr = by.get('Job - Read Request').parameters.jsCode;
    ok(/const SERVER_V = 7;/.test(rr) && /const JOB_CAP_TOTAL = 4;/.test(rr) && /const JOB_CAP_BULK = 2;/.test(rr) && /const JOB_RESERVE = 2;/.test(rr) && /maxSources: 15/.test(rr), 'job gateway constants: v 7, total cap 4, bulk cap 2, reserve 2, 15 sources');
    for (const m of ['studio_infographic: { deadlineS: 420, cap: 1 }', 'studio_slides: { deadlineS: 420, cap: 1 }', 'studio_digest: { deadlineS: 420, cap: 2, bulk: true }', 'transcribe: { deadlineS: 600, cap: 2, bulk: true }', 'template: { deadlineS: 600, cap: 1, bulk: true }', 'reviewer: { deadlineS: 600, cap: 1, bulk: true }']) ok(rr.includes(m), `job mode ${m}`);
    ok(/\{ deadlineS: (\d+)/.test(rr) && [...rr.matchAll(/deadlineS: (\d+)/g)].every((m) => Number(m[1]) <= 600), 'every job deadline <= 600 s');
    // the studio chain: no secret text in Code nodes that throw; no Studio node throws
    for (const nm of ['Studio - Validate Request', 'Studio - Retry Check', 'Studio - Validate']) ok(!/\bthrow\b/.test(by.get(nm).parameters.jsCode), `${nm} never throws`);
    ok(by.get('Studio - Validate Request').parameters.jsCode.includes("STUDIO_PROMPT_VERSION_V7 = 'studio-2026-12-a'") && by.get('Studio - Validate Request').parameters.jsCode.includes("const STUDIO_PROMPT_VERSION = 'studio-2026-11-a';"), 'prompt versions: v6 tools keep 2026-11-a, the new tools use 2026-12-a');
    // v1..v6 files are not touched by this PR (checked against the committed copies when run from the repo checkout)
    const repoDir = process.env.REPO_N8N || path.join(__dirname, '..');
    if (fs.existsSync(repoDir)) for (const f of ['sth-workflow-v1-additive.json', 'sth-workflow-v2-enforce.json', 'sth-workflow-v3-studio.json', 'sth-workflow-v4-jobs.json', 'sth-workflow-v5-flashcards.json', 'sth-workflow-v6-quiz.json']) ok(fs.readFileSync(path.join(repoDir, f), 'utf8') === fs.readFileSync(path.join(__dirname, f), 'utf8'), `${f} is byte-identical to the committed copy`);
    ok(wf.id === v6.id && wf.name === v6.name && JSON.stringify(wf.tags) === JSON.stringify(v6.tags), 'same workflow id and name as v6 (an import replaces it)');
    ok(wf.nodes.length === 197, 'v7 has 197 nodes (v6: 185, +12)', wf.nodes.length);
  },
});
console.log(`\n${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
