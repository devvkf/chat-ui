"""Routers: /api/settings, /api/models, /api/health.

Settings hold the *global* chat options (temperature, system prompt, theme,
streaming) plus the ``active_provider_id`` pointer. The connection itself
lives in the ``providers`` table — see ``routers/providers.py`` — and is
resolved from there, so the legacy ``endpoint``/``api_key``/``model`` rows
here are only a fallback for a database that has never had a provider.
"""

from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException

from ..db import get_db
from ..schemas import Health, Settings, TestConnectionRequest
from ..upstream import fetch_models
from .providers import resolve_target

router = APIRouter()

# Field order matters: it defines the canonical key set persisted in the
# settings table.
_SETTING_KEYS = list(Settings.model_fields.keys())

_UPSERT = (
    "INSERT INTO settings(key, value) VALUES(?, ?) "
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
)


async def load_settings() -> Settings:
    """Read all settings rows and overlay them on the defaults."""
    db = get_db()
    rows = await db.execute_fetchall("SELECT key, value FROM settings")
    data: dict[str, object] = {}
    for row in rows:
        key, value = row["key"], row["value"]
        if key in _SETTING_KEYS:
            # Values are stored JSON-encoded so bools/floats round-trip.
            data[key] = json.loads(value)
    return Settings(**data)


@router.get("/health")
async def health() -> Health:
    return Health()


@router.get("/settings")
async def get_settings() -> Settings:
    return await load_settings()


@router.put("/settings")
async def put_settings(settings: Settings) -> Settings:
    """Upsert every settings key (JSON-encoded values).

    A plain full overwrite: it never touches a provider, so a stale settings
    snapshot cannot clobber the connection. Change the connection through
    /api/providers instead.
    """
    db = get_db()
    for key, value in settings.model_dump().items():
        await db.execute(_UPSERT, (key, json.dumps(value)))
    await db.commit()
    return settings


@router.post("/settings/test-connection")
async def test_connection(body: TestConnectionRequest) -> dict:
    """Probe {endpoint}/models. Always HTTP 200 with an ok flag."""
    models, err = await fetch_models(body.endpoint, body.api_key)
    if err:
        return {"ok": False, "error": err}
    return {"ok": True, "models": models}


@router.get("/models")
async def list_models() -> dict:
    """List models from the connected provider."""
    target = await resolve_target(None)
    if not target.endpoint.strip():
        raise HTTPException(status_code=400, detail=target.error or "No endpoint configured")
    models, err = await fetch_models(target.endpoint, target.api_key)
    if err:
        raise HTTPException(status_code=400, detail=err)
    return {"models": models}
