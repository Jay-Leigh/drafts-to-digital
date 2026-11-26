// Renew Endpoint step 1: read the claims n8n verified (signature + exp). The request body is ignored: only the token matters.
// Never throws: unusable claims become prep {ok:false}, answered STH-INPUT-400 (reason token) after the Redis step.
const item = $input.first().json || {};
return [{ json: { prep: renewPrepare(item.jwtPayload, Date.now()) } }];
