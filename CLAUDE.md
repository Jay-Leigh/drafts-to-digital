# Working agreement

Orchestrator (main session) = decision maker + architect. Delegates work to sub-agents, reviews results, never skips a stage.

## Stages per feature
1. Align: goal, expected outcome, clarification Qs, confirmations. No code before user confirms.
2. Reviewer: adversarial sub-agent (Opus) tries to break the idea. Refine, then strategy.
3. Build: sub-agents implement per strategy. Surgical diffs.
4. Test: 3 iterations via sub-agents (different routes each). Orchestrator confirms results.
5. User does final test and signs off. Only then merge.

## Lean mode (usage budget, owner request 2026-10-28)
- Development and integration first; tests small and targeted. One combined test pass per PR by a single Sonnet agent (journeys + legal-vs-code check in one), not three parallel rounds.
- Builders run only the suites that cover code they changed, plus a gate/sync smoke; the full flat suite only before a risky merge.
- Opus only for design review of high-risk areas (auth, jobs, security) and for hard debugging; no Opus diff reviews of routine PRs. Haiku or Sonnet for mechanical checks.
- No redundant parallel agents on the same files; no screenshot marathons.

## Model routing
- Opus: architecture, reviewer, GCP/auth diagnosis, async-job design, final PR review
- Sonnet: legal drafts (use legal:brief), studio build, n8n branches
- Haiku: link checks, formatting, mechanical edits

## Rules
- GCP / n8n / Drive: read-only unless user approves a change. Ask first.
- Naming: one convention across functions and variables.
- Blockers or inconsistencies: raise before proceeding.
- Secrets redacted in chat; never commit keys.
- Branch `claude/dazzling-turing-arvv2i`, one draft PR per step.
- Stack: static `index.html` (GitHub Pages, no build) + n8n cloud workflow JSON in repo (user re-imports).

## Decisions
- Public name: Student Tools Hub. Audience: 18+ only (Gemini API terms bar under-18 audiences). Contact and error emails: jayleigh.dev@gmail.com.
- Gemini = paid Tier 1 project gen-lang-client-0679788985 (never delete). Vision/OAuth/Drive = project drafts-to-digital. n8n = self-hosted on Cloud Run (africa-south1).
- OCR cache: no expiry until PR-A3, then 30 days (owner decision). No postal address published; not registered as Information Officer.

