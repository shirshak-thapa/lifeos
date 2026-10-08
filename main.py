"""LifeOS web server. Start with:  python -m uvicorn main:app --reload --port 8000"""
import hashlib
import io
import os
import re
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image
from pydantic import BaseModel
from pypdf import PdfReader

import ai
import logic
import settings

os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app = FastAPI(title="LifeOS")

MAX_BYTES = 15 * 1024 * 1024
IMAGE_EXT = (".png", ".jpg", ".jpeg")

# The demo story, so the UI can offer one-click demo steps.
DEMO_STEPS = [
    {"file": "classmate_chat.png", "source_type": "classmate", "expect": "2 new items"},
    {"file": "assignment_brief.pdf", "source_type": "official", "expect": "Conflict on the assignment"},
    {"file": "seminar_poster.png", "source_type": "official", "expect": "Merges time + room into the presentation"},
    {"file": "note.png", "source_type": "note", "expect": "Helper task for the presentation"},
    {"file": "prof_notice.png", "source_type": "teacher", "expect": "Deadline update to Mon 19 Oct"},
]


class UserError(Exception):
    """A problem with the input that we can explain to the user."""


def shrink_image(data, name):
    """Big phone photos upload slowly: shrink anything over 1600px (small images are sent untouched)."""
    img = Image.open(io.BytesIO(data))
    if max(img.size) <= 1600:
        return data, "image/png" if name.endswith(".png") else "image/jpeg"
    img.thumbnail((1600, 1600))
    out = io.BytesIO()
    img.convert("RGB").save(out, "JPEG", quality=85)
    return out.getvalue(), "image/jpeg"


def read_source(filename, data):
    """Step 1 READ: turn the dropped thing into plain text. Returns (text, kind)."""
    name = filename.lower()
    if name.endswith(".pdf"):
        try:
            reader = PdfReader(io.BytesIO(data))
            text = "\n".join(page.extract_text() or "" for page in reader.pages)
        except Exception:
            raise UserError("Could not open this PDF. Is it a valid PDF file?")
        if not text.strip():
            raise UserError("This PDF has no text inside (it is probably a scan). Upload a screenshot of it instead.")
        return text, "pdf"
    if name.endswith(IMAGE_EXT):
        try:
            small, mime = shrink_image(data, name)
        except Exception:
            raise UserError("Could not open this image. Please use a PNG or JPG file.")
        return ai.read_image(small, mime), "image"  # the Gemma model reads the image
    return data.decode("utf-8", errors="replace"), "text"  # pasted text / .txt


def process(filename, data, source_type):
    """The whole pipeline for one dropped source: read -> extract -> verify -> match -> apply.
    Works on an in-memory copy and saves only at the very end, so an error never leaves half-done data."""
    if len(data) > MAX_BYTES:
        raise UserError("That file is too big (max 15 MB).")
    src_info = settings.SOURCE_TYPES.get(source_type, settings.SOURCE_TYPES["note"])
    filename = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(filename))[-80:] or "pasted.txt"
    if not filename.lower().endswith(IMAGE_EXT + (".pdf", ".txt")):
        raise UserError("Please drop a PNG, JPG or PDF file, or paste text.")
    digest = hashlib.sha256(data).hexdigest()

    with logic.LOCK:
        db = logic.load()
        if digest in db["seen"]:  # same content processed before -> nothing to do
            first = db["seen"][digest]
            return {"duplicate": True, "log": [f"Already added (as {first})."], "changes": [],
                    "model": ai.last_model_used, "backup_used": False, "items": db["items"], "file": first}

        text, kind = read_source(filename, data)
        if not text.strip():
            raise UserError("No text found in this source.")
        extracted = [e for e in (logic.clean_item(raw) for raw in ai.extract(text)) if e]

        # drop exact repeats inside the same source
        unique, seen_keys = [], set()
        for ext in extracted:
            key = (ext["title"].lower(), ext["date"], ext["time"])
            if key not in seen_keys:
                seen_keys.add(key)
                ext["verified"] = logic.verify_quote(ext["quote"], text)  # plain Python check
                unique.append(ext)

        # MATCH: all items of this source are compared with the list as it was before, in parallel (faster)
        existing = logic.summary_for_ai(db)
        if existing:
            with ThreadPoolExecutor(max_workers=4) as pool:
                verdicts = list(pool.map(lambda e: ai.match(
                    {k: e.get(k) for k in ("title", "type", "date", "time", "location", "quote")}, existing), unique))
        else:
            verdicts = [{"verdict": "new", "match_id": None, "reason": ""}] * len(unique)

        db["order"] += 1
        stored = f"{digest[:10]}_{filename}"
        src = {"file": filename, "stored": stored, "url": f"/uploads/{stored}", "kind": kind, "hash": digest,
               "label": src_info["label"], "rank": src_info["rank"], "order": db["order"]}
        changes = [logic.apply(db, ext, v, src, text) for ext, v in zip(unique, verdicts)]

        # everything worked -> now write the upload and the data
        with open(os.path.join(settings.UPLOAD_DIR, stored), "wb") as f:
            f.write(data)
        db["seen"][digest] = filename
        logic.save(db)

    log = [f"{c['kind']}: {c['text']}" for c in changes] or ["No tasks or events found."]
    return {"duplicate": False, "read_text": text, "log": log, "changes": changes, "order": db["order"],
            "model": ai.last_model_used, "backup_used": ai.last_model_used != settings.MAIN_MODEL,
            "items": db["items"], "file": filename}


