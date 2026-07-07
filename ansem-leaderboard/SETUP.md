# $ANSEM Leaderboard — Setup

No installs, no terminal. Everything happens in your browser.

## 1. Get your X API token
- Go to **developer.x.com**, sign in, load ~$10–20 of credits, and set a monthly spending limit.
- Create a Project → App → open **Keys and tokens** → copy the **Bearer Token**.

## 2. Put these files on GitHub
- On github.com: **+ → New repository**, name it `ansem-leaderboard`, set **Public**, create.
- Click **uploading an existing file** and drag in this whole folder's contents.
  (The `.github/workflows/scan.yml` file must keep its folder path — dragging the
  folder in preserves it. If GitHub flattens it, use **Add file → Create new file**
  and type the path `.github/workflows/scan.yml` manually, then paste that file's contents.)
- Commit.

## 3. Add your token as a secret
- In the repo: **Settings → Secrets and variables → Actions → New repository secret**.
- Name: `X_BEARER_TOKEN` — Value: paste your Bearer Token — **Add secret**.
- (This keeps the token private. It never appears in your code.)

## 4. Run it
- **Actions** tab → **Scan $ANSEM** → **Run workflow**.
- ~30 seconds later it turns green and builds `index.html` in your repo.
- After that it runs itself **every Monday** automatically.

## 5. Publish it
- In Netlify, use **Import from Git** and connect this repo.
- Every scan then auto-updates the live page. Nothing manual after this.

---

**Cost:** the weekly auto-run scans 3 pages (~$1.50). When you click "Run workflow"
manually, you can type a bigger page number for a deeper scan.

**Preview without an API token:** not possible on GitHub (it needs the real token),
but the mock preview you already saw shows exactly what the page looks like.

**Files in this folder:**
- `scanner.js` — the scanner (runs in the cloud, you don't touch it)
- `template.html` — the page design the scanner fills in
- `.github/workflows/scan.yml` — tells GitHub to run the scanner weekly
