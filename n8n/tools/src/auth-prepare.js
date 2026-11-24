// Auth Endpoint step 1: normalise the request. Nothing here can throw.
const item = $input.first().json || {};
const body = item.body && typeof item.body === 'object' ? item.body : {};
const code = typeof body.code === 'string' ? body.code : '';
const headers = item.headers || {};
const hops = String(headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
// Cloud Run appends the real client IP as the LAST hop; earlier hops are client-controlled.
let ip = hops.length ? hops[hops.length - 1] : 'unknown';
ip = ip.toLowerCase().replace(/[^a-z0-9:.\-]/g, '').slice(0, 64) || 'unknown';
return [{ json: { code: code.slice(0, 256), codeTooLong: code.length > 256, failKey: 'auth:fail:' + ip, okKey: 'auth:ok:' + ip } }];
