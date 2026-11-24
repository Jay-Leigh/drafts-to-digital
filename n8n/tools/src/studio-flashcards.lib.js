// --- STUDIO FLASHCARDS (pure functions: no n8n globals, no URL/crypto/fetch, no throws on bad input) ---
// Flashcards validation and repair (design 3.6 for sth.flashcards/1). v5 only. Inlined into the Code node
// "Studio - Validate" by build.js, directly AFTER studio-validate.lib.js (it uses that file's studioClean and
// studioParseJson), and exercised by the unit tests through the generated gen/studio5.lib.js.
//
// Reasons returned for failures are fixed tags only. No text taken from a request or from the model is
// ever put in an error, a reason or a repair line.
const FC_LIMITS = {
  MAX_CARDS: 80,        // schema cap (design 3.5.3); the dialog offers 15 / 30 / 50
  RAW_SCAN: 500,        // never walk more raw cards than this (the model output is bounded far below it)
  FRONT: 160,
  BACK: 500,
  TOPIC: 40,
  TITLE: 80,
  NOTICE: 160,
  NOTICES: 3,
  CITES: 2,
  MIN_SHARE: 0.5,       // hard check: at least half of the requested count must survive (design 3.6 step 3)
  SALVAGE_SHARE: 0.7,   // a cut-off answer is accepted when at least this share of the request was complete (design 3.6 step 2)
  NEAR_DUP: 0.9,        // word-set Jaccard of two fronts at which the later one is dropped (fronts of >= 5 words only)
  MAX_BYTES: 120000,
};
const FC_SCHEMA_ID = 'sth.flashcards/1';

// Lower case, NFKC, punctuation and symbols out, whitespace collapsed: the key used to compare fronts.
function fcNormalize(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

// Same front, or (for fronts of 5+ words) a word set that overlaps by NEAR_DUP or more.
function fcSimilar(a, b) {
  if (a === b) return true;
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  if (ta.length < 5 || tb.length < 5) return false;
  const A = new Set(ta);
  const B = new Set(tb);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter) >= FC_LIMITS.NEAR_DUP;
}

