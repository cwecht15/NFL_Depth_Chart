"""Fetch NFL transactions from ESPN's public site API → transactions.json.

The Transactions_New tab in the workbook is whatever upstream feed someone
configured; in practice it's been very stale. ESPN publishes its own
transactions list as a no-auth JSON endpoint that's typically current to
the prior business day. This script paginates that endpoint, parses each
team-day description into per-player events, and writes the result.

The output schema mirrors what pull_snapshot.py emits for transactions, so
the frontend's existing warning logic works unchanged. The frontend prefers
this file when present; the snapshot's Transactions_New section is a
fallback.

Schema:
    {
      "headers": ["date","season","description","descriptionAbbr",
                  "transactionType","position","teamId","smartId","teamAbbr",
                  "teamName","person_id","person_firstName","person_lastName",
                  "person_displayName","person_gsisId","person_headshot",
                  "sourceTeam_id","sourceTeam_fullName","sourceTeam_logo",
                  "destinationTeam_id","destinationTeam_fullName",
                  "destinationTeam_logo"],
      "rows":    [[...], ...],   # newest first
      "source":  "espn",
      "generated_at": "...Z",
      "raw_records": 665,
      "parsed_events": 712,
      "unparsed_sentences": 18
    }
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

ESPN_URL    = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/transactions"
USER_AGENT  = "Mozilla/5.0 (compatible; DepthChartBot/1.0)"
OUTPUT_PATH = Path(__file__).resolve().parent.parent / "docs" / "data" / "transactions.json"

MAX_PAGES = 40   # safety cap; ESPN currently has ~27 pages
KEEP_ROWS = 3000 # cap on emitted per-player events

# === Parsing ==============================================================

POSITION = r"(?:QB|RB|FB|HB|WR|TE|OT|T|OG|G|OL|C|DE|DT|NT|DL|LB|OLB|ILB|MLB|EDGE|CB|S|SS|FS|DB|NB|P|K|LS|H)s?"

# A "real" name token: starts with capital, has at least one lowercase, can
# contain apostrophes / hyphens / periods. Or an initial like "A." / "A.J."
NAME_PART = r"[A-Z][a-z][a-zA-Z'.\-]*"
INITIAL   = r"[A-Z]\.(?:[A-Z]\.)?"
NAME_TOKEN = rf"(?:{NAME_PART}|{INITIAL})"
NAME = rf"{NAME_TOKEN}(?:\s+{NAME_TOKEN})*(?:\s+(?:Jr\.?|Sr\.?|II|III|IV|V))?"

# Verb → canonical transactionType (matches the existing frontend warning logic).
VERB_RULES = [
    (re.compile(r"^(?:re-?)?signed\b", re.I),                                                "signings"),
    (re.compile(r"^claimed\b", re.I),                                                         "signings"),
    (re.compile(r"^waived\b", re.I),                                                          "waivers"),
    (re.compile(r"^released\b", re.I),                                                        "released"),
    (re.compile(r"^placed\b.*(?:injured reserve|reserve/injured|reserve/retired|reserve/non[- ]?football)", re.I), "reserve-list"),
    (re.compile(r"^placed\b.*practice squad", re.I),                                          "practice-squad"),
    (re.compile(r"^placed\b.*exempt", re.I),                                                  "other"),
    (re.compile(r"^activated\b", re.I),                                                       "activations"),
    (re.compile(r"^designated.*return", re.I),                                                "activations"),
    (re.compile(r"^(?:traded|acquired|completed)\b", re.I),                                   "trades"),
    (re.compile(r"^suspended\b", re.I),                                                       "suspensions"),
    (re.compile(r"^extended\b", re.I),                                                        "signings"),
    (re.compile(r"^terminated\b", re.I),                                                      "released"),
]

# Single leading verb that the player extractor strips so it doesn't accidentally
# match the verb tokens as names.
VERB_PREFIX = re.compile(
    r"^(?:re-?signed|signed|waived|released|claimed|placed|activated|designated|traded|acquired|completed|suspended|extended|terminated)\s+",
    re.I,
)

PLAYER_RE = re.compile(rf"\b(?:{POSITION}\s+)?({NAME})")
POSITION_ONLY_RE = re.compile(rf"^{POSITION}$")


def _classify(sent: str):
    s = sent.strip()
    for rx, kind in VERB_RULES:
        if rx.search(s):
            return kind
    return None


def _split_sentences(desc: str) -> list[str]:
    # Split on period followed by space + capital (or end-of-string). This
    # keeps "Jr." and abbreviations like "A.J." intact since they're followed
    # by a lowercase or another period, not a Capital+space.
    parts = re.split(r"\.(?=\s+[A-Z]|$)", desc)
    return [p.strip().rstrip(".") for p in parts if p and p.strip()]


def _extract_players(sent: str) -> list[str]:
    body = VERB_PREFIX.sub("", sent, count=1)
    out: list[str] = []
    seen: set[str] = set()
    for m in PLAYER_RE.finditer(body):
        name = m.group(1).strip()
        # Skip captures that are just a position abbreviation (e.g., "DTs").
        if POSITION_ONLY_RE.match(name):
            continue
        # Skip captures that look like multi-token but the first token is a
        # position abbreviation (e.g., "DTs Skyler Gill-Howard" with NAME
        # accidentally swallowing the position).
        if " " in name and POSITION_ONLY_RE.match(name.split(" ", 1)[0]):
            continue
        if name in seen:
            continue
        seen.add(name)
        out.append(name)
    return out


# === ESPN fetch ==========================================================

def _fetch_page(page: int) -> dict:
    url = f"{ESPN_URL}?page={page}&limit=25"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def _fetch_all() -> tuple[list[dict], dict]:
    """Returns (transactions, last_response_meta)."""
    all_txs: list[dict] = []
    page = 1
    meta = {}
    while page <= MAX_PAGES:
        data = _fetch_page(page)
        meta = {
            "timestamp": data.get("timestamp"),
            "season": data.get("season"),
            "count":  data.get("count"),
            "pageCount": data.get("pageCount"),
        }
        all_txs.extend(data.get("transactions") or [])
        page_count = data.get("pageCount") or 0
        if page >= page_count:
            break
        page += 1
    return all_txs, meta


# === Main ================================================================

HEADERS = [
    "date", "season", "description", "descriptionAbbr", "transactionType",
    "position", "teamId", "smartId", "teamAbbr", "teamName",
    "person_id", "person_firstName", "person_lastName", "person_displayName",
    "person_gsisId", "person_headshot",
    "sourceTeam_id", "sourceTeam_fullName", "sourceTeam_logo",
    "destinationTeam_id", "destinationTeam_fullName", "destinationTeam_logo",
]


def _row_for(event_date: str, season: str, sent: str, kind: str,
             team: dict, player: str) -> list[str]:
    # Split player into first/last for downstream consumers; this is rough,
    # but the warnings logic primarily uses displayName.
    parts = player.split(" ")
    first = parts[0] if parts else ""
    last  = " ".join(parts[1:]) if len(parts) > 1 else ""
    return [
        event_date, season, sent, "", kind,
        "", str(team.get("id") or ""), "", team.get("abbreviation") or "",
        team.get("displayName") or "",
        "", first, last, player,
        "", "",
        "", "", "",
        "", "", "",
    ]


def main() -> int:
    try:
        records, meta = _fetch_all()
    except urllib.error.URLError as e:
        print(f"ESPN fetch failed: {e}", file=sys.stderr)
        return 1
    print(f"Fetched {len(records)} team-day rows ({meta.get('count')} reported by ESPN).", flush=True)

    rows: list[list[str]] = []
    n_parsed = 0
    n_unparsed = 0
    season = str((meta.get("season") or {}).get("year") or "")

    for rec in records:
        team = rec.get("team") or {}
        date = (rec.get("date") or "")[:10]
        desc = rec.get("description") or ""
        for sent in _split_sentences(desc):
            kind = _classify(sent)
            if not kind:
                continue
            players = _extract_players(sent)
            if not players:
                n_unparsed += 1
                continue
            for p in players:
                rows.append(_row_for(date, season, sent, kind, team, p))
                n_parsed += 1

    # Newest-first, capped.
    rows.sort(key=lambda r: r[0], reverse=True)
    rows = rows[:KEEP_ROWS]

    payload = {
        "headers": HEADERS,
        "rows": rows,
        "source": "espn",
        "espn_endpoint": ESPN_URL,
        "espn_timestamp": meta.get("timestamp"),
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
        "raw_records": len(records),
        "parsed_events": n_parsed,
        "unparsed_sentences": n_unparsed,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(
        json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    size_kb = OUTPUT_PATH.stat().st_size / 1024
    print(f"Parsed {n_parsed} player events; {n_unparsed} sentences skipped.")
    print(f"Wrote {OUTPUT_PATH} ({size_kb:.1f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
