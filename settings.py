"""All settings in one place. Each one can be changed with an environment variable (or in .env)."""
import os
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))  # reads .env (the API key lives there; it is never printed or saved)

MAIN_MODEL = os.getenv("LIFEOS_MODEL", "gemma-4-26b-a4b-it")
BACKUP_MODEL = os.getenv("LIFEOS_BACKUP_MODEL", "gemma-4-31b-it")

# Fixed "today" so relative dates ("this Friday") always resolve the same way in the demo.
DEMO_DATE = os.getenv("LIFEOS_DEMO_DATE", "2026-10-12")

# Cache AI answers in cache.json so the demo replays instantly (set to "0" to turn off).
CACHE_ENABLED = os.getenv("LIFEOS_CACHE", "1") != "0"

API_KEY = os.getenv("GEMINI_API_KEY", "")

DATA_FILE = "data.json"
CACHE_FILE = "cache.json"
UPLOAD_DIR = "uploads"

# Where a piece of information came from, and how much we trust it (higher = more trusted).
SOURCE_TYPES = {
    "official": {"label": "Official notice", "rank": 4},
    "teacher": {"label": "Teacher", "rank": 3},
    "classmate": {"label": "Classmate", "rank": 2},
    "note": {"label": "My note", "rank": 1},
}
