"""Everything the open-weight Gemma model does: read images, extract items, match items, answer questions."""
import hashlib
import json
import os
import re
import threading
import time

from google import genai
from google.genai import types

import logic
import settings

_client = None
_client_lock = threading.Lock()
last_model_used = settings.MAIN_MODEL


class AIError(Exception):
    """An error with a friendly message we can show to the user."""


# ---------- cache (cache.json): only hashes + model answers, never the API key ----------
# Kept in memory (read once) and written atomically, so lookups are instant.

_cache = None
_cache_lock = threading.Lock()


def _cache_get(key):
    global _cache
    with _cache_lock:
        if _cache is None:
            try:
                with open(settings.CACHE_FILE, encoding="utf-8") as f:
                    _cache = json.load(f)
            except (OSError, ValueError):
                _cache = {}
        return _cache.get(key)


def _cache_put(key, value):
    with _cache_lock:
        _cache[key] = value
        logic.atomic_write(settings.CACHE_FILE, _cache)


used_keys = set()


def prune_cache(keep):
    """Drop cache entries that were not used (old prompts). Used by demo_test.py --prune."""
    global _cache
    _cache_get("")
    with _cache_lock:
        _cache = {k: v for k, v in _cache.items() if k in keep}
        logic.atomic_write(settings.CACHE_FILE, _cache)
    return len(_cache)


def _cache_key(step, *parts):
    h = hashlib.sha256(step.encode())
    for p in parts:
        h.update(p if isinstance(p, bytes) else str(p).encode("utf-8"))
    return f"{step}:{h.hexdigest()[:24]}"


# ---------- calling the model ----------

def _client_get():
    global _client
    with _client_lock:
        if _client is None:
            if not settings.API_KEY:
                raise AIError("No API key found. Copy .env.example to .env and add your GEMINI_API_KEY.")
            _client = genai.Client(api_key=settings.API_KEY, http_options=types.HttpOptions(timeout=60000))
        return _client


def _friendly(e):
    msg = str(e)
    if "429" in msg or "RESOURCE_EXHAUSTED" in msg:
        return "The free AI quota is busy (rate limit). Please wait a minute and try again."
    if "API key" in msg or "API_KEY" in msg or "403" in msg:
        return "The API key was rejected. Check GEMINI_API_KEY in your .env file."
    if "503" in msg or "UNAVAILABLE" in msg or "500" in msg or "INTERNAL" in msg:
        return "The AI service is overloaded right now. Please try again in a minute (nothing was saved)."
    return "Could not reach the AI model (network problem?). Please try again."


def _call_model(model, contents, want_json):
    config = types.GenerateContentConfig(
        temperature=0,
        # "minimal" is the lowest thinking level Gemma 4 accepts here -> faster and cheaper
        thinking_config=types.ThinkingConfig(thinking_level="minimal"),
        response_mime_type="application/json" if want_json else None,
    )
    resp = _client_get().models.generate_content(model=model, contents=contents, config=config)
    return (resp.text or "").strip()


def _generate(contents, want_json):
    """Try the main model (with one retry after a short wait), then the backup model."""
    global last_model_used
    last_error = None
    for model in (settings.MAIN_MODEL, settings.BACKUP_MODEL):
        for attempt in range(2):
            try:
                text = _call_model(model, contents, want_json)
                last_model_used = model
                return text
            except AIError:
                raise
            except Exception as e:  # rate limit, network, server error...
                last_error = e
                msg = str(e)
                print(f"[ai] {model} attempt {attempt + 1} failed: {type(e).__name__} {msg[:120]}")
                if "400" in msg or "403" in msg or "404" in msg:
                    break  # a bad request won't fix itself -> go straight to the backup model
                if attempt == 0:
                    time.sleep(6 if "429" in msg else 4 if "50" in msg[:5] or "ServerError" in type(e).__name__ else 2)
        print(f"[ai] {model} failed, trying backup model")
    raise AIError(_friendly(last_error))


def _parse_json(text):
    """Parse JSON safely: strip ```code fences``` and any text around the JSON."""
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    match = re.search(r"[\[{].*[\]}]", text, re.S)
    return json.loads(match.group(0) if match else text)


def ask_model(step, prompt, image=None, mime=None, want_json=True):
    """One AI step with caching. JSON answers are parsed; bad JSON gets one retry."""
    key = _cache_key(step, prompt, image or b"")
    used_keys.add(key)
    if settings.CACHE_ENABLED:
        cached = _cache_get(key)
        if cached is not None:
            return cached
    contents = [types.Part.from_bytes(data=image, mime_type=mime), prompt] if image else prompt
    result = None
    for attempt in range(2):
        text = _generate(contents, want_json)
        if not want_json:
            result = text
            break
        try:
            result = _parse_json(text)
            break
        except (ValueError, AttributeError):
            print(f"[ai] bad JSON from model on step '{step}', retrying once")
    if result is None:
        raise AIError("The AI gave an answer we could not understand. Please try again.")
    if settings.CACHE_ENABLED:
        _cache_get(key)  # make sure the cache is loaded before adding to it
        _cache_put(key, result)
    return result


