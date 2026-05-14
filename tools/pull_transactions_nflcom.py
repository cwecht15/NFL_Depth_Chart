"""Fetch NFL transactions from NFL.com's category pages → transactions.json.

NFL.com publishes per-player rows on six category pages (signings, waivers,
terminations, trades, reserve-list, other) keyed by year/month. Each row is
already one player + one transaction, so we don't have to slice multi-player
sentences the way the ESPN feed forced us to. The output schema matches what
pull_transactions.py emitted, so the frontend warning logic in
docs/app.js works unchanged — only the `source` field changes to `nfl.com`.

Schema (unchanged):
    {
      "headers": ["date","season","description","descriptionAbbr",
                  "transactionType","position","teamId","smartId","teamAbbr",
                  "teamName","person_id","person_firstName","person_lastName",
                  "person_displayName","person_gsisId","person_headshot",
                  "sourceTeam_id","sourceTeam_fullName","sourceTeam_logo",
                  "destinationTeam_id","destinationTeam_fullName",
                  "destinationTeam_logo"],
      "rows":    [[...], ...],   # newest first
      "source":  "nfl.com",
      ...
    }
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "docs" / "data" / "transactions.json"

# NFL.com URL categories → canonical transactionType the frontend expects.
# The frontend matches on these strings in _expectedStateForTx (docs/app.js).
CATEGORY_TO_TYPE = {
    "signings":     "signings",
    "waivers":      "waivers",
    "terminations": "released",
    "trades":       "trades",
    "reserve-list": "reserve-list",
    "other":        "other",
}

# How many months of history to pull. Three months covers the 14-day warning
# window with slack for late-month runs, while keeping page fetches bounded
# (6 categories × 3 months = 18 GETs per run).
LOOKBACK_MONTHS = 3

KEEP_ROWS = 3000  # safety cap on emitted events
REQUEST_DELAY_SEC = 1.0

# NFL team name → projection-style abbreviation. Covers full names, nicknames,
# and the handful of edge cases (Washington Commanders, LA teams).
TEAMS = [
    ("Arizona Cardinals",     "Cardinals",  "ARI"),
    ("Atlanta Falcons",       "Falcons",    "ATL"),
    ("Baltimore Ravens",      "Ravens",     "BAL"),
    ("Buffalo Bills",         "Bills",      "BUF"),
    ("Carolina Panthers",     "Panthers",   "CAR"),
    ("Chicago Bears",         "Bears",      "CHI"),
    ("Cincinnati Bengals",    "Bengals",    "CIN"),
    ("Cleveland Browns",      "Browns",     "CLE"),
    ("Dallas Cowboys",        "Cowboys",    "DAL"),
    ("Denver Broncos",        "Broncos",    "DEN"),
    ("Detroit Lions",         "Lions",      "DET"),
    ("Green Bay Packers",     "Packers",    "GB"),
    ("Houston Texans",        "Texans",     "HOU"),
    ("Indianapolis Colts",    "Colts",      "IND"),
    ("Jacksonville Jaguars",  "Jaguars",    "JAX"),
    ("Kansas City Chiefs",    "Chiefs",     "KC"),
    ("Las Vegas Raiders",     "Raiders",    "LV"),
    ("Los Angeles Chargers",  "Chargers",   "LAC"),
    ("Los Angeles Rams",      "Rams",       "LAR"),
    ("Miami Dolphins",        "Dolphins",   "MIA"),
    ("Minnesota Vikings",     "Vikings",    "MIN"),
    ("New England Patriots",  "Patriots",   "NE"),
    ("New Orleans Saints",    "Saints",     "NO"),
    ("New York Giants",       "Giants",     "NYG"),
    ("New York Jets",         "Jets",       "NYJ"),
    ("Philadelphia Eagles",   "Eagles",     "PHI"),
    ("Pittsburgh Steelers",   "Steelers",   "PIT"),
    ("San Francisco 49ers",   "49ers",      "SF"),
    ("Seattle Seahawks",      "Seahawks",   "SEA"),
    ("Tampa Bay Buccaneers",  "Buccaneers", "TB"),
    ("Tennessee Titans",      "Titans",     "TEN"),
    ("Washington Commanders", "Commanders", "WAS"),
]


def _team_abbr(text: str) -> str:
    """Map a NFL.com club cell ("Bengals", "Arizona Cardinals", ...) to abbrev."""
    if not text or text == "--":
        return ""
    t = text.strip().lower()
    for full, nickname, abbr in TEAMS:
        if full.lower() == t or nickname.lower() == t:
            return abbr
    for full, nickname, abbr in TEAMS:
        if nickname.lower() in t or full.lower() in t:
            return abbr
    return ""


def _team_full(abbr: str) -> str:
    for full, _, ab in TEAMS:
        if ab == abbr:
            return full
    return ""


def _normalize_cell(text: str) -> str:
    """Collapse whitespace and strip the duplicated-label artifact NFL.com
    sometimes emits in club cells (e.g. "Bengals Bengals")."""
    normalized = re.sub(r"\s+", " ", text or "").strip()
    parts = normalized.split()
    midpoint = len(parts) // 2
    if len(parts) % 2 == 0 and midpoint and parts[:midpoint] == parts[midpoint:]:
        return " ".join(parts[:midpoint])
    return normalized


def _months_to_pull(today: dt.date, count: int) -> list[tuple[int, int]]:
    """Return [(year, month), ...] newest first."""
    out: list[tuple[int, int]] = []
    y, m = today.year, today.month
    for _ in range(count):
        out.append((y, m))
        m -= 1
        if m == 0:
            m = 12
            y -= 1
    return out


def _parse_date(text: str, default_year: int) -> str:
    """Parse a transactions-table date cell to ISO YYYY-MM-DD.

    NFL.com uses "M/D" inside a month page (no year) and occasionally
    "M/D/YYYY" on rollup views. Falls back to today on unparseable input
    so we still emit a row rather than silently dropping it.
    """
    raw = (text or "").strip()
    if not raw:
        return ""
    for fmt in ("%m/%d/%Y", "%m/%d/%y", "%B %d, %Y", "%b %d, %Y"):
        try:
            return dt.datetime.strptime(raw, fmt).date().isoformat()
        except ValueError:
            continue
    try:
        # Append the page year so strptime doesn't have to invent one — silences
        # the Py3.15 ambiguous-year deprecation warning.
        d = dt.datetime.strptime(f"{raw}/{default_year}", "%m/%d/%Y").date()
        return d.isoformat()
    except ValueError:
        return raw


# === HTML fetch + parse ====================================================

def _fetch(url: str) -> str:
    req = urllib.request.Request(url, headers={
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8", errors="replace")


# Pull the transaction table out of the page without depending on
# BeautifulSoup. NFL.com's category pages render a single
# `<table class="d3-o-table ...">` whose tbody contains one <tr> per
# transaction. The HTML is well-formed and the column count is fixed, so
# a regex pass is good enough and keeps the GitHub Action's pip install
# down to zero packages.
_TABLE_RE = re.compile(
    r'<table[^>]*class="[^"]*d3-o-table[^"]*"[^>]*>(.*?)</table>',
    re.S,
)
_THEAD_RE = re.compile(r"<thead.*?>(.*?)</thead>", re.S)
_TBODY_RE = re.compile(r"<tbody.*?>(.*?)</tbody>", re.S)
_TR_RE = re.compile(r"<tr.*?>(.*?)</tr>", re.S)
_TH_RE = re.compile(r"<th.*?>(.*?)</th>", re.S)
_TD_RE = re.compile(r"<td.*?>(.*?)</td>", re.S)
_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(html: str) -> str:
    return _normalize_cell(_TAG_RE.sub(" ", html or ""))


def _parse_table(html: str) -> tuple[list[str], list[list[str]]]:
    """Return (headers, rows). Empty if the page has no transactions table."""
    m = _TABLE_RE.search(html)
    if not m:
        return [], []
    table = m.group(1)

    headers: list[str] = []
    thead = _THEAD_RE.search(table)
    if thead:
        for th in _TH_RE.findall(thead.group(1)):
            headers.append(_strip_html(th).lower())

    rows: list[list[str]] = []
    tbody = _TBODY_RE.search(table)
    if not tbody:
        return headers, rows
    for tr in _TR_RE.findall(tbody.group(1)):
        cells = [_strip_html(td) for td in _TD_RE.findall(tr)]
        if cells:
            rows.append(cells)
    return headers, rows


# === Main ==================================================================

HEADERS = [
    "date", "season", "description", "descriptionAbbr", "transactionType",
    "position", "teamId", "smartId", "teamAbbr", "teamName",
    "person_id", "person_firstName", "person_lastName", "person_displayName",
    "person_gsisId", "person_headshot",
    "sourceTeam_id", "sourceTeam_fullName", "sourceTeam_logo",
    "destinationTeam_id", "destinationTeam_fullName", "destinationTeam_logo",
]


def _row(date: str, season: str, description: str, tx_type: str,
         position: str, team_abbr: str, team_full: str,
         first: str, last: str, full_name: str,
         from_abbr: str, from_full: str,
         to_abbr: str, to_full: str) -> list[str]:
    return [
        date, season, description, "", tx_type,
        position, "", "", team_abbr, team_full,
        "", first, last, full_name,
        "", "",
        "", from_full, "",
        "", to_full, "",
    ]


def main() -> int:
    today = dt.datetime.now(dt.timezone.utc).date()
    months = _months_to_pull(today, LOOKBACK_MONTHS)
    season = str(today.year)

    rows: list[list[str]] = []
    seen: set[tuple[str, ...]] = set()  # (date, name, tx_type, team) dedupe
    pages_fetched = 0
    pages_empty = 0

    for year, month in months:
        for category, tx_type in CATEGORY_TO_TYPE.items():
            url = f"https://www.nfl.com/transactions/league/{category}/{year}/{month}"
            try:
                html = _fetch(url)
                pages_fetched += 1
            except urllib.error.URLError as e:
                print(f"  warn: {url} fetch failed: {e}", file=sys.stderr)
                continue
            except Exception as e:
                print(f"  warn: {url} unexpected error: {e}", file=sys.stderr)
                continue

            headers, table_rows = _parse_table(html)
            if not table_rows:
                pages_empty += 1
                time.sleep(REQUEST_DELAY_SEC)
                continue

            # Build column index by header name. Missing optional columns
            # (e.g. "position", "from") just stay absent.
            idx = {h: i for i, h in enumerate(headers)}
            date_i = idx.get("date")
            name_i = idx.get("name")
            tx_i = idx.get("transaction")
            pos_i = idx.get("position")
            from_i = idx.get("from")
            to_i = idx.get("to")
            if date_i is None or name_i is None or tx_i is None:
                continue

            for cells in table_rows:
                if len(cells) <= max(date_i, name_i, tx_i):
                    continue
                date_text = cells[date_i]
                name_text = cells[name_i]
                tx_text = cells[tx_i]
                if not date_text or not name_text or not tx_text:
                    continue

                position = cells[pos_i] if pos_i is not None and pos_i < len(cells) else ""
                from_text = cells[from_i] if from_i is not None and from_i < len(cells) else ""
                to_text = cells[to_i] if to_i is not None and to_i < len(cells) else ""
                from_abbr = _team_abbr(from_text)
                to_abbr = _team_abbr(to_text)
                from_full = _team_full(from_abbr) if from_abbr else (from_text if from_text != "--" else "")
                to_full = _team_full(to_abbr) if to_abbr else (to_text if to_text != "--" else "")

                # The team this transaction "belongs to" is the destination
                # if it exists, otherwise the source. For a release the
                # destination is "--" (FA), so we attribute the row to the
                # releasing club.
                team_abbr = to_abbr or from_abbr
                team_full = to_full or from_full

                iso_date = _parse_date(date_text, default_year=year)

                parts = name_text.split(" ", 1)
                first = parts[0]
                last = parts[1] if len(parts) > 1 else ""

                # Build a clean per-player description. The frontend uses
                # this string as the warning detail, and NFL.com's rows are
                # already per-player, so it stays tightly scoped.
                desc_bits = [tx_text]
                if from_text and from_text != "--" and to_text and to_text != "--" and from_text != to_text:
                    desc_bits.append(f"{from_text} → {to_text}")
                description = f"{name_text}: " + "; ".join(desc_bits)

                dedupe_key = (iso_date, name_text.lower(), tx_type, team_abbr)
                if dedupe_key in seen:
                    continue
                seen.add(dedupe_key)

                rows.append(_row(
                    iso_date, season, description, tx_type,
                    position, team_abbr, team_full,
                    first, last, name_text,
                    from_abbr, from_full,
                    to_abbr, to_full,
                ))

            time.sleep(REQUEST_DELAY_SEC)

    # Newest first, capped.
    rows.sort(key=lambda r: r[0], reverse=True)
    rows = rows[:KEEP_ROWS]

    payload = {
        "headers": HEADERS,
        "rows": rows,
        "source": "nfl.com",
        "nflcom_categories": list(CATEGORY_TO_TYPE.keys()),
        "lookback_months": LOOKBACK_MONTHS,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "pages_fetched": pages_fetched,
        "pages_empty": pages_empty,
        "parsed_events": len(rows),
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"Fetched {pages_fetched} pages ({pages_empty} empty).")
    print(f"Parsed {len(rows)} transactions.")
    print(f"Wrote {OUTPUT_PATH} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
