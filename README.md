[README.md](https://github.com/user-attachments/files/26701146/README.md)
# 📝 Drafts to Digital

> Convert handwritten notes into polished, editable Google Docs — powered by Gemini AI.

[![Live Demo](https://img.shields.io/badge/Live%20Demo-GitHub%20Pages-blue?style=for-the-badge&logo=github)](https://jay-leigh.github.io/drafts-to-digital/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg?style=for-the-badge)](LICENSE)

---

## ✨ What It Does

Drafts to Digital is a browser-based tool that lets you upload up to **15 images of handwritten notes**, uses **Google's Gemini 1.5 Pro** multimodal AI to read and transcribe them, and exports the result directly into a **Google Doc** in your Drive — all in one click.

No installs. No accounts (beyond Google). Just upload, process, and export.

---

## 🚀 Features

| Feature | Detail |
|---|---|
| 📸 Drag & Drop Upload | Upload up to 15 images; drag to reorder before processing |
| 🤖 AI Transcription | Gemini 1.5 Pro reads handwriting with high accuracy |
| 🗜️ Client-Side Compression | Images compressed before sending — no payload overflows |
| 🔐 Google OAuth 2.0 | Secure sign-in via Google Identity Services |
| 📄 Direct Google Docs Export | Creates a formatted Doc in your personal Drive |
| ⏳ Reassuring Loading States | Step-by-step progress messages during AI processing |
| 📧 Developer Error Alerts | Backend errors auto-emailed for monitoring |

---

## 🏗️ Architecture

```
[ Browser / GitHub Pages ]
        │
        │  (1) User uploads + reorders images
        │  (2) Client-side compression (browser-image-compression)
        │  (3) Base64 encode → POST to webhook
        ▼
[ n8n Webhook on GCP ]
        │
        │  Secure middleware — validates and forwards to Gemini
        ▼
[ Gemini 1.5 Pro API ]
        │
        │  OCR + logical ordering + text generation
        ▼
[ n8n returns transcribed text ]
        │
        ▼
[ Browser ]
        │
        │  (4) Google OAuth 2.0 (client-side GIS)
        │  (5) Google Docs API — creates Doc in user's Drive
        ▼
[ Google Drive — New Doc Created ✅ ]
```

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla JS · HTML5 · Tailwind CSS (CDN)
- **Compression:** [browser-image-compression](https://github.com/Donaldcwl/browser-image-compression)
- **Middleware:** [n8n.io](https://n8n.io) hosted on GCP
- **AI Engine:** Google Gemini 1.5 Pro (Multimodal)
- **Auth & Export:** Google Identity Services (OAuth 2.0) + Google Docs API
- **Hosting:** GitHub Pages

---

## ⚙️ Setup & Configuration

### Prerequisites

- A Google Cloud Console project with the following APIs enabled:
  - Google Docs API
  - Google Drive API
  - Google Identity (OAuth 2.0)
- An n8n instance (cloud or self-hosted on GCP)
- A Gemini API key

### Configuration

Open `index.html` and update the following constants near the top of the `<script>` tag:

```javascript
// ── CONFIG ──────────────────────────────────────────────
const CONFIG = {
  N8N_WEBHOOK_URL:   'YOUR_N8N_WEBHOOK_URL',
  GOOGLE_CLIENT_ID:  'YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com',
  DEVELOPER_EMAIL:   'your-dev-email@example.com',
};
// ────────────────────────────────────────────────────────
```

### n8n Workflow Nodes

| # | Node | Purpose |
|---|---|---|
| 1 | **Webhook** | Receives POST from frontend with Base64 images |
| 2 | **Code (JS)** | Extracts and validates image array from payload |
| 3 | **HTTP Request** | Calls Gemini 1.5 Pro API with multimodal prompt |
| 4 | **Code (JS)** | Parses Gemini response and formats clean text |
| 5 | **Respond to Webhook** | Returns `{ text: "..." }` to frontend |
| 6 | **Error Trigger** | Catches any workflow errors |
| 7 | **Send Email** | Emails error details to developer |

---

## 📁 Repository Structure

```
drafts-to-digital/
├── index.html          # Entire application (single-file)
└── README.md           # This file
```

> The entire frontend lives in a single `index.html` for frictionless GitHub Pages deployment.

---

## 🌐 Hosting on GitHub Pages

See the [Deployment Guide](#-deployment-guide) section below.

---

## 📋 Deployment Guide

### Step 1 — Rename your file

Your HTML file **must** be named `index.html` for GitHub Pages to serve it at the root URL.

```bash
# If using Git locally:
git mv drafts-to-digital.html index.html
git commit -m "fix: rename to index.html for GitHub Pages"
git push
```

Or via GitHub UI: open the file → click the pencil (edit) → change the filename at the top from `drafts-to-digital.html` to `index.html` → commit.

### Step 2 — Enable GitHub Pages

1. Go to your repo → **Settings** → **Pages**
2. Under **Source**, select:
   - Branch: `main`
   - Folder: `/ (root)`
3. Click **Save**

### Step 3 — Wait & Visit

GitHub Pages deploys in ~60 seconds. Your live URL will be:

```
https://jay-leigh.github.io/drafts-to-digital/
```

### Step 4 — Add Authorised Origin in Google Cloud Console

For Google OAuth to work on your live domain, add the Pages URL as an authorised JavaScript origin:

1. Go to [Google Cloud Console](https://console.cloud.google.com/) → **APIs & Services** → **Credentials**
2. Click your OAuth 2.0 Client ID
3. Under **Authorised JavaScript origins**, add:
   ```
   https://jay-leigh.github.io
   ```
4. Under **Authorised redirect URIs**, add:
   ```
   https://jay-leigh.github.io/drafts-to-digital/
   ```
5. Click **Save**

---

## 🔒 Security Notes

- No API keys are stored in the frontend code
- All Gemini API calls are proxied through n8n — your Gemini key never touches the browser
- Google OAuth tokens are handled entirely client-side via Google Identity Services and are never sent to n8n
- n8n webhook URL should have authentication enabled (Header Auth recommended)

---

## 🐛 Known Limitations

- Maximum 15 images per session (Gemini context window / payload limit)
- Processing 15 high-resolution images may take 30–60 seconds
- Requires a Google account for the Docs export feature
- GitHub Pages serves static files only — all dynamic processing happens via n8n + Gemini

---

## 📄 License

MIT © Jay-Leigh — feel free to fork, adapt, and build on this.

---

## 🙏 Acknowledgements

- [Google Gemini](https://deepmind.google/technologies/gemini/) for multimodal AI
- [n8n](https://n8n.io) for no-code workflow automation
- [browser-image-compression](https://github.com/Donaldcwl/browser-image-compression) by Donald Cwl
- [Tailwind CSS](https://tailwindcss.com) for utility-first styling
