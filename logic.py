"""Plain Python (no AI): storage, quote verification and the rules that apply AI verdicts."""
import json
import os
import re
from datetime import date

import settings


# ---------- storage (one JSON file) ----------

def load():
    if not os.path.exists(settings.DATA_FILE):
        return {"items": [], "next_id": 1, "order": 0}
    with open(settings.DATA_FILE, encoding="utf-8") as f:
        return json.load(f)


def save(db):
    with open(settings.DATA_FILE, "w", encoding="utf-8") as f:
        json.dump(db, f, indent=2, ensure_ascii=False)


def reset():
    save({"items": [], "next_id": 1, "order": 0})


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


def norm(text):
    """Lowercase and squash all whitespace, so small formatting differences don't matter."""
    return re.sub(r"\s+", " ", (text or "")).strip().lower()


def verify_quote(quote, source_text):
    """True if the quote really appears in the source text (ignoring case and extra spaces)."""
    q = norm(quote)
    return bool(q) and q in norm(source_text)


# ---------- applying the AI's verdict ----------

def make_source(src, ext):
    """One 'source' entry shown under a card: where it came from + the exact quote."""
    return {
        "file": src["file"],
        "url": src["url"],
        "source_type": src["label"],
        "rank": src["rank"],
        "order": src["order"],
        "quote": ext.get("quote") or "",
        "verified": ext["verified"],
        "date": ext.get("date"),
        "time": ext.get("time"),
    }


def suggest(options):
    """Index of the option to suggest: highest rank wins, ties go to the newer source."""
    return max(range(len(options)), key=lambda i: (options[i]["rank"], options[i]["order"]))


def apply(db, ext, verdict, src):
    """Apply one extracted item to the board. Returns a short log line. Never deletes anything."""
    v = verdict.get("verdict", "new")
    target = find(db, verdict.get("match_id"))
    if v != "new" and target is None:
        v = "new"  # AI pointed at an item that doesn't exist -> safest is to add it as new
    s = make_source(src, ext)

    # Safety rules on top of the AI verdict (plain Python double-check)
    if target and v == "same" and ext.get("date") and target.get("date") and ext["date"] != target["date"]:
        v = "conflict"  # "same" but the date is different -> let the user decide
    if target and v in ("update", "conflict") and ext.get("date") == target.get("date") \
            and (not ext.get("time") or ext.get("time") == target.get("time")):
        v = "same"  # nothing actually differs

    if v == "new" or v == "related":
        item = {
            "id": f"item{db['next_id']}",
            "title": ext["title"],
            "type": ext.get("type") or "task",
            "date": ext.get("date"),
            "time": ext.get("time"),
            "location": ext.get("location"),
            "status": "ok",
            "parent_id": target["id"] if v == "related" else None,
            "sources": [s],
            "date_source": 0,  # which source set the current date
            "conflict": None,
            "history": [f"Created from {src['file']} ({nice_date(ext.get('date'))})"],
        }
        db["next_id"] += 1
        db["items"].append(item)
        if v == "related":
            item["history"].append(f"Linked to \"{target['title']}\"")
            return f"related: \"{item['title']}\" (for \"{target['title']}\")"
        return f"new: \"{item['title']}\" on {nice_date(item['date'])}"

    target["sources"].append(s)

    if v == "same":
        added = []
        for field in ("time", "location"):
            if ext.get(field) and not target.get(field):
                target[field] = ext[field]
                added.append(f"{field} {ext[field]}")
        if ext.get("date") and not target.get("date"):
            target["date"] = ext["date"]
            added.append(f"date {nice_date(ext['date'])}")
        extra = f", added {', '.join(added)}" if added else ""
        target["history"].append(f"Confirmed by {src['file']}{extra}")
        return f"same: \"{target['title']}\"{extra}"

    if v == "update":
        old = when(target["date"], target["time"])
        target["date"] = ext.get("date") or target["date"]
        target["time"] = ext.get("time") or target["time"]
        if ext.get("location"):
            target["location"] = ext["location"]
        target["date_source"] = len(target["sources"]) - 1
        note = " (open conflict closed)" if target["status"] == "conflict" else ""
        target["status"], target["conflict"] = "ok", None
        target["history"].append(f"{old} -> {when(target['date'], target['time'])} ({src['file']}){note}")
        return f"update: \"{target['title']}\" {old} -> {when(target['date'], target['time'])}"

    # conflict: keep both dates with their sources, suggest one, let the user choose
    old_src = target["sources"][target.get("date_source", 0)]
    options = [
        {"date": target["date"], "time": target["time"], "file": old_src["file"],
         "source_type": old_src["source_type"], "rank": old_src["rank"], "order": old_src["order"],
         "source_index": target.get("date_source", 0)},
        {"date": ext.get("date"), "time": ext.get("time"), "file": src["file"],
         "source_type": src["label"], "rank": src["rank"], "order": src["order"],
         "source_index": len(target["sources"]) - 1},
    ]
    target["status"] = "conflict"
    target["conflict"] = {"options": options, "suggested": suggest(options), "reason": verdict.get("reason", "")}
    target["history"].append(
        f"Conflict: {when(options[0]['date'], options[0]['time'])} ({options[0]['file']}) vs "
        f"{when(options[1]['date'], options[1]['time'])} ({src['file']})")
    return f"conflict: \"{target['title']}\" {nice_date(options[0]['date'])} vs {nice_date(options[1]['date'])}"


def resolve(db, item_id, choice):
    """User picked one of the conflicting dates."""
    item = find(db, item_id)
    if not item or not item.get("conflict"):
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
