"""SQLite storage layer for Relay.

Uses aiosqlite with a module-level connection so all routers share one
database handle. The schema is created (idempotently) at app startup via
the lifespan hook in ``app.main``, and older databases are brought up to
date by :func:`migrate`.
"""

from __future__ import annotations

import asyncio
import json
import os
import sqlite3
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import AsyncIterator

import aiosqlite

from .upstream import host_of

# backend/data/relay.db, relative to this file (app/db.py -> backend/).
# RELAY_DB points somewhere else — the test suite uses it to stay off the
# real database.
DB_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = Path(os.environ.get("RELAY_DB") or DB_DIR / "relay.db")

_conn: aiosqlite.Connection | None = None

# Serializes multi-statement writes; see transaction().
_write_lock = asyncio.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    model TEXT,
    provider_id TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'complete',
    error TEXT,
    model TEXT,
    elapsed_ms INTEGER
);
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    endpoint TEXT NOT NULL DEFAULT '',
    api_key TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_session_created
    ON messages(session_id, created_at);
"""

_UPSERT_SETTING = (
    "INSERT INTO settings(key, value) VALUES(?, ?) "
    "ON CONFLICT(key) DO UPDATE SET value=excluded.value"
)


def utcnow() -> str:
    """ISO 8601 UTC timestamp."""
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid.uuid4().hex


def decode_settings(rows) -> dict:
    """JSON-decode key/value settings rows into a plain dict."""
    out: dict = {}
    for row in rows:
        try:
            out[row["key"]] = json.loads(row["value"])
        except (TypeError, ValueError):
            continue
    return out


async def _set_settings(pairs: list[tuple[str, object]]) -> None:
    """Upsert several settings keys in one transaction."""
    db = get_db()
    for key, value in pairs:
        await db.execute(_UPSERT_SETTING, (key, json.dumps(value)))
    await db.commit()


@asynccontextmanager
async def transaction() -> AsyncIterator[aiosqlite.Connection]:
    """Apply a group of writes all-or-nothing on the shared connection.

    aiosqlite runs every statement on one worker thread, but each ``await``
    is a scheduling point: in legacy transaction mode an INSERT opens a
    transaction that stays open until someone commits it, so a concurrent
    handler's ``commit()`` can land in the middle of ours. The lock
    serializes writers and ``BEGIN IMMEDIATE`` makes each group atomic.

    Must not be nested — no call inside a ``transaction()`` block may open
    another one.
    """
    db = get_db()
    async with _write_lock:
        # Another handler's implicit transaction may already be open. Joining
        # it keeps the previous behaviour; starting our own would raise
        # "cannot start a transaction within a transaction".
        if not db.in_transaction:
            await db.execute("BEGIN IMMEDIATE")
        try:
            yield db
            await db.commit()
        except BaseException:
            await db.rollback()
            raise


async def migrate(conn: aiosqlite.Connection) -> None:
    """Bring an existing database up to the current schema.

    ``CREATE TABLE IF NOT EXISTS`` never alters a table that already exists,
    so work added after a database was created has to be patched in by hand:

    1. ``sessions.provider_id`` — which saved provider a chat belongs to.
    2. Carry a single-endpoint setup from the settings table into the
       ``providers`` table, so upgrading keeps the endpoint, key, and model.
    """
    columns = await conn.execute_fetchall("PRAGMA table_info(sessions)")
    if "provider_id" not in {row["name"] for row in columns}:
        try:
            await conn.execute("ALTER TABLE sessions ADD COLUMN provider_id TEXT")
        except sqlite3.OperationalError as exc:
            # Two workers starting at once can both get here.
            if "duplicate column" not in str(exc):
                raise
    # The index needs the column to exist, so it follows the ALTER rather
    # than living in SCHEMA, where it would run against the old table shape.
    await conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_sessions_provider ON sessions(provider_id)"
    )

    stored = decode_settings(
        await conn.execute_fetchall("SELECT key, value FROM settings")
    )
    if not stored.get("providers_migrated", False):
        # One-shot flag: without it, deleting the last provider would let a
        # later start resurrect a provider from these same legacy rows.
        await conn.execute(
            "INSERT OR IGNORE INTO settings(key, value) VALUES('providers_migrated', 'true')"
        )
        endpoint = stored.get("endpoint", "")
        if isinstance(endpoint, str) and endpoint.strip():
            provider_id = new_id()
            now = utcnow()
            api_key = stored.get("api_key", "")
            model = stored.get("model", "")
            await conn.execute(
                "INSERT INTO providers(id, name, endpoint, api_key, model, created_at, updated_at) "
                "VALUES(?, ?, ?, ?, ?, ?, ?)",
                (
                    provider_id,
                    host_of(endpoint) or "Provider",
                    endpoint,
                    api_key if isinstance(api_key, str) else "",
                    model if isinstance(model, str) else "",
                    now,
                    now,
                ),
            )
            await conn.execute(_UPSERT_SETTING, ("active_provider_id", json.dumps(provider_id)))
            # Chats that already exist belong to the provider made from their
            # endpoint, rather than following whatever is connected later.
            await conn.execute(
                "UPDATE sessions SET provider_id = ? WHERE provider_id IS NULL",
                (provider_id,),
            )

    await conn.commit()


async def connect(path: Path | None = None) -> aiosqlite.Connection:
    """Open (and keep open) the shared database connection.

    ``path`` overrides :data:`DB_PATH`; the test suite uses it to open a
    throwaway database instead of the real one.
    """
    global _conn
    if _conn is not None:
        return _conn
    target = Path(path) if path is not None else DB_PATH
    target.parent.mkdir(parents=True, exist_ok=True)
    _conn = await aiosqlite.connect(target)
    _conn.row_factory = aiosqlite.Row
    # WAL for concurrent reads during streaming writes; enforce FK cascades.
    await _conn.execute("PRAGMA journal_mode=WAL")
    await _conn.execute("PRAGMA foreign_keys=ON")
    # A reloading worker overlaps its predecessor briefly; wait rather than
    # fail startup on a lock held by the process that is shutting down.
    await _conn.execute("PRAGMA busy_timeout=10000")
    await _conn.executescript(SCHEMA)
    await migrate(_conn)
    return _conn


async def close() -> None:
    """Close the shared connection (called at app shutdown)."""
    global _conn
    if _conn is not None:
        await _conn.close()
        _conn = None


def get_db() -> aiosqlite.Connection:
    """Return the shared connection. Raises if startup hasn't run."""
    if _conn is None:
        raise RuntimeError("Database not initialized; app startup has not run")
    return _conn