## Roadmap
DONE (live): Flashcards (n8n v5), Quiz (n8n v6), 14-day notice, mobile UI fixes, S1c release (Study Studio for everyone, Drive sync of study aids, jobs on by default, TERMS_VERSION 2026-11-18); 1a legal pages (PR #10); 1b hardening: PR-A1 gate/sign-in, A2 Drive token in browser and no `documents` scope, A3 per-device HMAC cache keys, PR-B JWT auth + server hardening (n8n v1 then v3), PR-C Google Picker; J1 error codes + status banner + loading states; Study Studio S1a shell + S1b mind map (n8n v3, owner cap `cfg:studio_max_tokens`, ceiling `cfg:daily_units`); J2/J3 background jobs (n8n v4 `sth-workflow-v4-jobs.json`, client `jobs` engine); Flashcards (n8n v5 `sth-workflow-v5-flashcards.json`, replaces v4); S1c release (Study Studio visible to everyone, no studio flag; study aids sync to Drive appData: field `studio` in `sth-userdata-v1.json` plus a hidden file `sth-studio-<id>.json` per aid; jobs on by default, the server `hello` and `sth_flag_jobs='0'` are the switches; TERMS_VERSION 2026-11-01, privacy/terms updated). Google Search Console verified (user-site repo jay-leigh.github.io).
NEXT, in this order (owner decision 2026-10-30):
  1. DONE: J6 legal rows for job results (privacy/terms), J3b tutor on jobs
  2. DONE: Flashcards (job mode + viewer + review + TSV), one n8n import
  3. DONE: Quiz (multiple choice, true/false; n8n v6)
  4. DONE: S1c release: Drive sync of study aids, privacy/terms update, TERMS_VERSION bump, studio flag removed, Home card
  5. DONE (merged, live from 8 Dec 2026, v7 bundle `sth-workflow-v7-bundle.json`): Infographic (SVG; PNG/SVG/PDF), Slide deck (.pptx via PptxGenJS 4.0.1 from jsDelivr with SRI, plus in-app viewer), J4 (transcribe/template/reviewer on background jobs), map-reduce for big Study Studio runs (max 16 parts, per-run cap cfg:mr_max_units 2,000,000, one big run at a time), per-chat tutor drafts, regression suite in tests/ (`cd tests && bash run-all.sh`), harness in n8n/tools/.
  6. RELEASE 26 Nov 2026: TERMS_VERSION 2026-11-26, privacy/terms text updated (infographics, slides, J4 on jobs, big runs, device storage list, every browser key named, one 14-day notice rule for FUTURE changes, presenting your own study aids to your class allowed), `#upcoming` box and in-app banner removed, tutor and document Markdown now sanitised (DOMPurify 3.5.0 with SRI; marked pinned to 15.0.12 with SRI). Features gate on server `hello` v>=7 (owner imports v7 when no job is running; load test in runbook section 22).
RELEASE 27 Nov 2026 (owner waived the notice, as on 26 Nov; TERMS_VERSION 2026-11-27): stay connected to Google (silent renewal on non-Safari browsers, tap flow on Safari family; tab token sharing off until the custom domain: SHARE_SYNC_TOKEN), sign-in renewal up to 30 days (client `renew`, server v8 `student-tools-renew`, `auth:ep`), auto-pull + three-way sync merge (C1), History sync (C2), cross-device job pickup (D, hidden `sth-jobs-v1.json`). Gated by server `hello` v>=8: the owner imports `n8n/sth-workflow-v8-bundle.json` when no job is running (runbook step 23; test 23.5 forged token is mandatory; rotate the access code ONLY with the combined EVAL in runbook step 3; never DEL `auth:ep`; Upstash eviction OFF). Reviews: docs/review-signin-sync-BD.md, review-v8-server.md, review-D-client.md. Progress notes: docs/progress-2026-11-26.md.
LATER / optional: email notices, cross-device pickup, quotas (none for now); Upstash pay-as-you-go cap about USD 5 when we commercialise.
NOTICE (v7 bundle): announced 24 Nov 2026; released 26 Nov 2026. The 14-day notice rule applies to future changes. Decisions kept: presenting slides allowed (no publishing or selling); tutor guard only (no map-reduce for the tutor); job cap stays 4, raise to 5 only after a load test (runbook section 22). Branding: Google needs a verified own domain (github.io cannot be verified): owner chose to skip for now and buy a domain later (plan: custom domain on GitHub Pages, Search Console domain property by DNS, add the origin to the OAuth client and to the n8n webhooks via STH_EXTRA_ORIGIN, update URLs, reply to Google's email).
OWNER TASKS: on release day import n8n v7 only when no job is running; run the load test in runbook section 22 before raising the job cap; Google branding re-verification (automated re-verify keeps returning "home page not registered"; appeal submitted 2026-11-24, wait for the human review; github.io cannot be verified, branding needs a custom domain; OAuth app is already In production, only non-sensitive scopes); publish nothing else.
DONE (owner, 2026-11-24): purged 82 legacy `ocr:*` keys (leave `gemini-file:*`, 47 h expiry), Gmail 90-day Apps Script on both mailboxes.
Known follow-ups: with all browser storage blocked, tutor New chat and Knowledge Bay saves fail; no sign-out control when sync shows "Re-connect Google"; iOS Safari may block opening the exported Doc tab; Escape does not close the result modal; 401 after export does not re-auth; error-report scrubber mangles ".docx or PDF"; stale test s1a G5 (placeholder text).
