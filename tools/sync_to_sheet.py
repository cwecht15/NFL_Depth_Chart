"""Push web-app edits into a sheet tab.

Reads ``sync_export.json`` (downloaded from the web app) and writes the
manual-column cells into a target tab in the Google Sheet. **Defaults to
dry-run**; pass ``--commit`` to actually write. **Refuses to touch the live
``DepthCharts`` tab** unless ``--allow-prod`` is set.

The web app cannot hold the service-account key, so this script runs locally
with your fp-data credentials.

Usage::

    # Preview what would change (no writes):
    python tools/sync_to_sheet.py sync_export.json

    # Actually write to "Copy of DepthCharts":
    python tools/sync_to_sheet.py sync_export.json --commit

    # Pick a different target tab:
    python tools/sync_to_sheet.py sync_export.json --tab "My Test Tab" --commit

    # Write to the live DepthCharts (deliberately gated):
    python tools/sync_to_sheet.py sync_export.json --commit --allow-prod
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SPREADSHEET_ID = "1XHXiR__p7h2JVLKNkS-F9aiKZjhar78YubQklW_baQA"
DEFAULT_TARGET_TAB = "Copy of DepthCharts"
PROD_TAB = "DepthCharts"

# Header zone in the target tab. Row 4 (1-based) carries cell notes that
# define the JSON key for each column; row 5 is the first data row.
HEADER_NOTE_ROW_INDEX = 3   # 0-based
DATA_START_ROW_INDEX  = 4   # 0-based; first data row is sheet row 5

# Only these JSON keys may be written. Everything else is formula-driven or
# bookkeeping and gets skipped to avoid breaking the spill formulas.
MANUAL_KEYS = {
    "eliasId", "gsisId", "jersey", "team", "status", "statusDescription",
    "nflId", "position", "depthPosition", "depthPositionCategory",
    "injury", "injuryReturnTarget", "injuryStatus",
    "isEdge", "freeAgentSigning", "isTradeAcquisition",
    "displayName", "firstName", "lastName", "footballName",
}

# Writable scopes (deliberately wider than the snapshot puller's read-only).
SCOPES_WRITE = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
]

DEFAULT_KEY_PATH = Path(
    os.environ.get(
        "FP_DATA_KEY_PATH",
        r"C:/Users/cwech/Documents/Football/Keys/fp-data-357113-a6174bb87054.json",
    )
)


# ---------------------------------------------------------------------------


def a1_col(idx: int) -> str:
    """0-based column index → A1 letters (0 → 'A', 26 → 'AA')."""
    s = ""
    n = idx
    while n >= 0:
        s = chr(ord("A") + (n % 26)) + s
        n = n // 26 - 1
    return s


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="Sync web-app edits into a sheet tab.")
    p.add_argument("export_file", help="Path to sync_export.json downloaded from the web app.")
    p.add_argument("--tab", default=DEFAULT_TARGET_TAB,
                   help=f"Target tab name (default: {DEFAULT_TARGET_TAB!r}).")
    p.add_argument("--commit", action="store_true",
                   help="Actually write the changes. Without this, runs as a dry-run.")
    p.add_argument("--allow-prod", action="store_true",
                   help="Allow writing to the live DepthCharts tab. Default: refused.")
    p.add_argument("--key", default=None,
                   help="Service-account key path (defaults to FP_DATA_KEY_PATH).")
    p.add_argument("--preview-rows", type=int, default=10,
                   help="How many sample changes to print in the dry-run output.")
    return p.parse_args()


def load_credentials(key_path: str | None) -> Credentials:
    path = Path(key_path) if key_path else DEFAULT_KEY_PATH
    if not path.exists():
        sys.exit(f"Service-account key not found at {path}.")
    return Credentials.from_service_account_file(str(path), scopes=SCOPES_WRITE)


def read_target_tab(svc, tab: str) -> dict[str, Any]:
    """Read header notes + current row values from the target tab."""
    resp = svc.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID,
        ranges=[f"'{tab}'!A1:BZ"],
        fields=(
            "sheets(properties(gridProperties),"
            "data(rowData(values(formattedValue,note,userEnteredValue))))"
        ),
    ).execute()
    if not resp.get("sheets"):
        sys.exit(f"Target tab not found: {tab!r}")
    sheet = resp["sheets"][0]
    rows = sheet["data"][0].get("rowData", [])
    col_count = sheet["properties"]["gridProperties"]["columnCount"]

    def cell(r_idx: int, c_idx: int) -> dict:
        if r_idx >= len(rows): return {}
        vals = rows[r_idx].get("values", [])
        if c_idx >= len(vals): return {}
        return vals[c_idx] or {}

    # Build the JSON-key map from row 4 cell notes.
    key_to_col: dict[str, int] = {}
    formula_cols: set[int] = set()
    for c in range(col_count):
        cv = cell(HEADER_NOTE_ROW_INDEX, c)
        note = (cv.get("note") or "").strip()
        if note:
            key_to_col[note] = c
        uev = cv.get("userEnteredValue") or {}
        if "formulaValue" in uev:
            formula_cols.add(c)

    # Current data rows by sheet row number.
    col_to_key = {c: k for k, c in key_to_col.items()}
    current: dict[int, dict[str, str]] = {}
    last_data_row = DATA_START_ROW_INDEX
    for r_idx in range(DATA_START_ROW_INDEX, len(rows)):
        row_vals = rows[r_idx].get("values", [])
        if not row_vals:
            continue
        rec: dict[str, str] = {}
        any_filled = False
        for c, k in col_to_key.items():
            cv = row_vals[c] if c < len(row_vals) else {}
            v = (cv or {}).get("formattedValue", "") or ""
            rec[k] = v
            if v:
                any_filled = True
        if any_filled:
            current[r_idx + 1] = rec
            last_data_row = r_idx + 1

    return {
        "key_to_col": key_to_col,
        "formula_cols": formula_cols,
        "current": current,
        "col_count": col_count,
        "last_data_row": last_data_row,
    }


def compute_diff(
    export: dict[str, Any],
    target: dict[str, Any],
) -> tuple[list[tuple[int, list[tuple[int, str]]]], list[dict]]:
    """Return (updates, appends).

    - updates: list of (sheet_row, [(col_idx, value), ...]) for existing rows
      whose manual columns differ from the desired state.
    - appends: full export rows whose _sheet_row doesn't exist in target.
    """
    key_to_col: dict[str, int] = target["key_to_col"]
    formula_cols: set[int] = target["formula_cols"]
    current: dict[int, dict[str, str]] = target["current"]

    writable: dict[str, int] = {
        k: c for k, c in key_to_col.items()
        if k in MANUAL_KEYS and c not in formula_cols
    }

    updates: list[tuple[int, list[tuple[int, str]]]] = []
    appends: list[dict] = []

    max_existing = max(current.keys(), default=0)
    new_row_threshold = max(max_existing + 1, 10000)

    for row in export.get("rows", []):
        sheet_row = int(row.get("_sheet_row") or 0)
        is_virtual = sheet_row >= new_row_threshold
        if is_virtual or sheet_row not in current:
            appends.append(row)
            continue
        target_row = current[sheet_row]
        diffs: list[tuple[int, str]] = []
        for key, col in writable.items():
            desired = row.get(key, "")
            if desired is None or desired is False:
                desired_str = "FALSE" if desired is False else ""
            elif desired is True:
                desired_str = "TRUE"
            else:
                desired_str = str(desired)
            cur = (target_row.get(key) or "")
            # Normalize TRUE/FALSE case mismatch.
            if desired_str.upper() in ("TRUE", "FALSE") and cur.upper() == desired_str.upper():
                continue
            if desired_str == cur:
                continue
            diffs.append((col, desired_str))
        if diffs:
            updates.append((sheet_row, diffs))

    return updates, appends


def apply_updates(svc, tab: str, updates: list[tuple[int, list[tuple[int, str]]]]) -> int:
    """Apply cell-level updates via batchUpdate."""
    data = []
    for sheet_row, cells in updates:
        for col, val in cells:
            data.append({
                "range": f"'{tab}'!{a1_col(col)}{sheet_row}",
                "values": [[val]],
            })
    if not data:
        return 0
    result = svc.spreadsheets().values().batchUpdate(
        spreadsheetId=SPREADSHEET_ID,
        body={"valueInputOption": "USER_ENTERED", "data": data},
    ).execute()
    return result.get("totalUpdatedCells", 0)


def apply_appends(
    svc, tab: str, appends: list[dict], target: dict[str, Any], start_row: int,
) -> int:
    """Append new rows below the last data row."""
    if not appends:
        return 0
    key_to_col: dict[str, int] = target["key_to_col"]
    formula_cols: set[int] = target["formula_cols"]
    col_count: int = target["col_count"]

    # Build a 2D matrix [rows][cols] of strings; formula columns left blank
    # so the spill from row 4 fills them in.
    matrix: list[list[str]] = []
    for row in appends:
        line = [""] * col_count
        for k, c in key_to_col.items():
            if c in formula_cols:
                continue
            if k not in MANUAL_KEYS:
                continue
            v = row.get(k, "")
            if v is True:  line[c] = "TRUE"
            elif v is False: line[c] = "FALSE"
            elif v is None:  line[c] = ""
            else:            line[c] = str(v)
        matrix.append(line)

    # Use a specific range so values land exactly where we want them.
    end_row = start_row + len(matrix) - 1
    rng = f"'{tab}'!A{start_row}:{a1_col(col_count - 1)}{end_row}"
    result = svc.spreadsheets().values().update(
        spreadsheetId=SPREADSHEET_ID,
        range=rng,
        valueInputOption="USER_ENTERED",
        body={"values": matrix},
    ).execute()
    return result.get("updatedCells", 0)


# ---------------------------------------------------------------------------


def main() -> int:
    args = parse_args()

    if args.tab == PROD_TAB and not args.allow_prod:
        sys.exit(
            f"Refusing to write to {PROD_TAB!r}. Re-run with --allow-prod "
            "if you really mean it (and ideally with --commit only on a test tab first)."
        )

    if not args.commit:
        print("[DRY-RUN] No writes will be made. Pass --commit to actually apply.\n")

    export_path = Path(args.export_file)
    if not export_path.exists():
        sys.exit(f"Export file not found: {export_path}")
    export = json.loads(export_path.read_text(encoding="utf-8"))

    creds = load_credentials(args.key)
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)

    print(f"Target tab: {args.tab!r}")
    print(f"Export rows: {len(export.get('rows', []))}")
    print(f"Exported at: {export.get('exported_at', '?')}")
    print(f"Snapshot at: {export.get('snapshot_at', '?')}\n")

    target = read_target_tab(svc, args.tab)
    print(f"Target columns: {target['col_count']}")
    print(f"Target keyed columns: {len(target['key_to_col'])}")
    print(f"Target formula columns (skipped): {len(target['formula_cols'])}")
    print(f"Target data rows currently: {len(target['current'])}\n")

    updates, appends = compute_diff(export, target)

    total_cells = sum(len(c) for _, c in updates)
    print(f"Updates: {len(updates)} rows ({total_cells} cells)")
    print(f"Appends: {len(appends)} new rows")

    if updates and args.preview_rows > 0:
        print("\nSample changes:")
        col_to_key = {c: k for k, c in target["key_to_col"].items()}
        shown = 0
        for sheet_row, cells in updates:
            if shown >= args.preview_rows: break
            target_row = target["current"].get(sheet_row, {})
            for col, val in cells[:4]:
                key = col_to_key.get(col, "?")
                before = target_row.get(key, "")
                print(f"  row {sheet_row} {key!r}: {before!r:30}  ->  {val!r}")
            shown += 1
        if len(updates) > args.preview_rows:
            print(f"  ... {len(updates) - args.preview_rows} more rows with changes")

    if appends and args.preview_rows > 0:
        print("\nSample appends (first 3):")
        for row in appends[:3]:
            print(f"  + {row.get('displayName', '?')} / "
                  f"{row.get('team', '?')} / "
                  f"{row.get('depthPosition', '?')} / "
                  f"elias={row.get('eliasId', '?')}")

    if not args.commit:
        print("\nDry-run complete. Use --commit to apply.")
        return 0

    # Apply.
    print("\nApplying updates...")
    n_updated = apply_updates(svc, args.tab, updates)
    print(f"  wrote {n_updated} cells")

    if appends:
        start_row = target["last_data_row"] + 1
        print(f"Appending {len(appends)} new rows starting at sheet row {start_row}...")
        n_appended = apply_appends(svc, args.tab, appends, target, start_row)
        print(f"  wrote {n_appended} cells across new rows")

    print("\nDone.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
