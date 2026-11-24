// "Route by Mode" fallback (v7): a request whose mode no rule knows (an app that is newer than this workflow, or garbage) gets a clean answer.
return [{ json: { ok: false, error: { code: 'STH-INPUT-400', retryable: false, reason: 'mode' } } }];
