#!/usr/bin/env python3
"""Launch ANTA POS as a desktop window (requires pywebview)."""
from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "desktop"))
sys.path.insert(0, str(ROOT / "backend"))

from main import main  # noqa: E402

if __name__ == "__main__":
    raise SystemExit(main())
