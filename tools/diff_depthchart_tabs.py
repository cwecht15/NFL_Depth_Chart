"""Compare the live ``DepthCharts`` tab against ``Copy of DepthCharts`` row-by-row.

Used to verify a Sync-to-Sheet round-trip landed correctly. Compares
every keyed column (manual + formula) by default; pass ``--manual-only``
to limit to the writable columns sync_to_sheet.py touches.

Usage::

    python tools/diff_depthchart_tabs.py
    python tools/diff_depthchart_tabs.py --tab "Copy of DepthCharts"  # compare a different tab
    python tools/diff_depthchart_tabs.py --manual-only                 # skip formula columns
    python tools/diff_depthchart_tabs.py --show-equal                  # print matching rows too
"""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Any

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

SPREADSHEET_ID = "1XHXiR__p7h2JVLKNkS-F9aiKZjhar78YubQklW_baQA"
PROD_TAB = "DepthCharts"
COPY_TAB = "Copy of DepthCharts"

HEADER_NOTE_ROW_INDEX = 3  # 0-based; row 4 in the sheet
DATA_START_ROW_INDEX = 4   # 0-based; row 5 in the sheet

MANUAL_KEYS = {
    "eliasId", "gsisId", "jersey", "team", "status", "statusDescription",
    "nflId", "position", "depthPosition", "depthPositionCategory",
    "injury", "injuryReturnTarget", "injuryStatus",
    "isEdge", "freeAgentSigning", "isTradeAcquisition",
    "displayName", "firstName", "lastName", "footballName",
}

SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

DEFAULT_KEY_PATH = Path(
    os.environ.get(
        "FP_DATA_KEY_PATH",
        r"C:/Users/cwech/Documents/Football/Keys/fp-data-357113-a6174bb87054.json",
    )
)


