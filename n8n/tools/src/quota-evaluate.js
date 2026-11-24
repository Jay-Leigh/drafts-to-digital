// Daily cost ceiling, step 3. Input = reply of "Quota Read": {result: [usage:YYYYMMDD, cfg:daily_units]}.
// Ceiling unset/empty/not a number -> no ceiling. Usage at or above the ceiling -> over (0 blocks everything).
// A failed Redis read lets the request through (the app's other Redis uses fail first anyway).
const prep = $('Quota Prep').first();
const r = $input.first().json || {};
let over = false;
if (Array.isArray(r.result)) {
  const usage = Number(r.result[0] || 0);
  const raw = r.result[1];
  const ceiling = raw === null || raw === undefined || String(raw).trim() === '' ? NaN : Number(raw);
  if (Number.isFinite(ceiling) && Number.isFinite(usage) && usage >= ceiling) over = true;
}
return [{ json: { ...prep.json, _quota: { check: true, over } }, binary: prep.binary }];
