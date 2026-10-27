# Working agreement

Orchestrator (main session) = decision maker + architect. Delegates work to sub-agents, reviews results, never skips a stage.

## Stages per feature
1. Align: goal, expected outcome, clarification Qs, confirmations. No code before user confirms.
2. Reviewer: adversarial sub-agent (Opus) tries to break the idea. Refine, then strategy.
3. Build: sub-agents implement per strategy. Surgical diffs.
4. Test: 3 iterations via sub-agents (different routes each). Orchestrator confirms results.
5. User does final test and signs off. Only then merge.

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
1a. DONE (PR #10): privacy.html + terms.html match the app as it was
1b. Verification hardening, split into PRs (owner decisions in brackets):
  - PR-A1 (PR #11): access gate (description, links, 18+/terms tick stored in browser), sign-in hardening (error_callback, include_granted_scopes false, revoke on sign-out, single-flight sign-in), scrubbed error reports, README (all rights reserved), legal text updated
  - PR-A2: Drive token stays in the browser (client-side .doc conversion and Drive-only scans), drop `documents` scope (create Docs with drive.file; append only to Docs the app created), policies updated
  - PR-A3: cache keys tied to a per-account secret kept in the sync file (HMAC on send), OCR/gemini-file cache 30-day expiry [owner: A], policies updated
  - PR-C: Google Picker for appending to any Doc (preloaded, so iOS popups still work) [owner: add Picker]
  - PR-B (n8n + client): webhook auth with n8n JWT Auth (owner creates JWT + Header Auth credentials), remove encrypted blob from the page, safe URL fetch for all three fetchers, escape/rate-limit error emails, execution data saving off for success and failure, set errorWorkflow, legacy path removed after a 72 h transition window, purge old ocr:* keys; owner keeps the current access code for now [deprioritised]
  - Owner console tasks: rename consent screen, Branding URLs, declare drive.appdata/userinfo scopes (remove documents after PR-A2), rotate API keys, Search Console property (user-site repo jay-leigh.github.io with the verification tag), Gmail 90-day filters on both mailboxes
  - Known follow-ups: with all browser storage blocked, tutor New chat and Knowledge Bay saves fail; no sign-out control when the sync row shows "Re-connect Google"; iOS Safari may block opening the exported Doc tab; Escape does not close the result modal
2. background jobs (async n8n: respond with jobId, result in Redis, poll on return)
3. error codes (D2D-NET-503 style) + loading states + global status banner
4. Study Studio: mind map, quiz, infographic (HTML/SVG first, image model later), slide deck, flashcards last
5. OAuth verification submission and publish (parallel, after 1b)
