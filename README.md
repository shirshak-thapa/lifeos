# LifeOS

**Drop everything. We'll organize it, and show you why.**

LifeOS is a web app for university students. You drop in messy information — chat screenshots, PDF notices, posters, photos of handwritten notes, or pasted text — and an open-weight AI model turns it into **one trusted list** of tasks and events. Every item shows the exact quote it came from, later messages **update** items instead of duplicating them, and when two sources disagree LifeOS shows a **conflict** and lets you choose.

## Open-weight AI at the core

LifeOS uses Google's open-weight **Gemma 4** model (`gemma-4-26b-a4b-it`, backup `gemma-4-31b-it`). The model does the real work:

| Step | Who does it | What happens |
|---|---|---|
| **Read** | Gemma | Images (screenshots, posters, notes) are sent to Gemma, which copies out the text exactly. PDFs are read with `pypdf`; pasted text is used as is. |
| **Extract** | Gemma | Finds every task and event: title, type, date, time, location and the exact quote. Relative dates ("this Friday") are resolved against a fixed demo date (Mon 12 Oct 2026). |
| **Verify** | Plain Python | Checks that each quote really appears in the source text (ignoring case/spaces) → green "verified" or yellow "check this". |
| **Match** | Gemma | Compares each new item with the existing list and returns `new`, `same`, `update`, `conflict` or `related`, with a reason. |
| **Apply** | Plain Python | Fixed rules turn the verdict into changes: add, merge details, change a date with a history line, open a conflict (suggesting the higher-ranked source), or link a helper task. Nothing is ever deleted automatically. |
| **Answer** | Gemma | The Ask box answers questions using **only** the stored items, with dates and source files. |

**Honest note:** the model is not run on your own computer. It is called through the **Gemini API (Google AI Studio free tier)**, which hosts the open-weight Gemma model. The model name is one setting (`LIFEOS_MODEL` in `settings.py` / `.env`), so it can be pointed at another Gemma variant.

## How to run it (Windows, beginner friendly)

1. Install [Python 3.10+](https://www.python.org/downloads/) (tick "Add Python to PATH").
2. Get a free API key at [Google AI Studio](https://aistudio.google.com/apikey).
3. Open a terminal in this folder and copy the example settings file:
   ```
   copy .env.example .env
   ```
   Open `.env` in Notepad and replace `your-api-key-here` with your key. (`.env` is in `.gitignore`, so it is never committed.)
4. Install the packages:
   ```
   pip install -r requirements.txt
   ```
5. Start the app:
   ```
   python -m uvicorn main:app --reload --port 8000
   ```
6. Open **http://localhost:8000** in your browser.

## Replay the demo

The fake demo files are in `demo_inputs/` (re-create them with `python make_demo_files.py`). Click **Reset demo**, then drop them in this order:

1. `classmate_chat.png` — *Classmate* → 2 new items (assignment Fri 16 Oct, presentation Tue 20 Oct)
2. `assignment_brief.pdf` — *Official notice* → conflict on the assignment (Fri vs Thu, Thu suggested). Click the suggested **Thu 15 Oct**.
3. `seminar_poster.png` — *Official notice* → merges into the presentation, adds 10:00 and Room 204
4. `note.png` — *My note* → "Ask Ram for the presentation slides", shown as *For: Physics presentation*
5. Ask: *What do I need to do before Tuesday?*
6. `prof_notice.png` — *Teacher* → update: assignment becomes Mon 19 Oct, with a history line

Every AI answer is saved in `cache.json` (keyed by a hash of the input and the step), so this exact story **replays instantly and identically, even without an API key**. Set `LIFEOS_CACHE=0` to always call the model.

Automatic check of the whole story: `python demo_test.py` (prints PASS/FAIL per step).

## Files

- `main.py` — FastAPI server and the pipeline (read → extract → verify → match → apply)
- `ai.py` — all Gemma calls: prompts, JSON parsing, retry, backup model, cache
- `logic.py` — plain-Python rules: storage, quote verification, applying verdicts, conflicts
- `settings.py` — model names, demo date, cache switch, source ranks
- `static/` — the one-page front end (HTML, CSS, JavaScript; no build tools)
- `make_demo_files.py`, `demo_inputs/` — the fake demo files
- `demo_test.py` — runs the demo story and prints PASS/FAIL
- `data.json` (items), `uploads/` (your files) — local only, not committed

## Privacy

Use **fake data only**. Text and images you drop in are sent to the Gemini API, and AI answers are stored in `cache.json`. The API key lives only in `.env`, which is never committed and never written to the cache.

## License

Apache-2.0 — see [LICENSE](LICENSE).
