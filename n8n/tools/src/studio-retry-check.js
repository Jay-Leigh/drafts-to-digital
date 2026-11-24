// Study Studio mind map, step 3: decide whether the Gemini answer is final or the call should be repeated.
// Same pattern as "Tutor Retry Check": 429 / 5xx / empty reply are retried, the flash-lite fallback is used
// on the third and last attempt only. Added for the synchronous request: a wall-clock budget, so the
// answer always leaves before Cloud Run's 300 s request limit, and the schema fallback of design 3.1
// (HTTP 400 on the first attempt -> same request with `responseSchema` instead of `responseJsonSchema`).
// Nothing here puts the Gemini reply text or the request into an error.
const MAX_ATTEMPTS = 3;
// Large requests (server estimate above this) are billed in full for every attempt that reaches the model: a retry after a
// timeout, a 5xx or an empty reply could double a large bill, so the first attempt is the only one. Only a 429 (refused
// before any processing) may be repeated, once, and the cheap schema-variant 400.
const LARGE_ESTIMATE = 300000;
const LARGE_MAX_ATTEMPTS = 2;
const FALLBACK_FROM_ATTEMPT = 3;
const FALLBACK_MODEL = 'gemini-2.5-flash-lite';
const CALL_TIMEOUT_MS = 240000; // keep equal to STUDIO_CALL_TIMEOUT_MS in "Studio - Validate Request"
const TOTAL_BUDGET_MS = 270000; // from the start of the request; leaves 30 s of the 300 s limit for the rest
const MIN_RETRY_MS = 90000; // a retry is only started when at least this much of the budget is left after the wait

const res = $input.first().json || {};
let st;
try {
  st = $('Studio - Wait Retry').first().json; // state carried by the previous retry decision
} catch (e) {
  st = null;
}
if (!st || typeof st.started !== 'number') st = $('Studio - Validate Request').first().json;

const status = Number(res.statusCode);
const hasStatus = Number.isFinite(status);
const cand = res.body && res.body.candidates && res.body.candidates[0];
const parts = (cand && cand.content && cand.content.parts) || [];
const hasText = parts.some((p) => p && typeof p.text === 'string' && p.text.trim() && !p.thought);
const reason = (cand && cand.finishReason) || '';
const blocked = ['SAFETY', 'RECITATION', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII'].includes(reason) || !!(res.body && res.body.promptFeedback && res.body.promptFeedback.blockReason);
const isRateLimited = status === 429;
const isServerError = [500, 502, 503, 504].includes(status);
const isNetworkFailure = !hasStatus; // connection error or the node timeout
const isEmptyReply = status === 200 && !hasText && !blocked && reason !== 'MAX_TOKENS';
const isSchemaRejected = status === 400 && st.variant === 0;
const attempt = $runIndex + 1;
const elapsed = Date.now() - st.started;

let waitSeconds = 0;
if (isRateLimited) {
  const hinted = parseFloat((((res.body || {}).error || {}).message || '').match(/retry in ([\d.]+)s/i)?.[1]);
  waitSeconds = attempt + 1 === FALLBACK_FROM_ATTEMPT ? 3 : Number.isFinite(hinted) ? Math.min(Math.ceil(hinted) + 2, 30) : 15 + Math.floor(Math.random() * 5);
} else if (isSchemaRejected) {
  waitSeconds = 1;
} else {
  waitSeconds = 5 * attempt;
}
const remainingAfterWait = TOTAL_BUDGET_MS - elapsed - waitSeconds * 1000;
const large = Number(st.estimate) > LARGE_ESTIMATE;
const retryable = large ? isRateLimited || isSchemaRejected : isRateLimited || isServerError || isNetworkFailure || isEmptyReply || isSchemaRejected;
const retry = retryable && attempt < (large ? LARGE_MAX_ATTEMPTS : MAX_ATTEMPTS) && remainingAfterWait >= MIN_RETRY_MS;

if (!retry) {
  // Final answer: only what "Studio - Validate" needs (no request text)
  return [{ json: { statusCode: hasStatus ? status : undefined, body: res.body, retry: false, attempt, model: st.model, variant: st.variant, elapsedMs: elapsed } }];
}

const next = { ...st, ok: true, retry: true, attempt, waitSeconds, started: st.started };
next.model = attempt + 1 >= FALLBACK_FROM_ATTEMPT ? FALLBACK_MODEL : st.model;
next.timeoutMs = Math.min(CALL_TIMEOUT_MS, remainingAfterWait); // a retry only starts with >= MIN_RETRY_MS left
if (isSchemaRejected) {
  const gc = { ...st.geminiBody.generationConfig };
  delete gc.responseJsonSchema;
  gc.responseSchema = st.schemaAlt;
  next.geminiBody = { ...st.geminiBody, generationConfig: gc };
  next.variant = 1;
}
return [{ json: next }];
