// Final answer when the daily ceiling is reached (Gemini is not called). v7: reason "bulk" when only the bulk ceiling was reached.
const q = ($input.first().json || {})._quota || {};
return [{ json: { ok: false, error: q.bulkOver === true ? { code: 'STH-QUOTA-430', retryable: false, reason: 'bulk' } : { code: 'STH-QUOTA-430', retryable: false } } }];
