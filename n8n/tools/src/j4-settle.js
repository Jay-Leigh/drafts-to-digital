// Job run only (v7): the answer of the ONE Gemini call of this job. A job never repeats the call inside the node (a repeat could be billed
// without being metered): a retry is the app's visible second attempt. A failed call becomes a fixed code (no Gemini text); a timeout or a 5xx
// may have been billed, so the usage is set to the worst case: estimated prompt + output limit + thinking budget.
const res = $input.first().json || {};
const status = Number(res.statusCode);
const hasStatus = Number.isFinite(status);
if (status === 200) return [{ json: { statusCode: 200, body: res.body && typeof res.body === 'object' ? res.body : {} } }];
const payload = ($('__BUILD__').first().json || {}).geminiPayload || {};
let chars = 0, media = 0;
for (const c of payload.contents || []) for (const p of c.parts || []) { if (typeof p.text === 'string') chars += p.text.length; else media++; }
const gc = payload.generationConfig || {};
const estIn = Math.ceil(chars / 4) + 1600 * media;
let code = 'STH-SRV-500';
let billed = false;
if (!hasStatus) { code = 'STH-AI-504'; billed = true; }
else if (status === 429) code = 'STH-AI-429';
else if (status >= 500) { code = status === 500 ? 'STH-AI-500' : status === 504 ? 'STH-AI-504' : 'STH-AI-503'; billed = true; }
else if (status === 401 || status === 403 || status === 404) code = 'STH-AI-403';
const usageMetadata = { promptTokenCount: estIn, candidatesTokenCount: Number(gc.maxOutputTokens) || 8192, thoughtsTokenCount: Number(gc.thinkingConfig && gc.thinkingConfig.thinkingBudget) || 0 };
return [{ json: { _jobFail: code, statusCode: hasStatus ? status : 0, body: billed ? { usageMetadata } : {} } }];
