// --- STUDIO VALIDATE (pure functions: no n8n globals, no URL/crypto/fetch, no throws on bad input) ---
// Mind map validation and repair (design 3.6 for sth.mindmap/1) plus the mapping from a Gemini answer to
// the response sent to the browser. Inlined into the Code node "Studio - Validate" by build.js and
// require()d by the unit tests (the export guard at the bottom is a no-op inside n8n).
//
// Reasons returned for failures are fixed tags only. No text taken from a request or from the model is
// ever put in an error, a reason or a repair line.
const SV_LIMITS = {
  MAX_NODES: 200,       // hard cap (review H7: output budget); the prompt asks for at most 200
  MIN_NODES: 4,         // design 3.6 step 3
  MAX_DEPTH: 5,         // root = depth 0; deeper nodes are lifted to depth 5
  MAX_CHILDREN: 20,     // design says 12; raised so a 17-leaf unit (design 8, S1b acceptance) survives
  TITLE: 80,
  LABEL: 90,
  DETAIL: 160,
  NOTICE: 160,
  NOTICES: 3,
  CITES: 3,
  MAX_PAGE: 20000,
  MAX_BYTES: 120000,
};
const SV_SCHEMA_ID = 'sth.mindmap/1';

// Weighted usage units: prompt + 8.33 x (output + thinking). One unit = one input token = USD 0.30 / 1M
// (Gemini 2.5 Flash). 8.33 = 2.50 / 0.30, the real output-to-input price ratio.
function studioUnits(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const n = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0);
  return Math.round(n(u.promptTokenCount) + 8.33 * (n(u.candidatesTokenCount) + n(u.thoughtsTokenCount)));
}

