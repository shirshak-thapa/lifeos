"""Plain Python (no AI): storage, validation, quote verification and the rules that apply AI verdicts."""
import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta, timezone

import settings

# One lock around every load -> modify -> save, so two requests never overwrite each other.
LOCK = threading.RLock()
VERSION = 2


# ---------- storage (one JSON file, written atomically) ----------

def atomic_write(path, obj):
    """Write to a temp file first, then swap it in, so a crash never leaves a half-written file."""
    tmp = f"{path}.{os.getpid()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=1, ensure_ascii=False, sort_keys=path == settings.CACHE_FILE)
    for attempt in range(5):  # Windows can briefly lock a file that is being read
        try:
            os.replace(tmp, path)
            return
        except PermissionError:
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


def empty_db():
    return {"version": VERSION, "files": [], "items": [], "next_id": 1, "next_file": 1, "order": 0, "seen": {}}


def load():
    try:
        with open(settings.DATA_FILE, encoding="utf-8") as f:
            db = json.load(f)
    except (OSError, ValueError):
        return empty_db()
    if not isinstance(db, dict) or db.get("version") != VERSION:
        return empty_db()  # data from an older LifeOS version: start fresh
    return db


def save(db):
    atomic_write(settings.DATA_FILE, db)


def reset():
    with LOCK:
        save(empty_db())


# ---------- validation: never trust model output ----------

def clean_text(value, limit, collapse=True):
    if value is None or isinstance(value, (dict, list, bool)):
        return None
    s = str(value).strip()
    if collapse:
        s = re.sub(r"\s+", " ", s)
    if s.lower() in ("", "null", "none", "n/a", "unknown", "tbd"):
        return None
    return s[:limit]


MONTHS = {m: n for n, m in enumerate(("jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"), 1)}


def _make_date(year, month, day, today):
    """A real calendar date, or None. With no year: the next time it happens (the last 30 days still count)."""
    if year is not None:
        year = int(year)
        year = year + 2000 if year < 100 else year
        return date(year, month, day)
    for y in (today.year - 1, today.year, today.year + 1):
        try:
            d = date(y, month, day)
        except ValueError:
            continue
        if d >= today - timedelta(days=30):
            return d
    return None


