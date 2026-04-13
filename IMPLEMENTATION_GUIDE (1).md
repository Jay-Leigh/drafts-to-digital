# Drafts to Digital — Implementation Guide

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  BROWSER (Client-Side)                              │
│                                                     │
│  index.html                                         │
│  ├── Upload + Drag-to-Reorder UI                    │
│  ├── browser-image-compression (sequential)         │
│  ├── Base64 encoding                                │
│  ├── POST to n8n webhook                            │
│  ├── Result display + editing                       │
│  ├── Copy / Download .txt                           │
│  └── Google Identity Services → Docs API            │
│                                                     │
└───────────────┬─────────────────────────────────────┘
                │ HTTPS POST (JSON: base64 images)
                ▼
┌─────────────────────────────────────────────────────┐
│  n8n (GCP Hosted Middleware)                        │
│                                                     │
│  Webhook Trigger                                    │
│  ├── IF type === "convert"                          │
│  │   ├── Code: Build Gemini multimodal payload      │
│  │   ├── HTTP Request: Gemini 1.5 Pro API           │
│  │   └── Code: Extract text → return to frontend    │
│  └── IF type === "error_report"                     │
│      ├── Code: Format error email                   │
│      └── Gmail: Send to dev                         │
│                                                     │
│  Error Trigger (catches workflow failures)           │
│  ├── Code: Format workflow error                    │
│  └── Gmail: Send to dev                             │
└─────────────────────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────┐
│  Gemini 1.5 Pro API (Google AI)                     │
│  - Multimodal: images + text prompt                 │
│  - Sequential page reading                          │
│  - Handwriting OCR + contextual assembly            │
└─────────────────────────────────────────────────────┘
```

---

## Step 1: Google Cloud Platform Setup

### A. Create GCP Project
1. Go to https://console.cloud.google.com
2. Create a new project: **"Drafts to Digital"**
3. Note the Project ID

### B. Enable APIs
Enable these APIs in your GCP project:
- **Google Docs API**
- **Google Drive API**
- **Generative Language API** (for Gemini)

### C. Create OAuth 2.0 Credentials (for Google Docs export)
1. Go to **APIs & Services → Credentials**
2. Click **Create Credentials → OAuth 2.0 Client ID**
3. Application type: **Web application**
4. Name: `D2D Frontend`
5. Authorized JavaScript origins:
   - `http://localhost` (development)
   - `https://your-production-domain.com` (production)
6. Authorized redirect URIs: (leave blank — we use popup flow)
7. Copy the **Client ID** → paste into `CONFIG.googleClientId` in `index.html`

### D. Configure OAuth Consent Screen
1. Go to **APIs & Services → OAuth consent screen**
2. User type: **External**
3. Fill in app name, support email, logo
4. Scopes: Add `../auth/documents` and `../auth/drive.file`
5. Test users: Add tester emails while in testing mode
6. Submit for verification when ready for production

### E. Get Gemini API Key
1. Go to https://aistudio.google.com/apikey
2. Create an API key for your GCP project
3. This key goes into your n8n environment variable `GEMINI_API_KEY`

---

## Step 2: n8n Setup (GCP Hosted)

### A. Environment Variables
Set these in your n8n instance:

```env
GEMINI_API_KEY=your_gemini_api_key_here
N8N_DEFAULT_TIMEOUT=120000
WEBHOOK_URL=https://your-n8n-instance.com/webhook/d2d-convert
```

### B. Import the Workflow
1. Open n8n dashboard
2. Go to **Workflows → Import from File**
3. Upload `n8n-workflow.json`
4. The workflow will appear with all nodes pre-configured

### C. Configure Gmail Credentials
1. In n8n, go to **Credentials → Add Credential → Gmail OAuth2**
2. Connect your Gmail account (the one that sends error emails)
3. Update the credential IDs in both Gmail nodes:
   - `Send Error Email`
   - `Send Workflow Error Email`

### D. Configure Webhook
1. Open the **Webhook Trigger** node
2. Note the webhook URL (production mode): `https://your-n8n.com/webhook/d2d-convert`
3. Paste this URL into `CONFIG.n8nWebhookUrl` in `index.html`

### E. CORS Configuration
Add these response headers to your n8n webhook:
- In n8n Settings or via reverse proxy (e.g., nginx):

```
Access-Control-Allow-Origin: https://your-frontend-domain.com
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type
```

If using n8n's built-in options, set **Allowed Origins** in the Webhook node's options.

### F. Activate the Workflow
1. Toggle the workflow to **Active**
2. Test with the n8n "Test" button using a sample payload

---

## Step 3: Frontend Deployment

### A. Configuration Checklist
Open `index.html` and replace these placeholders:

