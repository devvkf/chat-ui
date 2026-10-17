"""Routers: /api/sessions/{id}/messages and /api/sessions/{id}/chat (SSE)."""

from __future__ import annotations

import asyncio
import json
import time
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse

from ..db import get_db, new_id, transaction, utcnow
from ..schemas import ChatRequest, MessageOut
from ..upstream import auth_headers, normalize_endpoint
from .providers import resolve_target
from .sessions import _get_session_or_404
from .settings import load_settings

router = APIRouter()

# Upstream HTTP timeouts: quick to connect, generous while streaming.
CHAT_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=10.0)

SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


def _sse(payload: dict) -> str:
    """Frame one SSE event."""
    return f"data: {json.dumps(payload, ensure_ascii=False)}\n\n"


def _make_title(content: str) -> str:
    """First 48 chars of the message, newlines collapsed, '…' if truncated."""
    one_line = " ".join(content.split())
    if len(one_line) > 48:
        return one_line[:48] + "…"
    return one_line


def _extract_delta(chunk: dict) -> str:
    """Pull text out of one upstream SSE chunk, tolerating variants."""
    choices = chunk.get("choices")
    if choices:
        choice = choices[0] or {}
        delta = choice.get("delta")
        if isinstance(delta, dict) and isinstance(delta.get("content"), str):
            return delta["content"]
        message = choice.get("message")
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message["content"]
    # Non-OpenAI providers sometimes emit top-level "content"/"delta".
    for key in ("content", "delta"):
        value = chunk.get(key)
        if isinstance(value, str):
            return value
    return ""


async def _persist_assistant(
    message_id: str,
    session_id: str,
    created_at: str,
    content: str,
    status: str,
    error: str | None,
    model: str | None,
    elapsed_ms: int,
) -> None:
    """Insert (or replace) the assistant message row. Best effort."""
    try:
        async with transaction() as db:
            await db.execute(
                "INSERT OR REPLACE INTO messages"
                "(id, session_id, role, content, created_at, status, error, model, elapsed_ms) "
                "VALUES(?, ?, 'assistant', ?, ?, ?, ?, ?, ?)",
                (message_id, session_id, content, created_at, status, error, model, elapsed_ms),
            )
    except Exception:
        # Never let a persistence failure crash the stream generator.
        pass


@router.get("/sessions/{session_id}/messages")
async def list_messages(session_id: str) -> list[MessageOut]:
    await _get_session_or_404(session_id)
    db = get_db()
    rows = await db.execute_fetchall(
        "SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC",
        (session_id,),
    )
    return [
        MessageOut(
            id=r["id"],
            session_id=r["session_id"],
            role=r["role"],
            content=r["content"],
            created_at=r["created_at"],
            status=r["status"],
            error=r["error"],
            model=r["model"],
            elapsed_ms=r["elapsed_ms"],
        )
        for r in rows
    ]


