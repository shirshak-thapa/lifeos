# LifeOS

**Drop everything. We'll organize it, and show you why.**

LifeOS is a web app for university students. Drop in messy information (PDF notices, posters, chat screenshots, photos of notes, pasted text), several files at once, and an open-weight AI model turns it into **one plan** of tasks and events. Each file gets a short summary with its key dates highlighted, every item shows the exact quote it came from, later files **update** items instead of duplicating them, and when two files disagree LifeOS shows a **conflict** and lets you choose. You can also ask questions about your files and get answers that name the file they come from.

## Open-weight AI at the core

LifeOS uses Google's open-weight **Gemma 4** model (`gemma-4-26b-a4b-it`, backup `gemma-4-31b-it`). The model does the real work:

| Step | Who does it | What happens |
|---|---|---|
| **Read** | Gemma | Images (screenshots, posters, photos; PNG, JPG, WebP, AVIF…) are sent to Gemma, which copies out the text exactly. PDFs are read with `pypdf`; scanned PDF pages (no text inside) are sent to Gemma to read. |
| **Extract** | Gemma | For each file: who it is from (official notice, teacher, classmate, personal note), a 1–2 sentence summary, and every task and event with title, date, start/end time, place, link and the exact quote. Relative dates ("this Friday") are resolved against a fixed demo date (Mon 12 Oct 2026). |
| **Verify** | Plain Python | Every model field is validated (real dates, times, lengths), and each quote is checked against the file's text, so you can see whether it really is in the file. |
| **Match** | Gemma | Compares each new item with your plan and returns `new`, `same`, `update`, `conflict` or `related`, with a reason. |
| **Apply** | Plain Python | Fixed rules turn the verdict into changes: add, merge details, change a date with a history line, open a conflict (suggesting the more trusted file), or link a helper task. Nothing is deleted automatically. |
| **Answer** | Gemma | The search box answers questions using **only** your files' full text and your plan, naming the file for each fact. A plain keyword search shows matching lines instantly, even if the AI is busy. |

**Honest note:** the model is not run on your own computer. It is called through the **Gemini API (Google AI Studio free tier)**, which hosts the open-weight Gemma model. The model name is one setting (`LIFEOS_MODEL` in `settings.py` / `.env`).

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

The fake sample files are in `demo_inputs/` (re-create them with `python make_demo_files.py`). Click **Reset**, then drop the files from `demo_inputs/` onto the page in this order (one at a time, or several at once):

1. `classmate_chat.png` → 2 new items (assignment Fri 16 Oct, presentation Tue 20 Oct)
2. `assignment_brief.pdf` → conflict on the assignment (Fri vs Thu; Thu suggested, because an official notice beats a chat). Click **Thu 15 Oct**.
3. `seminar_poster.png` → merges into the presentation, adds 10:00 and Room 204
4. `note.png` → "Ask Ram for the presentation slides", shown under the presentation
5. Ask: *What do I need to do before Tuesday?*
6. `prof_notice.png` → update: the assignment moves to Mon 19 Oct, with a history line
7. `course_schedule.pdf` (3 pages) → lab report, exam, reading week and office hours. Ask: *What should I bring to the exam?*

**Using your own files?** The app's "today" is the fixed demo date, Mon 12 Oct 2026, so the sample story always replays the same way. To count from the real date instead, add `LIFEOS_DEMO_DATE=today` to `.env` and restart (the samples then need the API again).

Every AI answer is saved in `cache.json` (keyed by a hash of the input and the step), so this story **replays instantly and identically, even without an API key**. Set `LIFEOS_CACHE=0` to always call the model.

Automatic check of the whole story: `python demo_test.py` (prints PASS/FAIL per step).

## Features

- Several files at once (PDF, PNG, JPG, WebP, AVIF, GIF, TXT), Ctrl+V for screenshots, or pasted text
- Per file: key dates highlighted, then a short summary, then the full text with the quotes marked
- One plan by date, with conflicts, updates, helper tasks and the history of every change
- Search/ask box answered from your files' content, with clickable file names
- The same file twice is recognized ("already added")
- **Export to calendar** (.ics for Google Calendar, Outlook, Apple Calendar)

## Files

- `main.py`: FastAPI server and the pipeline (read → extract → verify → match → apply)
- `ai.py`: all Gemma calls: prompts, JSON parsing, retries, backup model, cache
- `logic.py`: plain-Python rules: storage, validation, quote checks, conflicts, calendar export
- `settings.py`: model names, demo date, cache switch, source trust ranks
- `static/`: the one-page front end (HTML, CSS, JavaScript; no build tools)
- `make_demo_files.py`, `demo_inputs/`: the fake sample files
- `demo_test.py`: runs the demo story and prints PASS/FAIL
- `data.json` (your plan) and `uploads/` (your files): local only, never committed

## Privacy

Use **fake data only** for demos. Text and images you add are sent to the Gemini API, and AI answers are stored in `cache.json`. The API key lives only in `.env`, which is never committed and never written to the cache.

## License

Apache-2.0. See [LICENSE](LICENSE).
