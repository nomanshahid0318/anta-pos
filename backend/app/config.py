"""Application configuration."""
from __future__ import annotations

import os
from pathlib import Path
from functools import lru_cache

from pydantic_settings import BaseSettings


# Resolve default DB path relative to project root (anta_pos/)
_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_DEFAULT_DB = _PROJECT_ROOT / "database" / "anta_pos.db"


class Settings(BaseSettings):
    app_name: str = "ANTA Shoes POS"
    app_version: str = "4.0.0"
    secret_key: str = os.getenv("ANTA_SECRET_KEY", "anta-pos-change-me-in-production-2026")
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 60 * 12  # 12-hour shift
    database_url: str = os.getenv("ANTA_DATABASE_URL", f"sqlite:///{_DEFAULT_DB}")
    cors_origins: str = os.getenv("ANTA_CORS_ORIGINS", "*")
    currency: str = "LYD"
    default_policy: str = "Exchange within 7 days with receipt."
    # Desktop mode embeds server on localhost
    host: str = "127.0.0.1"
    port: int = 8765

    class Config:
        env_prefix = "ANTA_"
        case_sensitive = False


@lru_cache
def get_settings() -> Settings:
    return Settings()
