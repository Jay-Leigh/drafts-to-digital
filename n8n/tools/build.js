// Builds sth-workflow-v1..v8 (v5 = flashcards, v6 = quiz, v7 = bundle: infographic, slides, J4 jobs, map-reduce server side, v8 = v7 + token renewal, auth epoch, job claim / collected) from live.json.
// Usage: node build.js
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const live = JSON.parse(fs.readFileSync(path.join(DIR, 'live.json'), 'utf8'));
const src = (f) => fs.readFileSync(path.join(DIR, 'src', f), 'utf8').replace(/\s+$/, '') + '\n';

const UPSTASH_URL = 'https://sweeping-jennet-172408.upstash.io';
const UPSTASH_CRED = { httpHeaderAuth: { id: 'VnWFZXj8xOxogUEA', name: 'Upstash Redis REST' } };
const JWT_CRED_NAME = 'STH JWT';
// Placeholder id: the owner selects the real credential after import (runbook step).
const JWT_CRED = { jwtAuth: { id: 'SELECT-STH-JWT', name: JWT_CRED_NAME } };

const uuid = (seed) => {
  const h = crypto.createHash('sha1').update('sth-prb:' + seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

// Redis: atomic "INCR, and set the expiry on first creation" (fixed window).
const EVAL_INCR =
  "local c = redis.call('INCR', KEYS[1]) if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return c";
// Redis: INCR attempts + read the stored code in one round trip -> {code, count}
const EVAL_AUTH =
  "local c = redis.call('INCR', KEYS[2]) if c == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end return {redis.call('GET', KEYS[1]), c}";

// Redis: usage meter (INCRBY weighted units, expiry set when the key has none)
const EVAL_INCRBY =
  "local c = redis.call('INCRBY', KEYS[1], ARGV[1]) if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end return c";
const meterExpr = (usageSrc) =>
  `={{ (() => { const u = ${usageSrc} || {}; const n = (v) => Number(v) || 0; ` +
  `const units = Math.round(n(u.promptTokenCount) + 4 * (n(u.candidatesTokenCount) + n(u.thoughtsTokenCount))); ` +
  `return ["EVAL", ${JSON.stringify(EVAL_INCRBY)}, "1", "usage:" + new Date().toISOString().slice(0, 10).replace(/-/g, ''), String(units), "259200"]; })() }}`;

const todayExpr = "new Date().toISOString().slice(0, 10).replace(/-/g, '')";

function codeNode(name, jsCode, position, extra = {}) {
  return {
    parameters: { jsCode },
    id: uuid(name),
    name,
    type: 'n8n-nodes-base.code',
    typeVersion: 2,
    position,
    ...extra,
  };
}

function redisNode(name, bodyExpr, position, extra = {}) {
  return {
    parameters: {
      method: 'POST',
      url: UPSTASH_URL,
      authentication: 'genericCredentialType',
      genericAuthType: 'httpHeaderAuth',
      sendBody: true,
      specifyBody: 'json',
      jsonBody: bodyExpr,
      options: { timeout: 8000 },
    },
    id: uuid(name),
    name,
    type: 'n8n-nodes-base.httpRequest',
    typeVersion: 4.4,
    position,
    credentials: UPSTASH_CRED,
    onError: 'continueRegularOutput',
    ...extra,
  };
}

function respondNode(name, code, bodyExpr, position) {
  return {
    parameters: {
      respondWith: 'json',
      responseBody: bodyExpr,
      options: {
        responseCode: code,
        responseHeaders: { entries: [{ name: 'Cache-Control', value: 'no-store' }] },
      },
    },
    id: uuid(name),
    name,
    type: 'n8n-nodes-base.respondToWebhook',
    typeVersion: 1.1,
    position,
  };
}

function ifNode(name, expr, position) {
  return {
    parameters: {
      conditions: {
        options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 1 },
        conditions: [
          {
            id: uuid(name + ':cond'),
            leftValue: expr,
            rightValue: true,
            operator: { type: 'boolean', operation: 'true', singleValue: true },
          },
        ],
        combinator: 'and',
      },
      options: {},
    },
    id: uuid(name),
    name,
    type: 'n8n-nodes-base.if',
    typeVersion: 2,
    position,
  };
}

function outcomeSwitch(name, outcomes, position) {
  return {
    parameters: {
      rules: {
        values: outcomes.map((o) => ({
          conditions: {
            options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
            conditions: [
              {
                id: uuid(name + ':' + o),
                leftValue: '={{ $json.outcome }}',
                rightValue: o,
                operator: { type: 'string', operation: 'equals' },
              },
            ],
            combinator: 'and',
          },
          renameOutput: true,
          outputKey: o,
        })),
      },
      options: {},
    },
    id: uuid(name),
    name,
    type: 'n8n-nodes-base.switch',
    typeVersion: 3,
    position,
  };
}

function link(conns, from, to, outIdx = 0) {
  conns[from] = conns[from] || { main: [] };
  while (conns[from].main.length <= outIdx) conns[from].main.push([]);
  conns[from].main[outIdx].push({ node: to, type: 'main', index: 0 });
}
function unlinkAllFrom(conns, from) {
  delete conns[from];
}
function replaceTarget(conns, from, oldTo, newTo) {
  for (const arr of conns[from].main) for (const c of arr) if (c.node === oldTo) c.node = newTo;
}
function removeNodes(wf, names) {
  const set = new Set(names);
  wf.nodes = wf.nodes.filter((n) => !set.has(n.name));
  for (const k of Object.keys(wf.connections)) {
    if (set.has(k)) {
      delete wf.connections[k];
      continue;
    }
    for (const t of Object.keys(wf.connections[k])) {
      wf.connections[k][t] = wf.connections[k][t].map((arr) => (arr || []).filter((c) => !set.has(c.node)));
    }
  }
}
const byName = (wf, name) => {
  const n = wf.nodes.find((x) => x.name === name);
  if (!n) throw new Error('node not found: ' + name);
  return n;
};
function mustReplace(str, a, b) {
  if (!str.includes(a)) throw new Error('replace target not found: ' + a.slice(0, 60));
  return str.split(a).join(b);
}

function buildV1() {
  const wf = JSON.parse(JSON.stringify(live));
  wf.active = false;
  wf.settings = { ...wf.settings, saveDataSuccessExecution: 'none', saveDataErrorExecution: 'none' };

  // ── a. JWT webhook + legacy counter ────────────────────────────────────────
  wf.nodes.push({
    parameters: {
      httpMethod: 'POST',
      path: 'student-tools-v2',
      authentication: 'jwtAuth',
      responseMode: 'lastNode',
      options: { rawBody: false, allowedOrigins: 'https://jay-leigh.github.io' },
    },
    id: uuid('Student Hub Endpoint (JWT)'),
    name: 'Student Hub Endpoint (JWT)',
    type: 'n8n-nodes-base.webhook',
    typeVersion: 2,
    position: [13856, 1360],
    webhookId: uuid('webhook:student-tools-v2'),
    credentials: JWT_CRED,
  });
  link(wf.connections, 'Student Hub Endpoint (JWT)', 'Normalize Multipart Body');

  // Legacy webhook -> counter -> restore item -> Normalize (sequential, so the response always comes
  // from the main chain; the counter is fail-open and has a short timeout).
  wf.nodes.push(
    redisNode(
      'Legacy Counter',
      `={{ ["EVAL", ${JSON.stringify(EVAL_INCR)}, "1", "stats:legacy:" + ${todayExpr}, "604800"] }}`,
      [13856, 1760],
      { notes: 'Counts calls to the legacy path student-tools (key stats:legacy:YYYYMMDD UTC, kept 7 days). Fail-open.' }
    ),
    codeNode('Legacy Restore Request', src('legacy-restore.js'), [14080, 1760])
  );
  wf.nodes.find((n) => n.name === 'Legacy Counter').parameters.options.timeout = 3000;
  replaceTarget(wf.connections, 'Student Hub Endpoint', 'Normalize Multipart Body', 'Legacy Counter');
  link(wf.connections, 'Legacy Counter', 'Legacy Restore Request');
  link(wf.connections, 'Legacy Restore Request', 'Normalize Multipart Body');

  // ── b. Auth endpoint ───────────────────────────────────────────────────────
  const AY = 3300;
  wf.nodes.push(
    {
      parameters: {
        httpMethod: 'POST',
        path: 'student-tools-auth',
        authentication: 'none',
        responseMode: 'responseNode',
        options: { rawBody: false, allowedOrigins: 'https://jay-leigh.github.io' },
      },
      id: uuid('Auth Endpoint'),
      name: 'Auth Endpoint',
      type: 'n8n-nodes-base.webhook',
      typeVersion: 2,
      position: [13856, AY],
      webhookId: uuid('webhook:student-tools-auth'),
    },
    codeNode('Auth Prepare', src('auth-prepare.js'), [14080, AY]),
    redisNode(
      'Auth Redis Attempt',
      `={{ ["EVAL", ${JSON.stringify(EVAL_AUTH)}, "2", "auth:code", $json.failKey, "600"] }}`,
      [14304, AY],
      { notes: 'Counts this attempt (key auth:fail:<ip>, window 600 s) and reads auth:code.' }
    ),
    codeNode('Auth Evaluate', src('auth-evaluate.js'), [14528, AY]),
    outcomeSwitch('Auth Outcome', ['match', 'mismatch', 'blocked', 'unavailable'], [14752, AY]),
    redisNode('Auth Clear Attempts', '={{ ["DEL", $json.failKey] }}', [14976, AY - 200]),
    redisNode(
      'Auth Issue Cap',
      `={{ ["EVAL", ${JSON.stringify(EVAL_INCR)}, "1", $('Auth Prepare').first().json.okKey, "3600"] }}`,
      [15200, AY - 200],
      { notes: 'Successful sign-ins per IP (auth:ok:<ip>, 3600 s window, max 20). Never cleared.' }
    ),
    codeNode('Auth Issue Check', src('auth-issue-check.js'), [15424, AY - 200]),
    outcomeSwitch('Auth Issue Route', ['ok', 'capped', 'unavailable'], [15648, AY - 200]),
    codeNode('Auth Build Claims', src('auth-build-claims.js'), [15872, AY - 300]),
    {
      parameters: {
        operation: 'sign',
        useJson: true,
        claimsJson: '={{ $json.claimsJson }}',
        headerClaims: '{}',
        options: {},
      },
      id: uuid('Auth Sign JWT'),
      name: 'Auth Sign JWT',
      type: 'n8n-nodes-base.jwt',
      typeVersion: 1,
      position: [16096, AY - 300],
      credentials: JWT_CRED,
      onError: 'continueRegularOutput',
    },
    codeNode(
      'Auth Shape Token',
      "const t = $input.first().json && $input.first().json.token;\nconst c = $('Auth Build Claims').first().json;\nif (typeof t !== 'string' || !t) return [{ json: { ok: false } }];\nreturn [{ json: { ok: true, token: t, expiresAt: c.expiresAt } }];\n",
      [16320, AY - 300]
    ),
    ifNode('Auth Token Ok?', '={{ $json.ok === true }}', [16544, AY - 300]),
    respondNode('Auth Respond OK', 200, '={{ JSON.stringify({ token: $json.token, expiresAt: $json.expiresAt }) }}', [16768, AY - 400]),
    respondNode('Auth Respond 500', 500, '={{ JSON.stringify({ error: "server_error" }) }}', [16768, AY - 200]),
    respondNode('Auth Respond 429 Rate Limited', 429, '={{ JSON.stringify({ error: "rate_limited" }) }}', [15872, AY - 50]),
    respondNode('Auth Respond 401', 401, '={{ JSON.stringify({ error: "invalid_code" }) }}', [14976, AY + 0]),
    respondNode('Auth Respond 429', 429, '={{ JSON.stringify({ error: "too_many_attempts" }) }}', [14976, AY + 200]),
    respondNode('Auth Respond 503', 503, '={{ JSON.stringify({ error: "unavailable" }) }}', [14976, AY + 400])
  );
  const c = wf.connections;
  link(c, 'Auth Endpoint', 'Auth Prepare');
  link(c, 'Auth Prepare', 'Auth Redis Attempt');
  link(c, 'Auth Redis Attempt', 'Auth Evaluate');
  link(c, 'Auth Evaluate', 'Auth Outcome');
  link(c, 'Auth Outcome', 'Auth Clear Attempts', 0);
  link(c, 'Auth Outcome', 'Auth Respond 401', 1);
  link(c, 'Auth Outcome', 'Auth Respond 429', 2);
  link(c, 'Auth Outcome', 'Auth Respond 503', 3);
  link(c, 'Auth Clear Attempts', 'Auth Issue Cap');
  link(c, 'Auth Issue Cap', 'Auth Issue Check');
  link(c, 'Auth Issue Check', 'Auth Issue Route');
  link(c, 'Auth Issue Route', 'Auth Build Claims', 0);
  link(c, 'Auth Issue Route', 'Auth Respond 429 Rate Limited', 1);
  link(c, 'Auth Issue Route', 'Auth Respond 503', 2);
  link(c, 'Auth Build Claims', 'Auth Sign JWT');
  link(c, 'Auth Sign JWT', 'Auth Shape Token');
  link(c, 'Auth Shape Token', 'Auth Token Ok?');
  link(c, 'Auth Token Ok?', 'Auth Respond OK', 0);
  link(c, 'Auth Token Ok?', 'Auth Respond 500', 1);

  // ── c. Safe Fetch ──────────────────────────────────────────────────────────
  const lib = src('safefetch.lib.js');
  const SF_NOTE =
    'Safe Fetch (shared logic). Replaces the HTTP Request node: validates URL + DNS-over-HTTPS, blocks private targets, follows redirects manually (max 5), 20 s timeout, 4 MB cap.';
  for (const [name, epi] of [
    ['Scrape — Fetch URL', 'scrape-fetch.epilogue.js'],
    ['Scrape Template URL', 'scrape-text.epilogue.js'],
    ['Scrape Reviewer URL', 'scrape-text.epilogue.js'],
  ]) {
    const old = byName(wf, name);
    const idx = wf.nodes.indexOf(old);
    wf.nodes[idx] = {
      parameters: { jsCode: lib + '\n' + src(epi) },
      id: old.id,
      name: old.name,
      type: 'n8n-nodes-base.code',
      typeVersion: 2,
      position: old.position,
      notes: SF_NOTE,
      notesInFlow: false,
    };
  }
  byName(wf, 'Reference').parameters.options.allowUnauthorizedCerts = false;

  // ── d. Error e-mails ───────────────────────────────────────────────────────
  const errLib = src('err.lib.js');
  const hnd = byName(wf, 'Handle Error Report1');
  hnd.parameters.jsCode = mustReplace(src('handle-error-report.js'), '__ERR_LIB__', errLib);
  hnd.position = [16768, 1584];
  byName(wf, 'Send Error Email1').position = [17216, 1584];
  byName(wf, 'Error Email Response1').position = [17440, 1584];
  wf.nodes.push(
    redisNode(
      'Error Rate Limit',
      `={{ ["EVAL", ${JSON.stringify(EVAL_INCR)}, "1", "err:" + ${todayExpr}, "172800"] }}`,
      [16544, 1584],
      { notes: 'Counts error reports per UTC day (err:YYYYMMDD, kept 2 days). Max 50 e-mails/day; fail-closed (drop).' }
    ),
    ifNode('Error Under Cap?', '={{ $json.drop !== true }}', [16992, 1584])
  );
  replaceTarget(wf.connections, 'Route by Mode', 'Handle Error Report1', 'Error Rate Limit');
  link(wf.connections, 'Error Rate Limit', 'Handle Error Report1');
  link(wf.connections, 'Handle Error Report1', 'Error Under Cap?');
  unlinkAllFrom(wf.connections, 'Handle Error Report1');
  link(wf.connections, 'Handle Error Report1', 'Error Under Cap?');
  link(wf.connections, 'Error Under Cap?', 'Send Error Email1', 0);
  link(wf.connections, 'Error Under Cap?', 'Error Email Response1', 1);

  byName(wf, 'Format Workflow Error1').parameters.jsCode = mustReplace(src('format-workflow-error.js'), '__ERR_LIB__', errLib);

  // ── e. OCR cache TTL, Clean HTML reference ─────────────────────────────────
  const ocrSet = byName(wf, 'OCR — Redis SET');
  ocrSet.parameters.jsonBody = '={{ ["SET", $json.cacheKey, $json.cacheValue, "EX", "2592000"] }}';
  const clean = byName(wf, 'Clean HTML — Scrape');
  clean.parameters.jsCode = mustReplace(
    clean.parameters.jsCode,
    "$('Student Hub Endpoint').first().json.body",
    "$('Normalize Multipart Body').first().json.body"
  );
  clean.parameters.jsCode = mustReplace(
    clean.parameters.jsCode,
    "const status = input.statusCode || (input.body && input.body.error ? 500 : null);\n",
    "const status = input.statusCode || (input.body && input.body.error ? 500 : null);\nif (input.blocked) return [{ json: { error: true, message: 'This address cannot be read. Only public http/https websites are supported.' } }];\n"
  );

  // ── PB+ (round 2) ──────────────────────────────────────────────────────────
  // 4. workflow-error mails: shared daily cap (same key as client error reports)
  wf.nodes.push(
    redisNode(
      'Workflow Error Rate Limit',
      `={{ ["EVAL", ${JSON.stringify(EVAL_INCR)}, "1", "err:" + ${todayExpr}, "172800"] }}`,
      [14080, 2496],
      { notes: 'Shared with client error reports: err:YYYYMMDD, max 50 e-mails/day in total; fail-closed (drop).' }
    ),
    ifNode('Workflow Error Under Cap?', '={{ $json.drop !== true }}', [14528, 2496])
  );
  byName(wf, 'Format Workflow Error1').position = [14304, 2496];
  byName(wf, 'Send Workflow Error Email1').position = [14752, 2496];
  unlinkAllFrom(wf.connections, 'Error Trigger');
  link(wf.connections, 'Error Trigger', 'Workflow Error Rate Limit');
  link(wf.connections, 'Workflow Error Rate Limit', 'Format Workflow Error1');
  unlinkAllFrom(wf.connections, 'Format Workflow Error1');
  link(wf.connections, 'Format Workflow Error1', 'Workflow Error Under Cap?');
  link(wf.connections, 'Workflow Error Under Cap?', 'Send Workflow Error Email1', 0);

  // 2. tutor: server-held persona + caps on the JWT path (legacy path unchanged)
  const prep = byName(wf, 'Prep — Tutor');
  let pj = prep.parameters.jsCode;
  pj = mustReplace(pj, 'const documentHash = input.documentHash;', 'const documentHash = input.documentHash;\n\n' + src('tutor-persona.js'));
  pj = mustReplace(pj, '${body.systemPrompt}', '${personaPrompt}');
  pj = mustReplace(
    pj,
    'generationConfig: {\n    temperature: 0.7,\n    maxOutputTokens: 49152\n  }',
    'generationConfig: viaJwt\n    ? { temperature: 0.7, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 2048 } }\n    : { temperature: 0.7, maxOutputTokens: 49152 }'
  );
  pj = mustReplace(pj, 'role: latestMessage.role,', "role: viaJwt ? 'user' : latestMessage.role,");
  prep.parameters.jsCode = pj;
  for (const nm of ['Build Transcription Payload', 'Build Template Payload', 'Build Reviewer Payload']) {
    const n = byName(wf, nm);
    n.parameters.jsCode = mustReplace(
      n.parameters.jsCode,
      'return { json: { geminiPayload } };',
      "// Cost cap on the JWT path only (legacy requests are unchanged until v2)\nif ($('Normalize Multipart Body').first().json.jwtPayload) geminiPayload.generationConfig.thinkingConfig = { thinkingBudget: 2048 };\nreturn { json: { geminiPayload } };"
    );
  }

  // 3. session trim
  const ssb = byName(wf, 'Save Session Builder');
  ssb.parameters.jsCode = mustReplace(
    mustReplace(
      ssb.parameters.jsCode,
      'const conversation = [\n    ...(previous.conversation || [])\n];',
      "// Stored session stays small: last 30 entries, each capped (TTL stays 3 h)\nconst MAX_STORED_ENTRIES = 30;\nconst MAX_ENTRY_CHARS = 8000;\nconst capConversation = list => list.slice(-MAX_STORED_ENTRIES).map(m => (m && typeof m.text === 'string' && m.text.length > MAX_ENTRY_CHARS) ? { ...m, text: m.text.slice(0, MAX_ENTRY_CHARS) + '\\n…[truncated]' } : m);\n\nconst conversation = [\n    ...(previous.conversation || [])\n];"
    ),
    '    conversation,\n',
    '    conversation: capConversation(conversation),\n'
  );

  // 5. cost metering + daily ceiling
  wf.nodes.push(
    codeNode('Quota Prep', src('quota-prep.js'), [14080, 1888]),
    ifNode('Quota Needed?', '={{ $json._quota.check === true }}', [14304, 1888]),
    redisNode(
      'Quota Read',
      `={{ ["MGET", "usage:" + ${todayExpr}, "cfg:daily_units"] }}`,
      [14528, 1888],
      { notes: 'Reads today\'s weighted usage and the optional ceiling cfg:daily_units. Fail-open.' }
    ),
    codeNode('Quota Evaluate', src('quota-evaluate.js'), [14752, 1888]),
    ifNode('Quota Over?', '={{ $json._quota.over === true }}', [14976, 1888]),
    codeNode('Quota Exceeded', src('quota-exceeded.js'), [15200, 1984])
  );
  wf.nodes.find((n) => n.name === 'Quota Read').parameters.options.timeout = 5000;
  replaceTarget(wf.connections, 'Normalize Multipart Body', 'Extract Scanned PDF Bytes', 'Quota Prep');
  link(wf.connections, 'Quota Prep', 'Quota Needed?');
  link(wf.connections, 'Quota Needed?', 'Quota Read', 0);
  link(wf.connections, 'Quota Needed?', 'Extract Scanned PDF Bytes', 1);
  link(wf.connections, 'Quota Read', 'Quota Evaluate');
  link(wf.connections, 'Quota Evaluate', 'Quota Over?');
  link(wf.connections, 'Quota Over?', 'Quota Exceeded', 0);
  link(wf.connections, 'Quota Over?', 'Extract Scanned PDF Bytes', 1);

  const meters = [
    ['Call Gemini (Transcription)', 'Extract Transcription Text', 'Meter Usage (Transcription)'],
    ['Call Gemini (Template)', 'Extract Template Text', 'Meter Usage (Template)'],
    ['Call Gemini (Reviewer)', 'Extract Reviewer Text', 'Meter Usage (Reviewer)'],
    ['Reference', 'Extract Reference Citation', 'Meter Usage (Reference)'],
  ];
  for (const [gem, ext, meter] of meters) {
    const g = byName(wf, gem);
    wf.nodes.push(
      redisNode(meter, meterExpr('($json.body && $json.body.usageMetadata) || $json.usageMetadata'), [g.position[0] + 112, g.position[1] + 128], {
        notes: 'Adds this call to usage:YYYYMMDD (weighted units: prompt + 4 x (output + thinking)). Fail-open.',
      })
    );
    replaceTarget(wf.connections, gem, ext, meter);
    link(wf.connections, meter, ext);
    const e = byName(wf, ext);
    e.parameters.jsCode = mustReplace(e.parameters.jsCode, 'const response = $input.first().json;', `const response = $('${gem}').first().json;`);
  }
  {
    const et = byName(wf, 'Extract Tutor Text');
    et.parameters.jsCode = mustReplace(
      et.parameters.jsCode,
      'return { json: {\n  result: text,',
      'return { json: {\n  usage: response.body?.usageMetadata || null,\n  result: text,'
    );
    const g = byName(wf, 'Extract Tutor Text');
    wf.nodes.push(
      redisNode('Meter Usage (Tutor)', meterExpr('$json.usage'), [g.position[0] + 112, g.position[1] + 128], {
        notes: 'Adds the (final) tutor call to usage:YYYYMMDD. Fail-open.',
      })
    );
    replaceTarget(wf.connections, 'Extract Tutor Text', 'Save Session Builder', 'Meter Usage (Tutor)');
    link(wf.connections, 'Meter Usage (Tutor)', 'Save Session Builder');
  }
  for (const n of wf.nodes.filter((x) => x.name.startsWith('Meter Usage'))) n.parameters.options.timeout = 5000;

  return wf;
}

function buildV2(v1) {
  const wf = JSON.parse(JSON.stringify(v1));
  removeNodes(wf, [
    'Student Hub Endpoint',
    'Legacy Counter',
    'Legacy Restore Request',
    'Needs DOC Conversion?',
    'Convert DOC Base64 To Binary',
    'Init Drive Import Upload',
    'Extract Drive Upload URL',
    'Drive Upload DOC Bytes',
    'Extract Drive Temp File ID',
    'Drive Export As PDF',
    'Drive Delete Temp File',
    'Finalize Converted PDF',
  ]);
  link(wf.connections, 'Extract Scanned PDF Bytes', 'Route by Mode');
  byName(wf, 'Student Hub Endpoint (JWT)').position = [13856, 1584];

  const ex = byName(wf, 'Extract Scanned PDF Bytes');
  const start = ex.parameters.jsCode.indexOf('  } else if (doc.driveFileId');
  const end = ex.parameters.jsCode.indexOf('  }\n\n  body.scannedPdfDocs');
  if (start < 0 || end < 0 || end < start) throw new Error('Extract Scanned PDF Bytes layout changed');
  ex.parameters.jsCode = ex.parameters.jsCode.slice(0, start) + ex.parameters.jsCode.slice(end);
  return wf;
}

// v3 = v2 + Study Studio mind map (mode studio_mindmap on the JWT webhook, one synchronous request/response).
// It REPLACES v2 (import v3 instead of v2). Everything that is not listed here is byte-for-byte v2.
function buildV3(v2) {
  const wf = JSON.parse(JSON.stringify(v2));

  // a. Cost ceiling also guards the new mode (same Quota Prep / Quota Read / Quota Evaluate nodes)
  const qp = byName(wf, 'Quota Prep');
  qp.parameters.jsCode = mustReplace(
    qp.parameters.jsCode,
    "const GEMINI_MODES = ['transcribe', 'template', 'reviewer', 'reference', 'tutor'];",
    "const GEMINI_MODES = ['transcribe', 'template', 'reviewer', 'reference', 'tutor', 'studio_mindmap'];"
  );

  // a2. The Studio token cap is the optional Upstash key cfg:studio_max_tokens, read in the same round trip as the daily ceiling
  const qr = byName(wf, 'Quota Read');
  qr.parameters.jsonBody = mustReplace(qr.parameters.jsonBody, '"cfg:daily_units"]', '"cfg:daily_units", "cfg:studio_max_tokens"]');
  qr.notes = mustReplace(qr.notes, 'the optional ceiling cfg:daily_units.', 'the optional ceiling cfg:daily_units and (v3) the optional Studio token cap cfg:studio_max_tokens.');

  // b. Tutor: [Page N] markers in the chunker, and the study-aid handoff sentence in the server persona
  const prep = byName(wf, 'Prep — Tutor');
  prep.parameters.jsCode = mustReplace(
    prep.parameters.jsCode,
    "const markers = paragraph.match(/\\[Scan page (\\d+)\\]/g);",
    "const markers = paragraph.match(/\\[(?:Scan )?[Pp]age (\\d+)\\]/g);"
  );
  prep.parameters.jsCode = mustReplace(
    prep.parameters.jsCode,
    '\n\nOUTPUT LENGTH LIMITS:',
    '\n\n' + src('tutor-persona-studio.txt').trim() + '\n\nOUTPUT LENGTH LIMITS:'
  );
  prep.parameters.jsCode = mustReplace(prep.parameters.jsCode, 'const TUTOR_PROMPT_VERSION = 1;', 'const TUTOR_PROMPT_VERSION = 2;');
  prep.parameters.jsCode = mustReplace(prep.parameters.jsCode, '(promptVersion 1)', '(promptVersion 2)');

  // c. Route by Mode: new last output (index 8) for studio_mindmap
  const route = byName(wf, 'Route by Mode');
  route.parameters.rules.values.push({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          id: uuid('route:studio_mindmap'),
          leftValue: '={{ $json.body.mode }}',
          rightValue: 'studio_mindmap',
          operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
        },
      ],
      combinator: 'and',
    },
  });

  // d. The Studio branch
  const X = 16544;
  const Y = 4000;
  const geminiCred = byName(wf, 'Gemini — Tutor').credentials;
  const libJs = src('studio-validate.lib.js');
  wf.nodes.push(
    codeNode('Studio - Validate Request', src('studio-validate-request.js'), [X, Y], {
      notes:
        'Study Studio mind map. Re-checks the request (1-10 sources, <=5 images, description <=1000, language in the list, server token estimate <= cfg:studio_max_tokens, default 400000, hard maximum 900000) and builds the Gemini request. Rejections return only a fixed error code, never request text.',
    }),
    ifNode('Studio - Request Ok?', '={{ $json.ok === true }}', [X + 224, Y]),
    codeNode('Studio - Reject', src('studio-reject.js'), [X + 448, Y + 200]),
    {
      parameters: {
        method: 'POST',
        url: '=https://generativelanguage.googleapis.com/v1beta/models/{{ $json.model }}:generateContent',
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        contentType: 'raw',
        rawContentType: 'application/json',
        body: '={{ JSON.stringify($json.geminiBody) }}',
        options: { response: { response: { fullResponse: true, neverError: true } }, timeout: '={{ $json.timeoutMs }}' },
      },
      id: uuid('Studio - Call Gemini'),
      name: 'Studio - Call Gemini',
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [X + 448, Y - 100],
      credentials: geminiCred,
      onError: 'continueRegularOutput',
      notes:
        'gemini-2.5-flash (flash-lite only on attempt 3), JSON mode with the mind map schema. Node timeout comes from the item (240000 ms, shorter when the request budget is running out). Never errors: failures are handled by Studio - Retry Check.',
    },
    codeNode('Studio - Retry Check', src('studio-retry-check.js'), [X + 672, Y - 100]),
    ifNode('Studio - Retry?', '={{ $json.retry === true }}', [X + 896, Y - 100]),
    {
      parameters: { amount: '={{ $json.waitSeconds }}', unit: 'seconds' },
      id: uuid('Studio - Wait Retry'),
      name: 'Studio - Wait Retry',
      type: 'n8n-nodes-base.wait',
      typeVersion: 1.1,
      position: [X + 896, Y + 120],
      webhookId: uuid('webhook:studio-wait-retry'),
    },
    codeNode('Studio - Validate', libJs + '\n' + src('studio-validate.epilogue.js'), [X + 1120, Y - 200], {
      notes: 'Parses, validates and repairs the mind map (single root, orphans, cycles, depth, caps, citations checked against the request sources). Pure function: no network, no globals.',
    }),
    ifNode('Studio - Metered?', '={{ $json.meterUnits > 0 }}', [X + 1344, Y - 200]),
    redisNode(
      'Studio - Meter Usage',
      `={{ ["EVAL", ${JSON.stringify(EVAL_INCRBY)}, "1", "usage:" + ${todayExpr}, String(Math.round(Number($json.meterUnits) || 0)), "259200"] }}`,
      [X + 1568, Y - 300],
      { notes: 'Adds this Gemini answer to usage:YYYYMMDD. Weighted units for Studio = prompt + 8.33 x (output + thinking). Fail-open. Not written for 429/5xx/timeouts (not billed).' }
    ),
    codeNode('Studio - Respond', src('studio-respond.js'), [X + 1792, Y - 200])
  );
  byName(wf, 'Studio - Meter Usage').parameters.options.timeout = 5000;
  const c = wf.connections;
  link(c, 'Route by Mode', 'Studio - Validate Request', 8);
  link(c, 'Studio - Validate Request', 'Studio - Request Ok?');
  link(c, 'Studio - Request Ok?', 'Studio - Call Gemini', 0);
  link(c, 'Studio - Request Ok?', 'Studio - Reject', 1);
  link(c, 'Studio - Call Gemini', 'Studio - Retry Check');
  link(c, 'Studio - Retry Check', 'Studio - Retry?');
  link(c, 'Studio - Retry?', 'Studio - Wait Retry', 0);
  link(c, 'Studio - Retry?', 'Studio - Validate', 1);
  link(c, 'Studio - Wait Retry', 'Studio - Call Gemini');
  link(c, 'Studio - Validate', 'Studio - Metered?');
  link(c, 'Studio - Metered?', 'Studio - Meter Usage', 0);
  link(c, 'Studio - Metered?', 'Studio - Respond', 1);
  link(c, 'Studio - Meter Usage', 'Studio - Respond');
  return wf;
}