@router.post("/sessions/{session_id}/chat")
async def chat(session_id: str, body: ChatRequest) -> StreamingResponse:
    session = await _get_session_or_404(session_id)
    settings = await load_settings()
    target = await resolve_target(session)
    db = get_db()

    # 1. Persist the user message immediately.
    now = utcnow()
    await db.execute(
        "INSERT INTO messages(id, session_id, role, content, created_at, status) "
        "VALUES(?, ?, 'user', ?, ?, 'complete')",
        (new_id(), session_id, body.content, now),
    )

    # 2. Auto-title and bump updated_at.
    title = session["title"]
    if title in ("", "New chat"):
        title = _make_title(body.content)
    await db.execute(
        "UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?",
        (title, utcnow(), session_id),
    )

    # 3. Resolve the model: request override > this chat's provider's model.
    #    The model stored on the chat is only reused when it was chosen
    #    against the provider the chat is actually talking to.
    model = body.model
    if not model and target.provider_id and session["provider_id"] == target.provider_id:
        model = session["model"]
    model = model or target.model or None
    # Pin the chat to the provider it is now using. One that has no provider
    # yet (its provider was deleted, or it predates them) adopts this one.
    pinned_provider = session["provider_id"] or target.provider_id
    await db.execute(
        "UPDATE sessions SET model = ?, provider_id = ? WHERE id = ?",
        (model, pinned_provider, session_id),
    )
    await db.commit()

    # 4. Build the upstream messages array from full history.
    rows = await db.execute_fetchall(
        "SELECT role, content FROM messages WHERE session_id = ? "
        "ORDER BY created_at ASC, rowid ASC",
        (session_id,),
    )
    upstream_messages: list[dict] = []
    if settings.system_prompt.strip():
        upstream_messages.append(
            {"role": "system", "content": settings.system_prompt}
        )
    upstream_messages.extend({"role": r["role"], "content": r["content"]} for r in rows)

    endpoint, ep_err = normalize_endpoint(target.endpoint)
    # Prefer the resolver's reason ("no provider connected") over the generic
    # empty-endpoint message.
    if target.error:
        ep_err = target.error
    message_id = new_id()
    created_at = utcnow()

    async def event_stream() -> AsyncIterator[str]:
        start = time.monotonic()
        parts: list[str] = []
        status = "complete"
        error_msg: str | None = None
        usage: dict | None = None
        disconnecting = False
        empty_reply = False

        yield _sse({"type": "start", "message_id": message_id, "created_at": created_at})

        if ep_err:
            # No usable endpoint configured — fail fast but keep the contract.
            error_msg = ep_err
            status = "error"
            yield _sse({"type": "error", "message": error_msg})
        else:
            try:
                payload = {
                    "model": model,
                    "messages": upstream_messages,
                    "temperature": settings.temperature,
                    "stream": body.stream,
                }
                async with httpx.AsyncClient(timeout=CHAT_TIMEOUT) as client:
                    async with client.stream(
                        "POST",
                        f"{endpoint}/chat/completions",
                        json=payload,
                        headers=auth_headers(target.api_key),
                    ) as resp:
                        if resp.status_code >= 400:
                            body_bytes = await _read_response_body(resp)
                            body_text = body_bytes.decode("utf-8", "replace")[:500]
                            raise RuntimeError(
                                f"Server returned HTTP {resp.status_code}: {body_text}"
                            )
                        if body.stream:
                            async for text in _consume_sse(resp):
                                if isinstance(text, dict):
                                    usage = text  # usage-only final chunk
                                else:
                                    parts.append(text)
                                    yield _sse({"type": "delta", "text": text})
                        else:
                            body_bytes = await _read_response_body(resp)
                            data = json.loads(body_bytes) if body_bytes.strip() else {}
                            content = _extract_nonstream_content(data)
                            parts.append(content)
                            if isinstance(data, dict) and isinstance(data.get("usage"), dict):
                                usage = data["usage"]
            except (GeneratorExit, asyncio.CancelledError):
                # Client disconnected: keep whatever we have, mark aborted.
                status = "aborted"
                disconnecting = True
                raise
            except BaseException as exc:
                # Report anything else (upstream down, 500s, starlette
                # internals) as an error event and keep going.
                error_msg = str(exc) or f"{type(exc).__name__}: {exc!r}"
                status = "error"
                yield _sse({"type": "error", "message": error_msg})
            finally:
                elapsed_ms = int((time.monotonic() - start) * 1000)
                content = "".join(parts)
                if status == "complete" and not content and not ep_err:
                    # The upstream closed the stream normally but sent no text
                    # (flaky streaming path on some providers). Say so rather
                    # than persisting a silently empty bubble. No yield here:
                    # this finally also runs during client disconnect, where
                    # yielding would raise RuntimeError — flag it and emit
                    # after the finally block instead.
                    status = "error"
                    error_msg = (
                        "The provider returned an empty reply. "
                        "Try again, or turn off streaming in Settings → Chat."
                    )
                    empty_reply = True
                await _persist_assistant(
                    message_id, session_id, created_at, content,
                    status, error_msg, model, elapsed_ms,
                )
                if empty_reply and not disconnecting:
                    yield _sse({"type": "error", "message": error_msg})
                if status == "complete":
                    done: dict = {
                        "type": "done",
                        "message_id": message_id,
                        "elapsed_ms": elapsed_ms,
                        "content": content,
                        "model": model,
                    }
                    if usage:
                        done["usage"] = usage
                    yield _sse(done)

    return StreamingResponse(
        event_stream(), media_type="text/event-stream", headers=SSE_HEADERS
    )


async def _read_response_body(resp: httpx.Response) -> bytes:
    """Read a response body, tolerating an abrupt close after the final byte.

    Some simple servers (Python's http.server among them) close the socket
    immediately after writing, which httpx can surface as ReadError even
    though the complete body was received.
    """
    try:
        return await resp.aread()
    except httpx.ReadError:
        return getattr(resp, "_content", b"") or b""


async def _read_sse(resp: httpx.Response) -> AsyncIterator[str]:
    """Yield raw SSE data lines, tolerating connections that close abruptly.

    Some simple servers (Python's http.server among them) close the socket
    immediately after the final bytes, which httpx can surface as ReadError
    *before* delivering buffered data. Treat a mid-response ReadError as
    end-of-stream.

    Read the *decoded* bytes: some OpenAI-compatible proxies (e.g. LiteLLM)
    gzip an event-stream, and ``aiter_raw()`` would hand back compressed
    bytes that contain no parsable ``data:`` lines.
    """
    buffer = ""
    try:
        async for chunk in resp.aiter_bytes():
            buffer += chunk.decode("utf-8", "replace")
            while "\n" in buffer:
                line, buffer = buffer.split("\n", 1)
                yield line
        if buffer.strip():
            yield buffer
    except httpx.ReadError:
        if buffer.strip():
            yield buffer


async def _consume_sse(resp: httpx.Response) -> AsyncIterator[str | dict]:
    """Yield delta text strings (or a usage dict) from an upstream SSE stream."""
    async for line in _read_sse(resp):
        line = line.strip()
        if not line or not line.startswith("data:"):
            continue
        data = line[len("data:"):].strip()
        if data == "[DONE]":
            return
        try:
            chunk = json.loads(data)
        except ValueError:
            continue
        if not isinstance(chunk, dict):
            continue
        choices = chunk.get("choices")
        if choices is None and isinstance(chunk.get("usage"), dict):
            # Usage-only final chunk (some providers): no choices at all.
            yield chunk["usage"]
            continue
        text = _extract_delta(chunk)
        if text:
            yield text


def _extract_nonstream_content(data: object) -> str:
    """Extract assistant text from a non-streaming chat completion."""
    if not isinstance(data, dict):
        return ""
    choices = data.get("choices")
    if choices:
        message = (choices[0] or {}).get("message")
        if isinstance(message, dict) and isinstance(message.get("content"), str):
            return message["content"]
    if isinstance(data.get("content"), str):
        return data["content"]
    return ""
