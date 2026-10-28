# Student Tools Hub

Student Tools Hub turns handwritten notes and study files into text and Google Docs, and offers an AI study tutor. For students aged 18 and over.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue?style=for-the-badge&logo=github)](https://jay-leigh.github.io/drafts-to-digital/)

- [Privacy Policy](privacy.html)
- [Terms of Service](terms.html)

---

## What it does

- Transcribes handwritten notes and extracts text from study files (images, PDF, Word, Excel, PowerPoint)
- Drafts templates and reviews, and answers questions as an AI tutor with a personal Knowledge Bay of reference material
- Exports results to Google Docs, and optionally syncs your data across devices through Google Drive app data
- Access is by a shared code, checked by the server at sign-in (the browser keeps a sign-in token valid for 7 days, never the code); students confirm they are 18 or older and accept the Terms and Privacy Policy

---

## Architecture

```
[ Browser / GitHub Pages ]  static index.html, no build step
        |
        |  sign-in: POST {code} to /webhook/student-tools-auth -> token (7 days)
        |  files and prompts (POST /webhook/student-tools-v2, Authorization: Bearer <token>)
        v
[ n8n workflow on Google Cloud Run ]  Vision OCR, Redis cache, Gemini 2.5 (Flash / Flash-Lite)
        |
        v
[ Browser ]  Google Identity Services -> Google Docs / Drive APIs
```

- **Frontend:** vanilla JS, HTML5, Tailwind CSS (CDN)
- **Middleware:** [n8n](https://n8n.io), workflow exported in this repo (`Student Tools Hub Pipeline - live n8n workflow.json`). The server compares the access code with a copy stored in Upstash, counts sign-in attempts per network address (failed attempts for up to 10 minutes, successful sign-ins for up to 1 hour) to limit guessing, and requires the token on every other request. The tutor's instructions are kept on the server.
- **AI:** Google Gemini 2.5 via n8n; the Gemini API key stays in n8n and never reaches the browser
- **Google sign-in:** Google Identity Services. Google access tokens stay in the browser and are never sent to n8n: Docs export, Drive sync, `.doc` conversion and reading scans back from Drive all run client-side, with only non-sensitive scopes (`drive.file`, `drive.appdata`, profile and email). Signing out of sync asks Google to revoke the app's access and tells you if that fails.

---

## Deploying

1. Serve `index.html` from the repo root with GitHub Pages (Settings, Pages, branch `main`, folder `/`).
2. Import the workflow JSON into n8n and set its credentials.
3. In Google Cloud Console, add the Pages origin (for example `https://jay-leigh.github.io`) as an authorised JavaScript origin for the OAuth client.

The sign-in and webhook URLs and the (public) Google client ID are plain constants in the `CONFIG` block of `index.html`. The access code is not in the page: n8n checks it (see `n8n/runbook-owner.md`), and the new client only ships after the n8n workflow with the sign-in path is imported.

---

## Legal

© 2026 Jay-Leigh Vergotine. All rights reserved. See [SECURITY.md](SECURITY.md) for reporting security issues.
