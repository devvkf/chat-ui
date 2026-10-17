"""Routers: /api/providers — saved upstream connections.

A provider is one saved endpoint, API key, and default model. Exactly one is
*connected* at a time (the ``active_provider_id`` setting), and every chat
records the provider it belongs to, so switching providers never re-points an
existing chat at a different endpoint.

``providers`` is the source of truth for the connection. The
``endpoint``/``api_key``/``model`` settings rows are only read as a fallback
when the database holds no providers at all — that is, when it has never been
migrated. Nothing writes them any more, which is what keeps ``PUT
/api/settings`` a plain full overwrite.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

from fastapi import APIRouter, HTTPException

from ..db import decode_settings, get_db, new_id, transaction, utcnow
from ..schemas import ProviderCreate, ProviderOut, ProviderPatch
from ..upstream import host_of

router = APIRouter()

# Settings rows that a pre-providers install used for its single connection.
_LEGACY_KEYS = ("endpoint", "api_key", "model")

_UPSERT_SETTING = (
    "INSERT INTO settings(key, value) VALUES(?, ?) "
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
)


@dataclass
class Target:
    """Where a chat request should go, once provider resolution is done."""

    provider_id: str | None
    endpoint: str
    api_key: str
    model: str
    error: str | None = None


def _to_provider(row, connected: bool) -> ProviderOut:
    return ProviderOut(
        id=row["id"],
        name=row["name"],
        endpoint=row["endpoint"],
        api_key=row["api_key"],
        model=row["model"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        connected=connected,
    )


async def _get_provider_or_404(provider_id: str):
    db = get_db()
    rows = await db.execute_fetchall("SELECT * FROM providers WHERE id = ?", (provider_id,))
    if not rows:
        raise HTTPException(
            status_code=404, detail={"error": f"Provider not found: {provider_id}"}
        )
    return rows[0]


async def _active_provider_id() -> str:
    """The connected provider's id, or "" when nothing is connected."""
    db = get_db()
    rows = await db.execute_fetchall(
        "SELECT value FROM settings WHERE key = 'active_provider_id'"
    )
    if not rows:
        return ""
    try:
        value = json.loads(rows[0]["value"])
    except (TypeError, ValueError):
        return ""
    return value if isinstance(value, str) else ""


async def _connected_provider():
    """The connected provider row, or None when nothing usable is connected."""
    provider_id = await _active_provider_id()
    if not provider_id:
        return None
    return await _get_provider_or_404(provider_id)


async def _set_settings(pairs: list[tuple[str, object]]) -> None:
    """Upsert several settings keys. Call inside a transaction()."""
    db = get_db()
    for key, value in pairs:
        await db.execute(_UPSERT_SETTING, (key, json.dumps(value)))


async def _set_active(provider_id: str) -> None:
    """Point the active-provider setting. Call inside a transaction()."""
    db = get_db()
    await db.execute(_UPSERT_SETTING, ("active_provider_id", json.dumps(provider_id)))


async def _clear_legacy_connection() -> None:
    """Forget the pre-providers endpoint, so nothing can resurrect it."""
    await _set_settings([(key, "") for key in _LEGACY_KEYS])


async def resolve_target(session_row=None) -> Target:
    """Work out which upstream a chat request should use.

    Order: the chat's own provider, then the connected provider. The legacy
    single-endpoint settings are consulted only when the database holds no
    providers at all.
    """
    db = get_db()
    session_provider = session_row["provider_id"] if session_row is not None else None
    provider_id = session_provider or await _active_provider_id()

    if provider_id:
        rows = await db.execute_fetchall("SELECT * FROM providers WHERE id = ?", (provider_id,))
        if rows:
            row = rows[0]
            return Target(row["id"], row["endpoint"], row["api_key"], row["model"])
        if session_provider:
            # The chat's own provider is gone (external edit, not a delete —
            # deletes re-home their chats). Say so rather than quietly sending
            # the history somewhere else.
            return Target(
                None,
                "",
                "",
                "",
                "This chat's provider no longer exists. Connect a provider in Settings to continue.",
            )

    rows = await db.execute_fetchall("SELECT COUNT(*) AS c FROM providers")
    if rows[0]["c"] > 0:
        return Target(None, "", "", "", "No provider connected. Choose one in Settings.")

    # Legacy settings, from before providers existed.
    stored = decode_settings(
        await db.execute_fetchall("SELECT key, value FROM settings")
    )
    endpoint = stored.get("endpoint", "")
    endpoint = endpoint if isinstance(endpoint, str) else ""
    api_key = stored.get("api_key", "")
    model = stored.get("model", "")
    if not endpoint.strip():
        return Target(None, "", "", "", "No provider connected. Choose one in Settings.")
    return Target(
        None,
        endpoint,
        api_key if isinstance(api_key, str) else "",
        model if isinstance(model, str) else "",
    )


