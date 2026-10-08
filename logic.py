"""Plain Python (no AI): storage, validation, quote verification and the rules that apply AI verdicts."""
import json
import os
import re
import threading
import time
from datetime import date

import settings

# One lock around every load -> modify -> save, so two requests never overwrite each other.
LOCK = threading.RLock()


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
    return {"items": [], "next_id": 1, "order": 0, "seen": {}}


def load():
    if not os.path.exists(settings.DATA_FILE):
        return empty_db()
    try:
        with open(settings.DATA_FILE, encoding="utf-8") as f:
            db = json.load(f)
    except (ValueError, OSError):
        return empty_db()
    for key, value in empty_db().items():
        db.setdefault(key, value)
    return db


def save(db):
    atomic_write(settings.DATA_FILE, db)


def reset():
    with LOCK:
        save(empty_db())


# ---------- validation: never trust model output ----------

def clean_text(value, limit, collapse=True):
    if value is None or isinstance(value, (dict, list)):
        return None
    s = str(value).strip()
    if collapse:
        s = re.sub(r"\s+", " ", s)
    if s.lower() in ("", "null", "none", "n/a", "unknown"):
        return None
    return s[:limit]


def clean_date(value):
    s = clean_text(value, 10)
    if not s or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
        return None
    try:
        date.fromisoformat(s)
        return s
    except ValueError:
        return None


def clean_time(value):
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?", clean_text(value, 8) or "")
    if not m or int(m.group(1)) > 23 or int(m.group(2)) > 59:
        return None
    return f"{int(m.group(1)):02d}:{m.group(2)}"


def clean_item(raw):
    """Return a safe item dict, or None if it has no usable title."""
    if not isinstance(raw, dict):
        return None
    title = clean_text(raw.get("title"), 120)
    if not title or not re.search(r"[A-Za-z0-9]", title):
        return None
    kind = str(raw.get("type") or "").strip().lower()
    return {
        "title": title,
        "type": kind if kind in ("task", "event") else "task",
        "date": clean_date(raw.get("date")),
        "time": clean_time(raw.get("time")),
        "location": clean_text(raw.get("location"), 100),
        "quote": clean_text(raw.get("quote"), 600, collapse=False) or "",  # keep line breaks: it must match the source
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

def make_source(src, ext, text):
    """One 'source' entry: where it came from, the full text it was read from, and the exact quote."""
    return {
        "file": src["file"],            # original (cleaned) file name
        "stored": src["stored"],        # name on disk in uploads/
        "url": src["url"],
        "kind": src["kind"],            # image / pdf / text
        "hash": src["hash"],
        "source_type": src["label"],
        "rank": src["rank"],
        "order": src["order"],
        "quote": ext["quote"],
        "verified": ext["verified"],
        "quote_span": find_span(ext["quote"], text),
        "place_span": find_span(ext.get("location"), text),
        "source_text": text[:8000],
        "date": ext.get("date"),
        "time": ext.get("time"),
    }


def suggest(options):
    """Index of the option to suggest: highest rank wins, ties go to the newer source."""
    return max(range(len(options)), key=lambda i: (options[i]["rank"], options[i]["order"]))


def _change(kind, item, text):
    item["last_change"], item["changed_order"] = kind, item["sources"][-1]["order"]
    return {"kind": kind, "item_id": item["id"], "text": text}


def apply(db, ext, verdict, src, text):
    """Apply one extracted item to the board. Returns a change dict. Never deletes anything."""
    v = verdict["verdict"]
    target = find(db, verdict.get("match_id"))
    if v != "new" and target is None:
        v = "new"  # AI pointed at an item that doesn't exist -> safest is to add it as new
    s = make_source(src, ext, text)

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
            "location": ext["location"], "status": "ok",
            "parent_id": target["id"] if v == "related" else None,
            "sources": [s], "date_source": 0, "conflict": None, "updated": False,
            "history": [f"Created from {src['file']} ({nice_date(ext['date'])})"],
        }
        db["next_id"] += 1
        db["items"].append(item)
        if v == "related":
            item["history"].append(f"Linked to \"{target['title']}\"")
            return _change("related", item, f"\"{item['title']}\" (for \"{target['title']}\")")
        return _change("new", item, f"\"{item['title']}\" on {nice_date(item['date'])}")

    target["sources"].append(s)

    if v == "same":
        added = []
        for field in ("time", "location"):
            if ext[field] and not target.get(field):
                target[field] = ext[field]
                added.append(f"{field} {ext[field]}")
        if ext["date"] and not target["date"]:
            target["date"] = ext["date"]
            added.append(f"date {nice_date(ext['date'])}")
        extra = f", added {', '.join(added)}" if added else ""
        target["history"].append(f"Confirmed by {src['file']}{extra}")
        return _change("same", target, f"\"{target['title']}\"{extra}")

    if v == "update":
        old = when(target["date"], target["time"])
        target["date"] = ext["date"] or target["date"]
        target["time"] = ext["time"] or target["time"]
        if ext["location"]:
            target["location"] = ext["location"]
        target["date_source"] = len(target["sources"]) - 1
        note = " (open conflict closed)" if target["status"] == "conflict" else ""
        target["status"], target["conflict"], target["updated"] = "ok", None, True
        target["history"].append(f"{old} -> {when(target['date'], target['time'])} ({src['file']}){note}")
        return _change("update", target, f"\"{target['title']}\" {old} -> {when(target['date'], target['time'])}")

    # conflict: keep every date with its source, suggest one, let the user choose
    new_opt = {"date": ext["date"], "time": ext["time"], "file": src["file"], "source_type": src["label"],
               "rank": src["rank"], "order": src["order"], "source_index": len(target["sources"]) - 1}
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
        f"{when(new_opt['date'], new_opt['time'])} ({src['file']})")
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
        if parent:
            row["for"] = parent["title"]
        if i["conflict"]:
            row["possible_dates"] = [f"{o['date']} ({o['file']})" for o in i["conflict"]["options"]]
        out.append(row)
    return sorted(out, key=lambda r: r["date"] or "9999")
