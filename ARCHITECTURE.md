# Depth Chart — architecture

> **Scope.** This document covers the whole Depth Chart system. The Pages
> site source lives in this repo (`docs/`, `tools/`, `apps_script/`,
> `.github/workflows/`); the **Streamlit app** source lives in a sibling
> local folder (`Depth_Chart/`, alongside this `pages-site/` checkout) and
> isn't pushed anywhere. The file tree below shows both for context — only
> the `pages-site/` subtree is present on GitHub.

Two front-ends edit the **2026 Depth Chart** Google Sheet without giving
editors the service-account key:

1. **Streamlit app** (local, not in this repo) — a desktop-style editor
   you run locally (`streamlit run streamlit_app.py`). Read-only against
   the sheet; edits live in your session and export as CSV/JSON.
2. **GitHub Pages site** (this repo) — a static browser editor served at
   <https://cwecht15.github.io/NFL_Depth_Chart/>. A scheduled GitHub
   Action refreshes the snapshot every 10 minutes; edits live in
   `localStorage`. Syncs back to the sheet through an Apps Script web app
   that enforces **mandatory Google sign-in**, **per-team edit locks**, and
   appends every change to an `AuditLog` tab so multiple editors can work
   the same workbook without stepping on each other.

Both front-ends read the same JSON-key schema (row-4 cell notes on the
`DepthCharts` tab) and target the same set of writable manual columns. Only
the Pages site has an opt-in write path; the Streamlit app is read-only by
design.

---

## Repository layout

```
Depth_Chart/
├── streamlit_app.py            Streamlit entrypoint
├── start-app.bat               Windows double-click launcher (py/python fallback)
├── smoke_test.py               Non-Streamlit sheet-load sanity check
├── requirements.txt            streamlit, gspread, google-auth, pandas
├── README.md                   ← you are here
├── sidecar-plan.md             Transaction watcher / sheet-hardening plan
├── web-app-plan.md             Original web-app plan (the Streamlit slice)
├── espn_test.json              Fixture from ESPN transactions API
│
├── .streamlit/
│   └── secrets.toml.example    Template for OAuth + allowlist when deployed
│
├── app/                        Streamlit app modules
│   ├── config.py               Sheet ID, scopes, MANUAL_KEYS, display order
│   ├── sheet_io.py             Read-only gspread/Sheets v4 loader
│   ├── auth.py                 Optional Google sign-in allowlist
│   ├── state.py                Session-state + edit log + diff helpers
│   └── views/
│       ├── team_editor.py      Team selector + grouped data_editor
│       └── diff_view.py        Pending edits + CSV/JSON exports
│
└── pages-site/                 GitHub Pages site (separate sub-project)
    ├── README.md               Site-specific docs
    ├── .github/workflows/
    │   ├── snapshot.yml        */10 min: pull sheet + ESPN transactions
    │   └── ourlads.yml         hourly: scrape OurLads depth charts + "Updated" stamps
    ├── docs/                   ← Pages publishes from this folder
    │   ├── index.html
    │   ├── app.js
    │   ├── styles.css
    │   ├── auth.config.json.example
    │   └── data/
    │       ├── snapshot.json
    │       ├── ourlads.json
    │       └── transactions.json
    ├── tools/
    │   ├── pull_snapshot.py    Sheet → docs/data/snapshot.json
    │   ├── pull_transactions_nflcom.py NFL.com → docs/data/transactions.json
    │   ├── pull_transactions.py ESPN API (legacy; kept for offline reference)
    │   ├── pull_ourlads.py     Scrape → docs/data/ourlads.json
    │   ├── sync_to_sheet.py    Local writer (CLI; dry-run by default)
    │   └── requirements.txt
    └── apps_script/
        ├── README.md           Apps Script web-app deployment steps
        └── sync.gs             Standalone web app the site POSTs to
```

---

## Architecture at a glance

