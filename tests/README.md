# Browser regression tests

Playwright scripts (Chromium) that run the static `index.html` against mocked services. No live system is ever touched: every external request is
intercepted, and the page's `n8n` backend, Google sign-in and Google Drive are in-process fakes. No secrets (tokens are signed with a fixed fake key).

```
tests/
  run-all.sh            runs every suite, prints PASS/FAIL per test and a final table; exit code 1 on any failure
  README.md
  .gitignore            .cache/ (CDN libraries), .results/ (JSON per suite), .tmp/ (built pages, failure screenshots)
  lib/
    build.js            copies the page under test to a temp folder and injects the test hook (see below)
    harness.js          static server, browser, one mocked page per test (newApp), the tiny test runner
    fake-n8n.js         the backend: auth, the v2 webhook, the job endpoints, budget; records every request
    fake-google.js      sign-in script (GIS), Picker loader, an in-memory Drive (appDataFolder) and Docs
    fixtures.js         answers of the fake server (mind map, cards, quiz, infographic, slides, digest) and Knowledge Bay items
    common.js           release dates, studioItem(), connectDrive(), noHScroll, mask()
    mr.js               helpers for the map-reduce journeys (big sources, consent step, tray buttons, counting creates)
    vendor.js           CDN libraries: fetched once with curl into .cache (about 1.4 MB; PptxGenJS 4.0.1 is the real file, so the .pptx can be opened with the cached JSZip), the rest stubbed
    table.js            the final table of run-all.sh
  suites/
    01-gate-sync        opens unlocked, sign-in gate, hello v6 vs v7, release date, 10 vs 15 sources, jobs flag, Drive sync push and pull
    02-tutor            chats, direct and job sends, reload mid-job, per-chat drafts (sth_tutor_drafts)
    03-studio-single    normalisers, XSS as text, request bodies BASE vs NEW, journeys, viewers at 320/390/1280, exports
    04-jobs             jobs engine: one job, groups (2 in flight), reload mid-group, cancel, failed member + retry, busy, token refused
    05-j4               transcribe / template / reviewer: gate off = same bodies as BASE, gate on = job group, retry, cancel
    06-mobile           no horizontal scroll at 320/360/390/430, tutor top bar order
    07-legal            privacy.html / terms.html load and carry the effective date; storage keys written vs named (warnings)
    08-mr-pure          map-reduce pure functions (plan, estimate, merge, hash, digest checks, cite checks)
    09-mr-journeys      map-reduce journeys: consent, 5-part run, resume, retry, skip, cancel, replaced run, delete
    10-mr-gates         map-reduce gate (v6 / date / flag), busy 429, budget and limits, retry limits, tutor next to a run
    11-ig-sources-icon  infographic "Show sources on the picture" (default, toggle, reload, sync, exports, request unchanged) and the app icon in the SVG/PNG/PDF/mind map/.pptx footers
    12-history-studio   History panel with study aids: live rows (badge, title, date, size line), interleaved by date, All / Documents / Study aids chips (sth_history_filter), open in Studio, delete through Studio (Drive file, tombstone), button dot, XSS, 320/390/1280
```

## Running

```
tests/run-all.sh                       # whole thing (about 3-4 minutes)
node tests/suites/04-jobs.js           # one suite
ONLY="cancel" node tests/suites/09-mr-journeys.js    # tests whose title matches a regex
SUITES="08 09" tests/run-all.sh        # some suites
```

Needs Node 18+, the preinstalled Playwright (`require('playwright')`) and its Chromium, and `curl` (first run only, for the CDN libraries; the proxy is used
automatically). If the download is impossible, put `localforage.min.js` (and, for layout, `tailwind.js`) into `tests/.cache/` by hand.

### Against another page, and BASE vs NEW

`PAGE` is the page under test (default `../index.html`). `BASE` is the baseline page for the suites that compare request bodies and refusal texts
(`03`, `05`, `10`). `run-all.sh` makes it from `git show origin/main:index.html` when `BASE` is not set; a suite run by hand without `BASE` skips those tests.

