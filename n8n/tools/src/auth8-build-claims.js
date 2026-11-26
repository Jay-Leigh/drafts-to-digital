// Auth Endpoint step 4 (match only, v8): claims for the JWT node (Use JSON = on).
// {sub:'sth', sid=jti (chain id), ac:'sth', v:2, jti, iat, exp = iat + 7 d, auth_time = iat (the access code was entered now), ep = auth:ep at issue}.
// exp/iat are put into the payload directly: in n8n 2.29 the node's "Expires In" claim is written into the payload as a plain field and does NOT set exp.
const ev = $('Auth Evaluate').first().json || {};
if (!Number.isInteger(ev.ep) || ev.ep < 0 || ev.ep > 999999999) return [{ json: { claimsJson: '', expiresAt: '' } }]; // fails closed: the JWT node gets nothing to sign
const c = authSignInClaims(ev.ep, Date.now());
return [{ json: { claimsJson: JSON.stringify(c), expiresAt: new Date(c.exp * 1000).toISOString() } }];
