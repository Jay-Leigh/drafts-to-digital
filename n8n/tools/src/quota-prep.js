// Daily cost ceiling, step 1: only requests that came through the JWT webhook and use Gemini are checked.
// The item (json + binary) is passed through untouched apart from a flag.
const GEMINI_MODES = ['transcribe', 'template', 'reviewer', 'reference', 'tutor'];
const item = $input.first();
const body = item.json.body || {};
const check = !!item.json.jwtPayload && GEMINI_MODES.includes(body.mode);
return [{ json: { ...item.json, _quota: { check } }, binary: item.binary }];
