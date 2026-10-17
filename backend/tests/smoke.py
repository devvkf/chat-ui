"""End-to-end smoke test for the Relay backend.

Spins up fake OpenAI-compatible upstreams (http.server, background threads)
and drives the real FastAPI app through TestClient. Covers: health, settings
round-trip, test-connection, session CRUD, streaming chat, auto-titling,
model listing, bulk delete, upstream-error persistence, the provider table
(CRUD, connecting, per-chat pinning), and the upgrade of a database written
before providers existed.

Run:  uv run python tests/smoke.py
"""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# SSE payloads can contain non-cp1252 characters (the app's own error copy
# uses "→"); make stdout tolerate them so a FAIL detail never crashes.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Make "app" importable when run as a script from the backend/ directory.
sys.path.insert(0, __file__.rsplit("\\", 2)[0].rsplit("/", 2)[0])

# Point the app at a scratch database before importing it: db.py reads
# RELAY_DB at import time. The real backend/data/relay.db holds the user's
# chats and API keys, so the suite must never open it.
os.environ["RELAY_DB"] = str(
    Path(tempfile.mkdtemp(prefix="relay-smoke-")) / "relay.db"
)

import aiosqlite  # noqa: E402

from fastapi.testclient import TestClient  # noqa: E402

from app import db  # noqa: E402
from app.main import app  # noqa: E402

# Mutable flag flipped mid-test to make the upstream fail on demand.
FAIL_CHAT = False

