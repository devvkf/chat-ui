"""FastAPI application factory for Relay.

Run with:  uv run uvicorn app.main:app --port 8000
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import db
from .routers import chat, providers, sessions, settings

# The Vite production build lives at <repo>/dist (one level above backend/).
DIST_DIR = Path(__file__).resolve().parent.parent.parent / "dist"

# Vite dev server origins.
CORS_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"]


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Create data dir, open the DB, and ensure the schema exists.
    await db.connect()
    yield
    await db.close()


def create_app() -> FastAPI:
    app = FastAPI(title="Relay", version="0.1.0", lifespan=lifespan)

    @app.exception_handler(HTTPException)
    async def http_error_shape(request: Request, exc: HTTPException) -> JSONResponse:
        # The frontend contract expects errors as {"error": "..."}.
        detail = exc.detail
        if isinstance(detail, dict) and "error" in detail:
            payload = detail
        else:
            payload = {"error": str(detail)}
        return JSONResponse(payload, status_code=exc.status_code)

    app.add_middleware(
        CORSMiddleware,
        allow_origins=CORS_ORIGINS,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(settings.router, prefix="/api", tags=["settings"])
    app.include_router(providers.router, prefix="/api", tags=["providers"])
    app.include_router(sessions.router, prefix="/api", tags=["sessions"])
    app.include_router(chat.router, prefix="/api", tags=["chat"])

    # Serve the production frontend if it has been built. StaticFiles with
    # html=True serves index.html for unknown paths (SPA fallback). Guarded
    # so the API still runs in dev mode before `npm run build` has happened.
    if DIST_DIR.is_dir():
        from fastapi.staticfiles import StaticFiles

        app.mount("/", StaticFiles(directory=str(DIST_DIR), html=True), name="spa")

    return app


app = create_app()
