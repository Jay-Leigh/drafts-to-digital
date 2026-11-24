// Background jobs (v7): answer to `budget`. What is left of today's shared AI capacity and the owner's limits for a big run.
// Never writes. Fail-open: when Redis does not answer, used / ceiling / remaining are null (the app then shows no share of the day).
const STUDIO_TOKENS_DEFAULT = 400000; // same rule as "Studio - Validate Request": missing or junk = default, clamped to 50000..900000
const STUDIO_TOKENS_MIN = 50000;
const STUDIO_TOKENS_MAX = 900000;
const MR_UNITS_DEFAULT = 2000000; // cfg:mr_max_units, the largest estimated cost of one map-reduce run (the app enforces it); clamped to 100000..20000000
const MR_UNITS_MIN = 100000;
const MR_UNITS_MAX = 20000000;
const BULK_RATIO_DEFAULT = 0.6; // cfg:bulk_ratio, same rule as "Quota Evaluate"
const plan = $('Job - Plan').first().json;
const r = $input.first().json || {};
const ok = Array.isArray(r.result) && r.result.length === 5;
const [usageRaw, ceilRaw, tokRaw, mrRaw, ratioRaw] = ok ? r.result : [];
const text = (v) => (typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : '');
const whole = (v) => (/^\d{1,12}$/.test(text(v)) ? Number(text(v)) : null);
const used = ok ? (Number.isFinite(Number(usageRaw || 0)) ? Number(usageRaw || 0) : null) : null;
const ceiling = ok && text(ceilRaw) !== '' && Number.isFinite(Number(ceilRaw)) ? Number(ceilRaw) : null;
const remaining = ceiling !== null && used !== null ? Math.max(0, ceiling - used) : null;
const tok = whole(tokRaw);
const mr = whole(mrRaw);
const ratio = text(ratioRaw) !== '' && Number.isFinite(Number(ratioRaw)) && Number(ratioRaw) >= 0 && Number(ratioRaw) <= 1 ? Number(ratioRaw) : BULK_RATIO_DEFAULT;
const bulkCeiling = ceiling !== null ? Math.floor(ceiling * ratio) : null;
return [{
  json: {
    ok: true,
    v: 7,
    day: plan.day,
    now: plan.now,
    ceiling,
    used,
    remaining,
    bulkRatio: ratio,
    bulkCeiling,
    bulkRemaining: bulkCeiling !== null && used !== null ? Math.max(0, bulkCeiling - used) : null,
    studioMaxTokens: Math.min(STUDIO_TOKENS_MAX, Math.max(STUDIO_TOKENS_MIN, tok === null ? STUDIO_TOKENS_DEFAULT : tok)),
    mrMaxUnits: Math.min(MR_UNITS_MAX, Math.max(MR_UNITS_MIN, mr === null ? MR_UNITS_DEFAULT : mr)),
  },
}];
