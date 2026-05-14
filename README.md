# Memoir

Your private photo and video journal. Stored entirely in GitHub. Zero cost.

---

## How It Works

- **The app** lives in this repo, hosted free on GitHub Pages
- **Your photos, videos, and music** live in your own private `memoir-data` repo
- Nothing passes through any server — it's just your browser talking to GitHub's API

---

## Setup (One Time)

### Step 1 — Fork or clone this repo

Push it to your GitHub account under any name (e.g. `memoir-app`).

### Step 2 — Enable GitHub Pages

Go to your repo **Settings → Pages → Source → GitHub Actions**.

Push to `main` — the deploy workflow runs automatically. Your app is now live at:
```
https://{your-username}.github.io/{repo-name}/
```

### Step 3 — Create your data repo

Create a **private** repo called `memoir-data` on GitHub (or any name you like).
Don't add any files — the app will initialize it on first login.

### Step 4 — Create a Personal Access Token

Go to: **GitHub → Settings → Developer Settings → Personal Access Tokens → Tokens (classic)**

Click **Generate new token (classic)** with these settings:
- **Note:** Memoir
- **Expiration:** No expiration
- **Scopes:** ✅ `repo` (full repo access)

Copy the token — you only see it once.

### Step 5 — Open the app and connect

Open your GitHub Pages URL in Safari (iOS) or Chrome (Android).

Enter:
- Your GitHub username
- Your data repo name (e.g. `memoir-data`)
- Your Personal Access Token
- Your email (for error alerts)

Tap **Connect**. The app initializes your repo structure automatically.

### Step 6 — Install on your phone

**iOS:** Tap the Share button → "Add to Home Screen"

**Android:** Chrome will show an install banner automatically

---

## Email Error Alerts Setup (Optional but Recommended)

The app logs errors to `logs/errors.json` in your data repo.
A GitHub Action emails you automatically when this happens.

To enable:

1. Go to your `memoir-data` repo → **Settings → Secrets and variables → Actions**
2. Add these two secrets:
   - `GMAIL_USER` — your Gmail address
   - `GMAIL_APP_PASSWORD` — a Gmail App Password (not your regular password)

To create a Gmail App Password:
- Go to your Google Account → Security → 2-Step Verification → App Passwords
- Create one named "Memoir"
- Paste it as `GMAIL_APP_PASSWORD`

---

## Adding Music

**Option A — In-app (from phone):**
Tap the ♫ tab → + → select an mp3/m4a file from your Files app.

**Option B — Direct GitHub upload:**
Upload mp3 files directly to the `music/` folder in your `memoir-data` repo.
Then in the app: Settings → Sync Music Library.

Recommended max file size: under 10MB per song (a typical 4-min mp3 at 192kbps is ~5MB).

---

## Adding New Users

Each person:
1. Creates their own private `memoir-data` repo
2. Creates their own Personal Access Token
3. Opens the same app URL and connects with their own credentials

Their data is completely isolated in their own repo. You have no access to it.

---

## Repo Structure (Your memoir-data)

```
memoir-data/
  posts/
    2026-05-14-ab3f/
      meta.json
      media_1.jpg
      media_2.jpg
      song.mp3
  posts-index.json
  music/
    music-index.json
    mixtape-oh.mp3
  logs/
    errors.json
    archive/
      2026-05.json
  profile.json
  .github/
    workflows/
      email-errors.yml
      cleanup-logs.yml
    scripts/
      cleanup_logs.py
```

---

## Limits

| Thing | Limit |
|---|---|
| File size per upload | 25 MB (GitHub API limit) |
| Repo size | 1 GB soft limit |
| API calls | 5,000 / hour (more than enough) |
| Users | Unlimited (each has their own repo) |

---

## Privacy

- Your data repo is **private** — only accessible with your PAT
- Your PAT is stored encrypted in your browser's localStorage
- It is only ever sent to `api.github.com` over HTTPS
- Memoir's app repo is public (just HTML/JS) but contains no personal data

---

## Tech Stack

| Layer | What |
|---|---|
| Frontend | Vanilla HTML/CSS/JS — no framework, no build step |
| Storage | GitHub Contents API (private repo) |
| Hosting | GitHub Pages (free) |
| Auth | GitHub Personal Access Token (encrypted in localStorage) |
| Email alerts | GitHub Actions + Gmail SMTP |
| Log cleanup | GitHub Actions cron |
| Media conversion | heic2any (HEIC→JPEG), ffmpeg.wasm (MOV→MP4) — in-browser |

---

Built with zero recurring cost in mind. The only thing you pay for is your internet connection.
