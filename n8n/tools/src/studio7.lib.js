// --- STUDIO V7 (pure functions: no n8n globals, no URL/crypto/fetch, no throws on bad input) ---
// v7: infographic (sth.infographic/1), slides (sth.slides/1) and digest (sth.digest/1) validators, the number / quote
// check against the source text, and the reduce citation rule. Inlined into the Code node "Studio - Validate" by build.js
// AFTER the mind map, flashcards, quiz and digest libraries (uses studioClean, studioParseJson, studioCleanDigest) and
// exercised by the unit tests through the generated gen/studio7.lib.js.
//
// Reasons returned for failures are fixed tags only. No text taken from a request or from the model is ever put in
// an error, a reason or a repair line.

// ── number and quote check (design H.7) ──
// Text is compared in a normal form: NFKC, Arabic-Indic / Extended Arabic-Indic / Devanagari digits as 0-9, lower case,
// punctuation and symbols out, spaces collapsed.
function svDigitsAscii(s) {
  return String(s).replace(/[٠-٩]/g, (c) => String(c.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (c) => String(c.charCodeAt(0) - 0x06f0)).replace(/[०-९]/g, (c) => String(c.charCodeAt(0) - 0x0966));
}
function svNormText(s) {
  return svDigitsAscii(String(s == null ? '' : s).normalize('NFKC')).toLowerCase().replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}
// "[Page 12]", "[Scan page 3]" and "## Slide 4" are markers, not numbers of the material
function svStripMarkers(s) {
  return String(s == null ? '' : s).replace(/\[(?:Scan )?[Pp]age \d{1,5}\]/g, ' ').replace(/^##\s+Slide \d{1,5}\b/gm, ' ');
}
// whole number tokens: "1 000", "1,000", "1.000" and "1000" are one thousand; "1,5" and "1.5" one and a half
const SV_NUM_RE = /\d{1,3}(?:[   ,.'’]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?/g;
function svNumKeys(tok) {
  const keys = new Set();
  const t = tok.replace(/[   '’]/g, '');
  keys.add(t.replace(/,/g, '.'));
  if (/^\d{1,3}(?:[.,]\d{3})+$/.test(t)) keys.add(t.replace(/[.,]/g, ''));
  if (/^\d{1,3}(?:,\d{3})+\.\d+$/.test(t)) keys.add(t.replace(/,/g, ''));
  if (/^\d{1,3}(?:\.\d{3})+,\d+$/.test(t)) keys.add(t.replace(/\./g, '').replace(',', '.'));
  return [...keys];
}
// every number token of a text as a list of key lists; a single digit ("3 steps") is not checked
function svNumbers(text, all) {
  const out = [];
  for (const m of svDigitsAscii(String(text == null ? '' : text).normalize('NFKC')).matchAll(SV_NUM_RE)) {
    if (!all && /^\d$/.test(m[0])) continue;
    out.push(svNumKeys(m[0]));
  }
  return out;
}
function svNumSet(text) {
  const set = new Set();
  for (const keys of svNumbers(svStripMarkers(text), true)) for (const k of keys) set.add(k);
  return set;
}
// verify = { texts: { S1: 'source text', ... } }  (direct run)  or  { digestText, digestFigures: [{value, quote}] }  (reduce run)
function svBuildCorpus(v) {
  const c = { bySource: {}, reduce: false, digestNums: new Set(), digestNorm: '', figs: [] };
  if (!v || typeof v !== 'object') return c;
  if (v.texts && typeof v.texts === 'object') {
    for (const id of Object.keys(v.texts)) {
      const raw = String(v.texts[id] == null ? '' : v.texts[id]);
      c.bySource[id] = { norm: svNormText(raw), nums: svNumSet(raw) };
    }
  }
  if (typeof v.digestText === 'string') {
    c.reduce = true;
    c.digestNorm = svNormText(v.digestText);
    c.digestNums = svNumSet(v.digestText);
    c.figs = (Array.isArray(v.digestFigures) ? v.digestFigures : []).map((f) => ({ v: svNormText(f && f.value), q: svNormText(f && f.quote) }));
  }
  return c;
}
// true when every checked number of `text` is found as a whole number in one of the sources the item cites (all sources when it cites none)
function svNumbersOk(text, ids, corpus) {
  const toks = svNumbers(text, false);
  if (!toks.length) return true;
  let pool;
  if (corpus.reduce) pool = [corpus.digestNums];
  else {
    const own = (ids || []).map((id) => corpus.bySource[id] && corpus.bySource[id].nums).filter(Boolean);
    pool = own.length ? own : Object.keys(corpus.bySource).map((id) => corpus.bySource[id].nums);
  }
  if (!pool.length) return false;
  return toks.every((keys) => pool.some((set) => keys.some((k) => set.has(k))));
}
function svWords(s) { return s ? s.split(' ').length : 0; }
// a quote must be found word for word (normal form) in its source; in a reduce run in the quote of a digest figure
function svQuoteFound(quote, ids, corpus) {
  const q = svNormText(quote);
  if (q.length < 8 || svWords(q) < 3) return false;
  if (corpus.reduce) return corpus.figs.some((f) => f.q && (f.q === q || f.q.includes(q)));
  const own = (ids || []).filter((id) => corpus.bySource[id]);
  const pool = own.length ? own : Object.keys(corpus.bySource);
  return pool.some((id) => corpus.bySource[id].norm.includes(q));
}
// a figure {value, label, quote, source, page} is kept only when its quote is in the source and every number of its value is in the quote
function svFigureOk(f, corpus) {
  if (!f.value || !f.quote) return false;
  const vt = svNumbers(f.value, true);
  if (!vt.length) return false;
  const qNums = new Set();
  for (const keys of svNumbers(f.quote, true)) for (const k of keys) qNums.add(k);
  if (!vt.every((keys) => keys.some((k) => qNums.has(k)))) return false;
  if (corpus.reduce) {
    const nv = svNormText(f.value);
    const nq = svNormText(f.quote);
    return corpus.figs.some((g) => g.v === nv && g.q === nq);
  }
  return svQuoteFound(f.quote, [f.source], corpus) && !!corpus.bySource[f.source];
}

function svCites(rawCites, srcMax, max, st) {
  const cites = [];
  const seen = new Set();
  for (const c of Array.isArray(rawCites) ? rawCites : []) {
    if (!c || typeof c !== 'object' || typeof c.source !== 'string' || !srcMax.has(c.source)) { st.badCites++; continue; }
    let page = typeof c.page === 'string' && /^\d{1,5}$/.test(c.page.trim()) ? Number(c.page) : c.page;
    if (!Number.isInteger(page) || page < 0 || page > srcMax.get(c.source)) { if (page !== 0) st.zeroedPages++; page = 0; }
    const key = c.source + ':' + page;
    if (seen.has(key)) continue;
    seen.add(key);
    if (cites.length >= max) { st.trimmedCites++; continue; }
    cites.push({ source: c.source, page });
  }
  return cites;
}
function svSrcMax(sources) {
  const m = new Map();
  for (const s of Array.isArray(sources) ? sources : []) if (s && typeof s.id === 'string') m.set(s.id, Number.isFinite(s.maxPage) && s.maxPage > 0 ? Math.min(Math.floor(s.maxPage), 20000) : 0);
  return m;
}
function svNotices(raw, limit, max) {
  const out = [];
  for (const nt of Array.isArray(raw) ? raw : []) {
    const c = studioClean(nt, limit);
    if (c.text && out.length < max) out.push(c.text);
  }
  return out;
}
function svLogger() {
  const repairs = [];
  return { repairs, log: (n, what) => { if (n > 0) repairs.push(what.replace('#', String(n))); } };
}

// ── infographic ──
const IG_SCHEMA_ID = 'sth.infographic/1';
const IG_LAYOUTS = ['steps', 'comparison', 'facts', 'timeline'];
const IG_ICONS = ['book', 'brain', 'bulb', 'target', 'check', 'warning', 'clock', 'calendar', 'chart-up', 'chart-down', 'people', 'person', 'globe', 'flask', 'atom', 'dna', 'heart', 'leaf', 'money', 'scale', 'gavel', 'building', 'gear', 'link', 'shield', 'question', 'star', 'flag', 'arrow', 'compare', 'document', 'pin'];
const IG_LIMITS = { TITLE: 80, SUBTITLE: 140, NOTICE: 160, NOTICES: 3, COLUMN: 30, HEADING: 50, TEXT: 160, WHEN: 24, SIDE: 100, FIGURES: 4, VALUE: 16, LABEL: 60, QUOTE: 160, TAKEAWAY: 160, MIN_ITEMS: 3, MAX_ITEMS: 8, MAX_TIMELINE: 10, CITES: 2, RAW_SCAN: 100, MAX_BYTES: 24000 };

// ctx: { sources: [{id, maxPage}], layout: 'auto' | one of IG_LAYOUTS (the student's pick), verify }
function studioValidateInfographic(rawText, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const L = IG_LIMITS;
  const { repairs, log } = svLogger();
  const parsed = studioParseJson(rawText);
  if (!parsed.ok) return { ok: false, reason: 'parse' };
  const top = parsed.value;
  if (!top || typeof top !== 'object' || Array.isArray(top)) return { ok: false, reason: 'shape' };
  if (top.schema !== IG_SCHEMA_ID) return { ok: false, reason: 'schema' };
  if (!Array.isArray(top.items)) return { ok: false, reason: 'shape' };
  const srcMax = svSrcMax(c.sources);
  const corpus = svBuildCorpus(c.verify);
  const cst = { badCites: 0, zeroedPages: 0, trimmedCites: 0 };

  // 1. figures: kept only when the number can be checked against the source (design H.7)
  const figures = [];
  let badFigures = 0;
  for (const raw of Array.isArray(top.figures) ? top.figures.slice(0, 20) : []) {
    if (!raw || typeof raw !== 'object' || typeof raw.source !== 'string' || !srcMax.has(raw.source)) { badFigures++; continue; }
    const f = { value: studioClean(raw.value, L.VALUE).text, label: studioClean(raw.label, L.LABEL).text, quote: studioClean(raw.quote, L.QUOTE).text, source: raw.source, page: 0 };
    const pg = svCites([{ source: raw.source, page: raw.page }], srcMax, 1, cst)[0];
    f.page = pg ? pg.page : 0;
    if (!f.label || !svFigureOk(f, corpus)) { badFigures++; continue; }
    if (figures.length >= L.FIGURES) { badFigures++; continue; }
    figures.push({ ...f, verified: true });
  }
  log(badFigures, 'removed # numbers that could not be checked');

  // 2. items: clamp, citations, numbers
  const items = [];
  let malformed = 0, unknownIcons = 0, badNumbers = 0;
  for (const raw of top.items.slice(0, L.RAW_SCAN)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { malformed++; continue; }
    const heading = studioClean(raw.heading, L.HEADING).text;
    const text = studioClean(raw.text, L.TEXT).text;
    if (!heading && !text) { malformed++; continue; }
    const it = { heading, text, when: studioClean(raw.when, L.WHEN).text, left: studioClean(raw.left, L.SIDE).text, right: studioClean(raw.right, L.SIDE).text, icon: 'dot', cites: svCites(raw.cites, srcMax, L.CITES, cst) };
    if (IG_ICONS.includes(raw.icon)) it.icon = raw.icon; else unknownIcons++;
    if (!svNumbersOk([it.heading, it.text, it.when, it.left, it.right].join(' '), it.cites.map((x) => x.source), corpus)) { badNumbers++; continue; }
    items.push(it);
  }
  log(malformed, 'dropped # malformed items');
  log(unknownIcons, 'replaced # unknown icons');
  log(badNumbers, 'removed # items with a number that could not be checked');
  log(cst.badCites, 'dropped # citations to unknown sources');
  log(cst.zeroedPages, 'reset # page numbers beyond the source to 0');
  log(cst.trimmedCites, 'dropped # surplus citations');

  // 3. layout: the student's pick wins; otherwise the model's, or inferred when it is not one of the four
  const columns = (Array.isArray(top.columns) ? top.columns.slice(0, 2) : []).map((x) => studioClean(x, L.COLUMN).text);
  const dated = items.filter((i) => i.when).length;
  const rows = items.filter((i) => i.left && i.right).length;
  let layout = IG_LAYOUTS.includes(top.layout) ? top.layout : '';
  if (IG_LAYOUTS.includes(c.layout)) {
    if (layout !== c.layout) log(1, 'used the layout you picked');
    layout = c.layout;
  } else if (!layout) {
    layout = dated >= 3 ? 'timeline' : columns.length === 2 && columns[0] && columns[1] && rows >= 3 ? 'comparison' : figures.length >= 2 ? 'facts' : 'steps';
    log(1, 'chose the layout from the content');
  }
  if (layout === 'timeline' && dated < 3) { layout = 'steps'; log(1, 'changed a timeline with fewer than 3 dated items to steps'); }
  if (layout === 'comparison' && !(columns.length === 2 && columns[0] && columns[1] && rows >= 3)) { layout = 'facts'; log(1, 'changed a comparison without two columns and 3 rows to key facts'); }

  // 4. fields a layout does not use are blanked; left / right of a dropped comparison are folded into the text
  for (const it of items) {
    if (layout !== 'timeline') it.when = '';
    if (layout !== 'comparison') {
      const side = it.left && it.right ? it.left + ' / ' + it.right : it.left || it.right;
      if (side) it.text = studioClean([it.text, side].filter(Boolean).join(' '), L.TEXT).text;
      it.left = '';
      it.right = '';
    }
  }
  const cap = layout === 'timeline' ? L.MAX_TIMELINE : L.MAX_ITEMS;
  let kept = items;
  if (items.length > cap) { log(items.length - cap, 'dropped # items beyond the ' + cap + ' item limit'); kept = items.slice(0, cap); }
  if (kept.length < L.MIN_ITEMS) return { ok: false, reason: 'too_few_items' };

  // 5. title, subtitle, takeaway (a number that cannot be checked blanks the line), notices
  let title = studioClean(top.title, L.TITLE);
  if (title.clamped) log(1, 'clamped # title');
  if (!title.text) { title = { text: studioClean(kept[0].heading || kept[0].text, L.TITLE).text }; log(1, 'filled # empty title from the first item'); }
  const line = (v, max, what) => {
    const x = studioClean(v, max).text;
    if (x && !svNumbersOk(x, [], corpus)) { log(1, 'blanked # ' + what + ' with a number that could not be checked'); return ''; }
    return x;
  };
  const data = {
    schema: IG_SCHEMA_ID,
    title: title.text,
    subtitle: line(top.subtitle, L.SUBTITLE, 'subtitle'),
    layout,
    notices: svNotices(top.notices, L.NOTICE, L.NOTICES),
    columns: layout === 'comparison' ? columns : [],
    items: kept,
    figures,
    takeaway: line(top.takeaway, L.TAKEAWAY, 'takeaway'),
  };
  if (JSON.stringify(data).length > L.MAX_BYTES) return { ok: false, reason: 'too_big' };
  return { ok: true, data, repairs };
}

// ── slides ──
const SL_SCHEMA_ID = 'sth.slides/1';
const SL_LAYOUTS = ['title', 'agenda', 'section', 'bullets', 'two_column', 'definition', 'timeline', 'quote', 'summary', 'check'];
const SL_BULLET_LAYOUTS = ['agenda', 'bullets', 'definition', 'timeline', 'summary', 'check'];
const SL_LIMITS = { TITLE: 80, SUBTITLE: 120, NOTICE: 160, NOTICES: 3, HEADING: 50, QUOTE: 240, COLUMN_BULLETS: 6, CITES: 3, MIN_SLIDES: 3, MAX_SLIDES: 20, RAW_SCAN: 60, MAX_BYTES: 120000, detailed: { bullets: 7, chars: 160, notes: 300 }, presenter: { bullets: 5, chars: 70, notes: 900 } };

// ctx: { sources, format: 'detailed' | 'presenter', verify }
function studioValidateSlides(rawText, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const L = SL_LIMITS;
  const F = c.format === 'presenter' ? L.presenter : L.detailed;
  const { repairs, log } = svLogger();
  const parsed = studioParseJson(rawText);
  if (!parsed.ok) return { ok: false, reason: 'parse' };
  const top = parsed.value;
  if (!top || typeof top !== 'object' || Array.isArray(top)) return { ok: false, reason: 'shape' };
  if (top.schema !== SL_SCHEMA_ID) return { ok: false, reason: 'schema' };
  if (!Array.isArray(top.slides)) return { ok: false, reason: 'shape' };
  const srcMax = svSrcMax(c.sources);
  const corpus = svBuildCorpus(c.verify);
  const cst = { badCites: 0, zeroedPages: 0, trimmedCites: 0 };
  let malformed = 0, unknownLayouts = 0, badNumbers = 0, badQuotes = 0, empty = 0, clipped = 0;

  const slides = [];
  for (const raw of top.slides.slice(0, L.RAW_SCAN)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { malformed++; continue; }
    let layout = SL_LAYOUTS.includes(raw.layout) ? raw.layout : 'bullets';
    if (layout !== raw.layout) unknownLayouts++;
    const cites = svCites(raw.cites, srcMax, L.CITES, cst);
    const ids = cites.map((x) => x.source);
    const s = { id: '', layout, title: studioClean(raw.title, L.TITLE).text, subtitle: '', bullets: [], columns: [], quote: '', notes: studioClean(raw.notes, F.notes).text, cites };
    if (layout === 'title' || layout === 'section') s.subtitle = studioClean(raw.subtitle, L.SUBTITLE).text;
    const bullet = (b) => {
      const o = typeof b === 'string' ? { text: b } : b;
      if (!o || typeof o !== 'object') return null;
      const t = studioClean(o.text, F.chars);
      if (!t.text) return null;
      if (t.clamped) clipped++;
      if (!svNumbersOk(t.text, ids, corpus)) { badNumbers++; return null; }
      return { text: t.text, level: o.level === 1 ? 1 : 0 };
    };
    if (SL_BULLET_LAYOUTS.includes(layout)) {
      const all = Array.isArray(raw.bullets) ? raw.bullets : [];
      s.bullets = all.slice(0, 40).map(bullet).filter(Boolean);
      if (s.bullets.length > F.bullets) { clipped += s.bullets.length - F.bullets; s.bullets = s.bullets.slice(0, F.bullets); }
    } else if (layout === 'two_column') {
      for (const col of (Array.isArray(raw.columns) ? raw.columns : []).slice(0, 2)) {
        if (!col || typeof col !== 'object') continue;
        const bl = (Array.isArray(col.bullets) ? col.bullets : []).slice(0, 40).map((b) => bullet(typeof b === 'string' ? { text: b } : { text: b && b.text })).filter(Boolean).slice(0, L.COLUMN_BULLETS).map((b) => b.text);
        const heading = studioClean(col.heading, L.HEADING).text;
        if (bl.length || heading) s.columns.push({ heading, bullets: bl });
      }
    } else if (layout === 'quote') {
      const q = studioClean(raw.quote, L.QUOTE).text;
      if (q && svQuoteFound(q, ids, corpus)) s.quote = q;
      else if (q) {
        // a quote that cannot be found in the source is shown as an ordinary point, without quotation marks
        badQuotes++;
        s.layout = 'bullets';
        const b = bullet({ text: q, level: 0 });
        if (b) s.bullets = [b];
      }
    }
    const keep = layout === 'title' || layout === 'section' ? !!s.title : SL_BULLET_LAYOUTS.includes(s.layout) ? s.bullets.length > 0 : s.layout === 'two_column' ? s.columns.some((x) => x.bullets.length) : s.layout === 'quote' ? !!s.quote : false;
    if (!keep) { empty++; continue; }
    slides.push(s);
  }
  log(malformed, 'dropped # malformed slides');
  log(unknownLayouts, 'changed # unknown layouts to bullets');
  log(badQuotes, 'turned # quotes that are not in the source into bullets');
  log(badNumbers, 'removed # points with a number that could not be checked');
  log(empty, 'dropped # empty slides');
  log(clipped, 'shortened # points to the ' + (c.format === 'presenter' ? 'presenter' : 'detailed') + ' limits');
  log(cst.badCites, 'dropped # citations to unknown sources');
  log(cst.zeroedPages, 'reset # page numbers beyond the source to 0');
  log(cst.trimmedCites, 'dropped # surplus citations');

  let deckTitle = studioClean(top.title, L.TITLE);
  if (deckTitle.clamped) log(1, 'clamped # title');
  if (!deckTitle.text && slides.length) { deckTitle = { text: slides[0].title }; log(1, 'filled # empty title from the first slide'); }
  const subtitle = studioClean(top.subtitle, L.SUBTITLE).text;
  // the first slide is always the title slide
  if (slides.length && slides[0].layout !== 'title') {
    slides.unshift({ id: '', layout: 'title', title: deckTitle.text, subtitle, bullets: [], columns: [], quote: '', notes: '', cites: [] });
    log(1, 'added # title slide');
  }
  let out = slides;
  if (slides.length > L.MAX_SLIDES) { log(slides.length - L.MAX_SLIDES, 'dropped # slides beyond the ' + L.MAX_SLIDES + ' slide limit'); out = slides.slice(0, L.MAX_SLIDES); }
  if (out.length < L.MIN_SLIDES) return { ok: false, reason: 'too_few_slides' };
  out.forEach((s, i) => { s.id = 'p' + (i + 1); });
  const data = { schema: SL_SCHEMA_ID, title: deckTitle.text, subtitle, notices: svNotices(top.notices, L.NOTICE, L.NOTICES), format: c.format === 'presenter' ? 'presenter' : 'detailed', slides: out };
  if (JSON.stringify(data).length > L.MAX_BYTES) return { ok: false, reason: 'too_big' };
  return { ok: true, data, repairs };
}

// ── digest (the map step of a map-reduce run) ──
// ctx: { sources: [{id, minPage, maxPage}], verify: { texts } }
function studioValidateDigest(rawText, ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const { repairs, log } = svLogger();
  const parsed = studioParseJson(rawText);
  if (!parsed.ok) return { ok: false, reason: 'parse' };
  const top = parsed.value;
  if (!top || typeof top !== 'object' || Array.isArray(top)) return { ok: false, reason: 'shape' };
  if (top.schema !== DG_SCHEMA_ID) return { ok: false, reason: 'schema' };
  if (!Array.isArray(top.topics)) return { ok: false, reason: 'shape' };
  const src = new Map();
  for (const s of Array.isArray(c.sources) ? c.sources : []) if (s && typeof s.id === 'string') src.set(s.id, { min: Number.isFinite(s.minPage) && s.minPage > 0 ? s.minPage : 0, max: Number.isFinite(s.maxPage) && s.maxPage > 0 ? s.maxPage : 0 });
  const d = studioCleanDigest(top, src);
  const corpus = svBuildCorpus(c.verify);
  let badNumbers = 0, badFigures = 0, dropped = 0;
  const topics = [];
  for (const t of d.topics) {
    const points = t.points.filter((p) => {
      if (svNumbersOk(p.text, [p.source], corpus)) return true;
      badNumbers++;
      return false;
    });
    if (points.length) topics.push({ ...t, points }); else dropped++;
  }
  const figures = d.figures.filter((f) => {
    if (svFigureOk(f, corpus)) return true;
    badFigures++;
    return false;
  }).map((f) => ({ ...f, verified: true }));
  log(d.stats.badCites, 'dropped # points with an unknown source');
  log(d.stats.zeroedPages, 'reset # page numbers outside this part to 0');
  log(d.stats.clamped, 'clamped # texts');
  log(badNumbers, 'removed # points with a number that could not be checked');
  log(badFigures, 'removed # numbers that could not be checked');
  log(dropped, 'dropped # topics without points');
  if (!topics.length) return { ok: false, reason: 'too_few_topics' };
  const data = { schema: DG_SCHEMA_ID, topics, figures };
  if (JSON.stringify(data).length > DG_LIMITS.MAX_BYTES) return { ok: false, reason: 'too_big' };
  return { ok: true, data, repairs };
}

// ── reduce run: a citation must be one of the (source, page) pairs of the digests; a page that is not in them becomes 0,
// a source that is not in them is dropped ──
function studioReduceCites(data, citeSet) {
  const sources = new Set();
  for (const k of citeSet) sources.add(String(k).split(':')[0]);
  let zeroed = 0, dropped = 0;
  const fix = (cites) => {
    const out = [];
    const seen = new Set();
    for (const c of Array.isArray(cites) ? cites : []) {
      if (!c || !sources.has(c.source)) { dropped++; continue; }
      let page = c.page;
      if (page !== 0 && !citeSet.has(c.source + ':' + page)) { page = 0; zeroed++; }
      const k = c.source + ':' + page;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ source: c.source, page });
    }
    return out;
  };
  for (const list of [data.nodes, data.items, data.slides]) for (const x of Array.isArray(list) ? list : []) x.cites = fix(x.cites);
  for (const f of Array.isArray(data.figures) ? data.figures : []) {
    const one = fix([{ source: f.source, page: f.page }])[0];
    if (one) f.page = one.page;
  }
  return { zeroed, dropped };
}
// --- end STUDIO V7 ---
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(module.exports || {}, { studioValidateInfographic, studioValidateSlides, studioValidateDigest, studioReduceCites, svNormText, svNumbers, svNumKeys, svNumbersOk, svBuildCorpus, svQuoteFound, svFigureOk, IG_LIMITS, IG_ICONS, IG_LAYOUTS, SL_LIMITS, SL_LAYOUTS });
