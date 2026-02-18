import os
from dotenv import load_dotenv

load_dotenv()


class Config:
    LINE_CHANNEL_ACCESS_TOKEN = os.environ.get("LINE_CHANNEL_ACCESS_TOKEN", "")
    LINE_CHANNEL_SECRET = os.environ.get("LINE_CHANNEL_SECRET", "")
    LIFF_ID_SCHEDULE = os.environ.get("LIFF_ID_SCHEDULE", "")
    SECRET_KEY = os.environ.get("SECRET_KEY", "dev-secret-change-this")
    DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
    DATABASE_PATH = os.environ.get("DATABASE_PATH", "data/when2meet.db")
    PORT = int(os.environ.get("PORT", 5000))
    BASE_URL = os.environ.get("BASE_URL", "http://localhost:5000")