def clean_date(value, today=None):
    """Turn the model's date into YYYY-MM-DD, or None. Accepts "2026-10-19", "2026-10-19T09:00Z", "10/19/2026",
    "19.10.2026", "19 Oct", "October 19th", "Mon, 19 October 2026"... The date is kept as written:
    no timezone conversion, so it can never shift by a day."""
    s = clean_text(value, 60)
    if not s:
        return None
    today = today or date.fromisoformat(settings.DEMO_DATE)
    s = s.lower().replace(",", " ")
    try:
        m = re.match(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", s)  # ISO first (also with a time after it)
        if m:
            return date(int(m[1]), int(m[2]), int(m[3])).isoformat()
        s = re.sub(r"\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?", " ", s)  # weekday names add nothing
        s = re.sub(r"(\d)(st|nd|rd|th)\b", r"\1", s)                       # 19th -> 19
        s = " ".join(s.replace(" of ", " ").split())
        m = re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?", s)
        if m:  # 10/19/2026 is month-first; 19/10/2026 or an unclear 05/06/2026 is read day-first
            a, b = int(m[1]), int(m[2])
            month, day = (a, b) if b > 12 else (b, a)
            d = _make_date(m[3], month, day, today)
            return d.isoformat() if d else None
        m = re.fullmatch(r"(\d{1,2}) ([a-z]+)\.?(?: (\d{2,4}))?", s) or re.fullmatch(r"([a-z]+)\.? (\d{1,2})(?: (\d{2,4}))?", s)
        if m:
            day, name = (m[1], m[2]) if m[1].isdigit() else (m[2], m[1])
            month = MONTHS.get(name[:3])
            if not month:
                return None
            d = _make_date(m[3], month, int(day), today)
            return d.isoformat() if d else None
    except ValueError:
        return None  # e.g. 31 February
    return None


def clean_time(value):
    """Turn "17:00", "5 PM", "11:59 p.m.", "9.30" or "noon" into HH:MM (24h), or None."""
    s = (clean_text(value, 20) or "").lower().replace("a.m.", "am").replace("p.m.", "pm").replace(".", ":")
    if s in ("noon", "midday"):
        return "12:00"
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?(?::\d{2})?\s*(am|pm)?", s)
    if not m or not (m[2] or m[3]):
        return None
    hour, minute = int(m[1]), int(m[2] or 0)
    if m[3]:
        if not 1 <= hour <= 12:
            return None
        hour = hour % 12 + (12 if m[3] == "pm" else 0)
    if hour > 23 or minute > 59:
        return None
    return f"{hour:02d}:{minute:02d}"


LINK_RE = re.compile(r"(https?://\S+|www\.\S+|[\w.+-]+@[\w-]+\.[\w.]+|[\w-]+(\.[\w-]+)*\.(com|org|edu|net|io|ac\.\w+|edu\.\w+)(/\S*)?)", re.I)


def clean_link(value):
    s = clean_text(value, 200)
    return s if s and " " not in s and LINK_RE.fullmatch(s) else None


def clean_item(raw):
    """Return a safe item dict, or None if it has no usable title."""
    if not isinstance(raw, dict):
        return None
    title = clean_text(raw.get("title"), 120)
    if not title or not re.search(r"[A-Za-z0-9]", title):
        return None
    kind = str(raw.get("type") or "").strip().lower()
    location, link = clean_text(raw.get("location"), 100), clean_link(raw.get("link"))
    if location and clean_link(location):  # a website is not a place
        link, location = link or clean_link(location), None
    start = clean_time(raw.get("time"))
    end = clean_time(raw.get("end_time"))
    return {
        "title": title,
        "type": kind if kind in ("task", "event") else "task",
        "date": clean_date(raw.get("date")),
        "time": start,
        "end_time": end if start and end and end > start else None,
        "location": location,
        "link": link,
        "quote": clean_text(raw.get("quote"), 600, collapse=False) or "",  # keep line breaks: it must match the source
    }


def clean_extraction(raw):
    """The model's answer for one file -> {"source", "summary", "items"} with every field checked."""
    raw = raw if isinstance(raw, dict) else {}
    source = str(raw.get("source") or "").strip().lower()
    items = raw.get("items") if isinstance(raw.get("items"), list) else []
    return {
        "source": source if source in settings.DOC_TYPES else "other",
        "summary": clean_text(raw.get("summary"), 400) or "",
        "items": [i for i in (clean_item(x) for x in items[:40]) if i],
    }


def clean_verdict(raw):
    if isinstance(raw, list) and raw:
        raw = raw[0]  # the model sometimes wraps the object in a list
    if not isinstance(raw, dict):
        raw = {}
    verdict = raw.get("verdict") if raw.get("verdict") in ("new", "same", "update", "conflict", "related") else "new"
    match_id = raw.get("match_id") if isinstance(raw.get("match_id"), str) else None
    return {"verdict": verdict, "match_id": match_id, "reason": clean_text(raw.get("reason"), 200) or ""}


# ---------- helpers ----------

def nice_date(d):
    """'2026-10-16' -> 'Fri 16 Oct'."""
    try:
        return date.fromisoformat(d).strftime("%a %d %b").replace(" 0", " ")
    except (TypeError, ValueError):
        return "no date"


def when(d, t):
    return nice_date(d) + (f" {t}" if t else "")


def find(db, item_id):
    return next((i for i in db["items"] if i["id"] == item_id), None)


def find_span(phrase, text):
    """[start, end] of phrase inside text, ignoring case and extra whitespace. None if not found."""
    words = (phrase or "").split()
    if not words or not text:
        return None
    m = re.search(r"\s+".join(re.escape(w) for w in words), text, re.IGNORECASE)
    return [m.start(), m.end()] if m else None


def verify_quote(quote, source_text):
    """True if the quote really appears in the source text (ignoring case and extra spaces)."""
    return find_span(quote, source_text) is not None


# ---------- applying the AI's verdict ----------

def make_source(f, ext):
    """One 'source' entry on an item: which file it came from and the exact quote."""
    return {
        "file_id": f["id"], "file": f["name"], "url": f["url"], "kind": f["kind"],
        "source_type": f["source_label"], "rank": f["rank"], "order": f["order"],
        "quote": ext["quote"], "verified": ext["verified"], "quote_span": ext["quote_span"],
        "date": ext["date"], "time": ext["time"],
    }


def suggest(options):
    """Index of the option to suggest: highest rank wins, ties go to the newer source."""
    return max(range(len(options)), key=lambda i: (options[i]["rank"], options[i]["order"]))


def _change(kind, item, text):
    item["last_change"], item["changed_order"] = kind, item["sources"][-1]["order"]
    return {"kind": kind, "item_id": item["id"], "text": text}


def apply(db, ext, verdict, f):
    """Apply one extracted item (from file f) to the plan. Returns a change dict. Never deletes anything."""
    v = verdict["verdict"]
    target = find(db, verdict.get("match_id"))
    if v != "new" and target is None:
        v = "new"  # AI pointed at an item that doesn't exist -> safest is to add it as new
    s = make_source(f, ext)

    # Safety rules on top of the AI verdict (plain Python double-check)
    if target and v == "same" and ext["date"] and target["date"] and ext["date"] != target["date"]:
        v = "conflict"  # "same" but the date is different -> let the user decide
    if target and v in ("update", "conflict") and (
            (not ext["date"] and not ext["time"]) or
            (ext["date"] == target["date"] and (not ext["time"] or ext["time"] == target["time"]))):
        v = "same"  # nothing actually differs

    if v in ("new", "related"):
        item = {
            "id": f"item{db['next_id']}",
            "title": ext["title"], "type": ext["type"], "date": ext["date"], "time": ext["time"],
            "end_time": ext["end_time"], "location": ext["location"], "link": ext["link"], "status": "ok",
            "parent_id": target["id"] if v == "related" else None,
            "sources": [s], "date_source": 0, "conflict": None, "updated": False,
            "history": [f"Created from {f['name']} ({nice_date(ext['date'])})"],
        }
        db["next_id"] += 1
        db["items"].append(item)
        if v == "related":
            item["history"].append(f"Linked to \"{target['title']}\"")
            return _change("related", item, f"\"{item['title']}\" (for \"{target['title']}\")")
        return _change("new", item, f"\"{item['title']}\" on {nice_date(item['date'])}")

    target["sources"].append(s)

    # a more trusted file that agrees with the item gives the clearer title (e.g. the official brief beats a chat)
    title_rank = target.get("title_rank", target["sources"][0]["rank"])
    if v in ("same", "update") and f["rank"] > title_rank and ext["title"].lower() != target["title"].lower():
        target["history"].append(f"Renamed from \"{target['title']}\" ({f['name']})")
        target["title"], target["title_rank"] = ext["title"], f["rank"]

    if v == "same":
        added = []
        for field in ("time", "end_time", "location", "link"):
            if ext[field] and not target.get(field):
                target[field] = ext[field]
                added.append(f"{field.replace('_', ' ')} {ext[field]}")
        if ext["date"] and not target["date"]:
            target["date"] = ext["date"]
            added.append(f"date {nice_date(ext['date'])}")
        extra = f", added {', '.join(added)}" if added else ""
        target["history"].append(f"Confirmed by {f['name']}{extra}")
        return _change("same", target, f"\"{target['title']}\"{extra}")

    if v == "update":
        old = when(target["date"], target["time"])
        target["date"] = ext["date"] or target["date"]
        target["time"] = ext["time"] or target["time"]
        for field in ("end_time", "location", "link"):
            if ext[field]:
                target[field] = ext[field]
        target["date_source"] = len(target["sources"]) - 1
        note = " (open conflict closed)" if target["status"] == "conflict" else ""
        target["status"], target["conflict"], target["updated"] = "ok", None, True
        target["history"].append(f"{old} -> {when(target['date'], target['time'])} ({f['name']}){note}")
        return _change("update", target, f"\"{target['title']}\" {old} -> {when(target['date'], target['time'])}")

    # conflict: keep every date with its source, suggest one, let the user choose
    new_opt = {"date": ext["date"], "time": ext["time"], "file": f["name"], "source_type": f["source_label"],
               "rank": f["rank"], "order": f["order"], "source_index": len(target["sources"]) - 1}
    if target.get("conflict"):
        options = target["conflict"]["options"]
    else:
        old_src = target["sources"][target.get("date_source", 0)]
        options = [{"date": target["date"], "time": target["time"], "file": old_src["file"],
                    "source_type": old_src["source_type"], "rank": old_src["rank"], "order": old_src["order"],
                    "source_index": target.get("date_source", 0)}]
    if not any(o["date"] == new_opt["date"] and o["time"] == new_opt["time"] for o in options):
        options.append(new_opt)
    target["status"] = "conflict"
    target["conflict"] = {"options": options, "suggested": suggest(options), "reason": verdict.get("reason", "")}
    target["history"].append(
        f"Conflict: {when(options[0]['date'], options[0]['time'])} ({options[0]['file']}) vs "
        f"{when(new_opt['date'], new_opt['time'])} ({f['name']})")
    return _change("conflict", target, f"\"{target['title']}\" {nice_date(options[0]['date'])} vs {nice_date(new_opt['date'])}")


def resolve(db, item_id, choice):
    """User picked one of the conflicting dates."""
    item = find(db, item_id)
    if not item or not item.get("conflict") or not 0 <= choice < len(item["conflict"]["options"]):
        return None
    opt = item["conflict"]["options"][choice]
    item["date"], item["time"] = opt["date"], opt["time"] or item["time"]
    item["date_source"] = opt["source_index"]
    item["status"], item["conflict"] = "ok", None
    item["history"].append(f"Confirmed {when(item['date'], item['time'])} (chosen by you)")
    return item


# ---------- what the AI sees ----------

def summary_for_ai(db):
    """Short version of the items, sent to the AI for matching (no history, no file paths)."""
    return [{k: i[k] for k in ("id", "title", "type", "date", "time", "location")} for i in db["items"]]


def summary_for_answer(db):
    """Items + their source files, sent to the AI to answer the user's question."""
    out = []
    for i in db["items"]:
        parent = find(db, i["parent_id"]) if i.get("parent_id") else None
        row = {"title": i["title"], "type": i["type"], "date": i["date"], "time": i["time"],
               "location": i["location"], "status": i["status"],
               "source_files": sorted({s["file"] for s in i["sources"]})}
        if i.get("end_time"):
            row["end_time"] = i["end_time"]
        if i.get("link"):
            row["link"] = i["link"]
        if parent:
            row["for"] = parent["title"]
        if i["conflict"]:
            row["possible_dates"] = [f"{o['date']} ({o['file']})" for o in i["conflict"]["options"]]
        out.append(row)
    return sorted(out, key=lambda r: r["date"] or "9999")


def documents_for_answer(db, budget=40000):
    """Full text of every file (shortened if there is a lot), so answers can use the files' content."""
    files = db["files"]
    per_file = max(1500, min(10000, budget // max(1, len(files))))
    return [{"file": f["name"], "kind": f["source_label"], "summary": f["summary"], "text": f["text"][:per_file]}
            for f in files]


# ---------- calendar export ----------

def _ics_text(s):
    return str(s).replace("\\", "\\\\").replace(";", "\\;").replace(",", "\\,").replace("\n", "\\n")


def calendar_ics(db):
    """All dated items as an .ics file that Google Calendar, Outlook and Apple Calendar can import."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//LifeOS//EN", "CALSCALE:GREGORIAN"]
    for i in db["items"]:
        if not i.get("date"):
            continue
        d = date.fromisoformat(i["date"])
        lines += ["BEGIN:VEVENT", f"UID:{i['id']}-{i['date']}@lifeos", f"DTSTAMP:{stamp}"]
        if i.get("time"):
            start = datetime.combine(d, datetime.strptime(i["time"], "%H:%M").time())
            end = (datetime.combine(d, datetime.strptime(i["end_time"], "%H:%M").time())
                   if i.get("end_time") else start + timedelta(hours=1))
            lines += [f"DTSTART:{start:%Y%m%dT%H%M%S}", f"DTEND:{end:%Y%m%dT%H%M%S}"]
        else:
            lines += [f"DTSTART;VALUE=DATE:{d:%Y%m%d}", f"DTEND;VALUE=DATE:{d + timedelta(days=1):%Y%m%d}"]
        title = ("[Date not confirmed] " if i["status"] == "conflict" else "") + i["title"]
        lines.append(f"SUMMARY:{_ics_text(title)}")
        if i.get("location"):
            lines.append(f"LOCATION:{_ics_text(i['location'])}")
        files = ", ".join(sorted({s["file"] for s in i["sources"]}))
        lines.append(f"DESCRIPTION:{_ics_text('From ' + files + (' - ' + i['link'] if i.get('link') else ''))}")
        lines.append("END:VEVENT")
    lines.append("END:VCALENDAR")
    return "\r\n".join(lines) + "\r\n"
