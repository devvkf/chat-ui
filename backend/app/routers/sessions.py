"""Routers: /api/sessions CRUD."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from ..db import get_db, new_id, utcnow
from ..schemas import DeleteAllOut, SessionPatch
from .providers import resolve_target

router = APIRouter()


def _row_to_session(row, message_count: int | None = None) -> dict:
    out = {
        "id": row["id"],
        "title": row["title"],
        "created_at": row["created_at"],
        "updated_at": row["updated_at"],
        "model": row["model"],
        "provider_id": row["provider_id"],
    }
    if message_count is not None:
        out["message_count"] = message_count
    return out


async def _get_session_or_404(session_id: str):
    db = get_db()
    rows = await db.execute_fetchall(
        "SELECT * FROM sessions WHERE id = ?", (session_id,)
    )
    if not rows:
        raise HTTPException(status_code=404, detail={"error": f"Session not found: {session_id}"})
    return rows[0]


@router.get("/sessions")
async def list_sessions() -> list[dict]:
    db = get_db()
    rows = await db.execute_fetchall(
        """
        SELECT s.*, COUNT(m.id) AS message_count
        FROM sessions s
        LEFT JOIN messages m ON m.session_id = s.id
        GROUP BY s.id
        ORDER BY s.updated_at DESC
        """
    )
    return [_row_to_session(r, r["message_count"]) for r in rows]


@router.post("/sessions", status_code=201)
async def create_session() -> dict:
    """Create a chat titled 'New chat' on the connected provider."""
    db = get_db()
    target = await resolve_target(None)
    now = utcnow()
    sid = new_id()
    model = target.model or None
    await db.execute(
        "INSERT INTO sessions(id, title, created_at, updated_at, model, provider_id) "
        "VALUES(?, ?, ?, ?, ?, ?)",
        (sid, "New chat", now, now, model, target.provider_id),
    )
    await db.commit()
    return {
        "id": sid,
        "title": "New chat",
        "created_at": now,
        "updated_at": now,
        "model": model,
        "provider_id": target.provider_id,
    }


@router.get("/sessions/{session_id}")
async def get_session(session_id: str) -> dict:
    row = await _get_session_or_404(session_id)
    return _row_to_session(row)


@router.patch("/sessions/{session_id}")
async def patch_session(session_id: str, body: SessionPatch) -> dict:
    row = await _get_session_or_404(session_id)
    db = get_db()
    title = body.title if body.title is not None else row["title"]
    model = body.model if body.model is not None else row["model"]
    now = utcnow()
    await db.execute(
        "UPDATE sessions SET title = ?, model = ?, updated_at = ? WHERE id = ?",
        (title, model, now, session_id),
    )
    await db.commit()
    return {
        "id": session_id,
        "title": title,
        "created_at": row["created_at"],
        "updated_at": now,
        "model": model,
    }


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    await _get_session_or_404(session_id)
    db = get_db()
    # FK ON DELETE CASCADE removes the messages.
    await db.execute("DELETE FROM sessions WHERE id = ?", (session_id,))
    await db.commit()
    return {"ok": True}


@router.delete("/sessions")
async def delete_all_sessions() -> DeleteAllOut:
    db = get_db()
    rows = await db.execute_fetchall("SELECT COUNT(*) AS c FROM sessions")
    n_sessions = rows[0]["c"]
    rows = await db.execute_fetchall("SELECT COUNT(*) AS c FROM messages")
    n_messages = rows[0]["c"]
    await db.execute("DELETE FROM messages")
    await db.execute("DELETE FROM sessions")
    await db.commit()
    return DeleteAllOut(
        ok=True, deleted_sessions=n_sessions, deleted_messages=n_messages
    )
