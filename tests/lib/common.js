'use strict';
// Helpers the suites share.
const fx = require('./fixtures');

const RELEASE_MS = Date.UTC(2026, 10, 26); // STUDIO_V7_RELEASE_MS in the page
const AFTER = RELEASE_MS + 36 * 3600e3; // 27 Nov 2026 12:00 UTC
const BEFORE = RELEASE_MS - 7 * 86400e3; // 19 Nov 2026

function studioItem(tool, over = {}) {
  const art = { envelope: fx.ENVELOPE, tool, schema: fx.SCHEMA[tool], promptVersion: 'x', generatedAt: '2026-12-09T00:00:00.000Z', usage: fx.usage(), repairs: [],
    data: tool === 'mindmap' ? fx.mindmap('t') : tool === 'flashcards' ? fx.flashcards(6, 't') : tool === 'quiz' ? fx.quiz(5, 't') : tool === 'infographic' ? fx.infographic() : fx.slides() };
  const now = Date.now();
  return { id: over.id || `item_${tool}_${Math.random().toString(36).slice(2, 8)}`, tool, title: `${tool} item`, language: 'en', topic: '', options: {}, sourceIds: ['k_a'], sourceNames: ['a.txt'],
    status: 'ready', createdAt: now, updatedAt: now, seen: true, error: null, artifact: art, ...over };
}

// signs in to Google sync through the page's own button (the sign-in script is the fake)
async function connectDrive(app) {
  await app.until('!!state.driveSyncClient', { what: 'Google sign-in client ready', timeout: 20000 });
  await app.page.click('#btnSyncSignIn');
  await app.until('!!state.driveSyncToken', { what: 'drive token' });
  await app.until(`/^Synced/.test(document.getElementById('syncStatus').textContent)`, { what: 'sync done', timeout: 20000 });
}

// true when the page has no horizontal scroll
const noHScroll = `document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.body.scrollWidth <= document.documentElement.clientWidth + 1`;

// mask the parts of a recorded request that differ per run (random ids, hashes)
function mask(value) {
  const s = JSON.stringify(value, (k, v) => {
    if (['requestId', 'id', 'key', 'contentHash', 'cacheName', 'chatId'].includes(k) && typeof v === 'string' && /^(f_\d+_|j_|g_|[A-Za-z0-9_-]{20,}|[0-9a-f]{16,})/.test(v)) return `<${k}>`;
    if (typeof v === 'string' && /^[0-9a-f]{40,}$/.test(v)) return '<hash>';
    if (typeof v === 'string' && /^f_\d{10,}_[a-z0-9]{6}$/.test(v)) return '<id>';
    return v;
  });
  return s;
}

module.exports = { studioItem, connectDrive, noHScroll, mask, RELEASE_MS, AFTER, BEFORE, fx };
