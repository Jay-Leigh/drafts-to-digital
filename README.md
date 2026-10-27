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
- Access is by code; students confirm they are 18 or older and accept the Terms and Privacy Policy

---

## Architecture

```
[ Browser / GitHub Pages ]  static index.html, no build step
        |
        |  files and prompts (POST)
        v
[ n8n workflow on Google Cloud Run ]  Vision OCR, Redis cache, Gemini 2.5 (Flash / Flash-Lite)
        |
        v
[ Browser ]  Google Identity Services -> Google Docs / Drive APIs
```

- **Frontend:** vanilla JS, HTML5, Tailwind CSS (CDN)
- **Middleware:** [n8n](https://n8n.io), workflow exported in this repo (`Student Tools Hub Pipeline - live n8n workflow.json`)
- **AI:** Google Gemini 2.5 via n8n; the Gemini API key stays in n8n and never reaches the browser
- **Google sign-in:** Google Identity Services. The Google access token is held in the browser for Docs export, and for Drive sync it is currently also passed to n8n for some Drive operations (see the Privacy Policy). Signing out of sync revokes Google access.

---

## Deploying

1. Serve `index.html` from the repo root with GitHub Pages (Settings, Pages, branch `main`, folder `/`).
2. Import the workflow JSON into n8n and set its credentials.
3. In Google Cloud Console, add the Pages origin (for example `https://jay-leigh.github.io`) as an authorised JavaScript origin for the OAuth client.

The webhook URL and Google client ID are stored encrypted inside `index.html` and unlock with the access code.

---

## Legal

© 2026 Jay-Leigh Vergotine. All rights reserved. See [SECURITY.md](SECURITY.md) for reporting security issues.
