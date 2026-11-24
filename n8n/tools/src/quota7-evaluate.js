// Daily cost ceiling, step 3. Input = reply of "Quota Read": {result: [usage:YYYYMMDD, cfg:daily_units, cfg:studio_max_tokens, cfg:bulk_ratio]}.
// Ceiling unset/empty/not a number -> no ceiling. Usage at or above the ceiling -> over (0 blocks everything).
// v7: bulk work stops earlier, at cfg:bulk_ratio (default 0.6) of the ceiling, so the rest of the day stays for the tutor and small runs.
// A failed Redis read lets the request through (the app's other Redis uses fail first anyway).
const BULK_RATIO_DEFAULT = 0.6;
const prep = $('Quota Prep').first();
const r = $input.first().json || {};
let over = false;
let bulkOver = false;
if (Array.isArray(r.result)) {
  const usage = Number(r.result[0] || 0);
  const raw = r.result[1];
  const ceiling = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(ceiling) && Number.isFinite(usage) && usage >= ceiling) over = true;
  if (!over && prep.json._quota.bulk === true && Number.isFinite(ceiling) && Number.isFinite(usage)) {
    const rr = r.result[3];
    const ratio = rr === null || rr === undefined || String(rr).trim() === '' || !Number.isFinite(Number(rr)) || Number(rr) < 0 || Number(rr) > 1 ? BULK_RATIO_DEFAULT : Number(rr);
    if (usage >= ratio * ceiling) { over = true; bulkOver = true; }
  }
}
return [{ json: { ...prep.json, _quota: { ...prep.json._quota, check: true, over, ...(bulkOver ? { bulkOver: true } : {}) } }, binary: prep.binary }];
