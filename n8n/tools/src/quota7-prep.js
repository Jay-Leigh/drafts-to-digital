// Daily cost ceiling, step 1: only requests that came through the JWT webhook and use Gemini are checked.
// The item (json + binary) is passed through untouched apart from a flag. v7: bulk work (digest, a part or the reduce run of a
// map-reduce run, and the background runs of transcribe / template / reviewer) is flagged for the softer bulk ceiling.
const GEMINI_MODES = ['transcribe', 'template', 'reviewer', 'reference', 'tutor', 'studio_mindmap', 'studio_flashcards', 'studio_quiz', 'studio_infographic', 'studio_slides', 'studio_digest'];
const BULK_JOB_MODES = ['transcribe', 'template', 'reviewer'];
const item = $input.first();
const body = item.json.body || {};
const check = !!item.json.jwtPayload && GEMINI_MODES.includes(body.mode);
const bulk = check && (body.mode === 'studio_digest' || !!body.part || body.strategy === 'reduce' || (!!item.json._job && BULK_JOB_MODES.includes(body.mode)));
return [{ json: { ...item.json, _quota: bulk ? { check, bulk: true } : { check } }, binary: item.binary }];
