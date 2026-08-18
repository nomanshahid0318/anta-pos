"""
ANTA Shoes POS — Desktop Client (Windows EXE)

Thin client: opens a native window pointed at your LIVE server
(the same Render/Neon backend all stores share). No local database,
no local server — every store's EXE talks to the same central API,
so sales, stock, and products stay in sync in real time.

The server URL is read from a `config.txt` file placed next to the
EXE (one URL per line, e.g. https://anta-pos-29w8.onrender.com/pos/).
If that file is missing, DEFAULT_URL below is used.
"""
from __future__ import annotations

import sys
import time
import urllib.request
from pathlib import Path

# ---- EDIT THIS if you don't want to use config.txt ----
DEFAULT_URL = "https://anta-pos-29w8.onrender.com/pos/"
# ---------------------------------------------------------


def _exe_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


def _load_url() -> str:
    cfg = _exe_dir() / "config.txt"
    if cfg.is_file():
        text = cfg.read_text(encoding="utf-8").strip()
        for line in text.splitlines():
            line = line.strip()
            if line and not line.startswith("#"):
                return line
    return DEFAULT_URL


def _server_reachable(url: str, timeout: float = 6.0) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:  # noqa: S310
            return r.status < 500
    except Exception:
        return False


def main() -> int:
    url = _load_url()

    import webview

    # Simple retry/offline screen if the server can't be reached yet
    if not _server_reachable(url):
        offline_html = f"""
        <html><body style="font-family:sans-serif;background:#0f172a;color:#fff;
        display:flex;align-items:center;justify-content:center;height:100vh;margin:0;">
          <div style="text-align:center">
            <h2>Connecting to ANTA POS server…</h2>
            <p style="opacity:.7">{url}</p>
            <p style="opacity:.7">Check your internet connection, then restart the app.</p>
          </div>
        </body></html>
        """
        window = webview.create_window(
            title="ANTA Shoes POS",
            html=offline_html,
            width=1280,
            height=800,
            min_size=(960, 640),
        )

        def _retry():
            for _ in range(30):
                if _server_reachable(url):
                    window.load_url(url)
                    return
                time.sleep(2)

        webview.start(_retry, debug=False)
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
