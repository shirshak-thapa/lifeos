"""All settings in one place. Each one can be changed with an environment variable (or in .env)."""
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))  # reads .env (the API key lives there; it is never printed or saved)

MAIN_MODEL = os.getenv("LIFEOS_MODEL", "gemma-4-26b-a4b-it")
BACKUP_MODEL = os.getenv("LIFEOS_BACKUP_MODEL", "gemma-4-31b-it")

# Fixed "today" so relative dates ("this Friday") always resolve the same way in the demo.
DEMO_DATE = os.getenv("LIFEOS_DEMO_DATE", "2026-10-12")

# Cache AI answers so the demo replays instantly (set LIFEOS_CACHE=0 to turn off).
CACHE_ENABLED = os.getenv("LIFEOS_CACHE", "1") != "0"

API_KEY = os.getenv("GEMINI_API_KEY", "")

DATA_FILE = os.getenv("LIFEOS_DATA_FILE", "data.json")
CACHE_FILE = os.getenv("LIFEOS_CACHE_FILE", "cache.json")
UPLOAD_DIR = os.getenv("LIFEOS_UPLOAD_DIR", "uploads")

# The model decides what kind of source a file is. Higher rank = more trusted when two files disagree.
DOC_TYPES = {
    "official": {"label": "Official notice", "rank": 4},
    "teacher": {"label": "Teacher", "rank": 3},
    "classmate": {"label": "Classmate", "rank": 2},
    "other": {"label": "Other", "rank": 2},
    "personal": {"label": "Personal note", "rank": 1},
}

MAX_PDF_PAGES = 30        # pages read from one PDF
MAX_SCANNED_PAGES = 8     # scanned PDF pages sent to the model to be read
