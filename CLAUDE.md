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
DONE (live): 1a legal pages (PR #10); 1b hardening: PR-A1 gate/sign-in, A2 Drive token in browser and no `documents` scope, A3 per-device HMAC cache keys, PR-B JWT auth + server hardening (n8n v1 then v3), PR-C Google Picker; J1 error codes + status banner + loading states; Study Studio S1a shell + S1b mind map (n8n v3, owner cap `cfg:studio_max_tokens`, ceiling `cfg:daily_units`); J2/J3 background jobs (n8n v4 `sth-workflow-v4-jobs.json`, client `jobs` engine, testers-only flag `sth_flag_jobs`). Google Search Console verified (user-site repo jay-leigh.github.io).
IN PROGRESS: J3b tutor on jobs (client).
NEXT, in this order (owner decision 2026-10-30):
  1. J6 legal rows for server-side job results (72 h); release blocker for enabling jobs beyond testers
  2. Flashcards (job mode + viewer + review + TSV), one n8n import
  3. Quiz (multiple choice, true/false), one n8n import
  4. S1c release: Drive sync of study aids, privacy/terms update, TERMS_VERSION bump, studio flag removed, Home card
  5. After that: Infographic (HTML/SVG; image mode later), then Slide deck (still to decide: in or out)
LATER / optional: J4 transcribe/template/reviewer on jobs; map-reduce worker for true 1M-token runs; email notices, cross-device pickup, quotas (none for now); Upstash pay-as-you-go cap about USD 5 if usage passes 60%.
OWNER TASKS: Google branding re-verification (retry after Search Console verified), publish the OAuth app after S1c (Testing mode expires sign-ins in 7 days), purge old `ocr:*` and `gemini-file:*` keys, Gmail 90-day filters on both mailboxes.
Known follow-ups: with all browser storage blocked, tutor New chat and Knowledge Bay saves fail; no sign-out control when sync shows "Re-connect Google"; iOS Safari may block opening the exported Doc tab; Escape does not close the result modal; 401 after export does not re-auth; error-report scrubber mangles ".docx or PDF"; stale test s1a G5 (placeholder text).
