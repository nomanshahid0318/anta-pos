"""ANTA Shoes POS + HO — FastAPI entrypoint."""
from __future__ import annotations

import sys
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .config import get_settings
from .database import init_db, SessionLocal
from .seed import seed_if_empty, ensure_default_users
from .routers import auth_routes, catalog, inventory_routes, reports, sales
from .routers import ho as ho_routes
from .routers import expenses as expenses_routes
from .routers import accounts as accounts_routes
from .routers import promotions as promotions_routes
from .routers import license_routes
from .routers import settings_routes
from .routers import receipts as receipts_routes
from .routers import handover_routes

settings = get_settings()
APP_DIR = Path(__file__).resolve().parent
BACKEND_DIR = APP_DIR.parent
PROJECT_ROOT = BACKEND_DIR.parent


def _resolve_frontend() -> Path:
    candidates = []
    if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
        meipass = Path(sys._MEIPASS)  # type: ignore[attr-defined]
        candidates += [meipass / "frontend", meipass]
    candidates += [PROJECT_ROOT / "frontend", BACKEND_DIR / "frontend", Path.cwd() / "frontend"]
    for c in candidates:
        if (c / "index.html").is_file() or (c / "portal.html").is_file():
            return c
    return PROJECT_ROOT / "frontend"


FRONTEND_DIR = _resolve_frontend()


def create_app() -> FastAPI:
    app = FastAPI(
        title=settings.app_name,
        version=settings.app_version,
        description="ANTA Shoes POS + Head Office — SQLite/PostgreSQL (no Google Sheets).",
    )
    origins = [o.strip() for o in settings.cors_origins.split(",") if o.strip()]
    app.add_middleware(
        CORSMiddleware,
        allow_origins=origins if origins != ["*"] else ["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def _no_cache_assets(request, call_next):
        response = await call_next(request)
        path = request.url.path
        if path.endswith((".html", ".js", ".css")) or path in ("/", "/pos", "/pos/", "/ho", "/ho/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate"
        return response

    app.include_router(auth_routes.router)
    app.include_router(catalog.router)
    app.include_router(sales.router)
    app.include_router(inventory_routes.router)
    app.include_router(reports.router)
    app.include_router(ho_routes.router)
    app.include_router(expenses_routes.router)
    app.include_router(accounts_routes.router)
    app.include_router(promotions_routes.router)
    app.include_router(license_routes.router)
    app.include_router(settings_routes.router)
    app.include_router(receipts_routes.router)
    app.include_router(handover_routes.router)

    @app.on_event("startup")
    def _startup():
        init_db()

    @app.get("/api/health")
    def health():
        return {
            "ok": True,
            "app": settings.app_name,
            "version": settings.app_version,
            "db": "sqlite" if settings.database_url.startswith("sqlite") else "other",
            "modules": ["pos", "ho", "accounts", "promotions", "license", "i18n"],
        }

    if FRONTEND_DIR.exists():
        assets = FRONTEND_DIR
        if (assets / "css").exists():
            app.mount("/css", StaticFiles(directory=str(assets / "css")), name="pos-css")
        if (assets / "js").exists():
            app.mount("/js", StaticFiles(directory=str(assets / "js")), name="pos-js")
        if (assets / "ho" / "css").exists():
            app.mount("/ho/css", StaticFiles(directory=str(assets / "ho" / "css")), name="ho-css")
        if (assets / "ho" / "js").exists():
            app.mount("/ho/js", StaticFiles(directory=str(assets / "ho" / "js")), name="ho-js")

        @app.get("/")
        def portal():
            p = assets / "portal.html"
            return FileResponse(str(p if p.is_file() else assets / "index.html"))

        @app.get("/pos")
        @app.get("/pos/")
        def pos_app():
            return FileResponse(str(assets / "index.html"))

        @app.get("/ho")
        @app.get("/ho/")
        def ho_app():
            hi = assets / "ho" / "index.html"
            return FileResponse(str(hi)) if hi.is_file() else RedirectResponse("/")

        @app.get("/{full_path:path}")
        def spa_fallback(full_path: str):
            if full_path.startswith("api"):
                return {"ok": False, "msg": "Not found"}
            cand = assets / full_path
            if cand.is_file():
                return FileResponse(str(cand))
            if full_path.startswith("ho"):
                hi = assets / "ho" / "index.html"
                if hi.is_file():
                    return FileResponse(str(hi))
            if full_path.startswith("pos"):
                return FileResponse(str(assets / "index.html"))
            p = assets / "portal.html"
            return FileResponse(str(p if p.is_file() else assets / "index.html"))

    return app


app = create_app()


def run():
    import uvicorn
    uvicorn.run("app.main:app", host=settings.host, port=settings.port, reload=False, log_level="info")


if __name__ == "__main__":
    run()