// v4 = v3 + background jobs (tutor and Study Studio mind map as jobs). It REPLACES v3 (import v4 instead of v3).
// Everything not listed here is byte-for-byte v3. See n8n/runbook-owner.md step 19.
function buildV4(v3) {
  const wf = JSON.parse(JSON.stringify(v3));
  const lua = (f) => src(f).replace(/\n+$/, '');
  const EVAL = (name, nkeys) => JSON.stringify(lua(name));
  const ORIGIN = 'https://jay-leigh.github.io';
  const Y = 5300;
  const jobRedis = (name, bodyExpr, position, { pipeline = false, retry = false, notes } = {}) => {
    const n = redisNode(name, bodyExpr, position, notes ? { notes } : {});
    n.parameters.options.timeout = 5000;
    if (pipeline) n.parameters.url = UPSTASH_URL + '/pipeline';
    if (retry) Object.assign(n, { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 });
    return n;
  };
  const fieldSwitch = (name, field, values, position) => {
    const n = outcomeSwitch(name, values, position);
    for (const v of n.parameters.rules.values) v.conditions.conditions[0].leftValue = '={{ $json.' + field + ' }}';
    return n;
  };

  // ── a. Edits to existing nodes (the synchronous responses stay byte-identical) ──
  const norm = byName(wf, 'Normalize Multipart Body');
  norm.parameters.jsCode = src('job-normalize.js');
  const prep = byName(wf, 'Prep — Tutor');
  prep.parameters.jsCode = mustReplace(
    prep.parameters.jsCode,
    'const previousConversation =\n    (session?.conversation || [])\n        .slice(-MAX_HISTORY);',
    "// A job run (re-run after a lost attempt) never sees its own earlier answer: entries tagged with this jobId are skipped.\nconst jobId = $('Normalize Multipart Body').first().json._job?.id;\nconst previousConversation =\n    (session?.conversation || [])\n        .filter(m => !jobId || !m || m.jobId !== jobId)\n        .slice(-MAX_HISTORY);"
  );
  const ssb = byName(wf, 'Save Session Builder');
  ssb.parameters.jsCode = mustReplace(
    ssb.parameters.jsCode,
    'if (!tutor.failed) {\n    if (latestUser) {\n        conversation.push({\n            role: latestUser.role,\n            text: latestUser.text\n        });\n    }\n\n    conversation.push({\n        role: "model",\n        text: assistant\n    });\n}',
    "// Job run: the pair of this job replaces an earlier pair of the same jobId (a re-run after a lost attempt must not duplicate it)\nconst jobId = $('Normalize Multipart Body').first().json._job?.id;\nconst jobTag = jobId ? { jobId } : {};\nif (jobId) {\n    for (let i = conversation.length - 1; i >= 0; i--) if (conversation[i] && conversation[i].jobId === jobId) conversation.splice(i, 1);\n}\n\nif (!tutor.failed) {\n    if (latestUser) {\n        conversation.push({\n            role: latestUser.role,\n            text: latestUser.text,\n            ...jobTag\n        });\n    }\n\n    conversation.push({\n        role: \"model\",\n        text: assistant,\n        ...jobTag\n    });\n}"
  );
  const trc = byName(wf, 'Tutor Retry Check');
  trc.parameters.jsCode = mustReplace(
    trc.parameters.jsCode,
    'const retry = (isRateLimited || isServerError || isEmptyReply) && attempt < MAX_ATTEMPTS;',
    "const job = $('Normalize Multipart Body').first().json._job;\nlet retry = (isRateLimited || isServerError || isEmptyReply) && attempt < MAX_ATTEMPTS;"
  );
  trc.parameters.jsCode = mustReplace(
    trc.parameters.jsCode,
    '  waitSeconds = Math.min(waitSeconds, 60);\n}',
    "  waitSeconds = Math.min(waitSeconds, 60);\n  // Job run only: no retry that could not finish (wait + the 300 s Gemini call) 30 s before the job deadline\n  if (job && Date.now() + waitSeconds * 1000 + 300000 > job.deadlineAt - 30000) {\n    retry = false;\n    waitSeconds = 0;\n  }\n}"
  );
  const src3 = byName(wf, 'Studio - Retry Check');
  src3.parameters.jsCode = mustReplace(
    src3.parameters.jsCode,
    'const TOTAL_BUDGET_MS = 270000; // from the start of the request; leaves 30 s of the 300 s limit for the rest',
    'const TOTAL_BUDGET_MS = 270000; // from the start of the request; leaves 30 s of the 300 s limit for the rest\nconst JOB_TOTAL_BUDGET_MS = 570000; // job run: the job deadline is 600 s; a retry must then fit a whole call'
  );
  src3.parameters.jsCode = mustReplace(
    src3.parameters.jsCode,
    'const remainingAfterWait = TOTAL_BUDGET_MS - elapsed - waitSeconds * 1000;',
    "const inJob = !!$('Normalize Multipart Body').first().json._job;\nconst remainingAfterWait = (inJob ? JOB_TOTAL_BUDGET_MS : TOTAL_BUDGET_MS) - elapsed - waitSeconds * 1000;"
  );
  src3.parameters.jsCode = mustReplace(
    src3.parameters.jsCode,
    'remainingAfterWait >= MIN_RETRY_MS;',
    'remainingAfterWait >= (inJob ? CALL_TIMEOUT_MS : MIN_RETRY_MS);'
  );
  wf.settings = { ...wf.settings, executionTimeout: 720 };

  // ── b. The two job webhooks ──
  const wh = (name, p, mode, options, position) => ({
    parameters: { httpMethod: 'POST', path: p, authentication: 'jwtAuth', responseMode: mode, options: { rawBody: false, allowedOrigins: ORIGIN, ...options } },
    id: uuid(name), name, type: 'n8n-nodes-base.webhook', typeVersion: 2, position, webhookId: uuid('webhook:' + p), credentials: JWT_CRED,
  });
  const X0 = 13856;
  wf.nodes.push(
    Object.assign(wh('Job Start Endpoint', 'sth-job-start', 'onReceived', { responseData: '{"ok":true,"accepted":true}', responseHeaders: { entries: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Cache-Control', value: 'no-store' }] } }, [X0, Y]), {
      notes: 'Starts a background job (op create). JWT required. Answers {"ok":true,"accepted":true} as soon as the request is queued; the run continues and stores its result in Upstash.',
    }),
    Object.assign(wh('Job Endpoint', 'sth-job', 'lastNode', {}, [X0, Y + 400]), {
      notes: 'Background jobs: hello / status / result / ack / cancel. JWT required. Ids and keys are read from the POST body only.',
    }),
    {
      parameters: {
        mode: 'manual',
        duplicateItem: false,
        assignments: { assignments: [{ id: uuid('Job - Pick Envelope:env'), name: 'env', value: '={{ ({ v: $json.body.v, op: $json.body.op, job: $json.body.job, jobs: $json.body.jobs }) }}', type: 'object' }] },
        includeOtherFields: false,
        options: {},
      },
      id: uuid('Job - Pick Envelope'), name: 'Job - Pick Envelope', type: 'n8n-nodes-base.set', typeVersion: 3.4, position: [X0 + 224, Y + 200],
      notes: 'Keeps only v, op, job, jobs of the request. The (possibly large) request body never enters the job gateway Code nodes.',
    },
    codeNode('Job - Read Request', src('job-read-request.js'), [X0 + 448, Y + 200], { notes: 'All job settings live here (JOBS_ENABLED, JOB_MODES, caps, deadlines, TTLs). Validates the envelope; never throws.' }),
    {
      parameters: { action: 'hash', type: 'SHA256', value: '={{ $json.key }}', dataPropertyName: 'kh', encoding: 'hex' },
      id: uuid('Job - Hash Key'), name: 'Job - Hash Key', type: 'n8n-nodes-base.crypto', typeVersion: 1, position: [X0 + 672, Y + 200],
      notes: 'SHA-256 (hex) of the job key. Only the hash is ever stored in Upstash.',
    },
    codeNode('Job - Plan', src('job-plan.js'), [X0 + 896, Y + 200], { notes: 'Builds the Redis call for the operation and drops the plain key.' }),
    fieldSwitch('Job - Route Op', 'route', ['create', 'reject', 'status', 'result', 'ack', 'cancel', 'reply'], [X0 + 1120, Y + 200]),
    jobRedis('Job - Admit', `={{ ["EVAL", ${EVAL('job-admit.lua')}, String($json.keys.length), ...$json.keys, ...$json.argv] }}`, [X0 + 1344, Y - 300], {
      notes: 'ADMIT (atomic): idempotent create, running caps per mode and in total (cfg:jobs_max_running overrides the total, 0 = off), records sth:job:<id>, the execution map sth:jobx:<execution id> and the running-set sth:jobs:run:<mode>. Fail-closed: if Upstash does not answer, the run ends here.',
    }),
    codeNode('Job - Admit Result', src('job-admit-result.js'), [X0 + 1568, Y - 300]),
    ifNode('Job - Admitted?', '={{ $json.admitted === true }}', [X0 + 1792, Y - 300]),
    jobRedis('Job - Record Rejection', `={{ ["EVAL", ${EVAL('job-reject.lua')}, String($json.keys.length), ...$json.keys, ...$json.argv] }}`, [X0 + 1344, Y - 100], {
      notes: 'Stores a short-lived "rejected" record (STH-JOB-503) when jobs are switched off or the mode is not allowed, so the app learns it by polling.',
    }),
    jobRedis('Job - Status Read', '={{ $json.pipeline }}', [X0 + 1344, Y + 100], { pipeline: true, notes: 'One HMGET per job (a /pipeline call).' }),
    codeNode('Job - Status Reply', src('job-status-reply.js'), [X0 + 1568, Y + 100]),
    jobRedis('Job - Result Read', '={{ $json.pipeline }}', [X0 + 1344, Y + 300], { pipeline: true, notes: 'HMGET + GET of one job (a /pipeline call).' }),
    codeNode('Job - Result Reply', src('job-result-reply.js'), [X0 + 1568, Y + 300]),
    jobRedis('Job - Ack', `={{ $json.jobs.map((j) => ["EVAL", ${EVAL('job-ack.lua')}, "2", j.job, j.jobr, j.kh]) }}`, [X0 + 1344, Y + 500], {
      pipeline: true, notes: 'ACK: deletes the record and the result of finished jobs, when the key hash matches.',
    }),
    codeNode('Job - Ack Reply', src('job-ack-reply.js'), [X0 + 1568, Y + 500]),
    jobRedis('Job - Cancel', `={{ $json.jobs.map((j) => ["EVAL", ${EVAL('job-cancel.lua')}, "2", j.job, j.jobr, j.kh, String($json.now), String($json.rejectTtlS)]) }}`, [X0 + 1344, Y + 700], {
      pipeline: true, notes: 'CANCEL: marks a running or rejected job cancelled (result discarded) when the key hash matches. The run slot is not freed while the execution still runs.',
    }),
    codeNode('Job - Cancel Reply', src('job-cancel-reply.js'), [X0 + 1568, Y + 700]),
    codeNode('Job - Reply', src('job-reply.js'), [X0 + 1344, Y + 900], { notes: 'Answers that need no Redis (hello, bad request).' }),
    ifNode('Job - Sync?', "={{ !$('Normalize Multipart Body').first().json._job }}", [23264, 1888]),
    codeNode('Job - Classify Outcome', src('job.lib.js') + '\n' + src('job-classify.js'), [23488, 2112], { notes: 'A job run reached its end: the state and the exact answer the synchronous request would have returned. Result over 524288 bytes: failed STH-JOB-413.' }),
    jobRedis('Job - Store Outcome', `={{ ["EVAL", ${EVAL('job-store.lua')}, "4", ...$json.keys, ...$json.argv] }}`, [23712, 2112], {
      retry: true, notes: 'STORE (atomic): a success from any attempt is accepted while the job is running; a failure only from the current attempt; cancelled or finished jobs discard. Retried 3 times (repeating it is harmless).',
    }),
    jobRedis('Job - Error Lookup', '={{ ["GET", "sth:jobx:" + String((($(\'Error Trigger\').first().json || {}).execution || {}).id)] }}', [14080, 2700], {
      notes: 'Maps the failed execution id to the job (sth:jobx:<execution id> = id|attempt|mode).',
    }),
    ifNode('Job - Error Is Job?', "={{ typeof $json.result === 'string' && $json.result.split('|').length === 3 }}", [14304, 2700]),
    codeNode('Job - Error Outcome', src('job.lib.js') + '\n' + src('job-error-outcome.js'), [14528, 2700], { notes: 'A job execution threw: stores failed with a code taken from the error message (the message itself is never stored).' })
  );
  const c = wf.connections;
  link(c, 'Job Start Endpoint', 'Job - Pick Envelope');
  link(c, 'Job Endpoint', 'Job - Pick Envelope');
  link(c, 'Job - Pick Envelope', 'Job - Read Request');
  link(c, 'Job - Read Request', 'Job - Hash Key');
  link(c, 'Job - Hash Key', 'Job - Plan');
  link(c, 'Job - Plan', 'Job - Route Op');
  link(c, 'Job - Route Op', 'Job - Admit', 0);
  link(c, 'Job - Route Op', 'Job - Record Rejection', 1);
  link(c, 'Job - Route Op', 'Job - Status Read', 2);
  link(c, 'Job - Route Op', 'Job - Result Read', 3);
  link(c, 'Job - Route Op', 'Job - Ack', 4);
  link(c, 'Job - Route Op', 'Job - Cancel', 5);
  link(c, 'Job - Route Op', 'Job - Reply', 6);
  link(c, 'Job - Admit', 'Job - Admit Result');
  link(c, 'Job - Admit Result', 'Job - Admitted?');
  link(c, 'Job - Admitted?', 'Normalize Multipart Body', 0);
  link(c, 'Job - Status Read', 'Job - Status Reply');
  link(c, 'Job - Result Read', 'Job - Result Reply');
  link(c, 'Job - Ack', 'Job - Ack Reply');
  link(c, 'Job - Cancel', 'Job - Cancel Reply');
  for (const t of ['Build Response', 'Studio - Respond', 'Studio - Reject', 'Quota Exceeded']) link(c, t, 'Job - Sync?');
  link(c, 'Job - Sync?', 'Job - Classify Outcome', 1); // output 0 stays unconnected: the synchronous answer is unchanged
  link(c, 'Job - Classify Outcome', 'Job - Store Outcome');
  link(c, 'Error Trigger', 'Job - Error Lookup');
  link(c, 'Job - Error Lookup', 'Job - Error Is Job?');
  link(c, 'Job - Error Is Job?', 'Job - Error Outcome', 0);
  link(c, 'Job - Error Outcome', 'Job - Store Outcome');
  return wf;
}


// v5 = v4 + Study Studio flashcards (mode studio_flashcards, sync and as a background job). It REPLACES v4 (import v5 instead of v4).
// No node is added or removed: the Studio chain branches on `tool` (Studio - Validate Request builds prompt, schema and call
// settings per tool; Studio - Validate validates per tool). Everything not listed here is byte-for-byte v4.
function buildV5(v4) {
  const wf = JSON.parse(JSON.stringify(v4));
  const FC_JOB = 'studio_flashcards: { deadlineS: 420, cap: 1 }';

  // a. Cost ceiling also guards the new mode
  const qp = byName(wf, 'Quota Prep');
  qp.parameters.jsCode = mustReplace(
    qp.parameters.jsCode,
    "'tutor', 'studio_mindmap'];",
    "'tutor', 'studio_mindmap', 'studio_flashcards'];"
  );

  // b. Route by Mode: new last output (index 9) for studio_flashcards, wired to the same Studio chain
  const route = byName(wf, 'Route by Mode');
  route.parameters.rules.values.push({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          id: uuid('route:studio_flashcards'),
          leftValue: '={{ $json.body.mode }}',
          rightValue: 'studio_flashcards',
          operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
        },
      ],
      combinator: 'and',
    },
  });
  link(wf.connections, 'Route by Mode', 'Studio - Validate Request', 9);

  // c. Studio - Validate Request: per-tool structure, options, prompt, schema, call settings
  const vr = byName(wf, 'Studio - Validate Request');
  let c = vr.parameters.jsCode;
  c = mustReplace(c, '// Study Studio mind map, step 1:', '// Study Studio (mind map, and from v5 flashcards), step 1:');
  c = mustReplace(
    c,
    'const CAP_DESCRIPTION = 1000;\n',
    "const CAP_DESCRIPTION = 1000;\n// Flashcards options (design 2.7): exactly these values; a missing option takes the default, a wrong one is STH-INPUT-400.\nconst FC_COUNTS = [15, 30, 50];\nconst FC_DIFFICULTIES = ['easy', 'medium', 'hard'];\nconst FC_DEFAULT_COUNT = 30;\nconst FC_DEFAULT_DIFFICULTY = 'medium';\n"
  );
  c = mustReplace(
    c,
    "  if (body.v !== 1 || body.tool !== 'mindmap') return reject('STH-INPUT-400', 'version_or_tool');\n",
    "  const tool = body.tool;\n  if (body.v !== 1 || (tool !== 'mindmap' && tool !== 'flashcards')) return reject('STH-INPUT-400', 'version_or_tool');\n  // the mode the request was routed by and the tool must agree\n  if (tool === 'flashcards' ? body.mode !== 'studio_flashcards' : body.mode === 'studio_flashcards') return reject('STH-INPUT-400', 'version_or_tool');\n"
  );
  c = mustReplace(
    c,
    "    if (description.length > CAP_DESCRIPTION) return reject('STH-STU-413', 'description_too_long');\n  }\n",
    "    if (description.length > CAP_DESCRIPTION) return reject('STH-STU-413', 'description_too_long');\n  }\n" +
      "  let count = 0, difficulty = '';\n" +
      "  if (tool === 'flashcards') {\n" +
      "    const o = body.options;\n" +
      "    if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o))) return reject('STH-INPUT-400', 'options');\n" +
      "    count = !o || o.count === undefined || o.count === null ? FC_DEFAULT_COUNT : o.count;\n" +
      "    difficulty = !o || o.difficulty === undefined || o.difficulty === null ? FC_DEFAULT_DIFFICULTY : o.difficulty;\n" +
      "    if (!FC_COUNTS.includes(count) || !FC_DIFFICULTIES.includes(difficulty)) return reject('STH-INPUT-400', 'options');\n" +
      "  }\n"
  );
  c = mustReplace(
    c,
    '  const ids = clean.map((c) => c.id);\n',
    "  const ids = clean.map((c) => c.id);\n  const toolLabel = tool === 'flashcards' ? 'flashcards' : 'mind map';\n  const settingsExtra = tool === 'flashcards' ? `cards: ${count}\\ndifficulty: ${difficulty}\\n` : '';\n"
  );
  c = mustReplace(c, 'tool: mind map\nlanguage: ${languageName}\n</settings>', 'tool: ${toolLabel}\nlanguage: ${languageName}\n${settingsExtra}</settings>');
  c = mustReplace(c, 'Create the mind map now.', 'Create the ${toolLabel} now.');
  c = mustReplace(
    c,
    "\n  // ── schema sth.mindmap/1 (flat list with parent ids; `source` limited to this request's ids) ──\n  const schema = {",
    '\n' + src('studio-flashcards.prompt.part.js') + "  // ── schema sth.mindmap/1 (flat list with parent ids; `source` limited to this request's ids) ──\n  const mindmapSchema = {"
  );
  c = mustReplace(c, '\n  // Fallback variant (design 3.1)', '\n' + src('studio-flashcards.schema.part.js') + '\n  // Fallback variant (design 3.1)');
  c = mustReplace(c, "text: COMMON + '\\n\\n' + MINDMAP }", "text: COMMON + '\\n\\n' + (tool === 'flashcards' ? FLASHCARDS : MINDMAP) }");
  c = mustReplace(
    c,
    '      temperature: 0.3,\n      maxOutputTokens: 32768,\n',
    "      temperature: tool === 'flashcards' ? 0.4 : 0.3,\n      // flashcards (design 3.1): 12288 for a batch of up to 40 cards; 16384 for the 50-card deck in one call (no batching)\n      maxOutputTokens: tool === 'flashcards' ? (count > 30 ? 16384 : 12288) : 32768,\n"
  );
  c = mustReplace(c, '      estimate: tokens,\n', "      estimate: tokens,\n      tool,\n      ...(tool === 'flashcards' ? { count, difficulty } : {}),\n");
  vr.parameters.jsCode = c;
  vr.notes =
    'Study Studio (mind map and, from v5, flashcards). Re-checks the request (tool and mode agree, 1-10 sources, <=5 images, description <=1000, language in the list, flashcards options count 15/30/50 and difficulty easy/medium/hard, server token estimate <= cfg:studio_max_tokens, default 400000, hard maximum 900000) and builds the Gemini request for the tool. Rejections return only a fixed error code, never request text.';

  // d. Studio - Retry Check: a flashcards JOB takes its retry budget from the job deadline (a ~60-120 s call can be repeated once
  //    when time is left); the mind map and the synchronous requests are unchanged
  const rc = byName(wf, 'Studio - Retry Check');
  rc.parameters.jsCode = mustReplace(
    rc.parameters.jsCode,
    "const inJob = !!$('Normalize Multipart Body').first().json._job;\nconst remainingAfterWait = (inJob ? JOB_TOTAL_BUDGET_MS : TOTAL_BUDGET_MS) - elapsed - waitSeconds * 1000;",
    "const jobRec = $('Normalize Multipart Body').first().json._job;\nconst inJob = !!jobRec;\n// flashcards job: the retry must end 30 s before the job deadline and may start with MIN_RETRY_MS left (calls take 60-120 s)\nconst flashJob = inJob && st.tool === 'flashcards';\nconst remainingAfterWait = (flashJob ? jobRec.deadlineAt - 30000 - Date.now() : (inJob ? JOB_TOTAL_BUDGET_MS : TOTAL_BUDGET_MS) - elapsed) - waitSeconds * 1000;"
  );
  rc.parameters.jsCode = mustReplace(rc.parameters.jsCode, 'remainingAfterWait >= (inJob ? CALL_TIMEOUT_MS : MIN_RETRY_MS);', 'remainingAfterWait >= (inJob && !flashJob ? CALL_TIMEOUT_MS : MIN_RETRY_MS);');

  // e. Studio - Validate: the mind map library (reply dispatches on the tool) plus the flashcards library
  const val = byName(wf, 'Studio - Validate');
  let lib = src('studio-validate.lib.js');
  lib = mustReplace(lib, "  if (reason === 'MAX_TOKENS') return done(studioFail('STH-STU-422', 'truncated'), true);\n", "  const isFc = !!ctx && ctx.tool === 'flashcards';\n  if (reason === 'MAX_TOKENS' && !isFc) return done(studioFail('STH-STU-422', 'truncated'), true); // flashcards: a cut-off answer may be salvaged\n");
  lib = mustReplace(lib, "done(studioFail('STH-STU-422', 'empty'), true);", "done(studioFail('STH-STU-422', reason === 'MAX_TOKENS' ? 'truncated' : 'empty'), true);");
  lib = mustReplace(lib, '  const v = studioValidateMindmap(text, ctx && ctx.sources);\n', "  const v = isFc ? studioValidateFlashcards(text, ctx.sources, ctx.count, { truncated: reason === 'MAX_TOKENS' }) : studioValidateMindmap(text, ctx && ctx.sources);\n");
  lib = mustReplace(lib, "        tool: 'mindmap',\n        schema: SV_SCHEMA_ID,\n", "        tool: isFc ? 'flashcards' : 'mindmap',\n        schema: isFc ? FC_SCHEMA_ID : SV_SCHEMA_ID,\n");
  const libAll = lib + '\n' + src('studio-flashcards.lib.js');
  val.parameters.jsCode = libAll + '\n' + src('studio5-validate.epilogue.js');
  val.notes = 'Parses, validates and repairs the answer per tool. Mind map: single root, orphans, cycles, depth, caps. Flashcards: empty/duplicate fronts, 80-card cap, at least half of the requested count, a cut-off answer is salvaged when 70% of the cards are complete. Citations are checked against the request sources. Pure function: no network, no globals.';
  byName(wf, 'Studio - Call Gemini').notes =
    'gemini-2.5-flash (flash-lite only on attempt 3), JSON mode with the schema of the tool (mind map or flashcards). Node timeout comes from the item (240000 ms, shorter when the request budget is running out). Never errors: failures are handled by Studio - Retry Check.';

  // f. Job modes: studio_flashcards with its own running set (sth:jobs:run:studio_flashcards), cap 1, 420 s deadline
  const rr = byName(wf, 'Job - Read Request');
  rr.parameters.jsCode = mustReplace(rr.parameters.jsCode, 'studio_mindmap: { deadlineS: 600, cap: 1 } };', 'studio_mindmap: { deadlineS: 600, cap: 1 }, ' + FC_JOB + ' };');

  return { wf, libAll };
}