```
   ┌──────────────────────────┐
   │  2026 Depth Chart Sheet  │  authoritative source of truth
   │  (Google Sheets)         │
   └──────────────┬───────────┘
                  │ read-only (fp-data service account)
                  │
        ┌─────────┴──────────────────────────────────────────┐
        │                                                    │
        ▼                                                    ▼
┌───────────────────┐                       ┌──────────────────────────────┐
│ Streamlit app     │                       │ GitHub Action (every 10 min) │
│ (local, this dir) │                       │ tools/pull_snapshot.py       │
│                   │                       │ tools/pull_transactions.py   │
│ session-only      │                       └────────────┬─────────────────┘
│ edits → CSV/JSON  │                                    │
└───────────────────┘                                    ▼
                                          ┌──────────────────────────────┐
                                          │ docs/data/snapshot.json      │
                                          │ docs/data/transactions.json  │
                                          │ docs/data/ourlads.json (cron)│
                                          └────────────┬─────────────────┘
                                                       │ static fetch
                                                       ▼
                                          ┌──────────────────────────────┐
                                          │ GitHub Pages site            │
                                          │ docs/index.html + app.js     │
                                          │ edits → localStorage         │
                                          └────────────┬─────────────────┘
                                                       │ optional sync
                                                       ▼
                          ┌──────────────────────────────────────────────┐
                          │ Write-back (opt-in, two paths)               │
                          │                                              │
                          │  A. Browser → Apps Script web app (sync.gs)  │
                          │     "Sync to sheet" button; preview + apply  │
                          │                                              │
                          │  B. Browser → sync_export.json → CLI         │
                          │     tools/sync_to_sheet.py (dry-run by       │
                          │     default; --commit to write)              │
                          │                                              │
                          │  Both default to the "Copy of DepthCharts"   │
                          │  tab; live "DepthCharts" requires explicit   │
                          │  opt-in.                                     │
                          └──────────────────────────────────────────────┘
```

### Shared data model

Both front-ends key off the same conventions baked into the spreadsheet:

- **Row 3** of `DepthCharts` is the human-readable header.
- **Row 4** carries *cell notes* that name the JSON key for each column.
  This is the canonical column-to-key map; the visible values in row 4 are
  formula output and not used.
- **Row 5+** is data. A row is only treated as real if column G
  (`eliasId`) is non-empty — this filters out the trailing phantom rows
  produced by `ARRAYFORMULA(ROW(...))` in column AR.
- The set of **manual / editable** columns is defined in
  `app/config.py` (`MANUAL_KEYS`) and mirrored in `pages-site/docs/app.js`
  (`MANUAL_KEYS`), `pages-site/tools/sync_to_sheet.py`, and
  `pages-site/apps_script/sync.gs`. Everything else is formula-driven and
  must stay read-only.
- Depth rows are grouped by `depthPositionCategory` (`OFF`, `DEF`, `ST`,
  `IR`, `SUS`, `PS`) and then by `depthPosition`.
- Placeholder IDs match `^ROOKIE\d{3}$` and are visibly flagged so they
  can be reconciled with the NFL feed once a real ID exists.

### Credentials

A single Google service account, `fp-data@fp-data-357113.iam.gserviceaccount.com`,
has read access to the spreadsheet. The key never reaches the browser:

- **Streamlit app**: reads the key file from disk via `FP_DATA_KEY_PATH`
  (default `C:/Users/cwech/Documents/Football/Keys/fp-data-357113-a6174bb87054.json`).
- **GitHub Action**: reads the JSON contents from the `FP_DATA_KEY_JSON`
  repo secret (`gh secret list -R cwecht15/NFL_Depth_Chart`).
- **`sync_to_sheet.py`** (local writer): uses the same key file as the
  Streamlit app but with writable scopes (`spreadsheets`, `drive`).
- **Apps Script web app**: runs under the deployer's own Google identity
  ("Execute as: Me"), so no key is needed — it inherits the deployer's
  access to the workbook.

---

## Quick start — Streamlit app

```bash
# 1. Install deps
pip install -r requirements.txt

# 2. Service account key in place (default location)
#    Override:  set FP_DATA_KEY_PATH=C:\path\to\key.json   (Windows)
#               export FP_DATA_KEY_PATH=/path/to/key.json  (mac/linux)

# 3. Optional sanity check (no Streamlit, just pulls the four tabs)
python smoke_test.py

# 4. Run it
streamlit run streamlit_app.py
#    → http://localhost:8501
```

On Windows you can also double-click `start-app.bat`.

**Pages in the app**

| Page          | What it does                                                                 |
| ------------- | ---------------------------------------------------------------------------- |
| Team Editor   | Pick a team → tabs for each category → `st.data_editor` grids per position. Edits are applied to the in-memory working copy and logged. |
| Diff & Export | Cell-level diff of session edits vs. the loaded sheet state. Download the full edited CSV, a diff/log JSON, or the untouched baseline CSV. |
| About         | What works, what's stubbed, links to the plan docs.                          |

**Session state contract** (see `app/state.py`):

- `depth`, `rosters`, `options`, `idmap` — loaded once on first request.
- `baseline_df` — the unmodified DataFrame straight from the sheet.
- `edited_df` — working copy; `apply_row_updates` merges edits in.
- `edit_log` — list of `{sheet_row, column, before, after, ts, who}`.
- "Refresh from sheet" = full re-load (drops all in-memory edits).
- "Discard in-memory edits" = reset `edited_df` to `baseline_df`.