```
git -C /home/user/drafts-to-digital show origin/main:index.html > /tmp/base.html
BASE=/tmp/base.html node tests/suites/03-studio-single.js
PAGE=/path/to/other/index.html tests/run-all.sh      # the same suites against another build
```

## How the test hook works

`lib/build.js` copies the page to `tests/.tmp/<kind>-xxxx/index.html` and, just before the closing of the main inline IIFE (the marker `  })();\n  </script>\n`,
which must occur exactly once), adds:

* `window.__t.<name>` for every top-level `const`, `let`, `function`, `class` of the IIFE (about 700 names: `jobs`, `kb`, `tutor`, `studio`, `studioMr`, `service`,
  `serverHas`, `studioV7Live`, `studioMrPlan`, `CONFIG`, `ERRORS`, `TERMS_VERSION` ...), each a lazy getter, so `let` variables are read live;
* `window.__t.ev(src)`: a direct `eval` inside the IIFE, so a test can run any code in the page's own scope (`await app.ev("jobs.hello()")`);
* a test-only job group kind `tgrp` (handlers that log to `localStorage` keys `tgrp_*`), used by `04-jobs`.

The page is changed in no other way. The same hook is injected into BASE, so both pages are driven the same way. The page needs no edits for a new name
(a new top-level function is exposed automatically).

## What the fakes do

* `FakeN8n`: `POST student-tools-auth` (code `app.n8n.code`), `student-tools-v2` (direct requests), `sth-job-start` (create, JSON or multipart) and `sth-job`
  (hello, status, result, ack, cancel, budget). Tokens are checked (bump `n8n.epoch` to make every token invalid). Jobs finish on their first status poll unless a
  plan says otherwise: `n8n.plan(matchFn, { type: 'hold' | 'busy' | 'fail', code, retryable }, times)`, `n8n.release()`. `new FakeN8n({ v: 0 })` is a v6 server (no `v`, no
  caps); `fake: { caps: { maxParts: 5 }, budget: { bulkRemaining: ... }, enforceCaps: true }` pass options. Everything the page sends is in `n8n.log` (`creates()`,
  `direct()`, `ops('cancel')`, `list()`).
* `FakeDrive`: `appDataFolder` files by name (`drive.byName`, `drive.json(id)`), user info, Docs create.
* Unknown external requests are aborted and listed in `app.blocked` (fonts and analytics included).

## Time

Most tests run with a fake clock (`newApp({ now })` or `{ clock: true }`, Playwright `clock`): time flows by itself and `app.advance(ms)` / `app.advanceUntil(expr)` move it
on, so 60-180 s busy waits and 24 h limits take milliseconds. Gate tests set the date (`BEFORE` = 1 Dec 2026, `AFTER` = 9 Dec 2026; the release is 8 Dec 2026 00:00 UTC).
`app.until(expr)` waits in real time for an expression evaluated inside the page.

## Writing a suite

```js
const { suite, assert } = require('../lib/harness');
const t = suite('11-my-suite');                       // the file name is the suite name; add the file to tests/suites
t.test('title', async (h) => {
  const app = await h.newApp({ now: Date.UTC(2026, 11, 9), v: 7 /* , jobs: false, width: 390, page: 'base' */ });
  await app.seedKb([h.fx.kbItem('a.txt', { tokens: 100, id: 'k_a' })]);
  await app.goto('#studio');
  assert.equal(await app.ev('studio.items.length'), 0);
});
t.test('needs the baseline', async (h) => { /* h.newApp({ page: 'base' }) */ }, { needsBase: true });
t.known('a bug found in the page (reported, not fixed)', async (h) => { /* fails today */ });   // listed as KNOWN, never fails the run; says so when it passes
t.run();                                              // writes .results/<suite>.json, prints RESULT, ends the process
```

`h.warn(text)` records a warning (printed and counted, never a failure). A failing test saves a screenshot to `tests/.tmp/` (gitignored). Each test gets a fresh browser
context (fresh storage); nothing is shared between tests. Nothing in `tests/` may contain a real key: use the fake token helpers only.
