"""LifeOS web server. Start with:  python -m uvicorn main:app --reload --port 8000"""
import hashlib
import io
import os
import re
import time
from concurrent.futures import ThreadPoolExecutor

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, ImageOps
from pydantic import BaseModel
from pypdf import PdfReader

import ai
import logic
import settings

os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app = FastAPI(title="LifeOS")

MAX_BYTES = 20 * 1024 * 1024
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".webp", ".avif", ".gif", ".bmp", ".tif", ".tiff")
TEXT_EXT = (".txt", ".md")

# Sample files (fake data) in demo_inputs/, in the order of the demo story.
SAMPLES = ["classmate_chat.png", "assignment_brief.pdf", "seminar_poster.png", "note.png",
           "prof_notice.png", "course_schedule.pdf"]


class UserError(Exception):
    """A problem with the input that we can explain to the user."""


# ---------- step 1: READ (turn any file into text) ----------

def prepare_image(data):
    """Return (bytes, mime) the model can read. Small PNG/JPG are sent untouched; anything else is
    converted (WebP, AVIF, GIF...) and big photos are shrunk so they upload fast."""
    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        raise UserError("Could not open this image. Please use PNG, JPG, WebP or AVIF.")
    if img.format in ("PNG", "JPEG") and max(img.size) <= 1600:
        return data, "image/png" if img.format == "PNG" else "image/jpeg"
    img = ImageOps.exif_transpose(img)
    if img.mode in ("RGBA", "LA", "P"):
        img = img.convert("RGBA")
        background = Image.new("RGB", img.size, "white")
        background.paste(img, mask=img.getchannel("A"))
        img = background
    img = img.convert("RGB")
    img.thumbnail((1600, 1600))
    out = io.BytesIO()
    img.save(out, "JPEG", quality=88)
    return out.getvalue(), "image/jpeg"


def largest_image(page):
    """Bytes of the biggest picture on a PDF page (a scanned page is one big picture)."""
    try:
        images = list(page.images)
    except Exception:
        return None
    return max((im.data for im in images), key=len, default=None)


def read_pdf(data):
    try:
        reader = PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            reader.decrypt("")
        pages = list(reader.pages)
    except Exception:
        raise UserError("Could not open this PDF. It may be damaged or password-protected.")
    texts, scanned = [], 0
    for page in pages[:settings.MAX_PDF_PAGES]:
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""
        if len(text.strip()) < 25 and scanned < settings.MAX_SCANNED_PAGES:
            picture = largest_image(page)  # scanned page: let the model read the picture
            if picture:
                try:
                    text = ai.read_image(*prepare_image(picture))
                    scanned += 1
                except UserError:
                    pass
        texts.append(text.strip())
    if len(texts) == 1:
        return texts[0], 1
    return "\n\n".join(f"[Page {n}]\n{t}" for n, t in enumerate(texts, 1)), len(pages)


def read_source(filename, data):
    """Returns (text, kind, pages)."""
    name = filename.lower()
    if name.endswith(".pdf"):
        text, pages = read_pdf(data)
        return text, "pdf", pages
    if name.endswith(IMAGE_EXT):
        return ai.read_image(*prepare_image(data)), "image", None  # the Gemma model reads the image
    return data.decode("utf-8", errors="replace"), "text", None


# ---------- the whole pipeline for one file ----------

def clean_name(filename):
    name = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(filename or ""))[-80:]
    return name or "file"


def duplicate_result(db, digest):
    f = next((x for x in db["files"] if x["id"] == db["seen"][digest]), None)
    name = f["name"] if f else "an earlier file"
    return {"duplicate": True, "file": f, "changes": [], "log": [f"Already added (same content as {name})."],
            "model": ai.last_model_used, "backup_used": False, "state": state_of(db)}