**Auth**

Off by default. To enable Google sign-in + allowlist (for example on
Streamlit Community Cloud), copy `.streamlit/secrets.toml.example` to
`.streamlit/secrets.toml` and set:

```toml
[auth]
enabled = true
allowlist = ["alice@example.com", "bob@example.com"]
```

When deploying to Streamlit Cloud you'll also need to paste the
service-account JSON into a `[gcp_service_account]` block and rework
`_sheets_client` in `app/sheet_io.py` to read from `st.secrets` — a TODO
marker is in place.

**Reaffirming the no-write guarantee**

- Service-account scopes are `spreadsheets.readonly` + `drive.readonly`
  in `app/config.py`.
- A repo grep for write verbs should turn up zero hits in the Streamlit
  app:

  ```bash
  grep -RIn "batchUpdate\|update_cells\|update_acell\|insert_row\|delete_row\|append_row\|setValues" app/ streamlit_app.py
  # → no matches
  ```

---

## Quick start — Pages site

See `pages-site/README.md` for the full setup. Short version:

```bash
cd pages-site

# Install Python deps (for local snapshot work)
pip install -r tools/requirements.txt

# Pull a local snapshot (uses FP_DATA_KEY_PATH)
python tools/pull_snapshot.py
# → writes docs/data/snapshot.json

# Serve docs/ with any static server
cd docs && python -m http.server 8000
# → http://localhost:8000
```