# ---------- API ----------

@app.exception_handler(ai.AIError)
def ai_error(request, exc):
    return JSONResponse(status_code=503, content={"error": str(exc)})


@app.exception_handler(UserError)
def user_error(request, exc):
    return JSONResponse(status_code=400, content={"error": str(exc)})


@app.exception_handler(Exception)
def any_error(request, exc):
    print(f"[server] unexpected error: {type(exc).__name__}: {exc}")
    return JSONResponse(status_code=500, content={"error": "Something went wrong on the server. Nothing was saved."})


@app.get("/api/info")
def info():
    return {"model": settings.MAIN_MODEL, "backup_model": settings.BACKUP_MODEL, "demo_date": settings.DEMO_DATE,
            "source_types": settings.SOURCE_TYPES}


@app.get("/api/items")
def items():
    return logic.load()["items"]


@app.post("/api/process")
async def process_route(source_type: str = Form("note"), text: str = Form(""), file: UploadFile | None = File(None)):
    if file and file.filename:
        data = await file.read()
        return await run_in_threadpool(process, file.filename, data, source_type)
    if text.strip():
        data = text.strip()[:20000].encode("utf-8")
        name = f"pasted_text_{hashlib.sha256(data).hexdigest()[:6]}.txt"
        return await run_in_threadpool(process, name, data, source_type)
    return JSONResponse(status_code=400, content={"error": "Please choose a file or paste some text."})


@app.get("/api/demo")
def demo_steps():
    return [{**s, "step": n, "url": f"/demo_inputs/{s['file']}",
             "source_label": settings.SOURCE_TYPES[s["source_type"]]["label"]} for n, s in enumerate(DEMO_STEPS)]


@app.post("/api/demo/{step}")
def demo_run(step: int):
    if not 0 <= step < len(DEMO_STEPS):
        return JSONResponse(status_code=404, content={"error": "No such demo step."})
    s = DEMO_STEPS[step]
    with open(os.path.join("demo_inputs", s["file"]), "rb") as f:
        return process(s["file"], f.read(), s["source_type"])


class Resolve(BaseModel):
    item_id: str
    choice: int


@app.post("/api/resolve")
def resolve_route(body: Resolve):
    with logic.LOCK:
        db = logic.load()
        item = logic.resolve(db, body.item_id, body.choice)
        if not item:
            return JSONResponse(status_code=404, content={"error": "This conflict was already resolved."})
        logic.save(db)
    return item


class Question(BaseModel):
    question: str


@app.post("/api/ask")
def ask_route(body: Question):
    question = body.question.strip()[:300]
    if not question:
        return JSONResponse(status_code=400, content={"error": "Please type a question."})
    db = logic.load()
    if not db["items"]:
        return {"answer": "Your list is empty. Drop in some information first."}
    return {"answer": ai.answer(question, logic.summary_for_answer(db)), "model": ai.last_model_used}


@app.post("/api/reset")
def reset_route():
    logic.reset()
    return {"ok": True}


app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")
app.mount("/demo_inputs", StaticFiles(directory="demo_inputs"), name="demo_inputs")
app.mount("/", StaticFiles(directory="static", html=True), name="static")
