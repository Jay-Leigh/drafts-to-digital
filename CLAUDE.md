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
- OCR cache keeps no expiry (owner decision). No postal address published; not registered as Information Officer.

## Roadmap
1a. privacy.html + terms.html match current app (drafted, in review)
1b. Verification hardening, before submitting to Google:
  - Drive token stays in browser: client-side Drive download and .doc to PDF conversion, send bytes only; remove driveAccessToken from n8n requests
  - Drop `documents` scope: create Docs with drive.file, "append to existing Doc" via Google Picker
  - 18+ tick and terms acceptance on the access gate; public description plus privacy/terms links on the gate; one app name
  - Webhook authentication; per-user (salted) cache keys; error emails to jayleigh.dev@gmail.com; error_callback on both GIS token clients; revoke Google access on sign-out
  - Update privacy.html/terms.html to match, add Search Console meta tag
  - Owner console tasks: rename consent screen, Branding URLs, declare drive.appdata/userinfo scopes, rotate API keys, Search Console property
2. background jobs (async n8n: respond with jobId, result in Redis, poll on return)
3. error codes (D2D-NET-503 style) + loading states + global status banner
4. Study Studio: mind map, quiz, infographic (HTML/SVG first, image model later), slide deck, flashcards last
5. OAuth verification submission and publish (parallel, after 1b)