@router.get("/providers", response_model=list[ProviderOut])
async def list_providers() -> list[ProviderOut]:
    db = get_db()
    active = await _active_provider_id()
    rows = await db.execute_fetchall(
        "SELECT * FROM providers ORDER BY created_at ASC, rowid ASC"
    )
    return [_to_provider(row, row["id"] == active) for row in rows]


@router.post("/providers", response_model=ProviderOut, status_code=201)
async def create_provider(body: ProviderCreate) -> ProviderOut:
    db = get_db()
    endpoint = body.endpoint.strip()
    name = body.name.strip() or host_of(endpoint) or "New provider"
    now = utcnow()
    provider_id = new_id()

    async with transaction():
        await db.execute(
            "INSERT INTO providers(id, name, endpoint, api_key, model, created_at, updated_at) "
            "VALUES(?, ?, ?, ?, ?, ?, ?)",
            (provider_id, name, endpoint, body.api_key, body.model.strip(), now, now),
        )
        # The first provider connects straight away, so a fresh install is
        # usable the moment it is saved.
        connected = (await _connected_provider()) is None
        if connected:
            await _set_active(provider_id)

    row = await _get_provider_or_404(provider_id)
    return _to_provider(row, connected)


@router.put("/providers/{provider_id}", response_model=ProviderOut)
async def update_provider(provider_id: str, body: ProviderPatch) -> ProviderOut:
    row = await _get_provider_or_404(provider_id)
    db = get_db()
    # An absent patch field means "leave alone"; an empty string means "clear".
    name = body.name if body.name is not None else row["name"]
    endpoint = body.endpoint if body.endpoint is not None else row["endpoint"]
    api_key = body.api_key if body.api_key is not None else row["api_key"]
    model = body.model if body.model is not None else row["model"]

    async with transaction():
        await db.execute(
            "UPDATE providers SET name = ?, endpoint = ?, api_key = ?, model = ?, "
            "updated_at = ? WHERE id = ?",
            (name, endpoint, api_key, model, utcnow(), provider_id),
        )
    # Editing the connected provider re-points the live connection on the next
    # request, because resolution reads the provider row directly.
    updated = await _get_provider_or_404(provider_id)
    return _to_provider(updated, await _active_provider_id() == provider_id)


@router.delete("/providers/{provider_id}")
async def delete_provider(provider_id: str) -> dict:
    db = get_db()
    await _get_provider_or_404(provider_id)

    async with transaction():
        rows = await db.execute_fetchall(
            "SELECT COUNT(*) AS c FROM sessions WHERE provider_id = ?", (provider_id,)
        )
        rehomed = rows[0]["c"]
        # Chats that belonged to it fall back to the connected provider, which
        # the caller reports so the UI can say what happened.
        await db.execute(
            "UPDATE sessions SET provider_id = NULL WHERE provider_id = ?", (provider_id,)
        )
        await db.execute("DELETE FROM providers WHERE id = ?", (provider_id,))
        if (await _active_provider_id()) == provider_id:
            await _set_active("")
            await _clear_legacy_connection()

    return {"ok": True, "rehomed_sessions": rehomed}


@router.post("/providers/{provider_id}/connect", response_model=ProviderOut)
async def connect_provider(provider_id: str) -> ProviderOut:
    row = await _get_provider_or_404(provider_id)
    async with transaction():
        await _set_active(provider_id)
    return _to_provider(row, True)
