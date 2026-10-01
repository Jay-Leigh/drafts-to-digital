# Security Policy

## Supported Versions

Only the latest code on `main` (the live GitHub Pages site and the current n8n workflow in this repo) is supported. Fixes are not backported.

## Reporting a Vulnerability

Please **do not open a public issue** for security problems.

Report privately via GitHub: **Security tab → Report a vulnerability** (private advisory).

Include:
- What you found and where (page, file or n8n node)
- Steps to reproduce
- Impact (e.g. data exposure, key leak, unauthorised access)

What to expect:
- Acknowledgement within **3 business days**
- An initial assessment within **7 days**
- A fix or mitigation as soon as practical, usually within **30 days** for confirmed issues
- Credit in the advisory if you'd like it

## Scope

In scope:
- `index.html` (the web app, including Knowledge Bay, Drive sync and Google sign-in)
- The n8n workflow JSON (webhook handling, Redis session/OCR cache, Gemini and Cloud Vision calls)

Out of scope:
- Third-party services themselves (Google, Gemini, Cloud Vision, Upstash, n8n), so report those to the vendor
- Denial-of-service or rate-limit testing against live endpoints
- Social engineering or physical attacks

## Handling of Secrets

API keys and credentials are never stored in this repository. They live in n8n credentials or the encrypted app config. If you spot a key committed anywhere, report it as above and it will be rotated immediately.