// Plain text: control characters out, Markdown markers out, whitespace collapsed, clamped at a word boundary.
// Markup such as <b> or <script> is kept as characters: it is data and the viewer shows it with textContent.
function studioClean(v, max) {
  if (v === null || v === undefined || typeof v === 'object' || typeof v === 'function') return { text: '', clamped: false };
  let s = String(v)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028\u2029\ufeff]/g, ' ')
    .replace(/\*\*|__|`+/g, '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  let clamped = false;
  if (s.length > max) {
    clamped = true;
    let cut = s.slice(0, max - 1);
    const sp = cut.lastIndexOf(' ');
    if (sp >= Math.floor(max * 0.6)) cut = cut.slice(0, sp);
    // never end on half of a surrogate pair
    if (/[\ud800-\udbff]$/.test(cut)) cut = cut.slice(0, -1);
    s = cut.replace(/[\s,;:.\-]+$/, '') + '\u2026';
  }
  return { text: s, clamped };
}

function studioParseJson(raw) {
  let s = typeof raw === 'string' ? raw : '';
  s = s.replace(/^\ufeff/, '').trim();
  const fence = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(s);
  if (fence) s = fence[1].trim();
  if (!s) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch (e) {
    return { ok: false }; // the parser's message can quote the text: never forwarded
  }
}

// sources: [{ id: 'S1', maxPage: 342 }, ...] (from the request, never from the model)
function studioValidateMindmap(rawText, sources) {
  const repairs = [];
  const log = (n, what) => { if (n > 0) repairs.push(what.replace('#', String(n))); };
  const parsed = studioParseJson(rawText);
  if (!parsed.ok) return { ok: false, reason: 'parse' };
  const top = parsed.value;
  if (!top || typeof top !== 'object' || Array.isArray(top)) return { ok: false, reason: 'shape' };
  if (top.schema !== SV_SCHEMA_ID) return { ok: false, reason: 'schema' };
  if (!Array.isArray(top.nodes)) return { ok: false, reason: 'shape' };
  const L = SV_LIMITS;

  const srcMax = new Map();
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s && typeof s.id === 'string') srcMax.set(s.id, Number.isFinite(s.maxPage) && s.maxPage > 0 ? Math.min(Math.floor(s.maxPage), L.MAX_PAGE) : 0);
  }

  // 1. Nodes: well-formed objects with an id and a label; ids made unique
  const nodes = []; // { id, parent, label, detail, cites, order }
  const byId = new Map();
  let malformed = 0, dupIds = 0, clampedLabels = 0, clampedDetails = 0;
  let badCites = 0, zeroedPages = 0, trimmedCites = 0;
  for (const raw of top.nodes) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { malformed++; continue; }
    const idRaw = typeof raw.id === 'number' && Number.isFinite(raw.id) ? String(raw.id) : raw.id;
    const idc = typeof idRaw === 'string' ? idRaw.trim() : '';
    const lab = studioClean(raw.label, L.LABEL);
    if (!idc || idc.length > 64 || !lab.text) { malformed++; continue; }
    if (lab.clamped) clampedLabels++;
    const det = studioClean(raw.detail, L.DETAIL);
    if (det.clamped) clampedDetails++;
    let parent = '';
    if (typeof raw.parent === 'string') parent = raw.parent.trim();
    else if (typeof raw.parent === 'number' && Number.isFinite(raw.parent)) parent = String(raw.parent);
    // citations: only sources of this request; pages beyond the source's last marker become 0
    const cites = [];
    const seen = new Set();
    for (const c of Array.isArray(raw.cites) ? raw.cites : []) {
      if (!c || typeof c !== 'object' || typeof c.source !== 'string' || !srcMax.has(c.source)) { badCites++; continue; }
      let page = typeof c.page === 'string' && /^\d{1,5}$/.test(c.page.trim()) ? Number(c.page) : c.page;
      if (!Number.isInteger(page) || page < 0 || page > srcMax.get(c.source)) { if (page !== 0) zeroedPages++; page = 0; }
      const key = c.source + ':' + page;
      if (seen.has(key)) continue;
      seen.add(key);
      if (cites.length >= L.CITES) { trimmedCites++; continue; }
      cites.push({ source: c.source, page });
    }
    let id = idc;
    if (byId.has(id)) {
      dupIds++;
      let k = 2;
      while (byId.has(id + '~' + k)) k++;
      id = id + '~' + k;
      // the later duplicate keeps its own parent pointer but children can only name the first one
    }
    const node = { id, origId: idc, parent, label: lab.text, detail: det.text, cites, order: nodes.length };
    nodes.push(node);
    if (!byId.has(idc)) byId.set(idc, node);
    if (id !== idc) byId.set(id, node);
  }
  log(malformed, 'dropped # malformed nodes');
  log(dupIds, 'renamed # duplicate ids');
  log(clampedLabels, 'clamped # labels');
  log(clampedDetails, 'clamped # details');
  log(badCites, 'dropped # citations to unknown sources');
  log(zeroedPages, 'reset # page numbers beyond the source to 0');
  log(trimmedCites, 'dropped # surplus citations');
  if (nodes.length < L.MIN_NODES) return { ok: false, reason: 'too_few_nodes' };

  // 2. Parent resolution. A node's parent is the FIRST node that carries that id.
  const parentNode = new Map(); // node -> node | null (null = declared root / no parent)
  const declaredRoots = [];
  const orphans = [];
  for (const n of nodes) {
    if (n.parent === '') { parentNode.set(n, null); declaredRoots.push(n); continue; }
    const p = byId.get(n.parent);
    if (!p || p === n) { parentNode.set(n, undefined); orphans.push(n); continue; } // unknown parent or own parent
    parentNode.set(n, p);
  }

  // 3. Cycles: walk up from every node; a node reached again on the same walk closes a cycle, which is
  //    broken by detaching the node whose parent edge closed it (it becomes parentless).
  const state = new Map(); // 1 = on the current walk, 2 = done
  let cyclesBroken = 0;
  const cycleNodes = [];
  for (const start of nodes) {
    if (state.get(start)) continue;
    const path = [];
    let cur = start;
    while (cur && !state.get(cur)) {
      state.set(cur, 1);
      path.push(cur);
      cur = parentNode.get(cur) || null;
    }
    if (cur && state.get(cur) === 1) {
      // `cur` is on this walk: the node just before the repeat points back to it
      const last = path[path.length - 1];
      parentNode.set(last, null);
      cycleNodes.push(last);
      cyclesBroken++;
    }
    for (const p of path) state.set(p, 2);
  }
  log(cyclesBroken, 'broke # cycles');

  // 4. Single root. Declared roots first (document order), else a node freed by breaking a cycle, else an orphan.
  let root = declaredRoots[0] || cycleNodes[0] || orphans[0] || null;
  if (!root) return { ok: false, reason: 'no_root' };
  if (!declaredRoots.length) log(1, 'promoted # node to root');
  const kids = new Map(nodes.map((n) => [n, []]));
  let extraRoots = 0, attached = 0, droppedOrphans = 0;
  const hasChildren = new Set();
  for (const n of nodes) { const p = parentNode.get(n); if (p) hasChildren.add(p); }
  const dropped = new Set();
  for (const n of nodes) {
    if (n === root) continue;
    let p = parentNode.get(n);
    if (p === null) { extraRoots++; p = root; } // another declared root or a cycle-broken node
    else if (p === undefined) { // orphan
      if (hasChildren.has(n)) { attached++; p = root; } else { droppedOrphans++; dropped.add(n); continue; }
    }
    kids.get(p).push(n);
  }
  log(extraRoots, 're-parented # extra roots under the first');
  log(attached, 'attached # orphan branches to the root');
  log(droppedOrphans, 'dropped # orphan nodes');

  // 5. Walk from the root (document order): depth limit, sibling duplicates, children cap
  const keep = []; // pre-order
  const outParent = new Map();
  let lifted = 0, dupSiblings = 0, overChildren = 0;
  const key = (s) => s.toLowerCase();
  const stack = [{ node: root, depth: 0, up: null, anc: [] }];
  const visited = new Set();
  while (stack.length) {
    const { node, depth, up, anc } = stack.pop();
    if (visited.has(node)) continue;
    visited.add(node);
    let d = depth, parent = up;
    if (d > L.MAX_DEPTH) { parent = anc[L.MAX_DEPTH - 1]; d = L.MAX_DEPTH; lifted++; }
    keep.push(node);
    outParent.set(node, parent);
    const chain = d === depth ? anc.concat(node) : anc.slice(0, L.MAX_DEPTH).concat(node);
    // children: merge sibling duplicates (the later one's children move under the first), then cap
    const list = [];
    const firstByLabel = new Map();
    const queue = kids.get(node).slice();
    for (let i = 0; i < queue.length; i++) {
      const c = queue[i];
      const k = key(c.label);
      if (firstByLabel.has(k)) {
        dupSiblings++;
        for (const g of kids.get(c)) kids.get(firstByLabel.get(k)).push(g);
        continue;
      }
      firstByLabel.set(k, c);
      list.push(c);
    }
    let useList = list;
    if (list.length > L.MAX_CHILDREN) {
      overChildren += list.length - L.MAX_CHILDREN;
      useList = list.slice(0, L.MAX_CHILDREN);
    }
    kids.set(node, useList);
    for (let i = useList.length - 1; i >= 0; i--) stack.push({ node: useList[i], depth: d + 1, up: node, anc: chain });
  }
  log(lifted, 'lifted # deep nodes to depth ' + L.MAX_DEPTH);
  log(dupSiblings, 'merged # duplicate siblings');
  log(overChildren, 'dropped # nodes beyond ' + L.MAX_CHILDREN + ' children of one parent');

  // 6. Node cap: keep the first levels (breadth first), so the tree stays connected
  let ordered = keep;
  if (keep.length > L.MAX_NODES) {
    const bfs = [];
    const q = [root];
    for (let i = 0; i < q.length && bfs.length < L.MAX_NODES; i++) {
      bfs.push(q[i]);
      for (const c of kids.get(q[i]) || []) q.push(c);
    }
    const inBfs = new Set(bfs);
    log(keep.length - bfs.length, 'dropped # nodes beyond the ' + L.MAX_NODES + ' node cap');
    ordered = keep.filter((n) => inBfs.has(n));
  }
  if (ordered.length < L.MIN_NODES) return { ok: false, reason: 'too_few_nodes' };

  // 7. Canonical ids n1..nN in reading order (pre-order), parents rewritten
  const newId = new Map(ordered.map((n, i) => [n, 'n' + (i + 1)]));
  const outNodes = ordered.map((n) => {
    const p = outParent.get(n);
    return {
      id: newId.get(n),
      parent: p && newId.has(p) ? newId.get(p) : '',
      label: n.label,
      detail: n.detail,
      cites: n.cites,
    };
  });
  outNodes[0].parent = '';

  // 8. Title and notices
  let title = studioClean(top.title, L.TITLE);
  if (title.clamped) log(1, 'clamped # title');
  if (!title.text) { title = { text: studioClean(outNodes[0].label, L.TITLE).text }; log(1, 'filled # empty title from the root'); }
  const notices = [];
  for (const nt of Array.isArray(top.notices) ? top.notices : []) {
    const c = studioClean(nt, L.NOTICE);
    if (c.text && notices.length < L.NOTICES) notices.push(c.text);
  }

  const data = { schema: SV_SCHEMA_ID, title: title.text, notices, nodes: outNodes };
  if (JSON.stringify(data).length > L.MAX_BYTES) return { ok: false, reason: 'too_big' };
  return { ok: true, data, repairs };
}

const SV_ERRORS = {
  'STH-STU-409': { retryable: true },
  'STH-STU-413': { retryable: false },
  'STH-STU-422': { retryable: true },
  'STH-AI-403': { retryable: false },
  'STH-AI-451': { retryable: false },
  'STH-AI-452': { retryable: false },
};
function studioFail(code, reason) {
  const e = { code, retryable: (SV_ERRORS[code] || { retryable: false }).retryable };
  if (reason) e.reason = reason;
  return { ok: false, error: e };
}

// res = last Gemini result after the retry loop: { statusCode, body, error?, model, attempt }
// ctx = { sources: [{id, maxPage}], promptVersion, now? }
// Returns { response, meterUnits }
function studioReply(res, ctx) {
  const r = res && typeof res === 'object' ? res : {};
  const status = Number(r.statusCode);
  const body = r.body && typeof r.body === 'object' ? r.body : {};
  const usage = body.usageMetadata && typeof body.usageMetadata === 'object' ? body.usageMetadata : null;
  const done = (response, billed) => ({ response, meterUnits: billed ? studioUnits(usage) : 0 });

  if (!Number.isFinite(status)) return done(studioFail('STH-STU-409', 'unreachable'), false);
  if (status === 429 || status >= 500) return done(studioFail('STH-STU-409', status === 429 ? 'busy' : 'upstream'), false);
  if (status === 401 || status === 403 || status === 404) return done(studioFail('STH-AI-403', 'forbidden'), false);
  if (status === 413) return done(studioFail('STH-STU-413', 'upstream_size'), false);
  if (status !== 200) return done(studioFail('STH-STU-422', 'rejected'), false);

  // HTTP 200: Gemini billed this call whatever the content turned out to be
  if (body.promptFeedback && body.promptFeedback.blockReason) return done(studioFail('STH-AI-451', 'blocked'), true);
  const cand = Array.isArray(body.candidates) ? body.candidates[0] : null;
  const reason = (cand && cand.finishReason) || '';
  if (['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(reason)) return done(studioFail('STH-AI-451', 'blocked'), true);
  if (reason === 'RECITATION') return done(studioFail('STH-AI-452', 'recitation'), true);
  if (reason === 'MAX_TOKENS') return done(studioFail('STH-STU-422', 'truncated'), true);
  const parts = cand && cand.content && Array.isArray(cand.content.parts) ? cand.content.parts : [];
  const text = parts.filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
  if (!text.trim()) return done(studioFail('STH-STU-422', 'empty'), true);

  const v = studioValidateMindmap(text, ctx && ctx.sources);
  if (!v.ok) return done(studioFail('STH-STU-422', v.reason), true);
  const u = usage || {};
  const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  return done(
    {
      ok: true,
      artifact: {
        envelope: 'sth.studio/1',
        tool: 'mindmap',
        schema: SV_SCHEMA_ID,
        promptVersion: ctx && ctx.promptVersion,
        model: typeof r.model === 'string' ? r.model : undefined,
        strategy: 'direct',
        generatedAt: new Date((ctx && ctx.now) || Date.now()).toISOString(),
        usage: { inputTokens: num(u.promptTokenCount), outputTokens: num(u.candidatesTokenCount), thinkingTokens: num(u.thoughtsTokenCount), calls: Number(r.attempt) || 1 },
        repairs: v.repairs,
        data: v.data,
      },
    },
    true
  );
}
// --- end STUDIO VALIDATE ---
if (typeof module !== 'undefined' && module.exports) module.exports = { studioValidateMindmap, studioReply, studioUnits, studioClean, studioFail, SV_LIMITS };
