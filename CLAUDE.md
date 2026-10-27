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

## Roadmap
1. privacy.html 2. terms.html 3. background jobs (async n8n + Redis) 4. error/loading states 5. Study Studio 6. iOS login fix + OAuth verification (parallel)
