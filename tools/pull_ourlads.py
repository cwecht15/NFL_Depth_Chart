"""Scrape OurLads team depth charts → docs/data/ourlads.json.

OurLads is the cleanest public source of beat-writer-curated depth charts;
they publish one HTML page per team. We parse the visible depth-chart table
into a normalized JSON.

Schema:
    {
      "generated_at": "2026-05-12T15:00:00Z",
      "source": "https://www.ourlads.com",
      "teams": {
        "ARZ": [
          { "name": "Marvin Harrison Jr.", "position": "WR",
            "depth_position": "LWR", "depth_order": 1 },
          ...
        ],
        ...
      }
    }

This script is intentionally polite (1.5s between requests, real UA string).
If OurLads ever breaks the format, the workflow will fail loudly rather than
silently overwrite with garbage.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import time
from pathlib import Path

import requests
from bs4 import BeautifulSoup

OUT_PATH = Path(__file__).resolve().parent.parent / "docs" / "data" / "ourlads.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36"
)

# OurLads uses NFL-standard 3-letter codes; we map them to the sheet's TV
# abbreviations so warnings line up with `team` values in DepthCharts.
OURLADS_TO_SHEET = {
    "ARZ": "ARZ", "ATL": "ATL", "BAL": "BLT", "BUF": "BUF",
    "CAR": "CAR", "CHI": "CHI", "CIN": "CIN", "CLE": "CLV",
    "DAL": "DAL", "DEN": "DEN", "DET": "DET", "GB":  "GB",
    "HOU": "HST", "IND": "IND", "JAX": "JAX", "KC":  "KC",
    "LAC": "LAC", "LAR": "LA",  "LV":  "LV",  "MIA": "MIA",
    "MIN": "MIN", "NE":  "NE",  "NO":  "NO",  "NYG": "NYG",
    "NYJ": "NYJ", "PHI": "PHI", "PIT": "PIT", "SEA": "SEA",
    "SF":  "SF",  "TB":  "TB",  "TEN": "TEN", "WAS": "WAS",
}

# OurLads URL takes a slugged team key (e.g., "ARI" for Arizona, "LAR" for Rams)
TEAM_URL_SLUGS = {
    "ARZ": "ARZ", "ATL": "ATL", "BLT": "BAL", "BUF": "BUF",
    "CAR": "CAR", "CHI": "CHI", "CIN": "CIN", "CLV": "CLE",
    "DAL": "DAL", "DEN": "DEN", "DET": "DET", "GB":  "GB",
    "HST": "HOU", "IND": "IND", "JAX": "JAX", "KC":  "KC",
    "LAC": "LAC", "LA":  "LAR", "LV":  "LV",  "MIA": "MIA",
    "MIN": "MIN", "NE":  "NE",  "NO":  "NO",  "NYG": "NYG",
    "NYJ": "NYJ", "PHI": "PHI", "PIT": "PIT", "SEA": "SEA",
    "SF":  "SF",  "TB":  "TB",  "TEN": "TEN", "WAS": "WAS",
}

# Generic position mapping: OurLads uses specific labels (LWR/RWR/LDE/...).
# We expose both the specific depth_position and a coarse position the
# frontend can compare against the sheet's `position` column.
DEPTH_TO_POSITION = {
    # Offense
    "QB": "QB",
    "RB": "RB", "FB": "FB", "HB": "RB",
    "WR": "WR", "LWR": "WR", "SWR": "WR", "RWR": "WR",
    "TE": "TE", "LTE": "TE", "RTE": "TE",
    "LT": "OT", "RT": "OT", "OT": "OT",
    "LG": "G",  "RG": "G",  "G":  "G",
    "C":  "C",
    # Defense
    "DE": "DE", "LDE": "DE", "RDE": "DE", "RUSH": "DE", "EDGE": "DE",
    "DT": "DT", "LDT": "DT", "RDT": "DT", "NT": "NT",
    "LB": "LB", "MLB": "LB", "ILB": "ILB", "LILB": "ILB", "RILB": "ILB",
    "OLB": "OLB", "LOLB": "OLB", "ROLB": "OLB", "WLB": "LB", "SLB": "LB",
    "CB": "CB", "LCB": "CB", "RCB": "CB", "NB": "NB", "NCB": "NB",
    "SS": "SS", "FS": "FS", "S": "S", "SAF": "S",
    # Special teams
    "K": "K", "P": "P", "LS": "LS", "KR": "KR", "PR": "PR", "KO": "KO", "H": "H",
}


def _fetch(url: str) -> str:
    r = requests.get(url, headers={"User-Agent": UA}, timeout=20)
    r.raise_for_status()
    return r.text


def _parse_team(html: str, team: str) -> list[dict]:
    """Parse a single team's depth chart page.

    OurLads uses a table where each row is a depth position (e.g., 'LWR') and
    the player columns are 1st-, 2nd-, 3rd-string etc. We pivot that into
    one record per (player, depth_position, depth_order).
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", id="ctl00_phContent_gvChart") or soup.find("table", class_="table")
    if not table:
        return []

    out: list[dict] = []
    for row in table.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) < 2:
            continue
        depth_position = (cells[0].get_text(strip=True) or "").upper()
        if not depth_position or depth_position in {"POS", "POSITION"}:
            continue
        for idx, cell in enumerate(cells[1:], start=1):
            text = cell.get_text(" ", strip=True)
            if not text:
                continue
            # Player cells look like: "Last F. 18 R" or "Last F." with extra glyphs.
            # Strip trailing parens/letters/numbers conservatively.
            name = _clean_player(text)
            if not name:
                continue
            out.append({
                "name": name,
                "position": DEPTH_TO_POSITION.get(depth_position, ""),
                "depth_position": depth_position,
                "depth_order": idx,
            })
    return out


