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
                    time.sleep(6 if "429" in msg else 2)
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

def read_image(image_bytes, mime):
    prompt = ("Copy out ALL the text in this image exactly as written, keeping the original "
              "spelling, capitalisation and punctuation. Output only the text, nothing else.")
    return ask_model("read", prompt, image_bytes, mime, want_json=False)


def extract(source_text):
    prompt = f"""You turn messy student information into a to-do list.
Today is {settings.DEMO_DATE} (Monday). Resolve relative dates ("this friday", "tuesday 20th") against today.

List EVERY task (something the student must do or submit) and event (something happening at a time/place) in the text below.
Do not invent anything. Only include things that are actually in the text.
Return JSON: {{"items": [{{"title": short clear title (e.g. "Physics Assignment 3", "Physics presentation"),
  "type": "task" or "event",
  "date": "YYYY-MM-DD" or null,
  "time": "HH:MM" (24h) or null,
  "location": string or null,
  "quote": the exact sentence or phrase from the text this item comes from, copied character for character}}]}}
If there is nothing, return {{"items": []}}.

TEXT:
\"\"\"{source_text}\"\"\""""
    data = ask_model("extract", prompt)
    items = data.get("items", []) if isinstance(data, dict) else data
    return items if isinstance(items, list) else []


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


def answer(question, items):
    prompt = f"""Today is {settings.DEMO_DATE} (Monday). Answer the student's question using ONLY these stored items:
{json.dumps(items, indent=1)}

Rules:
- List what to do in date order. For each item give its date and its source file(s).
- If an item's status is "conflict", say its date is "not confirmed" and show the possible dates.
- Tasks with no date that belong to ("for") an item you list: mention them too, marked "no date".
- Do not invent anything that is not in the items. If nothing matches, say so.
- Keep it under 8 lines. Plain text, one item per line starting with "- ".

QUESTION: {question}"""
    return ask_model("answer", prompt, want_json=False)