// A cut-off answer (finishReason MAX_TOKENS): the complete card objects of the "cards" array, read one by one with a
// string-aware bracket scanner. Returns null when there is no "cards" array. `head` is the text before it (schema id, title).
function fcSalvage(raw) {
  let s = typeof raw === 'string' ? raw.replace(/^\ufeff/, '').trim() : '';
  s = s.replace(/^```[a-zA-Z]*\s*\n/, '');
  const m = /(^|[^\\])"cards"\s*:\s*\[/.exec(s);
  if (!m) return null;
  let i = m.index + m[0].length;
  const cards = [];
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (s[i] !== '{') break;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < s.length; j++) {
      const ch = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end < 0) break;
    let one;
    try { one = JSON.parse(s.slice(i, end + 1)); } catch (e) { break; }
    cards.push(one);
    i = end + 1;
  }
  return { cards, head: s.slice(0, m.index) };
}

// sources: [{ id: 'S1', maxPage: 342 }, ...] (from the request, never from the model)
// target: the number of cards the student asked for (15, 30 or 50)
// opts.truncated: the model stopped at its token limit (finishReason MAX_TOKENS): a cut-off answer may be salvaged
function studioValidateFlashcards(rawText, sources, target, opts) {
  const truncated = !!(opts && opts.truncated);
  const repairs = [];
  const log = (n, what) => { if (n > 0) repairs.push(what.replace('#', String(n))); };
  const fail = (reason) => ({ ok: false, reason: truncated && ['parse', 'shape', 'schema', 'too_few_cards'].includes(reason) ? 'truncated' : reason });
  const L = FC_LIMITS;
  const want = Number.isInteger(target) && target > 0 ? target : 30;
  const minCards = Math.max(1, Math.ceil(want * L.MIN_SHARE));

  let top;
  const parsed = studioParseJson(rawText);
  if (parsed.ok) {
    top = parsed.value;
  } else if (truncated) {
    const sv = fcSalvage(rawText);
    if (!sv || sv.head.indexOf(FC_SCHEMA_ID) < 0 || sv.cards.length < Math.ceil(want * L.SALVAGE_SHARE)) return fail('parse');
    let t = '';
    const tm = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(sv.head);
    if (tm) { try { t = JSON.parse(tm[1]); } catch (e) { t = ''; } }
    top = { schema: FC_SCHEMA_ID, title: t, notices: [], cards: sv.cards };
    log(sv.cards.length, 'kept # complete cards of a cut-off answer');
  } else {
    return fail('parse');
  }
  if (!top || typeof top !== 'object' || Array.isArray(top)) return fail('shape');
  if (top.schema !== FC_SCHEMA_ID) return fail('schema');
  if (!Array.isArray(top.cards)) return fail('shape');

  const srcMax = new Map();
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s && typeof s.id === 'string') srcMax.set(s.id, Number.isFinite(s.maxPage) && s.maxPage > 0 ? Math.min(Math.floor(s.maxPage), 20000) : 0);
  }

  // 1. Cards: well-formed, non-empty front and back, clamped, citations checked, near-identical fronts dropped
  const kept = []; // { front, back, topic, cites }
  const keys = [];
  let malformed = 0, empty = 0, dupes = 0, clampedFronts = 0, clampedBacks = 0, clampedTopics = 0;
  let badCites = 0, zeroedPages = 0, trimmedCites = 0;
  const rawCards = top.cards.slice(0, L.RAW_SCAN);
  const beyondScan = top.cards.length - rawCards.length;
  for (const raw of rawCards) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { malformed++; continue; }
    const f = studioClean(raw.front, L.FRONT);
    const b = studioClean(raw.back, L.BACK);
    if (!f.text || !b.text) { empty++; continue; }
    const key = fcNormalize(f.text);
    if (keys.some((k) => fcSimilar(k, key))) { dupes++; continue; }
    keys.push(key);
    if (f.clamped) clampedFronts++;
    if (b.clamped) clampedBacks++;
    const tp = studioClean(raw.topic, L.TOPIC);
    if (tp.clamped) clampedTopics++;
    // citations: only sources of this request; pages beyond the source's last marker become 0
    const cites = [];
    const seen = new Set();
    for (const c of Array.isArray(raw.cites) ? raw.cites : []) {
      if (!c || typeof c !== 'object' || typeof c.source !== 'string' || !srcMax.has(c.source)) { badCites++; continue; }
      let page = typeof c.page === 'string' && /^\d{1,5}$/.test(c.page.trim()) ? Number(c.page) : c.page;
      if (!Number.isInteger(page) || page < 0 || page > srcMax.get(c.source)) { if (page !== 0) zeroedPages++; page = 0; }
      const ck = c.source + ':' + page;
      if (seen.has(ck)) continue;
      seen.add(ck);
      if (cites.length >= L.CITES) { trimmedCites++; continue; }
      cites.push({ source: c.source, page });
    }
    kept.push({ front: f.text, back: b.text, topic: tp.text, cites });
  }
  log(malformed, 'dropped # malformed cards');
  log(empty, 'dropped # cards with an empty front or back');
  log(dupes, 'dropped # cards with a front that repeats an earlier one');
  log(clampedFronts, 'clamped # fronts');
  log(clampedBacks, 'clamped # backs');
  log(clampedTopics, 'clamped # topics');
  log(badCites, 'dropped # citations to unknown sources');
  log(zeroedPages, 'reset # page numbers beyond the source to 0');
  log(trimmedCites, 'dropped # surplus citations');

  // 2. Cap
  let cards = kept;
  if (kept.length > L.MAX_CARDS) {
    log(kept.length - L.MAX_CARDS, 'dropped # cards beyond the ' + L.MAX_CARDS + ' card cap');
    cards = kept.slice(0, L.MAX_CARDS);
  }
  log(beyondScan, 'ignored # cards beyond the first ' + L.RAW_SCAN);

  // 3. Hard check: at least half of the requested number
  if (cards.length < minCards) return fail('too_few_cards');

  // 4. Canonical ids c1..cN in order
  const outCards = cards.map((c, i) => {
    const o = { id: 'c' + (i + 1), front: c.front, back: c.back };
    if (c.topic) o.topic = c.topic;
    o.cites = c.cites;
    return o;
  });

  // 5. Title and notices
  let title = studioClean(top.title, L.TITLE);
  if (title.clamped) log(1, 'clamped # title');
  if (!title.text) {
    title = { text: studioClean(outCards[0].topic || outCards[0].front, L.TITLE).text };
    log(1, 'filled # empty title from the first card');
  }
  const notices = [];
  for (const nt of Array.isArray(top.notices) ? top.notices : []) {
    const c = studioClean(nt, L.NOTICE);
    if (c.text && notices.length < L.NOTICES) notices.push(c.text);
  }

  const data = { schema: FC_SCHEMA_ID, title: title.text, notices, cards: outCards };
  if (JSON.stringify(data).length > L.MAX_BYTES) return fail('too_big');
  return { ok: true, data, repairs };
}
// --- end STUDIO FLASHCARDS ---
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(module.exports || {}, { studioValidateFlashcards, fcNormalize, fcSimilar, fcSalvage, FC_LIMITS });
