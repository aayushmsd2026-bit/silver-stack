#!/usr/bin/env python3
"""Fetch Nepal gold & silver rates (FENEGOSIDA) plus international spot prices.

Writes:
  data/prices.json   - the latest snapshot the app reads on load
  data/history.json  - daily per-tola rates, merged and grown over time

Sources, in order of preference for Nepal rates:
  1. FENEGOSIDA JSON API (api.fenegosida.org) - the official association rate
  2. hamropatro.com/gold   (mirrors FENEGOSIDA)
  3. ashesh.com.np widget  (mirrors FENEGOSIDA)

Only the Python standard library is used so the GitHub Action needs no installs.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
NPT = timezone(timedelta(hours=5, minutes=45))
UA = "Mozilla/5.0 (silver-stack price bot; +https://github.com)"
FEN_API = "https://api.fenegosida.org/api/website/v1/Dashboard"
MONTHS = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def log(*a):
    print(*a, file=sys.stderr)


def get(url: str, timeout: int = 25) -> str:
    req = Request(url, headers={"User-Agent": UA, "Accept": "application/json, text/html;q=0.9"})
    with urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def get_json(url: str):
    return json.loads(get(url))


def npt_date(iso: str | None = None) -> str:
    if iso:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if dt.tzinfo is None:  # FENEGOSIDA sends local timestamps without offset
            dt = dt.replace(tzinfo=NPT)
    else:
        dt = datetime.now(timezone.utc)
    return dt.astimezone(NPT).strftime("%Y-%m-%d")


def sane(gold: float, silver: float) -> bool:
    return gold and silver and gold > 10_000 and silver > 100 and gold / silver > 20


# --------------------------------------------------------------------------- FENEGOSIDA
def fetch_fenegosida():
    rates = get_json(f"{FEN_API}/today")
    log("fenegosida/today:", json.dumps(rates, ensure_ascii=False)[:600])
    if not isinstance(rates, list) or not rates:
        raise ValueError("empty response")

    def find(metal, unit):
        for r in rates:
            t = r.get("rateType") or ""
            if metal in t and unit in t:
                return r
        return None

    gt, gg = find("सुन", "तोला"), find("सुन", "ग्राम")
    st, sg = find("चाँदी", "तोला"), find("चाँदी", "ग्राम")
    if not gt or not st:
        raise ValueError("rate rows not found")
    gold, silver = gt["todayBaseRatePerGram"], st["todayBaseRatePerGram"]
    if not sane(gold, silver):
        raise ValueError(f"suspicious rates gold={gold} silver={silver}")
    date = npt_date(gt.get("todayDate"))
    snap = {
        "source": "FENEGOSIDA",
        "date": date,
        "gold": {"tola": gold, "g10": (gg or {}).get("todayBaseRatePerGram"),
                 "prevTola": gt.get("yestardayBaseRatePerGram") or None},
        "silver": {"tola": silver, "g10": (sg or {}).get("todayBaseRatePerGram"),
                   "prevTola": st.get("yestardayBaseRatePerGram") or None},
    }

    # History (nice to have). Try the longest window the API accepts.
    hist = {"gold": {}, "silver": {}}
    for span in (365, 180, 90, 30, 7):
        try:
            chart = get_json(f"{FEN_API}/WeeklyChartRate?weekmonthyear={span}")
        except Exception as e:  # noqa: BLE001
            log(f"chart span {span} failed: {e}")
            continue
        n = 0
        for metal, key in (("gold", "goldData"), ("silver", "silverData")):
            for e in chart.get(key) or []:
                # Saturdays (market holiday) are forward-filled by the API - skip them.
                if e.get("day") == "Saturday" or not e.get("tola") or e.get("month") not in MONTHS:
                    continue
                d = f"{e['year']}-{MONTHS[e['month']]:02d}-{int(e['date']):02d}"
                if d <= date:
                    hist[metal][d] = e["tola"]
                    n += 1
        log(f"chart span {span}: {n} points")
        if n:
            break
    return snap, hist


# --------------------------------------------------------------------------- Hamro Patro
def fetch_hamropatro():
    html = get("https://www.hamropatro.com/gold")
    chunks = []
    for m in re.finditer(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)', html):
        try:
            chunks.append(json.loads(m.group(1)))
        except Exception:  # noqa: BLE001
            pass
    flight = "".join(chunks)
    key = '"enSegment":'
    start = flight.find(key)
    if start < 0:
        raise ValueError("segment not found")
    seg = json.JSONDecoder().raw_decode(flight[start + len(key):])[0]

    def item(rx):
        return next((i for i in seg["items"] if re.search(rx, i.get("symbol", ""), re.I)), None)

    def price(it, rx):
        return next((p for p in (it or {}).get("prices", []) if re.search(rx, p["name"], re.I)), None)

    g, s = item("HAL+MARK"), item("SILVER")
    gt, gg, st, sg = price(g, "tola"), price(g, "gm|gram"), price(s, "tola"), price(s, "gm|gram")
    gold, silver = gt["price"]["price"], st["price"]["price"]
    if not sane(gold, silver):
        raise ValueError("suspicious rates")
    hist = {"gold": {}, "silver": {}}
    for metal, p in (("gold", gt), ("silver", st)):
        for h in p.get("history") or []:
            if h.get("price"):
                hist[metal][h["date"][:10]] = h["price"]

    def prev(metal):
        days = sorted(hist[metal])
        return hist[metal][days[-2]] if len(days) >= 2 else None

    return {
        "source": "Hamro Patro (FENEGOSIDA rate)",
        "date": (gt["price"].get("date") or seg.get("date") or npt_date())[:10],
        "gold": {"tola": gold, "g10": gg and gg["price"]["price"], "prevTola": prev("gold")},
        "silver": {"tola": silver, "g10": sg and sg["price"]["price"], "prevTola": prev("silver")},
    }, hist


# --------------------------------------------------------------------------- Ashesh
def fetch_ashesh():
    html = get("https://www.ashesh.com.np/gold/widget.php?api=402137q239&header_color=0077e5")
    rows = re.findall(
        r'class="name"[^>]*>(.*?)<.*?class="rate_buying"[^>]*>\s*([\d,]+)', html, re.S | re.I)
    rows = [(re.sub(r"<.*?>", "", n).strip().lower(), int(p.replace(",", ""))) for n, p in rows]
    if len(rows) < 6:
        raise ValueError("widget rows not found")
    tola, gram = rows[:3], rows[3:6]

    def pick(rs, label, i):
        return next((p for n, p in rs if label in n), rs[i][1])

    gold, silver = pick(tola, "hallmark", 0), pick(tola, "silver", 2)
    if not sane(gold, silver):
        raise ValueError("suspicious rates")
    return {
        "source": "Ashesh (FENEGOSIDA rate)",
        "date": npt_date(),
        "gold": {"tola": gold, "g10": pick(gram, "hallmark", 0), "prevTola": None},
        "silver": {"tola": silver, "g10": pick(gram, "silver", 2), "prevTola": None},
    }, {"gold": {}, "silver": {}}


# --------------------------------------------------------------------------- International
def fetch_international():
    out = {}
    try:
        out["xau"] = float(get_json("https://api.gold-api.com/price/XAU")["price"])
        out["xag"] = float(get_json("https://api.gold-api.com/price/XAG")["price"])
    except Exception as e:  # noqa: BLE001
        log("gold-api failed:", e)
    try:
        today = datetime.now(NPT).date()
        url = ("https://www.nrb.org.np/api/forex/v1/rates?page=1&per_page=10"
               f"&from={today - timedelta(days=7)}&to={today}")
        payload = get_json(url)["data"]["payload"]
        for day in sorted(payload, key=lambda d: d["date"], reverse=True):
            usd = next((r for r in day["rates"] if r["currency"]["iso3"] == "USD"), None)
            if usd:
                out["usdnpr"] = float(usd["sell"])
                break
    except Exception as e:  # noqa: BLE001
        log("NRB failed:", e)
    if "usdnpr" not in out:
        try:
            j = get_json("https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json")
            out["usdnpr"] = float(j["usd"]["npr"])
        except Exception as e:  # noqa: BLE001
            log("fx fallback failed:", e)
    return out or None


# --------------------------------------------------------------------------- main
def load(path: Path, default):
    try:
        return json.loads(path.read_text())
    except Exception:  # noqa: BLE001
        return default


def main():
    DATA.mkdir(exist_ok=True)
    snap = hist = None
    errors = []
    for name, fn in (("fenegosida", fetch_fenegosida), ("hamropatro", fetch_hamropatro), ("ashesh", fetch_ashesh)):
        try:
            snap, hist = fn()
            log(f"OK from {name}: silver={snap['silver']['tola']} gold={snap['gold']['tola']} date={snap['date']}")
            break
        except Exception as e:  # noqa: BLE001
            errors.append(f"{name}: {e}")
            log(f"{name} failed: {e}")

    old = load(DATA / "prices.json", {})
    history = load(DATA / "history.json", {"gold": [], "silver": [], "intl": []})
    intl = fetch_international()

    if snap is None:
        log("All Nepal sources failed:", errors)
        if not old.get("silver"):
            sys.exit(1)
        snap = {k: old[k] for k in ("source", "date", "gold", "silver")}
        snap["stale"] = True

    # Merge history: existing + source history + today's rate.
    for metal in ("gold", "silver"):
        merged = {d: p for d, p in history.get(metal, [])}
        merged.update((hist or {}).get(metal, {}))
        merged[snap["date"]] = snap[metal]["tola"]
        history[metal] = sorted([d, p] for d, p in merged.items())
        # Fill a missing "yesterday" from history.
        if not snap[metal].get("prevTola") and len(history[metal]) >= 2:
            snap[metal]["prevTola"] = history[metal][-2][1]

    if intl and intl.get("xau") and intl.get("xag"):
        rows = {r[0]: r for r in history.get("intl", [])}
        rows[npt_date()] = [npt_date(), intl["xau"], intl["xag"], intl.get("usdnpr")]
        history["intl"] = sorted(rows.values())

    snap["intl"] = intl or old.get("intl")
    snap["fetchedAt"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    if errors:
        snap["warnings"] = errors

    # Only rewrite prices.json when something material changed, to keep commits meaningful.
    def material(s):
        return json.dumps({k: s.get(k) for k in ("date", "gold", "silver", "source")}, sort_keys=True)

    intl_moved = not old.get("intl") or not intl or any(
        abs((intl.get(k) or 0) - (old["intl"].get(k) or 0)) / max(old["intl"].get(k) or 1, 1) > 0.002
        for k in ("xau", "xag"))
    if material(snap) != material(old) or intl_moved:
        (DATA / "prices.json").write_text(json.dumps(snap, ensure_ascii=False, indent=1) + "\n")
        log("prices.json updated")
    (DATA / "history.json").write_text(json.dumps(history, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
