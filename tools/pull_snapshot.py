"""Pull a snapshot of the Depth Chart workbook into docs/data/snapshot.json.

Runs locally (with FP_DATA_KEY_PATH pointing at the key file) and inside the
GitHub Action (with FP_DATA_KEY_JSON containing the JSON contents).

The frontend reads the snapshot as static JSON. The service-account key is
NEVER shipped to the browser.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any

from google.oauth2.service_account import Credentials
from googleapiclient.discovery import build

# --- Config (mirrors app/config.py from the Streamlit project) ------------

SPREADSHEET_ID = "1XHXiR__p7h2JVLKNkS-F9aiKZjhar78YubQklW_baQA"

DEPTHCHARTS_TAB = "DepthCharts"
ROSTERS_TAB = "Rosters"
OPTIONS_TAB = "Options"

DC_HEADER_NOTE_ROW = 4  # 1-based
DC_HUMAN_HEADER_ROW = 3
DC_FIRST_DATA_ROW = 5

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive.readonly",
]

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "docs" / "data" / "snapshot.json"


# --- Credentials ----------------------------------------------------------


def _credentials() -> Credentials:
    raw_json = os.environ.get("FP_DATA_KEY_JSON")
    if raw_json:
        info = json.loads(raw_json)
        return Credentials.from_service_account_info(info, scopes=SCOPES)

    key_path = os.environ.get(
        "FP_DATA_KEY_PATH",
        r"C:/Users/cwech/Documents/Football/Keys/fp-data-357113-a6174bb87054.json",
    )
    p = Path(key_path)
    if not p.exists():
        sys.exit(
            f"Service-account credentials not found. Either set "
            f"FP_DATA_KEY_JSON (the JSON contents) or FP_DATA_KEY_PATH to a "
            f"readable key file. Tried: {p}"
        )
    return Credentials.from_service_account_file(str(p), scopes=SCOPES)


def _svc():
    return build("sheets", "v4", credentials=_credentials(), cache_discovery=False)


# --- DepthCharts (with row-4 notes as JSON keys) --------------------------


def _load_depth_charts(svc) -> dict[str, Any]:
    resp = (
        svc.spreadsheets()
        .get(
            spreadsheetId=SPREADSHEET_ID,
            ranges=[f"{DEPTHCHARTS_TAB}!A1:BZ"],
            fields=(
                "sheets(properties(gridProperties),"
                "data(rowData(values(formattedValue,note))))"
            ),
        )
        .execute()
    )

    sheet = resp["sheets"][0]
    rows = sheet["data"][0].get("rowData", [])
    col_count = sheet["properties"]["gridProperties"]["columnCount"]

    def cell(r_idx: int, c_idx: int) -> dict:
        if r_idx >= len(rows):
            return {}
        vals = rows[r_idx].get("values", [])
        if c_idx >= len(vals):
            return {}
        return vals[c_idx] or {}

    notes_row_idx = DC_HEADER_NOTE_ROW - 1
    label_row_idx = DC_HUMAN_HEADER_ROW - 1

    key_to_col: dict[str, int] = {}
    key_to_label: dict[str, str] = {}
    col_to_key: dict[int, str] = {}
    for c in range(col_count):
        note = (cell(notes_row_idx, c).get("note") or "").strip()
        label = (cell(label_row_idx, c).get("formattedValue") or "").strip()
        if note:
            key_to_col[note] = c
            col_to_key[c] = note
            if label:
                key_to_label[note] = label

    required_idx = key_to_col.get("eliasId", 6)

    data_rows = []
    first_data_idx = DC_FIRST_DATA_ROW - 1
    for r_idx in range(first_data_idx, len(rows)):
        row_values = rows[r_idx].get("values", [])
        req = (row_values[required_idx] if required_idx < len(row_values) else {})
        req_val = ((req or {}).get("formattedValue") or "").strip()
        if not req_val:
            continue
        record = {"_sheet_row": r_idx + 1}
        for col_idx, key in col_to_key.items():
            cv = row_values[col_idx] if col_idx < len(row_values) else {}
            record[key] = (cv or {}).get("formattedValue", "")
        data_rows.append(record)

    return {
        "key_to_label": key_to_label,
        "keys": list(key_to_col.keys()),
        "rows": data_rows,
    }


# --- Rosters / Options ----------------------------------------------------


def _load_tab(svc, tab: str, rng: str) -> dict[str, Any]:
    resp = (
        svc.spreadsheets()
        .values()
        .get(
            spreadsheetId=SPREADSHEET_ID,
            range=f"{tab}!{rng}",
            valueRenderOption="FORMATTED_VALUE",
        )
        .execute()
    )
    values = resp.get("values", [])
    if not values:
        return {"headers": [], "rows": []}
    headers = [str(h).strip() for h in values[0]]
    width = len(headers)
    rows = [(r + [""] * width)[:width] for r in values[1:]]
    return {"headers": headers, "rows": rows}


def _shrink_rosters(rosters: dict) -> dict:
    """Keep only the columns the frontend needs (name autocomplete + IDs)."""
    wanted = [
        "playerId", "esbId", "gsisId", "displayName", "firstName",
        "lastName", "teamAbbreviation", "fantasyPosition", "jersey",
    ]
    headers = rosters["headers"]
    idx_map = {h: i for i, h in enumerate(headers)}
    keep_idx = [idx_map[w] for w in wanted if w in idx_map]
    new_headers = [headers[i] for i in keep_idx]
    new_rows = [[r[i] for i in keep_idx] for r in rosters["rows"]]
    return {"headers": new_headers, "rows": new_rows}


def _options_catalog(options_tab: dict) -> dict[str, list[str]]:
    """Pull out catalog lists by column index, matching the live Options tab."""
    headers = options_tab["headers"]
    rows = options_tab["rows"]
    def col(idx: int) -> list[str]:
        seen, out = set(), []
        for r in rows:
            if idx < len(r):
                v = (r[idx] or "").strip()
                if v and v not in seen:
                    seen.add(v)
                    out.append(v)
        return out
    return {
        "depthPosition": col(1),     # B
        "position": col(4),          # E
        "positionGroup": col(16),    # Q
        "conference": col(30),       # AE
    }


# --- Main ----------------------------------------------------------------


def main() -> int:
    svc = _svc()
    print("Loading DepthCharts...", flush=True)
    depth = _load_depth_charts(svc)
    print(f"  rows: {len(depth['rows'])}", flush=True)

    print("Loading Rosters...", flush=True)
    rosters_full = _load_tab(svc, ROSTERS_TAB, "A1:AZ")
    rosters = _shrink_rosters(rosters_full)
    print(f"  rows: {len(rosters['rows'])}", flush=True)

    print("Loading Options...", flush=True)
    options_tab = _load_tab(svc, OPTIONS_TAB, "A1:AZ")
    options = _options_catalog(options_tab)
    print(f"  catalog sizes: { {k: len(v) for k, v in options.items()} }", flush=True)

    snapshot = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "spreadsheet_id": SPREADSHEET_ID,
        "depth": depth,
        "rosters": rosters,
        "options": options,
    }

    payload = json.dumps(snapshot, ensure_ascii=False, separators=(",", ":")).encode("utf-8")

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_bytes(payload)
    size_kb = len(payload) / 1024
    print(f"Wrote {OUTPUT_PATH} ({size_kb:.1f} KB)", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