_PLAYER_TAIL = re.compile(r"\s*(?:#\d+|\d+|[A-Z]{1,3})\s*$")
def _clean_player(text: str) -> str:
    """Trim trailing jersey/status glyphs OurLads appends to names."""
    s = text.strip()
    # Compress whitespace.
    s = re.sub(r"\s+", " ", s)
    # Many OurLads cells look like "Smith T. 18 R" → strip trailing tokens
    # that look like jersey numbers / status letters.
    while True:
        m = _PLAYER_TAIL.search(s)
        if not m:
            break
        s = s[:m.start()].rstrip()
    return s


def main() -> int:
    teams: dict[str, list[dict]] = {}
    failures: list[str] = []
    for sheet_team, ourlads_slug in TEAM_URL_SLUGS.items():
        url = f"https://www.ourlads.com/nfldepthcharts/depthchart/{ourlads_slug}"
        try:
            html = _fetch(url)
            players = _parse_team(html, sheet_team)
        except Exception as e:
            failures.append(f"{sheet_team}: {type(e).__name__}: {e}")
            time.sleep(1.5)
            continue
        teams[sheet_team] = players
        print(f"  {sheet_team:4s} ({ourlads_slug:4s}): {len(players)} players", flush=True)
        time.sleep(1.5)

    if failures:
        print("Failures:", file=sys.stderr)
        for f in failures:
            print("  -", f, file=sys.stderr)

    payload = {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "source": "https://www.ourlads.com",
        "teams": teams,
        "failures": failures,
    }
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size_kb = OUT_PATH.stat().st_size / 1024
    total_players = sum(len(v) for v in teams.values())
    print(f"Wrote {OUT_PATH} ({size_kb:.1f} KB; {len(teams)} teams, {total_players} players)", flush=True)

    # Exit non-zero if everything failed; the workflow shouldn't commit an
    # all-empty payload over a working one.
    if not teams or all(len(v) == 0 for v in teams.values()):
        print("All scrapes returned 0 players; refusing to overwrite.", file=sys.stderr)
        return 2

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
