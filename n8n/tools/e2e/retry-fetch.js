// Test tooling: n8n closes idle keep-alive sockets after 5 s, so undici sometimes reuses a socket that has just been closed
// ("other side closed", UND_ERR_SOCKET). Retry such a request once (the request never reached n8n). Used via `node -r`.
const orig = globalThis.fetch;
globalThis.fetch = async (...a) => {
  try { return await orig(...a); } catch (e) {
    if (e && e.cause && e.cause.code === 'UND_ERR_SOCKET') return orig(...a);
    throw e;
  }
};
