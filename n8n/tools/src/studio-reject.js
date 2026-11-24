// Study Studio mind map: the request was rejected before Gemini was called. Only the fixed error is returned.
const e = $input.first().json.error || {};
const error = { code: e.code, retryable: e.retryable === true, reason: e.reason };
// the client shows the current limit: only for this reason, only a whole number
if (e.reason === 'too_much_material' && Number.isInteger(e.maxTokens)) error.maxTokens = e.maxTokens;
return [{ json: { ok: false, error } }];
