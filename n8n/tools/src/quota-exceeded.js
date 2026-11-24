// Final answer when the daily ceiling is reached (Gemini is not called).
return [{ json: { ok: false, error: { code: 'STH-QUOTA-430', retryable: false } } }];