// v6 = v5 + Study Studio quiz (mode studio_quiz, sync and as a background job). It REPLACES v5 (import v6 instead of v5).
// No node is added or removed: the Studio chain already branches on `tool`; v6 adds the quiz branch to the same nodes
// (Route by Mode output 10, Quota Prep, Studio - Validate Request, Studio - Retry Check, Studio - Validate, Job - Read Request).
// Everything not listed here is byte-for-byte v5.
function buildV6(v5, v5Lib) {
  const wf = JSON.parse(JSON.stringify(v5));
  const QZ_JOB = 'studio_quiz: { deadlineS: 420, cap: 1 }';

  // a. Cost ceiling also guards the new mode
  const qp = byName(wf, 'Quota Prep');
  qp.parameters.jsCode = mustReplace(qp.parameters.jsCode, "'studio_mindmap', 'studio_flashcards'];", "'studio_mindmap', 'studio_flashcards', 'studio_quiz'];");

  // b. Route by Mode: new last output (index 10) for studio_quiz, wired to the same Studio chain
  const route = byName(wf, 'Route by Mode');
  route.parameters.rules.values.push({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [
        {
          id: uuid('route:studio_quiz'),
          leftValue: '={{ $json.body.mode }}',
          rightValue: 'studio_quiz',
          operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' },
        },
      ],
      combinator: 'and',
    },
  });
  link(wf.connections, 'Route by Mode', 'Studio - Validate Request', 10);

  // c. Studio - Validate Request: tool/mode table, quiz options, prompt, schema, call settings
  const vr = byName(wf, 'Studio - Validate Request');
  let c = vr.parameters.jsCode;
  c = mustReplace(c, '// Study Studio (mind map, and from v5 flashcards), step 1:', '// Study Studio (mind map, from v5 flashcards, from v6 quiz), step 1:');
  c = mustReplace(
    c,
    "const FC_DEFAULT_DIFFICULTY = 'medium';\n",
    "const FC_DEFAULT_DIFFICULTY = 'medium';\n// Quiz options (design 2.4): exactly these values; a missing option takes the default, a wrong one is STH-INPUT-400. The explicit\n// number in the description (\"make 30 questions\") is not supported: the count comes from the dialog.\nconst QZ_COUNTS = [10, 20, 30];\nconst QZ_DEFAULT_COUNT = 20;\n"
  );
  c = mustReplace(
    c,
    "(tool !== 'mindmap' && tool !== 'flashcards')) return reject('STH-INPUT-400', 'version_or_tool');",
    "(tool !== 'mindmap' && tool !== 'flashcards' && tool !== 'quiz')) return reject('STH-INPUT-400', 'version_or_tool');"
  );
  c = mustReplace(
    c,
    "  if (tool === 'flashcards' ? body.mode !== 'studio_flashcards' : body.mode === 'studio_flashcards') return reject('STH-INPUT-400', 'version_or_tool');\n",
    "  if (tool === 'mindmap' ? body.mode === 'studio_flashcards' || body.mode === 'studio_quiz' : body.mode !== (tool === 'flashcards' ? 'studio_flashcards' : 'studio_quiz')) return reject('STH-INPUT-400', 'version_or_tool');\n"
  );
  c = mustReplace(
    c,
    "    if (!FC_COUNTS.includes(count) || !FC_DIFFICULTIES.includes(difficulty)) return reject('STH-INPUT-400', 'options');\n  }\n",
    "    if (!FC_COUNTS.includes(count) || !FC_DIFFICULTIES.includes(difficulty)) return reject('STH-INPUT-400', 'options');\n  }\n" +
      "  if (tool === 'quiz') {\n" +
      "    const o = body.options;\n" +
      "    if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o))) return reject('STH-INPUT-400', 'options');\n" +
      "    count = !o || o.count === undefined || o.count === null ? QZ_DEFAULT_COUNT : o.count;\n" +
      "    difficulty = !o || o.difficulty === undefined || o.difficulty === null ? FC_DEFAULT_DIFFICULTY : o.difficulty;\n" +
      "    if (!QZ_COUNTS.includes(count) || !FC_DIFFICULTIES.includes(difficulty)) return reject('STH-INPUT-400', 'options');\n" +
      "  }\n"
  );
  c = mustReplace(
    c,
    "  const toolLabel = tool === 'flashcards' ? 'flashcards' : 'mind map';\n  const settingsExtra = tool === 'flashcards' ? `cards: ${count}\\ndifficulty: ${difficulty}\\n` : '';\n",
    "  const toolLabel = tool === 'flashcards' ? 'flashcards' : tool === 'quiz' ? 'quiz' : 'mind map';\n  const settingsExtra = tool === 'flashcards' ? `cards: ${count}\\ndifficulty: ${difficulty}\\n` : tool === 'quiz' ? `questions: ${count}\\ndifficulty: ${difficulty}\\n` : '';\n"
  );
  c = mustReplace(c, '  // ── schema sth.mindmap/1 (flat list with parent ids;', src('studio-quiz.prompt.part.js') + '  // ── schema sth.mindmap/1 (flat list with parent ids;');
  c = mustReplace(c, "  const schema = tool === 'flashcards' ? fcSchema : mindmapSchema;\n", src('studio-quiz.schema.part.js') + "  const schema = tool === 'flashcards' ? fcSchema : tool === 'quiz' ? qzSchema : mindmapSchema;\n");
  c = mustReplace(c, "(tool === 'flashcards' ? FLASHCARDS : MINDMAP) }", "(tool === 'flashcards' ? FLASHCARDS : tool === 'quiz' ? QUIZ : MINDMAP) }");
  c = mustReplace(c, "      temperature: tool === 'flashcards' ? 0.4 : 0.3,\n", "      temperature: tool === 'mindmap' ? 0.3 : 0.4,\n");
  c = mustReplace(
    c,
    "      maxOutputTokens: tool === 'flashcards' ? (count > 30 ? 16384 : 12288) : 32768,\n",
    "      // quiz: one call for up to 30 questions (no batching): about 500 tokens a question (4 options with rationales, hint, explanation) is 15k, plus 1024 thinking; 24576 leaves half as much again\n      maxOutputTokens: tool === 'flashcards' ? (count > 30 ? 16384 : 12288) : tool === 'quiz' ? 24576 : 32768,\n"
  );
  c = mustReplace(c, "      ...(tool === 'flashcards' ? { count, difficulty } : {}),\n", "      ...(tool === 'flashcards' || tool === 'quiz' ? { count, difficulty } : {}),\n");
  vr.parameters.jsCode = c;
  vr.notes =
    'Study Studio (mind map, from v5 flashcards, from v6 quiz). Re-checks the request (tool and mode agree, 1-10 sources, <=5 images, description <=1000, language in the list, flashcards options count 15/30/50, quiz options count 10/20/30 (default 20), difficulty easy/medium/hard, server token estimate <= cfg:studio_max_tokens, default 400000, hard maximum 900000) and builds the Gemini request for the tool. Rejections return only a fixed error code, never request text.';

  // d. Studio - Retry Check: a quiz JOB takes its retry budget from the job deadline, like a flashcards job
  const rc = byName(wf, 'Studio - Retry Check');
  rc.parameters.jsCode = mustReplace(
    rc.parameters.jsCode,
    "// flashcards job: the retry must end 30 s before the job deadline and may start with MIN_RETRY_MS left (calls take 60-120 s)\nconst flashJob = inJob && st.tool === 'flashcards';",
    "// flashcards / quiz job: the retry must end 30 s before the job deadline and may start with MIN_RETRY_MS left (calls take 60-120 s)\nconst flashJob = inJob && (st.tool === 'flashcards' || st.tool === 'quiz');"
  );

  // e. Studio - Validate: dispatch on the tool (quiz library added after the flashcards library)
  const val = byName(wf, 'Studio - Validate');
  let code = val.parameters.jsCode;
  const epi = src('studio5-validate.epilogue.js');
  if (!code.endsWith(epi)) throw new Error('Studio - Validate epilogue not at the end');
  let lib = code.slice(0, code.length - epi.length);
  lib = mustReplace(lib, "  const isFc = !!ctx && ctx.tool === 'flashcards';\n  if (reason === 'MAX_TOKENS' && !isFc) return done(", "  const isFc = !!ctx && ctx.tool === 'flashcards';\n  const isQz = !!ctx && ctx.tool === 'quiz';\n  if (reason === 'MAX_TOKENS' && !isFc && !isQz) return done(");
  lib = mustReplace(lib, "// flashcards: a cut-off answer may be salvaged\n", "// flashcards / quiz: a cut-off answer may be salvaged\n");
  lib = mustReplace(lib, '  const v = isFc ? studioValidateFlashcards(', '  const v = isQz ? studioValidateQuiz(text, ctx.sources, ctx.count, { truncated: reason === \'MAX_TOKENS\' }) : isFc ? studioValidateFlashcards(');
  lib = mustReplace(lib, "        tool: isFc ? 'flashcards' : 'mindmap',\n        schema: isFc ? FC_SCHEMA_ID : SV_SCHEMA_ID,\n", "        tool: isQz ? 'quiz' : isFc ? 'flashcards' : 'mindmap',\n        schema: isQz ? QZ_SCHEMA_ID : isFc ? FC_SCHEMA_ID : SV_SCHEMA_ID,\n");
  const libAll = lib + '\n' + src('studio-quiz.lib.js');
  val.parameters.jsCode = libAll + '\n' + epi;
  val.notes = 'Parses, validates and repairs the answer per tool. Mind map: single root, orphans, cycles, depth, caps. Flashcards: empty/duplicate fronts, 80-card cap, at least half of the requested count, a cut-off answer is salvaged when 70% of the cards are complete. Quiz: exactly one correct answer among well-formed options, true/false options, duplicate stems, hints that give the answer away, 50-question cap, at least half of the requested count, a cut-off answer is salvaged when 70% of the questions are complete. Citations are checked against the request sources. Pure function: no network, no globals.';
  byName(wf, 'Studio - Call Gemini').notes =
    'gemini-2.5-flash (flash-lite only on attempt 3), JSON mode with the schema of the tool (mind map, flashcards or quiz). Node timeout comes from the item (240000 ms, shorter when the request budget is running out). Never errors: failures are handled by Studio - Retry Check.';

  // f. Job modes: studio_quiz with its own running set (sth:jobs:run:studio_quiz), cap 1, 420 s deadline
  const rr = byName(wf, 'Job - Read Request');
  rr.parameters.jsCode = mustReplace(rr.parameters.jsCode, 'studio_flashcards: { deadlineS: 420, cap: 1 } };', 'studio_flashcards: { deadlineS: 420, cap: 1 }, ' + QZ_JOB + ' };');

  return { wf, libAll };
}


