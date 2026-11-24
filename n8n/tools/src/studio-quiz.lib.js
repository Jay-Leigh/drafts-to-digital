// --- STUDIO QUIZ (pure functions: no n8n globals, no URL/crypto/fetch, no throws on bad input) ---
// Quiz validation and repair (design 3.6 for sth.quiz/1). v6 only. Inlined into the Code node "Studio - Validate" by
// build.js, directly AFTER studio-flashcards.lib.js (it uses that file's fcNormalize and fcSimilar and
// studio-validate.lib.js's studioClean and studioParseJson), and exercised by the unit tests through the generated
// gen/studio6.lib.js.
//
// Reasons returned for failures are fixed tags only. No text taken from a request or from the model is
// ever put in an error, a reason or a repair line.
const QZ_LIMITS = {
  MAX_QUESTIONS: 50,    // schema cap (design 3.5.2); the dialog offers 10 / 20 / 30
  RAW_SCAN: 500,        // never walk more raw questions than this (the model output is bounded far below it)
  STEM: 300,
  OPTION: 160,
  RATIONALE: 200,
  EXPLANATION: 500,
  HINT: 200,
  TOPIC: 40,
  TITLE: 80,
  NOTICE: 160,
  NOTICES: 3,
  CITES: 2,
  MIN_SHARE: 0.5,       // hard check: at least half of the requested count must survive (design 3.6 step 3)
  SALVAGE_SHARE: 0.7,   // a cut-off answer is accepted when at least this share of the request was complete (design 3.6 step 2)
  HINT_LEAK_MIN: 3,     // an option text shorter than this is not searched for in the hint
  MAX_BYTES: 160000,    // design 3.6: quiz result <= 160 KB
};
const QZ_SCHEMA_ID = 'sth.quiz/1';
const QZ_LETTERS = ['A', 'B', 'C', 'D'];