def read_tab(svc, tab: str, manual_only: bool) -> tuple[dict[str, dict[str, str]], set[str]]:
    """Returns ({eliasId: {key: value}}, formula_keys)."""
    resp = svc.spreadsheets().get(
        spreadsheetId=SPREADSHEET_ID,
        ranges=[f"'{tab}'!A1:BZ"],
        fields=(
            "sheets(properties(gridProperties),"
            "data(rowData(values(formattedValue,note,userEnteredValue))))"
        ),
    ).execute()
    sheet = resp["sheets"][0]
    rows = sheet["data"][0].get("rowData", [])

    def cell(r: int, c: int) -> dict:
        if r >= len(rows):
            return {}
        vals = rows[r].get("values", [])
        if c >= len(vals):
            return {}
        return vals[c] or {}

    col_count = sheet["properties"]["gridProperties"]["columnCount"]
    key_to_col: dict[str, int] = {}
    formula_keys: set[str] = set()
    for c in range(col_count):
        hcell = cell(HEADER_NOTE_ROW_INDEX, c)
        note = (hcell.get("note") or "").strip()
        if not note:
            continue
        if manual_only and note not in MANUAL_KEYS:
            continue
        key_to_col[note] = c
        # Row 4's userEnteredValue tells us whether this column is
        # formula-driven (the ARRAYFORMULA spill). Tracked so we can
        # call the differences out separately in the report.
        uev = hcell.get("userEnteredValue") or {}
        if "formulaValue" in uev:
            formula_keys.add(note)

    col_to_key = {c: k for k, c in key_to_col.items()}
    by_elias: dict[str, dict[str, str]] = {}
    elias_col = key_to_col.get("eliasId")
    if elias_col is None:
        sys.exit(f"Could not find eliasId column in {tab!r}")

    for r in range(DATA_START_ROW_INDEX, len(rows)):
        elias = (cell(r, elias_col).get("formattedValue") or "").strip()
        if not elias:
            continue
        rec: dict[str, str] = {}
        for c, k in col_to_key.items():
            rec[k] = (cell(r, c).get("formattedValue") or "").strip()
        by_elias[elias] = rec

    return by_elias, formula_keys


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--tab", default=COPY_TAB, help=f"Target tab to compare against {PROD_TAB!r}.")
    p.add_argument("--key", default=None)
    p.add_argument("--show-equal", action="store_true", help="Also print rows that match.")
    p.add_argument("--manual-only", action="store_true",
                   help="Only compare manual/writable columns. By default ALL keyed "
                        "columns (manual + formula-driven) are compared.")
    args = p.parse_args()

    key_path = Path(args.key) if args.key else DEFAULT_KEY_PATH
    if not key_path.exists():
        sys.exit(f"Service-account key not found at {key_path}.")
    creds = Credentials.from_service_account_file(str(key_path), scopes=SCOPES)
    svc = build("sheets", "v4", credentials=creds, cache_discovery=False)

    prod, prod_formula = read_tab(svc, PROD_TAB, args.manual_only)
    copy, copy_formula = read_tab(svc, args.tab, args.manual_only)
    formula_keys = prod_formula | copy_formula

    scope = "manual only" if args.manual_only else "ALL keyed columns (manual + formula)"
    print(f"Comparing: {scope}")
    print(f"{PROD_TAB!r}: {len(prod)} rows")
    print(f"{args.tab!r}: {len(copy)} rows")
    if formula_keys and not args.manual_only:
        print(f"Formula-driven columns being checked: {sorted(formula_keys)}")
    print()

    prod_keys = set(prod.keys())
    copy_keys = set(copy.keys())
    only_prod = prod_keys - copy_keys
    only_copy = copy_keys - prod_keys
    both = prod_keys & copy_keys

    if only_prod:
        print(f"Players only in {PROD_TAB!r} ({len(only_prod)}):")
        for e in sorted(only_prod):
            r = prod[e]
            print(f"  {e}  {r.get('displayName', '?')}  team={r.get('team', '?')}")
        print()
    if only_copy:
        print(f"Players only in {args.tab!r} ({len(only_copy)}):")
        for e in sorted(only_copy):
            r = copy[e]
            print(f"  {e}  {r.get('displayName', '?')}  team={r.get('team', '?')}")
        print()

    differing = []
    matching = []
    diff_by_col: dict[str, int] = {}
    for e in sorted(both):
        p_row = prod[e]
        c_row = copy[e]
        diff_keys = []
        for k in sorted(set(p_row) | set(c_row)):
            if (p_row.get(k) or "") != (c_row.get(k) or ""):
                diff_keys.append((k, p_row.get(k, ""), c_row.get(k, "")))
                diff_by_col[k] = diff_by_col.get(k, 0) + 1
        if diff_keys:
            differing.append((e, p_row.get("displayName", "?"), diff_keys))
        else:
            matching.append(e)

    print(f"Players in BOTH tabs: {len(both)}  "
          f"({len(matching)} identical, {len(differing)} differ)")
    print()

    if diff_by_col:
        print("Divergent columns (count of players differing on each):")
        for col, n in sorted(diff_by_col.items(), key=lambda x: -x[1]):
            marker = " (formula)" if col in formula_keys else ""
            print(f"  {n:4d}  {col}{marker}")
        print()

    if differing:
        # Cap the per-player detail dump so the report stays readable on
        # large divergences. Pass --show-equal to expand the full list.
        limit = len(differing) if args.show_equal else 25
        print(f"Per-player differences (showing {min(limit, len(differing))} of {len(differing)}):")
        for elias, name, diffs in differing[:limit]:
            print(f"  {elias}  {name}")
            for k, pv, cv in diffs:
                marker = " [formula]" if k in formula_keys else ""
                print(f"    {k:30s}{marker}  {PROD_TAB[:20]}={pv!r:25s}  {args.tab[:20]}={cv!r}")
        if not args.show_equal and len(differing) > limit:
            print(f"  ... {len(differing) - limit} more (use --show-equal for the full list)")
        print()

    if args.show_equal and matching:
        print(f"Identical players ({len(matching)}):")
        for e in matching[:20]:
            print(f"  {e}  {prod[e].get('displayName', '?')}")
        if len(matching) > 20:
            print(f"  ... and {len(matching) - 20} more")

    return 0 if (not only_prod and not only_copy and not differing) else 1


if __name__ == "__main__":
    raise SystemExit(main())
