"""
ANTA Shoes POS — Desktop (Windows EXE) launcher.

Starts the FastAPI backend on localhost and opens a native window
via pywebview. Packaged with PyInstaller into a single EXE.
"""
from __future__ import annotations

import os
import socket
import sys
import threading
import time
from pathlib import Path


def _project_root() -> Path:
    if getattr(sys, "frozen", False):
        # Running from PyInstaller bundle
        return Path(sys._MEIPASS)  # type: ignore[attr-defined]
    return Path(__file__).resolve().parents[1]


def _writable_data_dir() -> Path:
    """User-writable folder for SQLite DB (next to EXE when frozen)."""
    if getattr(sys, "frozen", False):
        base = Path(sys.executable).resolve().parent
    else:
        base = _project_root()
    data = base / "data"
    data.mkdir(parents=True, exist_ok=True)
    return data


def _find_free_port(start: int = 8765) -> int:
    for port in range(start, start + 40):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    return start


def start_server(host: str, port: int, db_path: Path) -> None:
    # Ensure backend package is importable
    root = _project_root()
    backend = root / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))

    os.environ["ANTA_DATABASE_URL"] = f"sqlite:///{db_path.as_posix()}"
    os.environ["ANTA_HOST"] = host
    os.environ["ANTA_PORT"] = str(port)

    import uvicorn
    from app.main import app  # noqa: WPS433

    uvicorn.run(app, host=host, port=port, log_level="warning", access_log=False)


def wait_ready(url: str, timeout: float = 20.0) -> bool:
    import urllib.request

    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1.5) as r:  # noqa: S310
                if r.status == 200:
                    return True
        except Exception:
            time.sleep(0.25)
    return False


def main() -> int:
    host = "127.0.0.1"
    port = _find_free_port(8765)
    data_dir = _writable_data_dir()
    db_path = data_dir / "anta_pos.db"

    t = threading.Thread(target=start_server, args=(host, port, db_path), daemon=True)
    t.start()

    url = f"http://{host}:{port}/"
    if not wait_ready(f"http://{host}:{port}/api/health"):
        print("ERROR: Backend failed to start.", file=sys.stderr)
        return 1

    try:
        import webview
    except ImportError:
        # Fallback: open system browser
        import webbrowser

        print(f"pywebview not installed — opening browser at {url}")
        webbrowser.open(url)
        # Keep process alive while server runs
        try:
            while True:
                time.sleep(1)
        except KeyboardInterrupt:
            return 0

    window = webview.create_window(
        title="ANTA Shoes POS",
        url=url,
        width=1280,
        height=800,
        min_size=(960, 640),
        confirm_close=True,
    )
    webview.start(debug=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
