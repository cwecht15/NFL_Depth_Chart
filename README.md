# Depth Chart Editor — Cloudflare Pages + R2

A static depth-chart editor. Stack:

- **Cloudflare Pages** hosts the static frontend (HTML + vanilla JS).
- **Cloudflare R2** holds the live `snapshot.json` — refreshed by a GitHub
  Action as often as you want (default: every 10 minutes).
- **GitHub Action** runs the snapshot puller against the live Google Sheet
  via the `fp-data` service account and uploads the result to R2.

Editing in the browser is purely in-memory (`localStorage`). The Google
Sheet is read-only from this stack's perspective; edits get exported as
CSV/JSON.

```
pages-site/
├── docs/                        <- Cloudflare Pages build output dir
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── runtime.config.json.example   -> copy to runtime.config.json
│   └── auth.config.json.example      -> copy to auth.config.json
├── tools/
│   ├── pull_snapshot.py         <- reads Sheet, uploads to R2
│   └── requirements.txt
├── .github/workflows/snapshot.yml
└── .gitignore
```

---

## One-time setup

### 1. Cloudflare account
Sign in to <https://dash.cloudflare.com>. The free plan covers everything
below.

### 2. Create the R2 bucket

1. Cloudflare dashboard → **R2** → **Create bucket**.
2. Name: `nfl-depth-chart` (any name works; you'll wire it in below).
3. Default settings; no need for location hint.
4. Open the bucket → **Settings** → **Public access** → "Allow Access".
   Cloudflare gives you a public URL like
   `https://pub-<HASH>.r2.dev`.

This public URL is how the frontend reads `snapshot.json`. Anyone with the
URL can read it — so this is your data-access boundary.

### 3. Get R2 API credentials

1. R2 → **Manage R2 API Tokens** → **Create API Token**.
2. Permissions: **Object Read & Write**, restricted to this bucket.
3. Save:
   - **Access Key ID**
   - **Secret Access Key**
   - **Account ID** (visible top-right of R2 dashboard)

### 4. Add the GitHub Actions secrets

In your repo (Settings → Secrets and variables → Actions) add:

| Name | Value |
|---|---|
| `FP_DATA_KEY_JSON` | Full JSON of the fp-data service-account key (already set if you ran the earlier setup) |
| `R2_ACCOUNT_ID` | Cloudflare account ID |
| `R2_ACCESS_KEY_ID` | from step 3 |
| `R2_SECRET_ACCESS_KEY` | from step 3 |
| `R2_BUCKET` | bucket name (e.g., `nfl-depth-chart`) |

Or from the CLI:
```bash
gh secret set R2_ACCOUNT_ID         -R cwecht15/NFL_Depth_Chart
gh secret set R2_ACCESS_KEY_ID      -R cwecht15/NFL_Depth_Chart
gh secret set R2_SECRET_ACCESS_KEY  -R cwecht15/NFL_Depth_Chart
gh secret set R2_BUCKET             -R cwecht15/NFL_Depth_Chart
```

### 5. Configure CORS on the R2 bucket

The frontend (served from Cloudflare Pages) needs to be allowed to fetch
from the R2 bucket.

R2 bucket → **Settings** → **CORS Policy** → paste:

```json
[
  {
    "AllowedOrigins": ["*"],
    "AllowedMethods": ["GET", "HEAD"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

(Tighten `AllowedOrigins` to your Pages domain later once you know it.)

### 6. Seed the first snapshot

Trigger the workflow once manually so R2 has a `snapshot.json` to serve:

Repo → **Actions** → "Pull DepthChart Snapshot" → **Run workflow** on `main`.

Watch the run; the last log line should say
`Uploaded to R2 bucket <name>/snapshot.json (~3000 KB)`.

Verify in the browser:
```
https://pub-<HASH>.r2.dev/snapshot.json
```
should serve the JSON.

### 7. Set up Cloudflare Pages

1. Cloudflare dashboard → **Workers & Pages** → **Create application** →
   **Pages** → **Connect to Git**.
2. Authenticate Cloudflare's GitHub app and grant access to
   `cwecht15/NFL_Depth_Chart` (private repo is fine — no Pro tier needed).
3. Project name: `nfl-depth-chart` (becomes your `*.pages.dev` subdomain).
4. Production branch: `main`.
5. Build settings:
   - **Framework preset**: None
   - **Build command**: (leave empty)
   - **Build output directory**: `docs`
6. Click **Save and Deploy**. First deploy takes ~30 seconds.

Your site is live at `https://nfl-depth-chart.pages.dev`.

### 8. Tell the frontend where to find the snapshot

In your local checkout:

```bash
cp docs/runtime.config.json.example docs/runtime.config.json
# Edit docs/runtime.config.json: set snapshot_url to the R2 public URL,
# e.g.,  "https://pub-1234abcd5678.r2.dev/snapshot.json"
git add docs/runtime.config.json
git commit -m "Add runtime config pointing at R2 bucket"
git push
```

Cloudflare Pages auto-redeploys on push. Within ~30 seconds the live site
will start fetching from R2.

### 9. (Optional) Turn on Google sign-in

In GCP Console:
- APIs & Services → **Credentials** → **Create credentials** →
  **OAuth Client ID** → Web application.
- Authorized JavaScript origins: `https://nfl-depth-chart.pages.dev`
  (plus any custom domain).

Copy the resulting client ID. Locally:
```bash
cp docs/auth.config.json.example docs/auth.config.json
# Fill in client_id and the editor allowlist.
git add docs/auth.config.json
git commit -m "Enable Google sign-in"
git push
```

Without `auth.config.json`, the site loads with no sign-in gate. Useful
for dev / preview deploys.

---

## Local development

```bash
# 1. Install Python deps
pip install -r tools/requirements.txt

# 2. Pull a local snapshot (no R2 upload because R2_* env vars aren't set)
python tools/pull_snapshot.py
# -> writes docs/data/snapshot.json

# 3. Serve docs/ with any static server
cd docs && python -m http.server 8000
# -> http://localhost:8000
```

If `docs/runtime.config.json` is absent locally, the app falls back to
`./data/snapshot.json` automatically.

---

## What it does

- Reads the live snapshot from R2 (or `./data/snapshot.json` locally).
- Team selector + category tabs (OFF/DEF/ST/IR/SUS/PS) + tables grouped by
  `depthPosition`.
- Inline cell editing for the manual columns; read-only formula columns are
  visible but disabled.
- "Add a player" with `Rosters`-backed autocomplete.
- Edits persist to `localStorage`; "Discard edits" clears them.
- Two export buttons: full edited CSV, diff/log JSON.
- Placeholder IDs (`ROOKIE###`) are visibly flagged.

## What it does NOT do

- Write back to the Google Sheet. The fp-data service-account scopes are
  read-only (`spreadsheets.readonly`, `drive.readonly`). The key never
  reaches the browser; only the GitHub Action sees it.
- Realtime collaborative editing — `localStorage` is per-browser. Two
  editors each download their own diff and a human reconciles.
