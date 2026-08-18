#!/usr/bin/env python3
"""Launch ANTA POS web server (development / production)."""
from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "backend"))


def main():
    parser = argparse.ArgumentParser(description="ANTA Shoes POS web server")
    parser.add_argument("--host", default=os.getenv("ANTA_HOST", "0.0.0.0"))
    parser.add_argument("--port", type=int, default=int(os.getenv("ANTA_PORT", "8765")))
    parser.add_argument("--reload", action="store_true", help="Auto-reload (dev only)")
    parser.add_argument(
        "--db",
        default=os.getenv("ANTA_DATABASE_URL", ""),
        help="SQLAlchemy DB URL (default: sqlite:///database/anta_pos.db)",
    )
    args = parser.parse_args()

    if args.db:
        os.environ["ANTA_DATABASE_URL"] = args.db
    else:
        db_path = ROOT / "database" / "anta_pos.db"
        db_path.parent.mkdir(parents=True, exist_ok=True)
        os.environ.setdefault("ANTA_DATABASE_URL", f"sqlite:///{db_path.as_posix()}")

    os.environ["ANTA_HOST"] = args.host
    os.environ["ANTA_PORT"] = str(args.port)

    import uvicorn

    print(f"ANTA POS → http://{args.host}:{args.port}/")
    print(f"API docs  → http://{args.host}:{args.port}/docs")
    print(f"DB        → {os.environ.get('ANTA_DATABASE_URL')}")
    uvicorn.run(
        "app.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
        log_level="info",
    )


if __name__ == "__main__":
    main()