Production URL: <https://cwecht15.github.io/NFL_Depth_Chart/>. The
`Pull DepthChart Snapshot` workflow refreshes the snapshot every 10
minutes; `Scrape OurLads` refreshes the OurLads scrape (depth charts plus
each page's "Updated" stamp) hourly at :07 UTC.

---

## Write-back paths

Both write-back paths default to the **`Copy of DepthCharts`** tab and
refuse to touch the live **`DepthCharts`** tab without an explicit
override.

| Path | Trigger | Where credentials live | Safety rails |
| ---- | ------- | ---------------------- | ------------ |
| Apps Script web app (`pages-site/apps_script/sync.gs`) | "Sync to sheet" button in the browser → POST to the deployer's web-app URL stored in `localStorage` | None in the browser; the script runs as the Google account that deployed it | Dry-run preview before commit; live tab gated by `allow_prod`; only writes JSON keys in `MANUAL_KEYS`; skips columns whose row-4 cell has a `formulaValue`; cell-level diff (no redundant writes); new rows append below `last_data_row`; refuses sync unless caller holds a `Locks` row for every team in the diff (FA exempt); each change recorded to `AuditLog` with `Session.getActiveUser().getEmail()` as the verified `actor_email` |
| CLI writer (`pages-site/tools/sync_to_sheet.py`) | Browser → "Download sync JSON" → `python tools/sync_to_sheet.py sync_export.json --commit --allow-bypass-locks` | `FP_DATA_KEY_PATH` on the operator's machine, with writable scopes | Same diff/append/manual-key/formula-skip logic; `--commit` requires both `--allow-bypass-locks` (because it skips the team-lock check) and (for the live tab) `--allow-prod`; every change is still appended to `AuditLog` as `cli_bypass` / `cli_bypass_append` so out-of-band writes are traceable |

Both paths produce the same diff semantics so they're swappable. The
browser path is the daily driver; the CLI is a fallback when the Apps
Script deployment isn't available or when an operator wants to inspect a
larger dry-run.

### Row-identity (staleness) gate

Every row is keyed by its **sheet row number** (`_sheet_row`), and the
browser sends *all* rows on every sync. That only holds together if nobody
inserts or deletes rows in `DepthCharts` while an editor session is open —
which is exactly what happened on 2026-08-29 (48 duplicate/cut rows deleted
by hand in the sheet shifted every row below by up to 48; a teammate's PIT
drop then diffed as "changes" on 27 teams and was refused by the lock gate).

Both write paths now verify identity before diffing:

- The browser attaches `_identity` (`gsisId`, `nflId`, `eliasId`,
  `displayName` **as loaded** — the baseline, so in-session edits to those
  fields don't trip it) to every real row in the payload.
- `sync.gs` `_computeDiff` / CLI `compute_diff` compare that against the row
  currently at that sheet row. Any one agreeing non-empty field passes; a row
  that disagrees on all of them, or whose row number is now blank / past the
  end of the tab, is **stale**. One stale row refuses the whole sync
  (`error: "stale_snapshot"`, CLI exit 2) — nothing is written and nothing is
  appended. (Previously a real row number missing from the tab was silently
  *appended*, i.e. duplicated.)
- Rows the browser added itself (virtual ids ≥ 100000) are exempt and are
  appended as before.

Client-side, each edit-log entry carries the same baseline identity
(`ident`). `applyEditsToRows()` — run on page load, on Refresh, and now
automatically **before every Sync dry-run** (the sync pulls a live snapshot
first) — discards any edit whose row no longer holds that player and toasts
the discarded names. It also rebuilds virtual rows from their edit log so a
refresh no longer drops a newly added player.

Operationally: **don't insert/delete rows in `DepthCharts` while anyone has
the editor open.** Drop players through the editor (team → FA), which keeps
row numbers stable. If a re-row is unavoidable, editors should Refresh and
redo pending edits afterwards.

## Multi-user safeguards

Three sidecar tabs persist shared state on the same workbook:

- **`Locks`** — one row per actively-edited team. Columns:
  `team | owner_email | acquired_at | last_heartbeat_at`. FA is never
  locked. Locks expire after **30 min** of no heartbeat
  (`LOCK_TTL_SECONDS` in `sync.gs`); past the TTL a peer can take the
  lock and the takeover is recorded as `lock_stolen` in `AuditLog`.
- **`AuditLog`** — append-only history. Columns:
  `ts | actor_email | action | team | sheet_row | column | before | after | details`.
  Actions: `edit`, `append`, `lock_acquired`, `lock_released`,
  `lock_stolen`, `lock_acquired_after_steal`, `force_release`,
  `ourlads_checked`, and `cli_bypass` / `cli_bypass_append`. The
  browser-sent `payload.editor` is informational only — `actor_email`
  always comes from `Session.getActiveUser().getEmail()` on the server.
- **`OurladsChecks`** — one row per team, upserted in place. Columns:
  `team | checked_at | checked_by | ourlads_updated_at | ourlads_updated_text`.
  Written by `markOurladsChecked`, read by `listOurladsChecks`. Records
  when one of our editors last reviewed a team against OurLads and which
  OurLads "Updated" stamp they saw. Marking does not require the team's
  edit lock. See "OurLads update tracker" below.

The browser side:

- Polls `?action=listLocks` every 30 s and renders other users' holds
  inline in the team dropdown (`DAL  🔒 alice@example.com`, disabled).
- Sends `heartbeatLock` every 2 min while a lock is held.
- Acquires on team-select change (and via an explicit "Lock team" button
  if you want to lock the team you're already viewing) and releases on
  the "Release lock" button or sign-out.
- Blocks edits in `recordEdit()` / `onAddPlayer()` / `onAddCustomPlayer()`
  unless the user holds the lock for `row.team` (or the row is FA).
- Shows a stale-snapshot banner if `snapshot.json.generated_at` is older
  than 20 min and warns on `beforeunload` if you have unsynced edits with
  a lock still held.

---

## Data sources (auxiliary)

Beyond the workbook itself, the Pages site renders warnings from two
external feeds:

- **NFL transactions** — `pages-site/tools/pull_transactions_nflcom.py`
  scrapes NFL.com's six per-category transaction pages
  (`signings`/`waivers`/`terminations`/`trades`/`reserve-list`/`other`)
  for the current and prior two months, emits one row per player per
  transaction, and writes `docs/data/transactions.json`. Preferred over
  the workbook's stale `Transactions_New` tab. The older
  `pull_transactions.py` (ESPN public API) is kept in the tree as an
  offline reference but is no longer wired to the workflow — ESPN's feed
  bundles multi-player team-day sentences that produced noisy warnings.
- **OurLads depth charts** — `pages-site/tools/pull_ourlads.py` scrapes
  `https://www.ourlads.com/nfldepthcharts/depthchart/<TEAM>` hourly,
  parses the visible table into one record per
  `(player, depth_position, depth_order)` under `teams[abbr]`, captures
  each page's `Updated: MM/DD/YYYY H:MMPM ET` stamp under
  `updates[abbr] = { text, iso }` (ET parsed to UTC; `iso` is `null` if
  the text ever stops parsing), and writes `docs/data/ourlads.json`. The
  scraper is polite (1.5 s between requests, real UA) and refuses to
  overwrite the existing file if every team scraped to zero players.

The frontend in `pages-site/docs/app.js` cross-references both feeds
against the loaded snapshot and surfaces flags in the right-hand
"External-source warnings" drawer. None of those flags mutate the depth
chart automatically — they're hints for the editor.

### OurLads update tracker

The **OL** top-bar button opens a second drawer that turns the `updates`
stamps into a review checklist:

```
ourlads.json.updates[team].iso   (OurLads' own "Updated" time, hourly scrape)
          vs.
OurladsChecks[team].checked_at   (when one of us last clicked "Mark checked")
```

`olTeamStatus()` in `app.js` yields `recheck` (never checked, or OurLads'
stamp is newer than our check), `checked` (reviewed since — an exact
`ourlads_updated_at` match short-circuits the clock comparison so skew
can't misflag), or `unknown` (checked, but no parseable stamp to compare
against). Amber rows + the badge count are the `recheck` set. The drawer
fetches `?action=listOurladsChecks` on open (cached 60 s) and posts
`markOurladsChecked` per click; `checked_by` is the verified caller
identity, never a body field.

---

## Development notes

- **Both ETL scripts share the same row-3 / row-4 / row-5 convention.**
  If you ever rename a column note in the sheet, every consumer
  re-derives the column index from the JSON key, so nothing in code
  needs to change.
- **The Streamlit `MANUAL_KEYS` (`app/config.py`) and the Pages
  `MANUAL_KEYS` (`docs/app.js`, `tools/sync_to_sheet.py`,
  `apps_script/sync.gs`) should match.** They've intentionally diverged
  on a few keys (`firstName`, `lastName`, `footballName`, `position` are
  in the Pages set but not in the Streamlit set) because the Pages site
  ships a richer "add custom player" form. If you add a new editable
  field, update all four lists.
- **Required-column filter.** Both `app/sheet_io.py` and
  `pages-site/tools/pull_snapshot.py` drop rows whose `eliasId` is
  empty, mirroring the `requiredCol: 6` filter in `sheet2json`. Don't
  remove this — the `ARRAYFORMULA(ROW(...))` spill in column AR creates
  ~280 trailing phantom rows otherwise.
- **`espn_test.json`** is a captured fixture from the ESPN transactions
  endpoint, kept around for offline parser tuning of
  `pull_transactions.py`. It isn't loaded at runtime.

---

## Plans / longer-term docs

- `web-app-plan.md` — the original full web-app plan; the Streamlit
  slice in this repo is its first deliverable.
- `sidecar-plan.md` — the transaction-watcher / sheet-hardening track
  (some of which has already landed in `tools/pull_transactions.py`).
- `pages-site/README.md` — Pages-specific setup, sync flow, no-write
  verification.
- `pages-site/apps_script/README.md` — step-by-step Apps Script web-app
  deployment.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| ------- | ------------ | --- |
| `Service account key not found at …` | `FP_DATA_KEY_PATH` not set or key missing | Place the JSON at the default path or `set FP_DATA_KEY_PATH=…` |
| Snapshot workflow keeps committing identical files | Should be a no-op when nothing changed — check the `git diff --staged --quiet` step | Inspect the workflow run; usually means a downstream-only column changed |
| Pages site shows "snapshot age: hours" | GitHub Pages caches; the cron is fine but Pages took its time to redeploy | Trigger `gh workflow run "Pull DepthChart Snapshot"` and wait ~1 min |
| `Sync to sheet` button does nothing | Apps Script URL not configured | Settings (⚙) → paste the web-app URL → Save |
| `sync_to_sheet.py` refuses to run against `DepthCharts` | Live tab is gated | Re-run with `--allow-prod --commit` only after a successful dry-run |
| OurLads workflow exit code 2 | All scrapes returned 0 players | Open the workflow log; usually OurLads changed their table markup |
| OurLads tracker shows "0 team stamps" / every "OurLads updated" cell is `—` | `ourlads.json` predates stamp capture, or OurLads renamed the `ctl00_phContent_DateUpd` div | Wait for the next hourly run; if `failures` lists "no 'Updated:' stamp", update `UPDATED_DIV_ID` in `tools/pull_ourlads.py` |
| Tracker says "Check log: … not_authorized" / "sign_in_required" | Apps Script not redeployed with the `OurladsChecks` actions, or caller not on `EDITOR_ALLOWLIST` | Redeploy `sync.gs` as a new version; check the allowlist |

- **"Sync refused — the sheet's rows have moved since you loaded"**
  (`stale_snapshot`): rows were inserted/deleted in `DepthCharts` after your
  browser loaded. Click Refresh (edits whose rows moved are discarded with a
  toast), then redo those edits and sync again. See "Row-identity
  (staleness) gate" above.
- **"Sync refused — teams not locked by you: <long list>"** on an edit to a
  single team: on an Apps Script deployment older than the staleness gate,
  this is the symptom of the same row shift. Redeploy `sync.gs`.
