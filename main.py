"""LifeOS web server. Start with:  python -m uvicorn main:app --reload --port 8000"""
import io
import os
import re

from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from pypdf import PdfReader

import ai
import logic
import settings

os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
app = FastAPI(title="LifeOS")


def read_source(filename, data):
    """Step 1 READ: turn the dropped thing into plain text."""
    name = filename.lower()
    if name.endswith(".pdf"):
        reader = PdfReader(io.BytesIO(data))
        return "\n".join(page.extract_text() or "" for page in reader.pages)
    if name.endswith((".png", ".jpg", ".jpeg")):
        mime = "image/png" if name.endswith(".png") else "image/jpeg"
        return ai.read_image(data, mime)  # the Gemma model reads the image
    return data.decode("utf-8", errors="replace")  # pasted text / .txt


def process(filename, data, source_type):
    """The whole pipeline for one dropped source: read -> extract -> verify -> match -> apply."""
    src_info = settings.SOURCE_TYPES.get(source_type, settings.SOURCE_TYPES["note"])
    db = logic.load()
    db["order"] = db.get("order", 0) + 1

    # keep a copy of the file so the card can link to it
    filename = re.sub(r"[^A-Za-z0-9._-]", "_", os.path.basename(filename)) or "pasted.txt"
    with open(os.path.join(settings.UPLOAD_DIR, filename), "wb") as f:
        f.write(data)
    src = {"file": filename, "url": f"/uploads/{filename}", "label": src_info["label"],
           "rank": src_info["rank"], "order": db["order"]}

    text = read_source(filename, data)
    extracted = ai.extract(text)
    log = []
    for ext in extracted:
        ext["verified"] = logic.verify_quote(ext.get("quote"), text)  # plain Python check
        if db["items"]:
            verdict = ai.match({k: ext.get(k) for k in ("title", "type", "date", "time", "location", "quote")},
                               logic.summary_for_ai(db))
        else:
            verdict = {"verdict": "new", "match_id": None}
        log.append(logic.apply(db, ext, verdict, src))
    logic.save(db)
    return {"read_text": text, "log": log or ["No tasks or events found."], "model": ai.last_model_used,
            "backup_used": ai.last_model_used != settings.MAIN_MODEL, "items": db["items"]}


# ---------- API ----------

@app.exception_handler(ai.AIError)
def ai_error(request, exc):
    return JSONResponse(status_code=503, content={"error": str(exc)})


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
        return process(file.filename, await file.read(), source_type)
    if text.strip():
        n = logic.load().get("order", 0) + 1
        return process(f"pasted_text_{n}.txt", text.encode("utf-8"), source_type)
    return JSONResponse(status_code=400, content={"error": "Please choose a file or paste some text."})


class Resolve(BaseModel):
    item_id: str
    choice: int


@app.post("/api/resolve")
def resolve_route(body: Resolve):
    db = logic.load()
    item = logic.resolve(db, body.item_id, body.choice)
    logic.save(db)
    return item or JSONResponse(status_code=404, content={"error": "No conflict to resolve."})


class Question(BaseModel):
    question: str


@app.post("/api/ask")
def ask_route(body: Question):
    db = logic.load()
    if not db["items"]:
        return {"answer": "Your list is empty. Drop in some information first."}
    return {"answer": ai.answer(body.question, logic.summary_for_answer(db)), "model": ai.last_model_used}


@app.post("/api/reset")
def reset_route():
    logic.reset()
    return {"ok": True}


app.mount("/uploads", StaticFiles(directory=settings.UPLOAD_DIR), name="uploads")
app.mount("/", StaticFiles(directory="static", html=True), name="static")