# The schema as it looked before providers existed: no providers table and no
# sessions.provider_id. Used to prove the upgrade path.
LEGACY_SCHEMA = """
CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    model TEXT
);
CREATE TABLE messages (
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
CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


class FakeUpstream(BaseHTTPRequestHandler):
    """Minimal OpenAI-compatible server used only by this test."""

    models = ("fake-model-1",)
    parts = ("Hel", "lo")
    whole = "Hello"

    def log_message(self, *args):  # silence request logging
        pass

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _authed(self) -> bool:
        return self.headers.get("Authorization", "").startswith("Bearer ")

    def do_GET(self):
        if self.path == "/v1/models":
            if not self._authed():
                return self._send_json(401, {"error": "missing api key"})
            return self._send_json(200, {"data": [{"id": m} for m in self.models]})
        self._send_json(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self._send_json(404, {"error": "not found"})
        if not self._authed():
            return self._send_json(401, {"error": "missing api key"})
        if FAIL_CHAT:
            return self._send_json(500, {"error": "upstream exploded"})
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            stream = json.loads(body).get("stream", True)
        except ValueError:
            stream = True
        self.send_response(200)
        if stream:
            # SSE stream, then [DONE].
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for text in self.parts:
                chunk = {"choices": [{"delta": {"content": text}}]}
                self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
                self.wfile.flush()
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        else:
            payload = json.dumps(
                {"choices": [{"message": {"role": "assistant", "content": self.whole}}]}
            ).encode()
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)


class FakeUpstreamB(FakeUpstream):
    """A second provider, so per-chat routing is observable."""

    models = ("beta-model",)
    parts = ("Sec", "ond")
    whole = "Second"


class GzipUpstream(FakeUpstream):
    """Streams SSE with Content-Encoding: gzip.

    Some OpenAI-compatible proxies gzip an event-stream even though the
    response is chunked. Reading it with httpx's raw iterator skips
    decompression and yields zero parsable lines, so the chat must read the
    decoded bytes to work at all.
    """

    models = ("gzip-model",)
    parts = ("gzi", "pped")
    whole = "gzipped"

    def do_POST(self):
        if self.path != "/v1/chat/completions":
            return self._send_json(404, {"error": "not found"})
        if not self._authed():
            return self._send_json(401, {"error": "missing api key"})
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b"{}"
        try:
            stream = json.loads(body).get("stream", True)
        except ValueError:
            stream = True
        self.send_response(200)
        if stream:
            raw = b""
            for text in self.parts:
                chunk = {"choices": [{"delta": {"content": text}}]}
                raw += f"data: {json.dumps(chunk)}\n\n".encode()
            raw += b"data: [DONE]\n\n"
            payload = gzip.compress(raw)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            self.wfile.flush()
        else:
            payload = gzip.compress(json.dumps(
                {"choices": [{"message": {"role": "assistant", "content": self.whole}}]}
            ).encode())
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)


def parse_sse(raw: str) -> list[dict]:
    """Parse 'data: {json}' lines into a list of event payloads."""
    events = []
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            events.append(json.loads(line[len("data:"):].strip()))
    return events


async def check_migration(checks) -> None:
    """A database written before providers existed keeps working.

    Builds a legacy-shaped database by hand, opens it through the real
    ``db.connect()``, and asserts the endpoint became a provider, the chat
    that used it was assigned to that provider, and a second startup is a
    no-op.
    """
    path = Path(tempfile.mkdtemp(prefix="relay-legacy-")) / "relay.db"
    endpoint = "http://legacy.example.test/v1"
    conn = await aiosqlite.connect(path)
    conn.row_factory = aiosqlite.Row
    await conn.executescript(LEGACY_SCHEMA)
    for key, value in (
        ("endpoint", endpoint),
        ("api_key", "legacy-key"),
        ("model", "legacy-model"),
        ("theme", "dark"),
    ):
        await conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?)", (key, json.dumps(value))
        )
    await conn.execute(
        "INSERT INTO sessions(id, title, created_at, updated_at, model) "
        "VALUES('legacy-session', 'Old chat', '2026-01-01T00:00:00+00:00', "
        "'2026-01-01T00:00:00+00:00', 'legacy-model')"
    )
    await conn.commit()
    await conn.close()

    conn = await db.connect(path)
    try:
        rows = await conn.execute_fetchall("SELECT * FROM providers")
        checks(
            "migration seeds a provider from legacy settings",
            len(rows) == 1
            and rows[0]["endpoint"] == endpoint
            and rows[0]["api_key"] == "legacy-key"
            and rows[0]["model"] == "legacy-model",
            str([dict(r) for r in rows]),
        )
        checks(
            "migration names the provider after its host",
            rows[0]["name"] == "legacy.example.test",
            rows[0]["name"],
        )
        active = await conn.execute_fetchall(
            "SELECT value FROM settings WHERE key = 'active_provider_id'"
        )
        checks(
            "migration connects the seeded provider",
            bool(active) and json.loads(active[0]["value"]) == rows[0]["id"],
            str(active),
        )
        sessions = await conn.execute_fetchall("SELECT provider_id FROM sessions")
        checks(
            "migration assigns existing chats to the seeded provider",
            [s["provider_id"] for s in sessions] == [rows[0]["id"]],
            str([dict(s) for s in sessions]),
        )

        # A second startup must not seed again.
        await db.migrate(conn)
        again = await conn.execute_fetchall("SELECT COUNT(*) AS c FROM providers")
        checks("migration is idempotent", again[0]["c"] == 1, str(again[0]["c"]))

        # Deleting the provider it seeded must not resurrect it on restart.
        await conn.execute("DELETE FROM providers")
        await conn.commit()
        await db.migrate(conn)
        after_delete = await conn.execute_fetchall("SELECT COUNT(*) AS c FROM providers")
        checks(
            "migration does not resurrect a deleted provider",
            after_delete[0]["c"] == 0,
            str(after_delete[0]["c"]),
        )
    finally:
        await db.close()


def main() -> int:
    # Start the fake upstreams on ephemeral ports.
    server = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()
    endpoint = f"http://127.0.0.1:{port}/v1"

    server_b = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstreamB)
    port_b = server_b.server_address[1]
    threading.Thread(target=server_b.serve_forever, daemon=True).start()
    endpoint_b = f"http://127.0.0.1:{port_b}/v1"

    server_gz = ThreadingHTTPServer(("127.0.0.1", 0), GzipUpstream)
    port_gz = server_gz.server_address[1]
    threading.Thread(target=server_gz.serve_forever, daemon=True).start()
    endpoint_gz = f"http://127.0.0.1:{port_gz}/v1"

    passed = 0

    def check(name: str, cond: bool, detail: str = ""):
        nonlocal passed
        if cond:
            passed += 1
            print(f"PASS {name}")
        else:
            print(f"FAIL {name} {detail}")
            raise SystemExit(1)

    # Upgrade path, on its own scratch database.
    asyncio.run(check_migration(check))

    with TestClient(app) as client:
        # Start from a clean slate so count assertions are deterministic,
        # even if the dev database already has chats in it.
        client.delete("/api/sessions")

        # Health.
        r = client.get("/api/health")
        check("health", r.status_code == 200 and r.json() == {"status": "ok", "version": "0.1.0"})

        # Settings round-trip.
        settings_body = {
            "endpoint": endpoint,
            "api_key": "secret-key",
            "model": "fake-model-1",
            "temperature": 0.5,
            "system_prompt": "be terse",
            "theme": "dark",
            "stream": True,
            "active_provider_id": "",
        }
        r = client.put("/api/settings", json=settings_body)
        check("settings PUT", r.status_code == 200 and r.json() == settings_body)
        r = client.get("/api/settings")
        check("settings GET round-trip", r.json() == settings_body)

        # Test connection (proves Authorization forwarding: upstream 401s without it).
        r = client.post("/api/settings/test-connection",
                        json={"endpoint": endpoint, "api_key": "secret-key"})
        check("test-connection ok", r.json() == {"ok": True, "models": ["fake-model-1"]}, r.text)
        r = client.post("/api/settings/test-connection",
                        json={"endpoint": "notaurl", "api_key": ""})
        check("test-connection bad endpoint", r.json()["ok"] is False)

        # Session create.
        r = client.post("/api/sessions", json={})
        check("session create", r.status_code == 201, r.text)
        session = r.json()
        sid = session["id"]
        check("session defaults", session["title"] == "New chat" and session["model"] == "fake-model-1")

        # Streaming chat: concatenated deltas must be "Hello".
        r = client.post(f"/api/sessions/{sid}/chat", json={"content": "Say hello world"})
        check("chat 200 SSE", r.status_code == 200 and "text/event-stream" in r.headers["content-type"])
        events = parse_sse(r.text)
        deltas = "".join(e["text"] for e in events if e["type"] == "delta")
        check("chat deltas == Hello", deltas == "Hello", r.text)
        done = [e for e in events if e["type"] == "done"]
        check("chat done event", len(done) == 1 and done[0]["content"] == "Hello")

        # Auto-title: first 48 chars, no 'New chat' left.
        r = client.get(f"/api/sessions/{sid}")
        check("auto-title", r.json()["title"] == "Say hello world", r.text)

        # Messages persisted: user + assistant(complete).
        r = client.get(f"/api/sessions/{sid}/messages")
        msgs = r.json()
        check("messages count", len(msgs) == 2, r.text)
        check("messages roles", [m["role"] for m in msgs] == ["user", "assistant"])
        check("assistant persisted",
              msgs[1]["status"] == "complete" and msgs[1]["content"] == "Hello"
              and msgs[1]["model"] == "fake-model-1" and isinstance(msgs[1]["elapsed_ms"], int),
              json.dumps(msgs[1]))

        # Model picker endpoint (uses the legacy settings, no providers yet).
        r = client.get("/api/models")
        check("models endpoint", r.status_code == 200 and r.json() == {"models": ["fake-model-1"]}, r.text)

        # Non-streaming chat: single done event, no deltas.
        r = client.post(f"/api/sessions/{sid}/chat",
                        json={"content": "again", "stream": False})
        events = parse_sse(r.text)
        done = [e for e in events if e["type"] == "done"]
        check("non-stream chat",
              not [e for e in events if e["type"] == "delta"]
              and len(done) == 1 and done[0]["content"] == "Hello", r.text)

        # Upstream error path: persisted assistant message with status "error".
        global FAIL_CHAT
        FAIL_CHAT = True
        r = client.post(f"/api/sessions/{sid}/chat", json={"content": "this will fail"})
        events = parse_sse(r.text)
        errors = [e for e in events if e["type"] == "error"]
        check("chat error event", len(errors) == 1 and "500" in errors[0]["message"], r.text)
        r = client.get(f"/api/sessions/{sid}/messages")
        last = r.json()[-1]
        check("error message persisted",
              last["role"] == "assistant" and last["status"] == "error" and last["error"],
              json.dumps(last))
        FAIL_CHAT = False

        # Bulk delete: 1 session, 6 messages (3 user + 3 assistant).
        r = client.delete("/api/sessions")
        check("delete all",
              r.json() == {"ok": True, "deleted_sessions": 1, "deleted_messages": 6}, r.text)
        r = client.get("/api/sessions")
        check("sessions empty after delete", r.json() == [])

        # A gzip-encoded event-stream must still be read (see GzipUpstream).
        r = client.post("/api/providers", json={
            "name": "Gzip", "endpoint": endpoint_gz, "api_key": "gz-key",
            "model": "gzip-model",
        })
        gz_id = r.json()["id"]
        client.post(f"/api/providers/{gz_id}/connect")
        r = client.post("/api/sessions", json={})
        gz_sid = r.json()["id"]
        r = client.post(f"/api/sessions/{gz_sid}/chat", json={"content": "hello"})
        events = parse_sse(r.text)
        deltas = "".join(e["text"] for e in events if e["type"] == "delta")
        done = [e for e in events if e["type"] == "done"]
        check("gzip-encoded stream is decoded",
              deltas == "gzipped" and len(done) == 1 and done[0]["content"] == "gzipped",
              r.text)
        # Remove it again so the provider/session checks below start clean.
        client.delete(f"/api/providers/{gz_id}")
        client.delete("/api/sessions")

        # 404s use the {"error": ...} shape.
        r = client.get("/api/sessions/does-not-exist")
        check("404 error shape", r.status_code == 404 and "error" in r.json(), r.text)

        # --- providers ---

        # Adding the first provider connects it, and puts the legacy endpoint
        # settings out of the picture from here on.
        r = client.post("/api/providers", json={
            "endpoint": endpoint, "api_key": "secret-key", "model": "fake-model-1",
        })
        check("provider create", r.status_code == 201, r.text)
        alpha = r.json()
        alpha_id = alpha["id"]
        check("first provider auto-connects", alpha["connected"] is True, r.text)
        check("provider name defaults to its host",
              alpha["name"] == f"127.0.0.1:{port}", r.text)

        # A second provider from the second upstream stays disconnected.
        r = client.post("/api/providers", json={
            "name": "Beta", "endpoint": endpoint_b, "api_key": "beta-key", "model": "beta-model",
        })
        check("second provider create", r.status_code == 201, r.text)
        beta = r.json()
        beta_id = beta["id"]
        check("second provider not connected", beta["connected"] is False, r.text)

        r = client.get("/api/providers")
        check("provider list",
              [p["id"] for p in r.json()] == [alpha_id, beta_id]
              and [p["connected"] for p in r.json()] == [True, False], r.text)

        # Connect the second one: new chats follow it, and so does /api/models.
        r = client.post(f"/api/providers/{beta_id}/connect")
        check("provider connect", r.json()["connected"] is True, r.text)
        r = client.get("/api/models")
        check("models endpoint follows connected provider",
              r.json() == {"models": ["beta-model"]}, r.text)

        r = client.post("/api/sessions", json={})
        beta_sid = r.json()["id"]
        check("new session pins connected provider",
              r.json()["provider_id"] == beta_id and r.json()["model"] == "beta-model", r.text)

        r = client.post(f"/api/sessions/{beta_sid}/chat", json={"content": "hi beta"})
        done = [e for e in parse_sse(r.text) if e["type"] == "done"]
        check("chat uses connected provider", done[0]["content"] == "Second", r.text)

        # Switching back must not re-point the chat that belongs to the other
        # provider — that is the whole point of storing the provider per chat.
        client.post(f"/api/providers/{alpha_id}/connect")
        r = client.post(f"/api/sessions/{beta_sid}/chat", json={"content": "still beta?"})
        done = [e for e in parse_sse(r.text) if e["type"] == "done"]
        check("chat keeps its own provider after a switch",
              done[0]["content"] == "Second" and done[0]["model"] == "beta-model", r.text)

        # A chat started while Beta is connected, used while Alpha is.
        r = client.post("/api/sessions", json={})
        alpha_sid = r.json()["id"]
        r = client.post(f"/api/sessions/{alpha_sid}/chat", json={"content": "hi alpha"})
        done = [e for e in parse_sse(r.text) if e["type"] == "done"]
        check("second chat uses the other provider", done[0]["content"] == "Hello", r.text)

        # Editing the connected provider re-points the live connection.
        r = client.put(f"/api/providers/{alpha_id}", json={"endpoint": endpoint_b, "model": "beta-model"})
        check("provider update", r.json()["endpoint"] == endpoint_b and r.json()["model"] == "beta-model", r.text)
        r = client.post(f"/api/sessions/{alpha_sid}/chat", json={"content": "edited?"})
        done = [e for e in parse_sse(r.text) if e["type"] == "done"]
        check("editing the connected provider changes the live connection",
              done[0]["content"] == "Second", r.text)
        client.put(f"/api/providers/{alpha_id}", json={"endpoint": endpoint, "model": "fake-model-1"})

        # Deleting a provider re-homes its chats and reports how many.
        r = client.delete(f"/api/providers/{beta_id}")
        check("provider delete re-homes chats",
              r.json() == {"ok": True, "rehomed_sessions": 1}, r.text)
        r = client.get(f"/api/sessions/{beta_sid}")
        check("re-homed chat loses its provider",
              r.json()["provider_id"] is None, r.text)
        r = client.post(f"/api/sessions/{beta_sid}/chat", json={"content": "now alpha"})
        done = [e for e in parse_sse(r.text) if e["type"] == "done"]
        check("re-homed chat falls back to the connected provider",
              done[0]["content"] == "Hello" and done[0]["model"] == "fake-model-1", r.text)

        # Disconnecting leaves nothing connected, and the chat uses the
        # remaining provider rather than erroring.
        r = client.get("/api/providers")
        check("providers left after delete", len(r.json()) == 1, r.text)

        # Both chats have been re-pinned onto it by the sends above.
        r = client.delete(f"/api/providers/{alpha_id}")
        check("deleting the last provider",
              r.json() == {"ok": True, "rehomed_sessions": 2}, r.text)
        r = client.get("/api/providers")
        check("no providers left", r.json() == [], r.text)
        r = client.get("/api/models")
        check("models endpoint 400s with nothing connected",
              r.status_code == 400 and "error" in r.json(), r.text)
        r = client.post(f"/api/sessions/{alpha_sid}/chat", json={"content": "no provider"})
        errors = [e for e in parse_sse(r.text) if e["type"] == "error"]
        check("chat with nothing connected emits an SSE error",
              len(errors) == 1 and "provider" in errors[0]["message"].lower(), r.text)

        # Empty settings fall back to the documented defaults.
        r = client.put("/api/settings", json={
            "endpoint": "", "api_key": "", "model": "", "temperature": 0.7,
            "system_prompt": "", "theme": "system", "stream": True,
            "active_provider_id": "",
        })
        r = client.get("/api/settings")
        check("settings defaults", r.json()["theme"] == "system" and r.json()["stream"] is True)

    server.shutdown()
    server_b.shutdown()
    print(f"ALL {passed} CHECKS PASSED")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
