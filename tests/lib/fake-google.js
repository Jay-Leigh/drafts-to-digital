'use strict';
// Google stand-ins: the sign-in script (GIS), the Picker loader, and an in-memory Drive (appDataFolder) and Docs. No real Google calls.
const { parseMultipart, CORS } = require('./fake-n8n');

const GIS = `
window.__gis = { requests: [], mode: 'ok' };
window.google = { accounts: { oauth2: {
  initTokenClient(cfg) {
    return { requestAccessToken(opts) {
      window.__gis.requests.push({ scope: cfg.scope, at: Date.now() });
      setTimeout(() => {
        if (window.__gis.mode === 'cancel') { (cfg.callback || function(){})({ error: 'access_denied' }); return; }
        cfg.callback({ access_token: 'fake-drive-token', expires_in: 3600, scope: cfg.scope });
      }, 0);
    } };
  },
  revoke(token, cb) { if (cb) cb({ successful: true }); },
} } };`;
const PICKER = 'window.gapi = { load(name, cb) { if (typeof cb === "function") cb(); else if (cb && cb.callback) cb.callback(); } };';

class FakeDrive {
  constructor() { this.files = new Map(); this.n = 0; this.log = []; this.userinfo = { name: 'Test User', email: 'tester@example.test', picture: '' }; this.failNext = 0; this.token = 'fake-drive-token'; }
  add(name, body, mime = 'application/json') { const id = `fid${String(++this.n).padStart(6, '0')}x`; this.files.set(id, { id, name, mime, body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body) }); return id; }
  byName(name) { return [...this.files.values()].filter(f => f.name === name); }
  json(id) { const f = this.files.get(id); return f ? JSON.parse(String(f.body)) : null; }
  count(method, re) { return this.log.filter(l => l.method === method && (!re || re.test(l.url))).length; }
  attach(context) {
    return context.route(/^https:\/\/(www|docs)\.googleapis\.com\//, (route) => this.handle(route).catch(() => { try { route.abort('failed'); } catch { /* gone */ } }));
  }
  async handle(route) {
    const req = route.request(), url = new URL(req.url()), method = req.method();
    const out = (status, json, raw) => route.fulfill({ status, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'content-type': raw ? 'application/octet-stream' : 'application/json' }, body: raw !== undefined ? raw : JSON.stringify(json === undefined ? {} : json) });
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS' } });
    this.log.push({ method, url: req.url() });
    if (req.headers().authorization !== `Bearer ${this.token}`) return out(401, { error: { code: 401 } });
    if (this.failNext > 0) { this.failNext--; return out(500, { error: { code: 500 } }); }
    const p = url.pathname;
    if (url.hostname === 'docs.googleapis.com') {
      if (method === 'POST' && p === '/v1/documents') return out(200, { documentId: `doc${++this.n}` });
      return out(200, {});
    }
    if (p === '/oauth2/v3/userinfo') return out(200, this.userinfo);
    if (p === '/drive/v3/files' && method === 'GET') {
      const q = url.searchParams.get('q') || '';
      const m = /name='([^']*)'/.exec(q);
      return out(200, { files: [...this.files.values()].filter(f => !m || f.name === m[1]).map(f => ({ id: f.id })) });
    }
    const one = /^\/(?:upload\/)?drive\/v3\/files\/([^/]+)$/.exec(p);
    if (one) {
      const f = this.files.get(decodeURIComponent(one[1]));
      if (!f) return out(404, { error: { code: 404 } });
      if (method === 'GET') return out(200, null, f.body);
      if (method === 'PATCH') { f.body = req.postDataBuffer() || ''; return out(200, { id: f.id }); }
      if (method === 'DELETE') { this.files.delete(f.id); return out(204, null, ''); }
    }
    if (p === '/upload/drive/v3/files' && method === 'POST') {
      const ctype = req.headers()['content-type'] || '';
      const boundary = /boundary=([^;]+)/.exec(ctype);
      const parts = boundary ? parseMultipart(req.postDataBuffer(), boundary[1]) : [];
      const meta = parts.find(x => x.name === 'metadata');
      const file = parts.find(x => x.name === 'file');
      const name = meta ? JSON.parse(meta.data.toString()).name : 'unnamed';
      return out(200, { id: this.add(name, file ? file.data : '') });
    }
    return out(404, { error: { code: 404 } });
  }
}

module.exports = { GIS, PICKER, FakeDrive };
