// --- STUDIO DIGEST (pure functions: no n8n globals, no URL/crypto/fetch, no throws on bad input) ---
// v7. Shared by "Studio - Validate Request" (cleans the digests a browser sends back for a reduce run) and "Studio - Validate"
// (validates the digest a Gemini part run returns). Needs studioClean in scope (build.js adds it to the Request node).
// Reasons are fixed tags; no text of a request or of the model is ever put in an error.
const DG_SCHEMA_ID = 'sth.digest/1';
const DG_LIMITS = { TOPICS: 60, HEADING: 100, POINTS: 15, POINT: 200, FIGURES: 20, VALUE: 16, LABEL: 60, QUOTE: 160, MAX_PAGE: 20000, MAX_BYTES: 64000 };
const DG_SOURCE_RE = /^S([1-9]|1[0-5])$/;

// d: the digest object ({topics, figures}); src: Map id -> {min, max} (the request's own sources) or null (a digest sent back by the browser)
// Returns { topics, figures, stats } with only known fields, clamped; points and figures without a valid source are dropped.
function studioCleanDigest(d, src) {
  const L = DG_LIMITS;
  const stats = { topics: 0, points: 0, figures: 0, clamped: 0, badCites: 0, zeroedPages: 0 };
  const page = (raw, s) => {
    const p = typeof raw === 'string' && /^\d{1,5}$/.test(raw.trim()) ? Number(raw) : raw;
    if (!Number.isInteger(p) || p < 0 || p > L.MAX_PAGE) { if (p !== 0) stats.zeroedPages++; return 0; }
    if (src && p !== 0 && (p > s.max || p < s.min)) { stats.zeroedPages++; return 0; }
    return p;
  };
  const known = (id) => typeof id === 'string' && DG_SOURCE_RE.test(id) && (!src || src.has(id));
  const topics = [];
  for (const t of Array.isArray(d && d.topics) ? d.topics.slice(0, 500) : []) {
    if (topics.length >= L.TOPICS) break;
    if (!t || typeof t !== 'object' || Array.isArray(t)) continue;
    const h = studioClean(t.heading, L.HEADING);
    if (!h.text) continue;
    if (h.clamped) stats.clamped++;
    const points = [];
    for (const p of Array.isArray(t.points) ? t.points.slice(0, 100) : []) {
      if (points.length >= L.POINTS) break;
      if (!p || typeof p !== 'object' || !known(p.source)) { if (p && typeof p === 'object') stats.badCites++; continue; }
      const tx = studioClean(p.text, L.POINT);
      if (!tx.text) continue;
      if (tx.clamped) stats.clamped++;
      points.push({ text: tx.text, source: p.source, page: page(p.page, src && src.get(p.source)) });
    }
    if (!points.length) continue;
    const level = t.level === 2 || t.level === 3 ? t.level : 1;
    topics.push({ heading: h.text, level, points });
    stats.points += points.length;
  }
  stats.topics = topics.length;
  const figures = [];
  for (const f of Array.isArray(d && d.figures) ? d.figures.slice(0, 200) : []) {
    if (figures.length >= L.FIGURES) break;
    if (!f || typeof f !== 'object' || !known(f.source)) continue;
    const v = studioClean(f.value, L.VALUE);
    const q = studioClean(f.quote, L.QUOTE);
    if (!v.text || !q.text) continue;
    figures.push({ value: v.text, label: studioClean(f.label, L.LABEL).text, quote: q.text, source: f.source, page: page(f.page, src && src.get(f.source)) });
  }
  stats.figures = figures.length;
  return { topics, figures, stats };
}
// --- end STUDIO DIGEST ---
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(module.exports || {}, { studioCleanDigest, DG_LIMITS, DG_SCHEMA_ID, DG_SOURCE_RE });
