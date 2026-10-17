# Relay backend

FastAPI backend for the Relay local chat UI. Talks to any OpenAI-compatible
server (LM Studio, llama.cpp, vLLM, OpenAI, ...) and stores chats in SQLite.

## Run

```bash
cd backend
uv sync                                # create .venv and install deps
uv run uvicorn app.main:app --port 8000
```

Dev mode (auto-reload): add `--reload`. If `../dist` exists (the Vite
production build), it is served at `http://127.0.0.1:8000/` with SPA
fallback; otherwise only the API is available.

## Database

SQLite at `backend/data/relay.db` (created on first startup, WAL mode,
foreign keys on). Tables: `sessions` (each row names its `provider_id`),
`messages`, `settings`, `providers`. Delete the `data/` directory to start
fresh. Upgrading keeps a previously configured endpoint: it is carried into
the `providers` table on first startup and connected automatically.

## Endpoints

All under `/api`:

| Method | Path | Description |
|---|---|---|
| GET | `/health` | `{"status": "ok", "version": "0.1.0"}` |
| GET / PUT | `/settings` | Read / overwrite settings (temperature, system_prompt, theme, stream, `active_provider_id`; `endpoint`/`api_key`/`model` are a legacy fallback used only when no provider is saved) |
| POST | `/settings/test-connection` | Probe `{endpoint}/models`; always 200 with `{"ok": bool, ...}` |
| GET / POST | `/providers` | List saved providers (each with a `connected` flag) / save a new one |
| PUT / DELETE | `/providers/{id}` | Edit / delete; deleting also clears the provider off its chats (reported as `rehomed_sessions`) |
| POST | `/providers/{id}/connect` | Connect a saved provider |
| GET | `/models` | List models from the connected provider; 400 `{"error": ...}` when nothing is connected/unreachable |
| GET / POST | `/sessions` | List (with `message_count`, newest first) / create session (stamped with the connected provider) |
| GET / PATCH / DELETE | `/sessions/{id}` | Fetch / rename-or-remodel / delete (cascades messages) |
| DELETE | `/sessions` | Delete everything; returns `{"ok", "deleted_sessions", "deleted_messages"}` |
| GET | `/sessions/{id}/messages` | Full history, oldest first |
| POST | `/sessions/{id}/chat` | Send a message; responds `text/event-stream` |

Chat SSE events (`data: {json}` lines): `start`, `delta` (text chunks),
`done` (full content + `elapsed_ms`, optional `usage`), `error`. The
assistant message is persisted when the stream finishes with status
`complete` / `error` / `aborted` (client disconnect). Errors elsewhere use
the shape `{"error": "..."}`.

## Test

```bash
uv run python tests/smoke.py
```

Spins up a fake OpenAI-compatible upstream and exercises the whole API
end to end; prints PASS lines and exits 0 on success.
