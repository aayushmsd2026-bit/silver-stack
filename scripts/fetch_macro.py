#!/usr/bin/env python3
"""Fetch the US macro picture behind silver prices for the Fed tab.

Writes data/macro.json with:
  fed        - Fed funds target range, effective rate, last decision, every change since 2015
  meetings   - upcoming FOMC meeting dates (federalreserve.gov)
  market     - what bonds are pricing: 3-month T-bill and 2-year yield vs. the fed funds rate
  inflation  - CPI and core CPI, year on year
  realYield  - 10-year TIPS real yield
  dollar     - broad trade-weighted US dollar index
  quarterly  - 2018 onward: Fed funds (quarter end), silver $/oz and USD/NPR (quarterly averages)

Sources: FRED (St. Louis Fed) CSV downloads, the Fed's FOMC calendar page, and Yahoo Finance for
monthly silver futures closes. Each block falls back to the previous file's value if its source fails,
so one outage never blanks the page. Standard library only.

Runs from the price workflow; skips itself if data/macro.json is under 6 hours old (use --force).
"""
from __future__ import annotations

import csv
import io
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "macro.json"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) silver-stack macro bot"
START_Q = 2018
INR_PEG = 1.6  # NPR per INR, fixed by Nepal Rastra Bank
MONTHS = ["January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December"]


def log(*a):
    print(*a, file=sys.stderr)


def notice(msg: str, level: str = "notice"):
    print(f"::{level}::{msg}".replace("\n", " "), flush=True)


def get(url: str, timeout: int = 30) -> str:
    req = Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def fred(series: str, start: str = "2015-01-01") -> list[tuple[str, float]]:
    """Return [(YYYY-MM-DD, value)] for a FRED series, skipping blanks ('.')."""
    text = get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}&cosd={start}")
    rows = []
    for r in csv.reader(io.StringIO(text)):
        if len(r) < 2 or not re.match(r"\d{4}-\d{2}-\d{2}$", r[0]):
            continue
        try:
            rows.append((r[0], float(r[1])))
        except ValueError:
            pass
    if not rows:
        raise ValueError(f"{series}: no data")
    return rows


def value_on_or_before(rows, day: str):
    v = None
    for d, x in rows:
        if d > day:
            break
        v = x
    return v


def change_over(rows, days: int):
    last_d, last_v = rows[-1]
    target = (date.fromisoformat(last_d) - timedelta(days=days)).isoformat()
    prev = value_on_or_before(rows, target)
    return (last_v - prev) if prev is not None else None


def quarter(d: str) -> str:
    return f"{d[:4]} Q{(int(d[5:7]) - 1) // 3 + 1}"


def quarter_labels(today: date) -> list[str]:
    cur = quarter(today.isoformat())
    out = []
    for y in range(START_Q, today.year + 1):
        for q in range(1, 5):
            lab = f"{y} Q{q}"
            out.append(lab)
            if lab == cur:
                return out
    return out


def quarterly_avg(rows, labels):
    acc: dict[str, list[float]] = {}
    for d, v in rows:
        acc.setdefault(quarter(d), []).append(v)
    return [round(sum(acc[q]) / len(acc[q]), 3) if q in acc else None for q in labels]


# --------------------------------------------------------------------------- blocks
def block_fed():
    upper, lower, effr = fred("DFEDTARU"), fred("DFEDTARL"), fred("DFF", "2024-01-01")
    lower_map = dict(lower)
    changes, prev = [], None
    for d, u in upper:
        if prev is None or u != prev:
            changes.append([d, lower_map.get(d, u - 0.25), u])
        prev = u
    last = changes[-1]
    before = changes[-2] if len(changes) > 1 else None
    return {
        "lo": lower[-1][1], "hi": upper[-1][1], "effr": effr[-1][1], "asOf": upper[-1][0],
        "lastChange": {"date": last[0], "bps": round((last[2] - before[2]) * 100) if before else 0},
        "changes": changes[1:],  # first row is just the start of the window
        "_upper": upper,
    }


def block_meetings(today: date):
    html = get("https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm")
    meetings = []
    for seg in re.split(r'<div class="panel-heading">', html)[1:]:
        head = re.search(r"(\d{4}) FOMC Meetings", seg[:300])
        if not head:
            continue
        year = int(head.group(1))
        months = re.findall(r'fomc-meeting__month[^>]*>(?:\s*<[^>]+>)*\s*([A-Za-z/]+)', seg)
        days = re.findall(r'fomc-meeting__date[^>]*>\s*(\d+)(?:-(\d+))?(\*?)', seg)
        for mon, (d1, d2, star) in zip(months, days):
            parts = mon.split("/")
            try:
                m1 = next(i for i, n in enumerate(MONTHS, 1) if n.lower()[:3] == parts[0].lower()[:3])
                m2 = next(i for i, n in enumerate(MONTHS, 1) if n.lower()[:3] == parts[-1].lower()[:3])
            except StopIteration:
                continue
            start = date(year, m1, int(d1))
            end = date(year + (1 if m2 < m1 else 0), m2, int(d2 or d1))
            meetings.append({"start": start.isoformat(), "end": end.isoformat(), "sep": bool(star)})
    meetings.sort(key=lambda x: x["start"])
    upcoming = [x for x in meetings if x["end"] >= today.isoformat()]
    if not upcoming:
        raise ValueError("no upcoming meetings parsed")
    return {"next": upcoming[0], "upcoming": upcoming[:4]}


