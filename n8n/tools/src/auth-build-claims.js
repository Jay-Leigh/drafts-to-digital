// Auth Endpoint step 4 (match only): claims for the JWT node (Use JSON = on).
// sid = jti = one id per issued token; ac = access-code id; v = claims version.
// exp/iat are put into the payload directly: in n8n 2.29 the node's "Expires In" claim
// is written into the payload as a plain field and does NOT set exp.
const TTL_SECONDS = 7 * 24 * 3600;
const iat = Math.floor(Date.now() / 1000);
const exp = iat + TTL_SECONDS;
let jti = '';
try {
  jti = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : '';
} catch (e) {}
if (!jti) {
  const hex = () => Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
  jti = hex() + hex() + hex() + hex();
}
return [{ json: { claimsJson: JSON.stringify({ sub: 'sth', sid: jti, ac: 'sth', v: 1, jti, iat, exp }), expiresAt: new Date(exp * 1000).toISOString() } }];