def process(filename, data):
    """read -> extract -> verify -> match -> apply. Saves only at the very end,
    so an error never leaves half-done data."""
    started = time.perf_counter()
    name = clean_name(filename)
    low = name.lower()
    if low.endswith((".heic", ".heif")):
        raise UserError("iPhone HEIC photos aren't supported. Please export the photo as JPG first.")
    if not low.endswith(IMAGE_EXT + TEXT_EXT + (".pdf",)):
        raise UserError("Please use a PDF or an image (PNG, JPG, WebP, AVIF), or paste text.")
    if not data:
        raise UserError("That file is empty.")
    if len(data) > MAX_BYTES:
        raise UserError("That file is too big (max 20 MB).")
    digest = hashlib.sha256(data).hexdigest()

    with logic.LOCK:
        db = logic.load()
        if digest in db["seen"]:  # same content processed before -> nothing to do
            return duplicate_result(db, digest)

    # READ + EXTRACT (slow AI calls, done outside the lock so the app stays usable)
    text, kind, pages = read_source(name, data)
    if not text.strip():
        raise UserError("No readable text was found in this file.")
    found = logic.clean_extraction(ai.extract(text[:30000]))
    unique, keys = [], set()
    for ext in found["items"]:
        key = (ext["title"].lower(), ext["date"], ext["time"])
        if key in keys:
            continue  # same item twice in one file
        keys.add(key)
        ext["quote_span"] = logic.find_span(ext["quote"], text)  # VERIFY: plain Python, not AI
        ext["verified"] = ext["quote_span"] is not None
        unique.append(ext)

    with logic.LOCK:
        db = logic.load()
        if digest in db["seen"]:
            return duplicate_result(db, digest)
        # MATCH: compare each item with the plan as it is now (in parallel = faster)
        existing = logic.summary_for_ai(db)
        if existing:
            with ThreadPoolExecutor(max_workers=4) as pool:
                verdicts = list(pool.map(lambda e: ai.match(
                    {k: e.get(k) for k in ("title", "type", "date", "time", "location", "quote")}, existing), unique))
        else:
            verdicts = [{"verdict": "new", "match_id": None, "reason": ""}] * len(unique)

        db["order"] += 1
        doc = settings.DOC_TYPES[found["source"]]
        stored = f"{digest[:10]}_{name}"
        f = {"id": f"file{db['next_file']}", "name": name, "stored": stored, "url": f"/uploads/{stored}",
             "kind": kind, "pages": pages, "hash": digest, "order": db["order"],
             "source": found["source"], "source_label": doc["label"], "rank": doc["rank"],
             "summary": found["summary"], "text": text[:60000], "facts": []}
        db["next_file"] += 1

        # APPLY: plain Python rules
        changes = []
        for ext, verdict in zip(unique, verdicts):
            change = logic.apply(db, ext, verdict, f)
            changes.append(change)
            f["facts"].append({**ext, "item_id": change["item_id"], "result": change["kind"]})
        f["seconds"] = round(time.perf_counter() - started, 1)

        # everything worked -> now write the upload and the data
        with open(os.path.join(settings.UPLOAD_DIR, stored), "wb") as out:
            out.write(data)
        db["files"].append(f)
        db["seen"][digest] = f["id"]
        logic.save(db)

    log = [f"{c['kind']}: {c['text']}" for c in changes] or ["No tasks or events found."]
    return {"duplicate": False, "file": f, "changes": changes, "log": log, "model": ai.last_model_used,
            "backup_used": ai.last_model_used != settings.MAIN_MODEL, "state": state_of(db)}


def state_of(db):
    return {"files": db["files"], "items": db["items"]}


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
            "accept": list(IMAGE_EXT + TEXT_EXT + (".pdf",))}


@app.get("/api/state")
def get_state():
    return state_of(logic.load())


@app.post("/api/process")
async def process_route(text: str = Form(""), file: UploadFile | None = File(None)):
    if file and file.filename:
        data = await file.read()
        return await run_in_threadpool(process, file.filename, data)
    if text.strip():
        data = text.strip()[:20000].encode("utf-8")
        return await run_in_threadpool(process, f"pasted_text_{hashlib.sha256(data).hexdigest()[:6]}.txt", data)
    return JSONResponse(status_code=400, content={"error": "Please choose a file or paste some text."})


@app.get("/api/samples")
def samples():
    return [name for name in SAMPLES if os.path.exists(os.path.join("demo_inputs", name))]


@app.post("/api/samples/{name}")
def run_sample(name: str):
    if name not in SAMPLES:
        return JSONResponse(status_code=404, content={"error": "No such sample file."})
    with open(os.path.join("demo_inputs", name), "rb") as f:
        return process(name, f.read())


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
    return state_of(db)


class Question(BaseModel):
    question: str


@app.post("/api/ask")
def ask_route(body: Question):
    question = body.question.strip()[:300]
    if not question:
        return JSONResponse(status_code=400, content={"error": "Please type a question."})
    db = logic.load()
    if not db["files"]:
        return {"answer": "Upload a file first, then ask about it."}
    answer = ai.answer(question, logic.summary_for_answer(db), logic.documents_for_answer(db))
    return {"answer": answer, "model": ai.last_model_used}


@app.get("/api/calendar.ics")
def calendar():
    return Response(logic.calendar_ics(logic.load()), media_type="text/calendar",
                    headers={"Content-Disposition": 'attachment; filename="lifeos.ics"'})


@app.post("/api/reset")
def reset_route():
    logic.reset()
    return state_of(logic.empty_db())


app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")
app.mount("/demo_inputs", StaticFiles(directory="demo_inputs"), name="demo_inputs")
app.mount("/", StaticFiles(directory="static", html=True), name="static")