def block_market(effr: float):
    t3, y2 = fred("DGS3MO", "2025-01-01"), fred("DGS2", "2025-01-01")
    spread = t3[-1][1] - effr
    if spread >= 0.15:
        bias, expected = "hike", 25
    elif spread <= -0.15:
        bias, expected = "cut", -25
    else:
        bias, expected = "hold", 0
    strength = "strongly " if abs(spread) >= 0.35 else ""
    return {
        "t3m": t3[-1][1], "y2": y2[-1][1], "asOf": t3[-1][0], "spread": round(spread, 3),
        "y2Change30": change_over(y2, 30),
        "bias": bias, "expectedBps": expected,
        "label": {"hike": f"Markets {strength}lean toward a hike",
                  "cut": f"Markets {strength}lean toward a cut",
                  "hold": "Markets expect a hold"}[bias],
    }


def block_inflation():
    def yoy(rows):
        last_d, last_v = rows[-1]
        y, m = int(last_d[:4]), int(last_d[5:7])
        ago = value_on_or_before(rows, f"{y - 1}-{m:02d}-01")
        prev_d = rows[-2][0]
        py, pm = int(prev_d[:4]), int(prev_d[5:7])
        prev_ago = value_on_or_before(rows, f"{py - 1}-{pm:02d}-01")
        return last_d, (last_v / ago - 1) * 100, (rows[-2][1] / prev_ago - 1) * 100

    d, cpi, cpi_prev = yoy(fred("CPIAUCSL", "2023-01-01"))
    _, core, _ = yoy(fred("CPILFESL", "2023-01-01"))
    label = "hot" if cpi >= 3.5 else "sticky" if cpi >= 2.7 else "cooling" if cpi >= 2.2 else "near target"
    return {"cpi": round(cpi, 2), "core": round(core, 2), "prev": round(cpi_prev, 2), "month": d[:7], "label": label}


def block_real_yield():
    r = fred("DFII10", "2025-01-01")
    return {"value": r[-1][1], "asOf": r[-1][0], "change30": change_over(r, 30)}


def block_dollar():
    r = fred("DTWEXBGS", "2025-01-01")
    ch = change_over(r, 30)
    return {"value": round(r[-1][1], 2), "asOf": r[-1][0],
            "change30Pct": round(ch / (r[-1][1] - ch) * 100, 2) if ch is not None else None}


def silver_monthly():
    j = json.loads(get("https://query1.finance.yahoo.com/v8/finance/chart/SI=F?range=10y&interval=1mo"))
    res = j["chart"]["result"][0]
    closes = res["indicators"]["quote"][0]["close"]
    rows = []
    for ts, c in zip(res["timestamp"], closes):
        if c:
            rows.append((datetime.fromtimestamp(ts, timezone.utc).date().isoformat(), float(c)))
    if len(rows) < 24:
        raise ValueError("too few silver points")
    return rows


def block_quarterly(today: date, fed_upper, old):
    labels = quarter_labels(today)
    q_end = []
    for lab in labels:
        y, q = int(lab[:4]), int(lab[-1])
        end = date(y, q * 3, 1) + timedelta(days=32)
        end = (end.replace(day=1) - timedelta(days=1)).isoformat()
        q_end.append(value_on_or_before(fed_upper, min(end, today.isoformat())))
    out = {"labels": labels, "fed": q_end}
    old_q = old.get("quarterly") or {}
    try:
        out["xag"] = quarterly_avg(silver_monthly(), labels)
    except Exception as e:  # noqa: BLE001
        notice(f"silver history failed: {e}", "warning")
        out["xag"] = old_q.get("xag")
    try:
        inr = fred("DEXINUS", f"{START_Q}-01-01")
        out["usdnpr"] = [round(v * INR_PEG, 2) if v else None for v in quarterly_avg(inr, labels)]
    except Exception as e:  # noqa: BLE001
        notice(f"INR history failed: {e}", "warning")
        out["usdnpr"] = old_q.get("usdnpr")
    return out


# --------------------------------------------------------------------------- main
def main():
    force = "--force" in sys.argv
    old = {}
    try:
        old = json.loads(OUT.read_text())
    except Exception:  # noqa: BLE001
        pass
    if not force and old.get("fetchedAt"):
        age = datetime.now(timezone.utc) - datetime.fromisoformat(old["fetchedAt"])
        if age < timedelta(hours=6):
            log(f"macro.json is {age} old - skipping (use --force)")
            return

    today = datetime.now(timezone.utc).date()
    out = {"source": "FRED (St. Louis Fed), federalreserve.gov, Yahoo Finance"}
    errors = []

    def run(key, fn, *a):
        try:
            out[key] = fn(*a)
        except Exception as e:  # noqa: BLE001
            errors.append(f"{key}: {e}")
            notice(f"{key} failed: {e}", "warning")
            if key in old:
                out[key] = old[key]

    run("fed", block_fed)
    fed_upper = out.get("fed", {}).pop("_upper", None)
    run("meetings", block_meetings, today)
    if out.get("fed"):
        run("market", block_market, out["fed"]["effr"])
    run("inflation", block_inflation)
    run("realYield", block_real_yield)
    run("dollar", block_dollar)
    if fed_upper:
        run("quarterly", block_quarterly, today, fed_upper, old)
    elif "quarterly" in old:
        out["quarterly"] = old["quarterly"]

    if "fed" not in out:
        log("No Fed data at all:", errors)
        sys.exit(0 if old else 1)
    out["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if errors:
        out["warnings"] = errors
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps(out, separators=(",", ":")) + "\n")
    notice(f"macro: fed {out['fed']['lo']}-{out['fed']['hi']}%, next FOMC "
           f"{out.get('meetings', {}).get('next', {}).get('end')}, market {out.get('market', {}).get('bias')}, "
           f"CPI {out.get('inflation', {}).get('cpi')}%")


if __name__ == "__main__":
    main()