# ---------- the four AI steps ----------

def _today():
    from datetime import date
    return f"{settings.DEMO_DATE} ({date.fromisoformat(settings.DEMO_DATE).strftime('%A')})"


def read_image(image_bytes, mime):
    prompt = ("Copy out ALL the text in this image exactly as written, keeping the original "
              "spelling, capitalisation and punctuation. Output only the text, nothing else.")
    return ask_model("read", prompt, image_bytes, mime, want_json=False)


def extract(source_text):
    """Returns the raw model answer: {"source", "summary", "items"} (validated later in logic.py)."""
    prompt = f"""You read ONE document that a university student received: a chat screenshot, notice, poster, PDF or note.
Today is {_today()}. Resolve relative dates ("this friday", "tuesday 20th") against today.
If a date has no year, use the next time that date happens on or after today.
If something happens every week, use its next date on or after today.

Return ONE JSON object with exactly three keys: "source", "summary" and "items".
"source" is one word saying who wrote the document:
  "official" = a university, department, school or organisation (notices, briefs, posters)
  "teacher" = a teacher or professor writing to students
  "classmate" = another student, for example in a group chat
  "personal" = the student's own note
  "other" = anything else
"summary" is one or two plain sentences: what this document is and what the student needs to know.
"items" is a list with EVERY task and event in the text. Each item is an object with:
  "title": short and specific, with the course or organisation if the text gives it. A task starts with what to do
           (e.g. "Submit Physics Assignment 3", "Ask Ram for the presentation slides"); an event is named (e.g. "Kalg School open day")
  "type": "task" (something the student must do, submit or register for) or "event" (something that happens at a time or place)
  "date": "YYYY-MM-DD" or null
  "time": start time "HH:MM" (24h) or null
  "end_time": end time "HH:MM" (24h) or null
  "location": a physical place or null (never a website)
  "link": a website, URL or email given for this item, or null
  "quote": the exact sentence or phrase from the text this item comes from, copied character for character
Do not invent anything. Ignore placeholder text such as "lorem ipsum". If there are no tasks or events, "items" is [].

TEXT:
\"\"\"{source_text}\"\"\""""
    data = ask_model("extract", prompt)
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict) and "items" in data[0]:
        data = data[0]  # the model sometimes wraps the object in a list
    elif isinstance(data, list):
        data = {"items": data}  # ...or returns only the list of items
    return data if isinstance(data, dict) else {}


def match(new_item, existing_items):
    prompt = f"""You keep a student's to-do list free of duplicates. Today is {settings.DEMO_DATE}.

EXISTING ITEMS:
{json.dumps(existing_items, indent=1)}

NEW ITEM (with the quote it came from):
{json.dumps(new_item, indent=1)}

Decide how the NEW ITEM relates to the existing items. verdict must be one of:
- "new": it is not in the list.
- "same": it is the same thing on the same date, or it only adds details (time, location).
- "update": it is the same thing and the quote clearly says something CHANGED (extended, postponed, moved, rescheduled, new date).
- "conflict": it is the same thing but gives a different date/time WITHOUT saying that it changed.
- "related": it is a separate helper task for an existing item (e.g. "ask Ram for the slides" for a presentation).
Important: first decide if the NEW ITEM is about the SAME THING as an existing item, by subject and kind only.
Names may differ a little ("physics assignment" = "Physics Assignment 3 Submission", "Presentation Day" = "presentation").
A different date does NOT make it a different thing: same thing + different date is "update" or "conflict", never "new".
Return ONE JSON object: {{"match_id": id of the existing item or null, "verdict": "...", "reason": one short sentence}}"""
    return logic.clean_verdict(ask_model("match", prompt))


def answer(question, items, documents):
    prompt = f"""Today is {_today()}. A student asks a question about the files they uploaded.
Answer using ONLY the plan and the documents below. Never use outside knowledge.

PLAN (tasks and events already extracted from the files):
{json.dumps(items, indent=1)}

DOCUMENTS (full text of each uploaded file):
{json.dumps(documents, indent=1, ensure_ascii=False)}

Rules:
- Answer the question directly in 1 to 6 short lines of plain text (no markdown, no bold).
- After each fact, name the file it comes from in brackets, e.g. [assignment_brief.pdf].
- When listing things to do, put them in date order and give each one its date.
- Write dates like "Thu 15 Oct" and times like "10:00".
- If an item's status is "conflict", say its date is "not confirmed" and give the possible dates.
- If the answer is not in the documents, say: I couldn't find that in your files.

QUESTION: {question}"""
    return ask_model("answer", prompt, want_json=False)
