# DepthChart Sync — Apps Script web app

This folder contains a **brand new, standalone Apps Script** that the web
app calls to write edits back to the spreadsheet. It is **not** bound to the
spreadsheet, and it does not touch any existing Apps Script files
(`_app.gs`, `_handler.gs`, `_publish.gs`, etc.) on the bound project.

It exposes one POST endpoint that accepts the JSON the web app's
**Sync to sheet** button generates, diffs it against the target tab
(default: `Copy of DepthCharts`), and writes the changed manual cells.

## Deployment

This is a one-time setup per Google account.

1. Go to <https://script.google.com> → **New project**.
2. Rename the project to something memorable, e.g. **"DepthChart Sync"**.
3. Delete the default `function myFunction() {}` in `Code.gs`.
4. Open `sync.gs` from this folder, copy its entire contents, paste into
   `Code.gs`, save (Ctrl+S).
5. (Optional) Edit `EDITOR_ALLOWLIST` at the top to lock the endpoint down
   to specific Google accounts. Leave empty to allow any signed-in user.
6. **Deploy → New deployment**:
   - Click the gear icon → choose **Web app**.
   - **Description:** "DepthChart sync v1"
   - **Execute as:** *Me* (so the script runs with your access to the workbook)
   - **Who has access:** *Anyone with Google account*
     (or *Anyone within \<workspace\>* if you have a Workspace org and want
     to restrict to it)
   - Click **Deploy**.
7. The first deploy prompts for OAuth consent — review and **Allow**. You
   may see a "Google hasn't verified this app" screen; click **Advanced →
   Go to (project) (unsafe)**. (It's your own script under your account;
   the warning is just because it isn't published in the Marketplace.)
8. Copy the **Web app URL**. It will look like:
   ```
   https://script.google.com/macros/s/AKfycbXXXXXXXXXXXXXXX.../exec
   ```

## Wire it into the web app

1. Open <https://cwecht15.github.io/NFL_Depth_Chart/>.
2. Click the **Settings** (⚙) button in the top bar.
3. Paste the Apps Script URL.
4. Save. The URL is stored only in your browser's `localStorage` — it isn't
   committed to the repo and isn't sent anywhere else.
5. Make an edit, click **Sync to sheet**, review the dry-run preview, click
   **Apply**.

## Health check

You can verify the deployment by visiting the URL in a browser (a `GET`).
You should see JSON like:

```json
{
  "ok": true,
  "service": "DepthChart sync",
  "spreadsheet_id": "1XHXiR__p7h2JVLKNkS-F9aiKZjhar78YubQklW_baQA",
  "default_target_tab": "Copy of DepthCharts",
  "time": "2026-05-13T01:23:45.678Z"
}
```

If you see Google's sign-in page instead, the deployment requires
authentication (expected with "Anyone with Google account").

## Safety rails baked in

- **Refuses to write to the live `DepthCharts` tab** unless the request
  body includes `allow_prod: true`. The web app does not send that flag by
  default.
- **Dry-run by default** — every request returns a preview unless the body
  includes `commit: true`. The web app sends two POSTs per sync (preview
  then commit) and shows the preview to you between them.
- **Only writes manual columns.** The script inspects row 4 of the target
  tab to find which columns are formula-driven and skips them. Spill
  formulas keep working.
- **No cell is overwritten with its existing value** — the script computes
  a cell-level diff and only writes cells that differ.
- **New rows append below the last existing data row.** Custom players you
  add in the web app land at the bottom of the target tab.

## Actions

Every POST body carries `action` (default `sync`) plus `id_token`. GET
supports `?action=listLocks`, `?action=listOurladsChecks`, and
`?action=whoami` (all with `&id_token=…`).

| Action | What it does | Sidecar tab |
| ------ | ------------ | ----------- |
| `sync` | Diff + (with `commit: true`) write manual cells; mirrors to `Roster_Info` | `AuditLog` |
| `snapshot` | Read the live `DepthCharts` tab for the browser's "Refresh snapshot" | — |
| `acquireLock` / `heartbeatLock` / `releaseLock` / `listLocks` / `forceReleaseLock` | Per-team edit locks | `Locks`, `AuditLog` |
| `listOurladsChecks` | Return every team's last "checked against OurLads" record | `OurladsChecks` |
| `markOurladsChecked` | Upsert `{ team, checked_at: now, checked_by: <verified caller>, ourlads_updated_at, ourlads_updated_text }`; logs `ourlads_checked` | `OurladsChecks`, `AuditLog` |

## Updating the script

If you change `sync.gs`:

1. Replace the code in your Apps Script project.
2. **Deploy → Manage deployments → (your deployment) → Edit (pencil)**.
3. Bump the version to "New version", set a description, **Deploy**.
4. The URL stays the same; the new version takes effect immediately.

## Rotating / revoking

- **Manage deployments → Archive** to retire a URL.
- Or restrict who can use it via `EDITOR_ALLOWLIST` in the script.
- Or set "Who has access" to "Only myself" if you want a personal-only URL.
