#!/usr/bin/env python3
"""Create database tables and seed default data."""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

db_path = ROOT / "database" / "anta_pos.db"
db_path.parent.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("ANTA_DATABASE_URL", f"sqlite:///{db_path.as_posix()}")

from app.database import init_db  # noqa: E402

if __name__ == "__main__":
    init_db()
    print(f"✅ Database ready: {os.environ['ANTA_DATABASE_URL']}")