| Placeholder | Replace With | Location |
|---|---|---|
| `YOUR_N8N_WEBHOOK_URL` | Your n8n production webhook URL | `CONFIG.n8nWebhookUrl` |
| `YOUR_GOOGLE_CLIENT_ID` | GCP OAuth Client ID (ends in `.apps.googleusercontent.com`) | `CONFIG.googleClientId` |

### B. Hosting Options
This is a single static HTML file. Host anywhere:
- **GitHub Pages** — Free, push to repo
- **Netlify / Vercel** — Free tier, drag-and-drop deploy
- **Azure Static Web Apps** — Since you have Azure access
- **Firebase Hosting** — Since you're on GCP

### C. Production Checklist
- [ ] Both config values replaced
- [ ] CORS configured on n8n for your domain
- [ ] OAuth consent screen submitted for verification
- [ ] Test with 1, 5, and 15 images
- [ ] Test error reporting (temporarily break webhook URL)
- [ ] Test Google Docs export flow

---

## Step 4: n8n Node-by-Node Breakdown

### Node 1: Webhook Trigger
- **Path:** `/d2d-convert`
- **Method:** POST
- **Response Mode:** "Respond to Webhook" via last node
- Receives JSON with `{ type, images: [{ index, base64 }] }`

### Node 2: Route Request (IF)
- Routes `type === "convert"` → Gemini pipeline (True branch)
- Routes `type === "error_report"` → Error email pipeline (False branch)

### Node 3: Build Gemini Payload (Code)
- Constructs the multimodal request body
- Each image becomes an `inline_data` part with mime_type `image/jpeg`
- Appends the master transcription prompt
- Sets temperature=0.2 for faithful transcription

### Node 4: Call Gemini API (HTTP Request)
- URL: `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${GEMINI_API_KEY}`
- Method: POST
- Timeout: 120 seconds (critical for 15 images)
- Sends the constructed payload as JSON body

### Node 5: Extract Text (Code)
- Navigates the Gemini response structure
- Handles both wrapped (`body.candidates`) and direct (`candidates`) response formats
- Returns `{ text: "..." }` which the webhook sends back to the browser

### Node 6–8: Error Email Pipeline
- Formats frontend error reports into HTML emails
- Sends via Gmail to `jay-leigh.v@conversionscience.co.za`

### Node 9–10: Workflow Error Catcher
- **Error Trigger** catches any unhandled n8n node failures
- Formats the error with workflow name, failing node, and full stack trace
- Sends via Gmail to the dev email

---

## Key Design Decisions

### Sequential Compression (Not Parallel)
```
❌  Promise.all(images.map(compress))   — can crash mobile browsers
✅  for (const img of images) await compress(img)  — safe, shows progress
```
Processing images one-by-one prevents memory spikes on older devices and allows per-image progress updates.

### Client-Side Google OAuth (Not n8n)
- The user's Google token never touches n8n servers
- Docs are created directly in the user's Drive
- No need to manage refresh tokens server-side
- Reduces n8n's attack surface

### Single Webhook, Dual Purpose
The same webhook URL handles both conversion requests and error reports, routed by the `type` field. This keeps the frontend config simple (one URL).

### Gemini Prompt Design
- Temperature 0.2: Low creativity, high fidelity to source material
- Safety settings disabled: Handwritten notes may contain anything; we don't want false blocks
- maxOutputTokens 8192: Sufficient for ~15 handwritten pages
- Explicit instruction to NOT add commentary or summaries

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Webhook times out | Gemini processing > 60s | Set `N8N_DEFAULT_TIMEOUT=120000` |
| CORS errors in console | Missing CORS headers on n8n | Add `Access-Control-Allow-Origin` |
| Google OAuth popup blocked | Browser blocking popup | User must allow popups for your domain |
| Empty text returned | Unclear handwriting / bad images | Prompt user to upload clearer photos |
| 413 Payload Too Large | Images not compressed enough | Lower `maxSizeMB` in compression config |
| Gmail send fails | OAuth credential expired | Re-authenticate Gmail in n8n credentials |

---

## Testing Checklist

### Unit Tests
- [ ] Upload 1 image → conversion works
- [ ] Upload 15 images → compression completes, conversion works
- [ ] Upload 16+ images → properly blocked at 15
- [ ] Drag to reorder → indices update correctly
- [ ] Remove single image → grid re-renders
- [ ] Clear All → full reset

### Integration Tests
- [ ] n8n webhook receives payload correctly
- [ ] Gemini returns valid transcription
- [ ] Error report emails arrive at dev inbox
- [ ] Workflow errors trigger error email

### Export Tests
- [ ] Copy → text in clipboard
- [ ] Download → .txt file downloads with correct content
- [ ] Google Docs → OAuth popup → doc created → opens in new tab

### Edge Cases
- [ ] Very dark/blurry image → graceful error message
- [ ] Network disconnect during processing → error state shown
- [ ] Google OAuth cancelled → user-friendly message
- [ ] n8n down → timeout → error reported to dev
