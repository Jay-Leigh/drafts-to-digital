// Study Studio: the request was rejected before Gemini was called. Only the fixed error is returned.
const e = $input.first().json.error || {};
const error = { code: e.code, retryable: e.retryable === true, reason: e.reason };
// the client shows the current limit: only for these reasons, only a whole number
if (['too_much_material', 'part_too_big', 'reduce_too_big'].includes(e.reason) && Number.isInteger(e.maxTokens)) error.maxTokens = e.maxTokens;
return [{ json: { ok: false, error } }];