// A cut-off answer (finishReason MAX_TOKENS): the complete question objects of the "questions" array, read one by one with a
// string-aware bracket scanner. Returns null when there is no "questions" array. `head` is the text before it (schema id, title).
function qzSalvage(raw) {
  let s = typeof raw === 'string' ? raw.replace(/^﻿/, '').trim() : '';
  s = s.replace(/^```[a-zA-Z]*\s*\n/, '');
  const m = /(^|[^\\])"questions"\s*:\s*\[/.exec(s);
  if (!m) return null;
  let i = m.index + m[0].length;
  const questions = [];
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
    questions.push(one);
    i = end + 1;
  }
  return { questions, head: s.slice(0, m.index) };
}

// The model's answer for one question -> { kind: 'id', id } | { kind: 'bool', value } | { kind: 'many' } | { kind: 'none' }
function qzReadAnswer(a) {
  if (typeof a === 'boolean') return { kind: 'bool', value: a };
  if (Array.isArray(a)) return a.length === 1 ? qzReadAnswer(a[0]) : { kind: a.length > 1 ? 'many' : 'none' };
  if (typeof a === 'string') {
    const s = a.trim().replace(/[.)\]:]+$/, '').replace(/^[(\[]+/, '').trim();
    if (/^[A-Za-z]$/.test(s)) return { kind: 'id', id: s.toUpperCase() };
    if (/^(true|false)$/i.test(s)) return { kind: 'bool', value: s.toLowerCase() === 'true' };
    if (/[A-Da-d]\s*(,|;|\/|&|\band\b|\bor\b)\s*[A-Da-d]\b/i.test(s) || /^[A-Da-d]{2,4}$/.test(s)) return { kind: 'many' };
    return { kind: 'none' };
  }
  return { kind: 'none' };
}

// sources: [{ id: 'S1', maxPage: 342 }, ...] (from the request, never from the model)
// target: the number of questions the student asked for (10, 20 or 30)
// opts.truncated: the model stopped at its token limit (finishReason MAX_TOKENS): a cut-off answer may be salvaged
function studioValidateQuiz(rawText, sources, target, opts) {
  const truncated = !!(opts && opts.truncated);
  const repairs = [];
  const log = (n, what) => { if (n > 0) repairs.push(what.replace('#', String(n))); };
  const fail = (reason) => ({ ok: false, reason: truncated && ['parse', 'shape', 'schema', 'too_few_questions'].includes(reason) ? 'truncated' : reason });
  const L = QZ_LIMITS;
  const want = Number.isInteger(target) && target > 0 ? target : 20;
  const minQuestions = Math.max(1, Math.ceil(want * L.MIN_SHARE));

  let top;
  const parsed = studioParseJson(rawText);
  if (parsed.ok) {
    top = parsed.value;
  } else if (truncated) {
    const sv = qzSalvage(rawText);
    if (!sv || sv.head.indexOf(QZ_SCHEMA_ID) < 0 || sv.questions.length < Math.ceil(want * L.SALVAGE_SHARE)) return fail('parse');
    let t = '';
    const tm = /"title"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(sv.head);
    if (tm) { try { t = JSON.parse(tm[1]); } catch (e) { t = ''; } }
    top = { schema: QZ_SCHEMA_ID, title: t, notices: [], questions: sv.questions };
    log(sv.questions.length, 'kept # complete questions of a cut-off answer');
  } else {
    return fail('parse');
  }
  if (!top || typeof top !== 'object' || Array.isArray(top)) return fail('shape');
  if (top.schema !== QZ_SCHEMA_ID) return fail('schema');
  if (!Array.isArray(top.questions)) return fail('shape');

  const srcMax = new Map();
  for (const s of Array.isArray(sources) ? sources : []) {
    if (s && typeof s.id === 'string') srcMax.set(s.id, Number.isFinite(s.maxPage) && s.maxPage > 0 ? Math.min(Math.floor(s.maxPage), 20000) : 0);
  }

  // 1. Questions: well-formed, one correct answer among well-formed options, clamped, citations checked, near-identical stems dropped
  const kept = []; // { type, stem, options:[{text, rationale}], answerIdx, explanation, hint, topic, cites }
  const stemKeys = [];
  let malformed = 0, noStem = 0, badOptions = 0, noAnswer = 0, dupes = 0, filledTf = 0, hintLeaks = 0, filledExpl = 0;
  let clampedStems = 0, clampedOptions = 0, clampedRationales = 0, clampedExpl = 0, clampedHints = 0, clampedTopics = 0;
  let badCites = 0, zeroedPages = 0, trimmedCites = 0;
  const rawQs = top.questions.slice(0, L.RAW_SCAN);
  const beyondScan = top.questions.length - rawQs.length;
  for (const raw of rawQs) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || (raw.type !== 'mcq' && raw.type !== 'true_false')) { malformed++; continue; }
    const type = raw.type;
    const stem = studioClean(raw.stem, L.STEM);
    if (!stem.text) { noStem++; continue; }

    // options: objects with a text, in the order given; the ids the model used are only needed to find its answer
    const rawOpts = Array.isArray(raw.options) ? raw.options : [];
    let opts = [];
    let optClamp = 0, ratClamp = 0;
    let wellFormed = rawOpts.length <= 4;
    for (const o of rawOpts.slice(0, 8)) {
      if (!o || typeof o !== 'object' || Array.isArray(o)) { wellFormed = false; break; }
      const tx = studioClean(o.text, L.OPTION);
      const ra = studioClean(o.rationale, L.RATIONALE);
      if (!tx.text) { wellFormed = false; break; }
      if (tx.clamped) optClamp++;
      if (ra.clamped) ratClamp++;
      opts.push({ rid: o.id, text: tx.text, rationale: ra.text, flag: o.correct });
    }
    const distinct = () => new Set(opts.map((o) => fcNormalize(o.text))).size === opts.length;
    if (type === 'mcq') {
      if (!wellFormed || opts.length !== 4 || !distinct()) { badOptions++; continue; }
    } else if (rawOpts.length === 0) {
      // true/false without options: the two options are fixed (A = True, B = False)
      opts = [{ rid: 'A', text: 'True', rationale: '', flag: undefined }, { rid: 'B', text: 'False', rationale: '', flag: undefined }];
      filledTf++;
    } else if (!wellFormed || opts.length !== 2 || !distinct()) { badOptions++; continue; }

    // the ids the model gave to its options (A..D, any case); anything else means "by position"
    const given = opts.map((o) => (typeof o.rid === 'string' ? o.rid.trim().toUpperCase() : ''));
    const idsOk = given.every((g, i) => QZ_LETTERS.indexOf(g) >= 0 && given.indexOf(g) === i);
    const idOf = (i) => (idsOk ? given[i] : QZ_LETTERS[i]);

    // exactly one correct answer, and it exists among the options
    const ans = qzReadAnswer(raw.answer);
    let idx = -1;
    if (ans.kind === 'id') idx = opts.findIndex((_, i) => idOf(i) === ans.id);
    else if (ans.kind === 'bool' && type === 'true_false') idx = ans.value ? 0 : 1; // A = True, B = False
    else if (ans.kind === 'many') { noAnswer++; continue; }
    const flagged = opts.map((o, i) => (o.flag === true ? i : -1)).filter((i) => i >= 0);
    if (flagged.length > 1) { noAnswer++; continue; } // two options marked correct
    if (flagged.length === 1) {
      if (ans.kind === 'none') idx = flagged[0];
      else if (idx !== flagged[0]) { noAnswer++; continue; } // the flag and the answer disagree
    }
    if (idx < 0) { noAnswer++; continue; }

    const outOpts = opts.map((o) => ({ text: o.text, rationale: o.rationale }));
    const correctText = outOpts[idx].text;

    // hint: must not contain the correct option's text word for word (true/false labels are not searched for)
    let hint = studioClean(raw.hint, L.HINT);
    let leaked = false;
    if (type === 'mcq' && hint.text) {
      const c = fcNormalize(correctText);
      if (c.length >= L.HINT_LEAK_MIN && (' ' + fcNormalize(hint.text) + ' ').indexOf(' ' + c + ' ') >= 0) { hint = { text: '', clamped: false }; leaked = true; }
    }

    // explanation: filled from the rationale of the correct option when the model left it empty
    let expl = studioClean(raw.explanation, L.EXPLANATION);
    let filled = false;
    if (!expl.text && outOpts[idx].rationale) { expl = { text: outOpts[idx].rationale, clamped: false }; filled = true; }

    // near-identical stems: the later one is dropped (checked last, so a broken earlier question never removes a good later one)
    const key = fcNormalize(stem.text);
    if (stemKeys.some((k) => fcSimilar(k, key))) { dupes++; continue; }
    stemKeys.push(key);

    if (leaked) hintLeaks++;
    if (filled) filledExpl++;
    if (stem.clamped) clampedStems++;
    clampedOptions += optClamp;
    clampedRationales += ratClamp;
    if (expl.clamped) clampedExpl++;
    if (hint.clamped) clampedHints++;
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
    kept.push({ type, stem: stem.text, options: outOpts, answerIdx: idx, explanation: expl.text, hint: hint.text, topic: tp.text, cites });
  }
  log(malformed, 'dropped # malformed questions');
  log(noStem, 'dropped # questions with an empty stem');
  log(badOptions, 'dropped # questions with unusable options');
  log(noAnswer, 'dropped # questions without exactly one correct answer among their options');
  log(dupes, 'dropped # questions with a stem that repeats an earlier one');
  log(filledTf, 'gave # true/false questions the fixed True and False options');
  log(hintLeaks, 'blanked # hints that contained the correct answer');
  log(filledExpl, 'filled # empty explanations from the rationale of the correct option');
  log(clampedStems, 'clamped # stems');
  log(clampedOptions, 'clamped # options');
  log(clampedRationales, 'clamped # rationales');
  log(clampedExpl, 'clamped # explanations');
  log(clampedHints, 'clamped # hints');
  log(clampedTopics, 'clamped # topics');
  log(badCites, 'dropped # citations to unknown sources');
  log(zeroedPages, 'reset # page numbers beyond the source to 0');
  log(trimmedCites, 'dropped # surplus citations');

  // 2. Cap
  let qs = kept;
  if (kept.length > L.MAX_QUESTIONS) {
    log(kept.length - L.MAX_QUESTIONS, 'dropped # questions beyond the ' + L.MAX_QUESTIONS + ' question cap');
    qs = kept.slice(0, L.MAX_QUESTIONS);
  }
  log(beyondScan, 'ignored # questions beyond the first ' + L.RAW_SCAN);

  // 3. Hard check: at least half of the requested number
  if (qs.length < minQuestions) return fail('too_few_questions');

  // 4. Canonical ids q1..qN in order, options A..D by position, the answer as an option id
  const outQs = qs.map((q, i) => ({
    id: 'q' + (i + 1),
    type: q.type,
    stem: q.stem,
    options: q.options.map((o, k) => ({ id: QZ_LETTERS[k], text: o.text, rationale: o.rationale })),
    answer: QZ_LETTERS[q.answerIdx],
    explanation: q.explanation,
    hint: q.hint,
    topic: q.topic,
    cites: q.cites,
  }));

  // 5. Title and notices
  let title = studioClean(top.title, L.TITLE);
  if (title.clamped) log(1, 'clamped # title');
  if (!title.text) {
    title = { text: studioClean(outQs[0].topic || outQs[0].stem, L.TITLE).text };
    log(1, 'filled # empty title from the first question');
  }
  const notices = [];
  for (const nt of Array.isArray(top.notices) ? top.notices : []) {
    const c = studioClean(nt, L.NOTICE);
    if (c.text && notices.length < L.NOTICES) notices.push(c.text);
  }

  const data = { schema: QZ_SCHEMA_ID, title: title.text, notices, questions: outQs };
  if (JSON.stringify(data).length > L.MAX_BYTES) return fail('too_big');
  return { ok: true, data, repairs };
}
// --- end STUDIO QUIZ ---
if (typeof module !== 'undefined' && module.exports) module.exports = Object.assign(module.exports || {}, { studioValidateQuiz, qzSalvage, qzReadAnswer, QZ_LIMITS });
