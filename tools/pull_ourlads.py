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
        order_in_row = 0  # only increments on real player cells, not blanks
        for cell in cells[1:]:
            text = cell.get_text(" ", strip=True)
            if not text:
                continue
            name = _clean_player(text)
            if not name:
                continue
            order_in_row += 1
            out.append({
                "name": name,
                "position": DEPTH_TO_POSITION.get(depth_position, ""),
                "depth_position": depth_position,
                "depth_order": order_in_row,
            })
    return out


# Trailing notes OurLads stamps after a player name:
#   "Smith J. 24/"   -> jersey + "/"
#   "Smith J. 24 R"  -> jersey + status flag
#   "Smith J. U/"    -> single-letter status (R/P/N/U/...)
#   "Smith J. PUP"   -> 2-3 letter status code
# All of these get stripped. We deliberately do NOT touch name suffixes like
# "Jr.", "Sr.", "II", "III" since they contain dots or are 3+ chars without
# matching the suffix pattern.
def _is_trailing_note(token: str) -> bool:
    """True if a trailing whitespace-separated token looks like an OurLads
    jersey/status annotation rather than part of the player's name.

    Treated as notes:
      - Pure digits (e.g., "24")
      - Anything containing a slash (e.g., "24/", "U/", "P/")
      - A single uppercase letter (e.g., "R", "P")

    Deliberately NOT treated as notes:
      - 2-3 letter sequences without a slash (so "II", "III", "Jr", "PUP")
        — false positives on rare status codes are accepted to keep name
        suffixes intact.
    """
    if not token:
        return False
    if token.isdigit():
        return True
    if "/" in token:
        return True
    if len(token) == 1 and token.isupper() and token.isalpha():
        return True
    return False


_INLINE_CODE = re.compile(r"^[A-Z]{1,3}\d{1,2}$")

def _clean_player(text: str) -> str:
    """Clean up an OurLads player cell into 'First Last (suffix)'.

    OurLads renders names as 'Last, First' with trailing jersey/status notes,
    and sometimes interleaves a draft-status code mid-name (e.g., "Bryson
    CF25 Green" = College Free agent 2025). We strip both and flip the
    comma so the result matches the sheet's `displayName` convention.
    """
    s = re.sub(r"\s+", " ", text.strip())
    tokens = s.split(" ")

    # 1) Drop trailing jersey/status notes.
    while tokens and _is_trailing_note(tokens[-1]):
        tokens.pop()

    # 2) Drop mid-name OurLads codes like "CF25", "SF26", "WV24".
    tokens = [t for t in tokens if not _INLINE_CODE.match(t)]

    s = " ".join(tokens)
    # 3) Flip "Last, First" → "First Last".
    if "," in s:
        last, _, first = s.partition(",")
        last = last.strip().rstrip(",")
        first = first.strip()
        if first and last:
            s = f"{first} {last}"
    return s.strip()


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