// v7 = v6 + Study Studio infographic, slides and digest (map-reduce part / reduce runs), J4 job modes (transcribe, template, reviewer),
// the version gate (hello v + caps), reserved job slots with a bulk cap, the budget op, bulk soft ceiling, tutor guard.
// It REPLACES v6 (import v7 instead of v6). Everything not listed here is byte-for-byte v6. See n8n/runbook-owner.md step 22.
function buildV7(v6, v6Lib) {
  const wf = JSON.parse(JSON.stringify(v6));
  const lua = (f) => src(f).replace(/\n+$/, '');
  const NEW_MODES = ['studio_infographic', 'studio_slides', 'studio_digest'];
  const J4 = [
    ['Transcription', 'Build Transcription Payload', 'Extract Transcription Text', 'Meter Usage (Transcription)'],
    ['Template', 'Build Template Payload', 'Extract Template Text', 'Meter Usage (Template)'],
    ['Reviewer', 'Build Reviewer Payload', 'Extract Reviewer Text', 'Meter Usage (Reviewer)'],
  ];
  const c = wf.connections;
  const ruleOf = (mode) => ({
    conditions: {
      options: { caseSensitive: true, leftValue: '', typeValidation: 'strict', version: 1 },
      conditions: [{ id: uuid('route:' + mode), leftValue: '={{ $json.body.mode }}', rightValue: mode, operator: { type: 'string', operation: 'equals', name: 'filter.operator.equals' } }],
      combinator: 'and',
    },
  });

  // ── a. Route by Mode: outputs 11-13 for the three new Studio modes, and a fallback output (14) for every other mode ──
  const route = byName(wf, 'Route by Mode');
  for (const m of NEW_MODES) route.parameters.rules.values.push(ruleOf(m));
  route.parameters.options = { fallbackOutput: 'extra', renameFallbackOutput: 'Unknown mode' };
  NEW_MODES.forEach((m, k) => link(c, 'Route by Mode', 'Studio - Validate Request', 11 + k));
  wf.nodes.push(codeNode('Route - Unknown Mode', src('route7-unknown.js'), [16320, 5800], { notes: 'Fallback output of Route by Mode: a mode no rule knows (an app newer than this workflow) gets a clean STH-INPUT-400 (reason mode) instead of an unspecified answer.' }));
  link(c, 'Route by Mode', 'Route - Unknown Mode', 14);
  link(c, 'Route - Unknown Mode', 'Job - Sync?');

  // ── b. Quota: the three new modes call Gemini; bulk work has a softer ceiling (cfg:bulk_ratio of cfg:daily_units, default 0.6) ──
  byName(wf, 'Quota Prep').parameters.jsCode = src('quota7-prep.js');
  byName(wf, 'Quota Evaluate').parameters.jsCode = src('quota7-evaluate.js');
  byName(wf, 'Quota Exceeded').parameters.jsCode = src('quota7-exceeded.js');
  const qr = byName(wf, 'Quota Read');
  qr.parameters.jsonBody = mustReplace(qr.parameters.jsonBody, '"cfg:studio_max_tokens"]', '"cfg:studio_max_tokens", "cfg:bulk_ratio"]');
  qr.notes = mustReplace(qr.notes, 'the optional Studio token cap cfg:studio_max_tokens.', 'the optional Studio token cap cfg:studio_max_tokens and (v7) the optional bulk ratio cfg:bulk_ratio.');
  byName(wf, 'Studio - Reject').parameters.jsCode = src('studio7-reject.js');

  // ── c. Studio - Validate Request ──
  const vr = byName(wf, 'Studio - Validate Request');
  let q = vr.parameters.jsCode;
  q = mustReplace(q, '// Study Studio (mind map, from v5 flashcards, from v6 quiz), step 1:', '// Study Studio (mind map, from v5 flashcards, from v6 quiz, from v7 infographic, slides and digest), step 1:');
  q = mustReplace(q, "const STUDIO_PROMPT_VERSION = 'studio-2026-11-a';\n", "const STUDIO_PROMPT_VERSION = 'studio-2026-11-a';\nconst STUDIO_PROMPT_VERSION_V7 = 'studio-2026-12-a'; // the new tools and the part / reduce runs; the three v6 tools keep the v6 version\n");
  q = mustReplace(q, 'const CAP_SOURCES = 10;', 'const CAP_SOURCES = 15;');
  q = mustReplace(
    q,
    'const QZ_DEFAULT_COUNT = 20;\n',
    "const QZ_DEFAULT_COUNT = 20;\n" +
      "// v7: tool <-> mode, infographic / slides options, map-reduce limits (design C, H)\n" +
      "const STUDIO_MODE_OF = { mindmap: 'studio_mindmap', flashcards: 'studio_flashcards', quiz: 'studio_quiz', infographic: 'studio_infographic', slides: 'studio_slides', digest: 'studio_digest' };\n" +
      "const IG_LAYOUTS = ['auto', 'steps', 'comparison', 'facts', 'timeline'];\n" +
      "const SL_FORMATS = ['detailed', 'presenter'];\n" +
      "const SL_LENGTHS = ['short', 'default'];\n" +
      "const MR_MAX_PARTS = 16;\n" +
      "const MR_PART_MAX_TOKENS = 200000; // one part (also limited by the owner's cap)\n" +
      "const MR_REDUCE_MAX_TOKENS = 300000; // the digests of a reduce run (also limited by the owner's cap)\n" +
      "const MR_REDUCE_MAX_CHARS = 1000000;\n"
  );
  const cleanFn = (() => { const s = src('studio-validate.lib.js'); const a = s.indexOf('function studioClean'); const b = s.indexOf('\n}\n', a); if (a < 0 || b < 0) throw new Error('studioClean not found'); return s.slice(a, b + 3); })();
  q = mustReplace(q, 'const reject = (code, reason, extra) =>', '// helpers of the digest of a map-reduce run (the same code runs in "Studio - Validate")\n' + cleanFn + src('studio7-digest.lib.js').replace(/\nif \(typeof module[^\n]*\n?$/, '\n') + '\nconst reject = (code, reason, extra) =>');
  q = mustReplace(
    q,
    "  if (body.v !== 1 || (tool !== 'mindmap' && tool !== 'flashcards' && tool !== 'quiz')) return reject('STH-INPUT-400', 'version_or_tool');\n  // the mode the request was routed by and the tool must agree\n  if (tool === 'mindmap' ? body.mode === 'studio_flashcards' || body.mode === 'studio_quiz' : body.mode !== (tool === 'flashcards' ? 'studio_flashcards' : 'studio_quiz')) return reject('STH-INPUT-400', 'version_or_tool');\n",
    "  if (body.v !== 1 || typeof tool !== 'string' || !Object.prototype.hasOwnProperty.call(STUDIO_MODE_OF, tool)) return reject('STH-INPUT-400', 'version_or_tool');\n  // the mode the request was routed by and the tool must agree\n  if (tool === 'mindmap' ? Object.values(STUDIO_MODE_OF).includes(body.mode) && body.mode !== 'studio_mindmap' : body.mode !== STUDIO_MODE_OF[tool]) return reject('STH-INPUT-400', 'version_or_tool');\n"
  );
  q = mustReplace(
    q,
    "    if (!QZ_COUNTS.includes(count) || !FC_DIFFICULTIES.includes(difficulty)) return reject('STH-INPUT-400', 'options');\n  }\n",
    "    if (!QZ_COUNTS.includes(count) || !FC_DIFFICULTIES.includes(difficulty)) return reject('STH-INPUT-400', 'options');\n  }\n" +
      "  // v7 options: infographic layout; slides format and length (a missing option takes the default, a wrong one is STH-INPUT-400)\n" +
      "  let layout = 'auto', format = 'detailed', length = 'default';\n" +
      "  if (tool === 'infographic' || tool === 'slides') {\n" +
      "    const o = body.options;\n" +
      "    if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o))) return reject('STH-INPUT-400', 'options');\n" +
      "    const pick = (v, d) => (!o || o[v] === undefined || o[v] === null ? d : o[v]);\n" +
      "    if (tool === 'infographic') { layout = pick('layout', 'auto'); if (!IG_LAYOUTS.includes(layout)) return reject('STH-INPUT-400', 'options'); }\n" +
      "    else { format = pick('format', 'detailed'); length = pick('length', 'default'); if (!SL_FORMATS.includes(format) || !SL_LENGTHS.includes(length)) return reject('STH-INPUT-400', 'options'); }\n" +
      "  }\n" +
      "  // v7 map-reduce: a part of a big run (digest, flashcards, quiz) or the reduce run over the digests (mind map, infographic, slides). Jobs only,\n" +
      "  // and only as a bulk job (design H.5): the job record (set by ADMIT, never by the client) must say bulk.\n" +
      "  const strategy = body.strategy === undefined || body.strategy === null ? 'direct' : body.strategy;\n" +
      "  if (strategy !== 'direct' && strategy !== 'reduce') return reject('STH-INPUT-400', 'strategy');\n" +
      "  const isReduce = strategy === 'reduce';\n" +
      "  const hasPart = body.part !== undefined && body.part !== null;\n" +
      "  const jobRec = (() => { try { return $('Normalize Multipart Body').first().json._job || null; } catch (e) { return null; } })();\n" +
      "  if (hasPart || isReduce || tool === 'digest') {\n" +
      "    if (!jobRec) return reject('STH-INPUT-400', 'job_only');\n" +
      "    if (jobRec.bulk !== true) return reject('STH-INPUT-400', 'not_bulk');\n" +
      "  }\n" +
      "  if (tool === 'digest' && !hasPart) return reject('STH-INPUT-400', 'part');\n" +
      "  if (isReduce && (hasPart || (tool !== 'mindmap' && tool !== 'infographic' && tool !== 'slides'))) return reject('STH-INPUT-400', 'strategy');\n" +
      "  let part = null;\n" +
      "  if (hasPart) {\n" +
      "    const p = body.part;\n" +
      "    if (tool !== 'digest' && tool !== 'flashcards' && tool !== 'quiz') return reject('STH-INPUT-400', 'part');\n" +
      "    if (!p || typeof p !== 'object' || Array.isArray(p) || !Number.isInteger(p.i) || !Number.isInteger(p.n) || p.n < 1 || p.n > MR_MAX_PARTS || p.i < 1 || p.i > p.n) return reject('STH-INPUT-400', 'part');\n" +
      "    if (p.count !== undefined && p.count !== null && (tool === 'digest' || !Number.isInteger(p.count) || p.count < 2 || p.count > 50)) return reject('STH-INPUT-400', 'part');\n" +
      "    part = { i: p.i, n: p.n, ...(Number.isInteger(p.count) ? { count: p.count } : {}) };\n" +
      "    if (part.count) count = part.count; // the number of cards / questions of this part\n" +
      "  }\n" +
      "  const v7Request = tool === 'infographic' || tool === 'slides' || tool === 'digest' || !!part || isReduce;\n"
  );
  q = mustReplace(q, '/^S([1-9]|10)$/', '/^S([1-9]|1[0-5])$/');
  q = mustReplace(
    q,
    "    if (s.kind === 'image') {\n      images++;",
    "    if (isReduce) { // the digests carry the material: the sources are only their names\n      if (s.kind === 'image' || (s.text !== undefined && s.text !== null && s.text !== '') || (s.image !== undefined && s.image !== null)) return reject('STH-INPUT-400', 'reduce_sources');\n      clean.push({ id: s.id, name, kind: s.kind, markers: 'none', text: '' });\n      continue;\n    }\n    if (s.kind === 'image') {\n      images++;"
  );
  q = mustReplace(
    q,
    "  const capTokens = effectiveCap();\n  if (tokens > capTokens) return reject('STH-STU-413', 'too_much_material', { maxTokens: capTokens });\n",
    "  const capTokens = effectiveCap();\n" +
      "  // reduce run: the digests (cleaned to the known shape, every source must be one of the request's) are the material\n" +
      "  const cleanDigests = [];\n" +
      "  const citeSet = [];\n" +
      "  const digestMax = new Map();\n" +
      "  let digestText = '';\n" +
      "  const digestFigures = [];\n" +
      "  if (isReduce) {\n" +
      "    const ds = body.digests;\n" +
      "    if (!Array.isArray(ds) || ds.length < 1 || ds.length > MR_MAX_PARTS) return reject('STH-INPUT-400', 'digest_invalid');\n" +
      "    const cites = new Set();\n" +
      "    let chars = 0;\n" +
      "    for (const d of ds) {\n" +
      "      if (!d || typeof d !== 'object' || Array.isArray(d) || d.schema !== DG_SCHEMA_ID || !Array.isArray(d.topics)) return reject('STH-INPUT-400', 'digest_invalid');\n" +
      "      const cd = studioCleanDigest(d, null);\n" +
      "      if (!cd.topics.length) return reject('STH-INPUT-400', 'digest_invalid');\n" +
      "      for (const x of [...cd.topics.flatMap((t) => t.points), ...cd.figures]) {\n" +
      "        if (!seenIds.has(x.source)) return reject('STH-INPUT-400', 'digest_invalid');\n" +
      "        cites.add(x.source + ':' + x.page);\n" +
      "        if (x.page > (digestMax.get(x.source) || 0)) digestMax.set(x.source, x.page);\n" +
      "      }\n" +
      "      for (const f of cd.figures) digestFigures.push({ value: f.value, quote: f.quote });\n" +
      "      const topicsText = cd.topics.map((t) => '#'.repeat(t.level) + ' ' + t.heading + '\\n' + t.points.map((p) => '- ' + p.text + ' [' + p.source + ' p.' + p.page + ']').join('\\n')).join('\\n');\n" +
      "      const figText = cd.figures.map((f) => '* ' + f.value + ' | ' + f.label + ' | \"' + f.quote + '\" [' + f.source + ' p.' + f.page + ']').join('\\n');\n" +
      "      const one = topicsText + (figText ? '\\nFIGURES\\n' + figText : '');\n" +
      "      chars += one.length;\n" +
      "      cleanDigests.push(one);\n" +
      "      digestText += one + '\\n';\n" +
      "    }\n" +
      "    if (chars > MR_REDUCE_MAX_CHARS) return reject('STH-STU-413', 'reduce_too_big', { maxTokens: Math.min(MR_REDUCE_MAX_TOKENS, capTokens) });\n" +
      "    tokens += Math.ceil(chars / 4);\n" +
      "    citeSet.push(...cites);\n" +
      "  }\n" +
      "  if (part) { const lim = Math.min(MR_PART_MAX_TOKENS, capTokens); if (tokens > lim) return reject('STH-STU-413', 'part_too_big', { maxTokens: lim }); }\n" +
      "  else if (isReduce) { const lim = Math.min(MR_REDUCE_MAX_TOKENS, capTokens); if (tokens > lim) return reject('STH-STU-413', 'reduce_too_big', { maxTokens: lim }); }\n" +
      "  else if (tokens > capTokens) return reject('STH-STU-413', 'too_much_material', { maxTokens: capTokens });\n"
  );
  q = mustReplace(
    q,
    "  const sourceMeta = clean.map((c) => ({ id: c.id, maxPage: c.kind === 'image' ? 0 : c.markers === 'sheet' || c.markers === 'none' ? 0 : maxPageOf(c.text) }));",
    "  const minPageOf = (text) => {\n    let min = 0;\n    const re = /\\[(?:Scan )?[Pp]age (\\d{1,5})\\]|^##\\s+Slide (\\d{1,5})\\b/gm;\n    let m;\n    while ((m = re.exec(text)) !== null) {\n      const n = Number(m[1] || m[2]);\n      if (n > 0 && n <= 20000 && (min === 0 || n < min)) min = n;\n    }\n    return min;\n  };\n" +
      "  const sourceMeta = clean.map((c) => ({ id: c.id, maxPage: isReduce ? digestMax.get(c.id) || 0 : c.kind === 'image' ? 0 : c.markers === 'sheet' || c.markers === 'none' ? 0 : maxPageOf(c.text), ...(tool === 'digest' && c.kind !== 'image' && c.markers !== 'sheet' && c.markers !== 'none' ? { minPage: minPageOf(c.text) } : {}) }));"
  );
  q = mustReplace(q, '(source|settings|request)\\b', '(source|settings|request|digest)\\b');
  q = mustReplace(
    q,
    "  const toolLabel = tool === 'flashcards' ? 'flashcards' : tool === 'quiz' ? 'quiz' : 'mind map';\n  const settingsExtra = tool === 'flashcards' ? `cards: ${count}\\ndifficulty: ${difficulty}\\n` : tool === 'quiz' ? `questions: ${count}\\ndifficulty: ${difficulty}\\n` : '';\n",
    "  const toolLabel = tool === 'flashcards' ? 'flashcards' : tool === 'quiz' ? 'quiz' : tool === 'infographic' ? 'infographic' : tool === 'slides' ? 'slide deck' : tool === 'digest' ? 'digest' : 'mind map';\n" +
      "  const settingsExtra = (tool === 'flashcards' ? `cards: ${count}\\ndifficulty: ${difficulty}\\n` : tool === 'quiz' ? `questions: ${count}\\ndifficulty: ${difficulty}\\n` : tool === 'infographic' ? `layout: ${layout}\\n` : tool === 'slides' ? `format: ${format}\\nlength: ${length}\\n` : '') + (part ? `part: ${part.i} of ${part.n}\\n` : '') + (isReduce ? 'strategy: reduce (the material is the digests of the parts)\\n' : '');\n"
  );
  q = mustReplace(
    q,
    '  clean.forEach((c, i) => {\n    if (c.kind === \'image\') {',
    "  if (isReduce) {\n    clean.forEach((c) => parts.push({ text: `<source id=\"${c.id}\" name=\"${c.name}\" type=\"${c.kind}\"/>` }));\n    cleanDigests.forEach((d, k) => parts.push({ text: `<digest part=\"${k + 1}\">\\n${neutral(d)}\\n</digest>` }));\n  } else clean.forEach((c, i) => {\n    if (c.kind === 'image') {"
  );
  q = mustReplace(q, '  // ── schema sth.mindmap/1 (flat list with parent ids;', src('studio7.prompt.part.js') + '  // ── schema sth.mindmap/1 (flat list with parent ids;');
  q = mustReplace(q, "  const schema = tool === 'flashcards' ? fcSchema : tool === 'quiz' ? qzSchema : mindmapSchema;\n", src('studio7.schema.part.js').replace('igLayout ===', 'layout ===').replace('[igLayout]', '[layout]') + "  const schema = tool === 'flashcards' ? fcSchema : tool === 'quiz' ? qzSchema : tool === 'infographic' ? igSchema : tool === 'slides' ? slSchema : tool === 'digest' ? dgSchema : mindmapSchema;\n");
  q = mustReplace(q, "(tool === 'flashcards' ? FLASHCARDS : tool === 'quiz' ? QUIZ : MINDMAP) }", "(tool === 'flashcards' ? FLASHCARDS : tool === 'quiz' ? QUIZ : tool === 'infographic' ? INFOGRAPHIC : tool === 'slides' ? SLIDES : tool === 'digest' ? DIGEST : MINDMAP) + (isReduce ? '\\n\\n' + REDUCE : '') }");
  q = mustReplace(q, "      temperature: tool === 'mindmap' ? 0.3 : 0.4,\n", "      temperature: tool === 'mindmap' || tool === 'infographic' || tool === 'digest' ? 0.3 : 0.4,\n");
  q = mustReplace(q, ': tool === \'quiz\' ? 24576 : 32768,\n', ": tool === 'quiz' ? 24576 : tool === 'infographic' || tool === 'digest' ? 8192 : tool === 'slides' ? 16384 : 32768,\n");
  q = mustReplace(q, "      promptVersion: STUDIO_PROMPT_VERSION,\n", "      promptVersion: v7Request ? STUDIO_PROMPT_VERSION_V7 : STUDIO_PROMPT_VERSION,\n");
  q = mustReplace(
    q,
    "      ...(tool === 'flashcards' || tool === 'quiz' ? { count, difficulty } : {}),\n",
    "      ...(tool === 'flashcards' || tool === 'quiz' ? { count, difficulty } : {}),\n" +
      "      ...(v7Request ? {\n" +
      "        strategy: isReduce ? 'reduce' : part ? 'part' : 'direct',\n" +
      "        // no repeat of a timeout / 5xx / empty answer (it could be billed without being metered); a timeout or 5xx is metered at the worst case\n" +
      "        strictRetry: true,\n" +
      "        worstUnits: Math.round(tokens + 2500 + 8.33 * (geminiBody.generationConfig.maxOutputTokens + 1024)),\n" +
      "        ...(part ? { part } : {}),\n" +
      "        ...(tool === 'infographic' ? { layout } : tool === 'slides' ? { format, length } : {}),\n" +
      "        ...(isReduce ? { citeSet, ...(tool === 'mindmap' ? {} : { verify: { digestText, digestFigures } }) } : tool === 'infographic' || tool === 'slides' || tool === 'digest' ? { verify: { texts: Object.fromEntries(clean.filter((x) => x.kind !== 'image').map((x) => [x.id, x.text])) } } : {}),\n" +
      "      } : {}),\n"
  );
  vr.parameters.jsCode = q;
  vr.notes = 'Study Studio (mind map, flashcards, quiz and, from v7, infographic, slides and digest). Re-checks the request (tool and mode agree, 1-15 sources, <=5 images, description <=1000, language in the list, per-tool options, server token estimate <= cfg:studio_max_tokens, default 400000, hard maximum 900000) and builds the Gemini request for the tool. A part (digest, flashcards, quiz) or a reduce run (digests of the parts: <= min(300000, cap) tokens) is accepted only inside a bulk job. Rejections return only a fixed error code, never request text.';

  // ── d. Studio - Retry Check: every tool except a direct mind map takes its retry budget from the job deadline; a v7 request (new tool, part, reduce) is never repeated after a timeout, 5xx or empty answer ──
  const rc = byName(wf, 'Studio - Retry Check');
  let rj = rc.parameters.jsCode;
  rj = mustReplace(rj, "// flashcards / quiz job: the retry must end 30 s before the job deadline and may start with MIN_RETRY_MS left (calls take 60-120 s)\nconst flashJob = inJob && (st.tool === 'flashcards' || st.tool === 'quiz');", "// every job except a direct mind map: the retry must end 30 s before the job deadline and may start with MIN_RETRY_MS left (calls take 60-120 s)\nconst deadlineJob = inJob && (st.tool !== 'mindmap' || st.strategy === 'reduce');");
  rj = mustReplace(rj, 'flashJob', 'deadlineJob');
  rj = mustReplace(rj, 'const large = Number(st.estimate) > LARGE_ESTIMATE;', 'const large = Number(st.estimate) > LARGE_ESTIMATE || st.strictRetry === true; // v7: also every new tool, part and reduce run');
  rc.parameters.jsCode = rj;

  // ── e. Studio - Validate: infographic, slides, digest, reduce citations, worst-case metering ──
  const val = byName(wf, 'Studio - Validate');
  let code = val.parameters.jsCode;
  const epi6 = src('studio5-validate.epilogue.js');
  if (!code.endsWith(epi6)) throw new Error('Studio - Validate epilogue not at the end');
  let lib = code.slice(0, code.length - epi6.length);
  lib = mustReplace(lib, 'const done = (response, billed) => ({ response, meterUnits: billed ? studioUnits(usage) : 0 });', 'const done = (response, billed, atRisk) => ({ response, meterUnits: billed ? studioUnits(usage) : atRisk && ctx && Number.isFinite(ctx.worstUnits) ? Math.round(ctx.worstUnits) : 0 }); // atRisk: a timeout or 5xx may have been billed (v7 requests only carry worstUnits)');
  lib = mustReplace(lib, "if (!Number.isFinite(status)) return done(studioFail('STH-STU-409', 'unreachable'), false);", "if (!Number.isFinite(status)) return done(studioFail('STH-STU-409', 'unreachable'), false, true);");
  lib = mustReplace(lib, "return done(studioFail('STH-STU-409', status === 429 ? 'busy' : 'upstream'), false);", "return done(studioFail('STH-STU-409', status === 429 ? 'busy' : 'upstream'), false, status >= 500);");
  lib = mustReplace(lib, "  const isQz = !!ctx && ctx.tool === 'quiz';\n", "  const isQz = !!ctx && ctx.tool === 'quiz';\n  const isIg = !!ctx && ctx.tool === 'infographic';\n  const isSl = !!ctx && ctx.tool === 'slides';\n  const isDg = !!ctx && ctx.tool === 'digest';\n");
  lib = mustReplace(lib, '  const v = isQz ? studioValidateQuiz(', '  const v = isIg ? studioValidateInfographic(text, ctx) : isSl ? studioValidateSlides(text, ctx) : isDg ? studioValidateDigest(text, ctx) : isQz ? studioValidateQuiz(');
  lib = mustReplace(
    lib,
    "  if (!v.ok) return done(studioFail('STH-STU-422', v.reason), true);\n",
    "  if (!v.ok) return done(studioFail('STH-STU-422', v.reason), true);\n  if (ctx && ctx.strategy === 'reduce' && ctx.citeSet) {\n    const rcs = studioReduceCites(v.data, ctx.citeSet);\n    if (rcs.zeroed) v.repairs.push('reset ' + rcs.zeroed + ' page numbers that are not in the digests to 0');\n    if (rcs.dropped) v.repairs.push('dropped ' + rcs.dropped + ' citations to sources that are not in the digests');\n  }\n"
  );
  lib = mustReplace(lib, "        tool: isQz ? 'quiz' : isFc ? 'flashcards' : 'mindmap',\n        schema: isQz ? QZ_SCHEMA_ID : isFc ? FC_SCHEMA_ID : SV_SCHEMA_ID,\n", "        tool: isIg ? 'infographic' : isSl ? 'slides' : isDg ? 'digest' : isQz ? 'quiz' : isFc ? 'flashcards' : 'mindmap',\n        schema: isIg ? IG_SCHEMA_ID : isSl ? SL_SCHEMA_ID : isDg ? DG_SCHEMA_ID : isQz ? QZ_SCHEMA_ID : isFc ? FC_SCHEMA_ID : SV_SCHEMA_ID,\n");
  lib = mustReplace(lib, "        strategy: 'direct',\n", "        strategy: (ctx && ctx.strategy) || 'direct',\n        ...(ctx && ctx.part ? { part: { i: ctx.part.i, n: ctx.part.n } } : {}),\n");
  const libAll = lib + '\n' + src('studio7-digest.lib.js') + '\n' + src('studio7.lib.js');
  val.parameters.jsCode = libAll + '\n' + src('studio7-validate.epilogue.js');
  val.notes = 'Parses, validates and repairs the answer per tool. Mind map: single root, orphans, cycles, depth, caps. Flashcards / quiz: as v5 / v6. v7: infographic (4 layouts, icon set, numbers kept only when their quote is found in the source), slides (10 layouts, quotes must be in the source), digest (points and figures of one part). A reduce run keeps only citations that are in the digests. A timeout or 5xx of a v7 request is metered at the worst case. Pure function: no network, no globals.';
  byName(wf, 'Studio - Call Gemini').notes = 'gemini-2.5-flash (flash-lite only on attempt 3), JSON mode with the schema of the tool (mind map, flashcards, quiz, infographic, slides or digest). Node timeout comes from the item (240000 ms, shorter when the request budget is running out). Never errors: failures are handled by Studio - Retry Check.';

  // ── f. Jobs: new modes, reserved slots + bulk cap (ADMIT), bulk flag on the job, STORE frees both sets, budget op ──
  const X0 = 13856, Y = 5300;
  byName(wf, 'Job - Read Request').parameters.jsCode = src('job7-read-request.js');
  byName(wf, 'Job - Plan').parameters.jsCode = src('job7-plan.js');
  const adm = byName(wf, 'Job - Admit');
  adm.parameters.jsonBody = `={{ ["EVAL", ${JSON.stringify(lua('job7-admit.lua'))}, String($json.keys.length), ...$json.keys, ...$json.argv] }}`;
  adm.notes = 'ADMIT (atomic): idempotent create, running caps per mode and in total (cfg:jobs_max_running overrides the total, 0 = off), the bulk cap (2 bulk jobs together; the 2 other slots stay for interactive work), records sth:job:<id>, the execution map sth:jobx:<execution id> and the running sets sth:jobs:run:<mode> and sth:jobs:run:bulk. Fail-closed: if Upstash does not answer, the run ends here.';
  const sto = byName(wf, 'Job - Store Outcome');
  sto.parameters.jsonBody = `={{ ["EVAL", ${JSON.stringify(lua('job7-store.lua'))}, "5", ...$json.keys, ...$json.argv] }}`;
  const jobLib7 = mustReplace(src('job.lib.js'), "'sth:jobs:n:' + jobDay(now)],", "'sth:jobs:n:' + jobDay(now), 'sth:jobs:run:bulk'],");
  const cls = mustReplace(
    src('job-classify.js'),
    "  if (m) err = { code: TUTOR_MARKERS[m[1]] };\n  else state = 'succeeded';\n}\n",
    "  if (m) err = { code: TUTOR_MARKERS[m[1]] };\n  else state = 'succeeded';\n} else if (r.ok === undefined && typeof r.text === 'string') {\n  // transcribe / template / reviewer (v7 jobs): the answer is {text}; the blocked markers are failures with a code, an empty text is AI-204\n  const m = r.text.match(/^\\[(Blocked|Transcription blocked)\\]/);\n  if (m) err = { code: TUTOR_MARKERS[m[1]] };\n  else if (!r.text.trim()) err = { code: 'STH-AI-204' };\n  else state = 'succeeded';\n}\n"
  );
  byName(wf, 'Job - Classify Outcome').parameters.jsCode = jobLib7 + '\n' + cls;
  byName(wf, 'Job - Error Outcome').parameters.jsCode = jobLib7 + '\n' + src('job-error-outcome.js');
  // Job - Route Op: output 7 = budget
  const ro = byName(wf, 'Job - Route Op');
  const rule0 = JSON.parse(JSON.stringify(ro.parameters.rules.values[0]));
  rule0.conditions.conditions[0].id = uuid('Job - Route Op:budget');
  rule0.conditions.conditions[0].rightValue = 'budget';
  rule0.outputKey = 'budget';
  ro.parameters.rules.values.push(rule0);
  const jobRedis = (name, bodyExpr, position, notes) => {
    const n = redisNode(name, bodyExpr, position, { notes });
    n.parameters.options.timeout = 5000;
    return n;
  };
  wf.nodes.push(
    jobRedis('Job - Budget Read', '={{ ["MGET", ...$json.keys] }}', [X0 + 1344, Y + 1100], 'One MGET: usage of today, cfg:daily_units, cfg:studio_max_tokens, cfg:mr_max_units, cfg:bulk_ratio. Fail-open (the answer then has no ceiling).'),
    codeNode('Job - Budget Reply', src('job7-budget-reply.js'), [X0 + 1568, Y + 1100], { notes: 'Answer to op budget: used, ceiling, remaining, bulk ceiling, the Studio token cap and the per-run limit of a map-reduce run. Numbers only, no personal data.' })
  );
  link(c, 'Job - Route Op', 'Job - Budget Read', 7);
  link(c, 'Job - Budget Read', 'Job - Budget Reply');

  // ── g. J4: transcribe / template / reviewer as jobs ──
  for (const [nm, build, ext, meter] of J4) {
    const call = byName(wf, `Call Gemini (${nm})`);
    const gate = ifNode(`Job? (${nm})`, "={{ !!$('Normalize Multipart Body').first().json._job }}", [call.position[0] - 224, call.position[1]]);
    const jobCall = {
      parameters: {
        method: 'POST',
        url: call.parameters.url,
        authentication: 'genericCredentialType',
        genericAuthType: 'httpHeaderAuth',
        sendBody: true,
        specifyBody: 'json',
        jsonBody: call.parameters.jsonBody,
        options: { response: { response: { fullResponse: true, neverError: true } }, timeout: 280000 },
      },
      id: uuid(`Call Gemini (${nm}, job)`),
      name: `Call Gemini (${nm}, job)`,
      type: 'n8n-nodes-base.httpRequest',
      typeVersion: 4.2,
      position: [call.position[0], call.position[1] - 160],
      credentials: call.credentials,
      onError: 'continueRegularOutput',
      notes: 'Job run only: one call, no repeat inside the node (a repeat could be billed without being metered; the app retries the whole job, visibly). Time-out 280 s. Never errors: "Job Settle" turns a failure into a fixed code.',
    };
    wf.nodes.push(
      gate,
      jobCall,
      codeNode(`Job Settle (${nm})`, mustReplace(src('j4-settle.js'), '__BUILD__', build), [call.position[0] + 224, call.position[1] - 160], { notes: 'Job run only: passes a good answer on; a failed call becomes a fixed STH-AI code and, for a time-out or 5xx, the worst-case usage (meter). The Extract node throws the code.' })
    );
    replaceTarget(c, build, call.name, gate.name);
    link(c, gate.name, jobCall.name, 0);
    link(c, gate.name, call.name, 1);
    link(c, jobCall.name, `Job Settle (${nm})`);
    link(c, `Job Settle (${nm})`, meter);
    const ex = byName(wf, ext);
    ex.parameters.jsCode = mustReplace(ex.parameters.jsCode, `const response = $('Call Gemini (${nm})').first().json;`, `const response = $('Job Settle (${nm})').isExecuted ? $('Job Settle (${nm})').first().json : $('Call Gemini (${nm})').first().json;\nif (response._jobFail) throw new Error(response._jobFail + ' Gemini call failed');`);
    link(c, ext, 'Job - Sync?'); // output 0 of Job - Sync? stays unconnected: the synchronous answer is unchanged
    const m = byName(wf, meter);
    m.parameters.jsonBody = mustReplace(m.parameters.jsonBody, '+ 4 * (n(u.candidatesTokenCount)', '+ 8.33 * (n(u.candidatesTokenCount)');
    m.notes = 'Adds this call to usage:YYYYMMDD (weighted units: prompt + 8.33 x (output + thinking)). Fail-open.';
    call.notes = 'Direct (synchronous) request: unchanged, up to 3 tries. A job run takes the "(' + nm + ', job)" node.';
  }
  for (const nm of ['Gemini Init Upload', 'Gemini Init Upload (Template)', 'Gemini Init Upload (Reviewer)', 'Gemini Upload Bytes', 'Gemini Upload Bytes (Template)', 'Gemini Upload Bytes (Reviewer)']) byName(wf, nm).parameters.options.timeout = 60000;

  // ── h. Tutor: the whole document is sent only up to 400,000 estimated tokens; above it, search excerpts and a pointer to Study Studio ──
  const pt = byName(wf, 'Prep — Tutor');
  pt.parameters.jsCode = mustReplace(pt.parameters.jsCode, 'const RETRIEVAL_BUDGET_TOKENS = 60000;\n', 'const RETRIEVAL_BUDGET_TOKENS = 60000;\nconst WHOLE_DOCUMENT_MAX_TOKENS = 400000; // above this a "summarise the whole book" question gets excerpts, not the whole text (cost guard)\n');
  pt.parameters.jsCode = mustReplace(pt.parameters.jsCode, 'const sendWholeDocuments = totalTokens <= RETRIEVAL_BUDGET_TOKENS || WHOLE_DOCUMENT_PATTERN.test(latestQuestion);', 'const wholeAsked = WHOLE_DOCUMENT_PATTERN.test(latestQuestion);\n  const sendWholeDocuments = totalTokens <= RETRIEVAL_BUDGET_TOKENS || (wholeAsked && totalTokens <= WHOLE_DOCUMENT_MAX_TOKENS);\n  const tooBigForWhole = wholeAsked && totalTokens > WHOLE_DOCUMENT_MAX_TOKENS;');
  pt.parameters.jsCode = mustReplace(pt.parameters.jsCode, "These are excerpts, not the full documents. Treat them as the source of truth.\n", "These are excerpts, not the full documents. Treat them as the source of truth.\n${tooBigForWhole ? 'The student asked about the whole of material that is too large to read at once. Answer from the excerpts and add one sentence: for a summary or outline of a whole book, Study Studio can make it.\\n' : ''}");

  return { wf, libAll };
}

// ── App origins (a final step over the bundle, run on every shipped bundle AFTER it is built, so nothing added later can miss it): the webhook
// nodes answer only the app origin(s). Default = the single current origin (nothing changes). To allow a second origin (a future custom domain)
// build with STH_EXTRA_ORIGIN=https://example.org node build.js; n8n takes a comma-separated list. v1..v6 never change. `expected` = how many
// webhook nodes must carry the app origin (v7: 4, v8: 5 = + Renew Endpoint); any other number is a build error, so a new webhook cannot be forgotten.
const APP_ORIGIN = 'https://jay-leigh.github.io';
function applyExtraOrigin(wf, expected) {
  const extra = (process.env.STH_EXTRA_ORIGIN || '').trim();
  if (!extra) return wf;
  if (!/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/i.test(extra)) throw new Error('STH_EXTRA_ORIGIN must be an https origin without path (https://host[:port]), got: ' + extra);
  let n = 0;
  for (const nd of wf.nodes) if (nd.type === 'n8n-nodes-base.webhook' && nd.parameters.options && nd.parameters.options.allowedOrigins === APP_ORIGIN) { nd.parameters.options.allowedOrigins = APP_ORIGIN + ',' + extra; n++; }
  if (n !== expected) throw new Error(`expected ${expected} webhook nodes with the app origin, found ${n}`);
  return wf;
}

// v8 = v7 + (a) token renewal (Renew Endpoint, stateless, optional Upstash key auth:ep = revocation epoch, hourly global breaker), (b) sign-in claims v2 (auth_time, ep),
// (c) job pickup by another device (op claim, state collected after ack, result honours a live claim), (d) hello v 8. It REPLACES v7 (import v8 instead of v7).
// Design: docs/design-signin-sync.md B and D; every must-fix of docs/review-signin-sync-BD.md is in. Everything not listed here is byte-for-byte v7.
function buildV8(v7) {
  const wf = JSON.parse(JSON.stringify(v7));
  const c = wf.connections;
  const lua = (f) => src(f).replace(/\n+$/, '');
  const authLib = src('auth.lib.js').replace(/\nif \(typeof module[^\n]*\n?$/, '\n');
  const RX = 13856, RY = 7400;

  // ── a. Sign-in: the epoch rides along in the same Redis round trip; claims v2 ──
  const EVAL_AUTH8 =
    "local c = redis.call('INCR', KEYS[2]) if c == 1 then redis.call('EXPIRE', KEYS[2], ARGV[1]) end return {redis.call('GET', KEYS[1]), c, redis.call('GET', KEYS[3])}";
  const att = byName(wf, 'Auth Redis Attempt');
  att.parameters.jsonBody = `={{ ["EVAL", ${JSON.stringify(EVAL_AUTH8)}, "3", "auth:code", $json.failKey, "auth:ep", "600"] }}`;
  att.notes = 'Counts this attempt (key auth:fail:<ip>, window 600 s), reads auth:code and (v8) the optional revocation epoch auth:ep, in one round trip.';
  byName(wf, 'Auth Evaluate').parameters.jsCode = authLib + src('auth8-evaluate.js');
  byName(wf, 'Auth Build Claims').parameters.jsCode = authLib + src('auth8-build-claims.js');
  wf.nodes.push(codeNode('Auth Alarm', src('auth8-alarm.js'), [16992, 3300 + 400], { notes: 'After the 503 answer: a stored auth:ep that is not a whole number raises one short error (mailed to the owner by the error workflow). Anything else passes silently.' }));
  link(c, 'Auth Respond 503', 'Auth Alarm');

  // ── b. Renewal ──
  const EVAL_RENEW =
    "local n = redis.call('INCR', KEYS[1]) if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end return {n, redis.call('GET', KEYS[2])}";
  const readEpoch = redisNode(
    'Renew Read Epoch',
    `={{ ["EVAL", ${JSON.stringify(EVAL_RENEW)}, "2", "auth:rn:" + new Date().toISOString().slice(0, 13).replace(/[^0-9]/g, ''), "auth:ep", "7200"] }}`,
    [RX + 448, RY],
    { notes: 'ONE round trip: counts this renewal in the hourly global breaker (auth:rn:<yyyymmddhh>, 2 h expiry) and reads the optional revocation epoch auth:ep. Fail closed: no answer = unavailable.' }
  );
  readEpoch.parameters.options.timeout = 5000;
  wf.nodes.push(
    {
      parameters: { httpMethod: 'POST', path: 'student-tools-renew', authentication: 'jwtAuth', responseMode: 'responseNode', options: { rawBody: false, allowedOrigins: APP_ORIGIN } },
      id: uuid('Renew Endpoint'), name: 'Renew Endpoint', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [RX, RY], webhookId: uuid('webhook:student-tools-renew'), credentials: JWT_CRED,
      notes: 'Renews the app token (v8). JWT required (n8n checks signature and expiry before anything runs). Stateless: new exp = min(now + 7 d, auth_time + 30 d); refused after the 30-day cap, when auth:ep differs, or when the token is under 1 h old. Answers 200 with {ok:true, token, ...} or {ok:false, error}. The body is ignored.',
    },
    codeNode('Renew Prepare', authLib + src('renew8-prepare.js'), [RX + 224, RY], { notes: 'Reads the verified claims only, strictly and by token version (v1 / v2). Never throws.' }),
    readEpoch,
    codeNode('Renew Evaluate', authLib + src('renew8-evaluate.js'), [RX + 672, RY], { notes: 'Decides with server time only. Rules in order: Redis failed, hourly breaker, unusable claims, invalid auth:ep, epoch differs, 30-day cap, token too young, ok.' }),
    outcomeSwitch('Renew Outcome', ['ok', 'refused'], [RX + 896, RY]),
    {
      parameters: { operation: 'sign', useJson: true, claimsJson: '={{ $json.claimsJson }}', headerClaims: '{}', options: {} },
      id: uuid('Renew Sign JWT'), name: 'Renew Sign JWT', type: 'n8n-nodes-base.jwt', typeVersion: 1, position: [RX + 1120, RY - 100], credentials: JWT_CRED, onError: 'continueRegularOutput',
    },
    codeNode('Renew Shape Token', src('renew8-shape-token.js'), [RX + 1344, RY - 100]),
    ifNode('Renew Token Ok?', '={{ $json.ok === true }}', [RX + 1568, RY - 100]),
    respondNode('Renew Respond OK', 200, '={{ JSON.stringify({ ok: true, token: $json.token, expiresAt: $json.expiresAt, authExpiresAt: $json.authExpiresAt, now: $json.now }) }}', [RX + 1792, RY - 200]),
    respondNode('Renew Respond Refused', 200, '={{ JSON.stringify($json.reply) }}', [RX + 1792, RY + 100]),
    codeNode('Renew Alarm', src('renew8-alarm.js'), [RX + 2016, RY + 100], { notes: 'After the refusal is sent: an invalid auth:ep raises one short error (mailed to the owner). Every other refusal passes silently.' })
  );
  link(c, 'Renew Endpoint', 'Renew Prepare');
  link(c, 'Renew Prepare', 'Renew Read Epoch');
  link(c, 'Renew Read Epoch', 'Renew Evaluate');
  link(c, 'Renew Evaluate', 'Renew Outcome');
  link(c, 'Renew Outcome', 'Renew Sign JWT', 0);
  link(c, 'Renew Outcome', 'Renew Respond Refused', 1);
  link(c, 'Renew Sign JWT', 'Renew Shape Token');
  link(c, 'Renew Shape Token', 'Renew Token Ok?');
  link(c, 'Renew Token Ok?', 'Renew Respond OK', 0);
  link(c, 'Renew Token Ok?', 'Renew Respond Refused', 1);
  link(c, 'Renew Respond Refused', 'Renew Alarm');

  // ── c. Jobs: hello v 8, claim, collected after ack, result honours a live claim ──
  const X0 = 13856, Y = 5300;
  byName(wf, 'Job - Read Request').parameters.jsCode = src('job8-read-request.js');
  byName(wf, 'Job - Plan').parameters.jsCode = src('job8-plan.js');
  byName(wf, 'Job - Result Reply').parameters.jsCode = src('job8-result-reply.js');
  const ack = byName(wf, 'Job - Ack');
  ack.parameters.jsonBody = `={{ $json.jobs.map((j) => ["EVAL", ${JSON.stringify(lua('job8-ack.lua'))}, "2", j.job, j.jobr, j.kh, j.nonce, String($json.now), String($json.collectedTtlS)]) }}`;
  ack.notes = 'ACK (v8): a finished (succeeded) job becomes a contentless `collected` record (72 h) and its answer is deleted, so a device that started the job never re-runs it; a job claimed by ANOTHER nonce is left alone (returns 3); failed / rejected / cancelled jobs are deleted as before; running is left alone.';
  byName(wf, 'Job - Ack Reply').parameters.jsCode = src('job8-ack-reply.js');
  byName(wf, 'Job - Result Read').notes = 'HMGET (kh, st, a, m, cl, cla) + GET of one job (a /pipeline call). A live claim makes the answer STH-JOB-409.';
  const ro = byName(wf, 'Job - Route Op');
  const rule0 = JSON.parse(JSON.stringify(ro.parameters.rules.values[0]));
  rule0.conditions.conditions[0].id = uuid('Job - Route Op:claim');
  rule0.conditions.conditions[0].rightValue = 'claim';
  rule0.outputKey = 'claim';
  ro.parameters.rules.values.push(rule0);
  const claim = redisNode('Job - Claim', `={{ [["EVAL", ${JSON.stringify(lua('job-claim.lua'))}, "2", $json.jobs[0].job, $json.jobs[0].jobr, $json.jobs[0].kh, $json.jobs[0].nonce, String($json.now), String($json.claimLeaseMs)]] }}`, [X0 + 1344, Y + 1300], {
    notes: 'CLAIM (v8, atomic): the holder of the key takes the finished answer under a nonce of its own (10 minute lease; the same nonce renews it). Another live claim = STH-JOB-409. Writes only cl / cla on an existing record (its expiry is unchanged).',
  });
  claim.parameters.options.timeout = 5000;
  claim.parameters.url = UPSTASH_URL + '/pipeline';
  wf.nodes.push(claim, codeNode('Job - Claim Reply', src('job-claim-reply.js'), [X0 + 1568, Y + 1300], { notes: 'Answer to op claim: the answer and its mode, or a state, or STH-JOB-409 (claimed), or STH-JOB-404.' }));
  link(c, 'Job - Route Op', 'Job - Claim', 8);
  link(c, 'Job - Claim', 'Job - Claim Reply');
  return wf;
}

const v1 = buildV1();
const v2 = buildV2(v1);
const v3 = buildV3(v2);
const v4 = buildV4(v3);
const { wf: v5, libAll: v5Lib } = buildV5(v4);
const { wf: v6, libAll: v6Lib } = buildV6(v5, v5Lib);
const { wf: v7, libAll: v7Lib } = buildV7(v6, v6Lib);
const v8 = applyExtraOrigin(buildV8(v7), 5); // built from the plain v7, before v7 itself gets the extra origin
applyExtraOrigin(v7, 4);
const OUT = process.env.STH_OUT_DIR ? path.resolve(process.env.STH_OUT_DIR) : DIR; // tests build into a temp folder (the extra-origin build)
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'sth-workflow-v1-additive.json'), JSON.stringify(v1, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'sth-workflow-v2-enforce.json'), JSON.stringify(v2, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'sth-workflow-v3-studio.json'), JSON.stringify(v3, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'sth-workflow-v4-jobs.json'), JSON.stringify(v4, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'sth-workflow-v5-flashcards.json'), JSON.stringify(v5, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'sth-workflow-v6-quiz.json'), JSON.stringify(v6, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'sth-workflow-v7-bundle.json'), JSON.stringify(v7, null, 2) + '\n');
fs.writeFileSync(path.join(OUT, 'sth-workflow-v8-bundle.json'), JSON.stringify(v8, null, 2) + '\n');
fs.mkdirSync(path.join(OUT, 'gen'), { recursive: true });
fs.writeFileSync(path.join(OUT, 'gen', 'studio5.lib.js'), '// GENERATED by build.js (v5 Studio - Validate library): do not edit\n' + v5Lib);
fs.writeFileSync(path.join(OUT, 'gen', 'studio6.lib.js'), '// GENERATED by build.js (v6 Studio - Validate library): do not edit\n' + v6Lib);
fs.writeFileSync(path.join(OUT, 'gen', 'studio7.lib.js'), '// GENERATED by build.js (v7 Studio - Validate library): do not edit\n' + v7Lib);
console.log('v8 nodes', v8.nodes.length, '|', 'v7 nodes', v7.nodes.length, '|', 'v6 nodes', v6.nodes.length, '|', 'v5 nodes', v5.nodes.length, '|', 'v4 nodes', v4.nodes.length, '|', 'v1 nodes', v1.nodes.length, 'v2 nodes', v2.nodes.length, 'v3 nodes', v3.nodes.length);
