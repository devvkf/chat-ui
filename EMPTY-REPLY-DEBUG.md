# Empty replies from streaming chat — debugging handoff

Date: 2026-10-12. App: Relay (local OpenAI-compatible chat client).
Repo root: `U:\venvs\chatui`. Backend: `backend/` (FastAPI + aiosqlite,
run via `npm run dev:api` from repo root, serves API + `dist/` on :8000).
Frontend: `src/` (React 19 + TS + Tailwind v4), production bundle in `dist/`.

## The problem

Sending a message through the UI (viewed at `http://127.0.0.1:8000/`)
produces an **assistant bubble that is empty but NOT errored**. Screenshot:
`modelsdoesntrespond.png` (repo root) — user messages "HELLO" and "I" each
followed by an empty assistant bubble with the sparkle icon. Model picker
shows `deepseek-v4-flash`, connected provider `ai.flaz.id`
(`https://ai.flaz.id/v1`). Persists across incognito (rules out extensions
and HTTP cache). User's words: "connection works, streaming just doesnt."

"Connection works" = Settings → Test connection succeeds and the model list
loads. So `/models` against the provider is fine; only `/chat/completions`
streaming misbehaves.

## What was proven working (do NOT re-investigate)

- Backend serves fresh code: `GET /api/providers` lists 3 saved providers
  with `ai.flaz.id` (`id 9ff7bc9a…`) `connected: true`; `/api/models`
  returns ~80 model ids through it.
- Served bundle is fresh: `dist/assets/index-D26jlzbr.js` (built 20:27, after
  all src edits) contains "Switch provider" / "Manage providers" UI strings.
- `src/lib/sse.ts` (frontend SSE parser) correctly handles
  `data: {json}\n\n` frames including `done` with `content`.
- Backend `/api/sessions/{id}/chat` works **sometimes**: a direct curl
  returned `start` → 6 `delta` events ("Hi! What are you working on?") →
  `done` with full content, persisted `complete`. So provider resolution
  (`backend/app/routers/providers.py::resolve_target`), auth headers, model
  pinning, and persistence are all correct.

## The key reproduction (intermittent upstream empty stream)

Same curl repeated minutes later returned:

```
data: {"type": "start", ...}
                                          # ~1.5 s gap, zero deltas
data: {"type": "done", ..., "content": "", "model": "deepseek-v4-flash"}
```

And with `"stream": false` the same model/upstream returned
`"Hi. What are we building?"` with usage
(`completion_tokens: 8`). So:

- The upstream's **streaming path intermittently closes normally with zero
  text chunks**; its non-streaming path answers fine.
- The backend faithfully proxies this as `start` → `done` with empty
  content — hence the silent empty bubble. **This is believed to be the
  whole bug: an upstream streaming flake, surfaced with no error.**

## What was changed (uncommitted — repo is NOT git, no commits exist)

`backend/app/routers/chat.py`, inside `event_stream()`'s try/finally:

- Added `disconnecting = False` / `empty_reply = False` flags at generator
  top.
- `except (GeneratorExit, ...)`: sets `disconnecting = True` before re-raise.
- `finally`: when `status == "complete"` but `content` is empty and there
  was no endpoint error, flips to `status = "error"` with message
  "The provider returned an empty reply. Try again, or turn off streaming
  in Settings → Chat." It does NOT yield there (yield-in-finally during
  GeneratorExit raises RuntimeError); instead it sets `empty_reply = True`
  and the `yield _sse({"type": "error", ...})` happens after the
  `_persist_assistant` call, guarded by `if empty_reply and not
  disconnecting:`.
- Verified: `syntax ok`, `backend/tests/smoke.py` → ALL 50 CHECKS PASSED.
- Backend was NOT restarted after this edit — `dev:api` runs with `--reload`,
  so it should have picked it up; confirm the next empty reply now shows a
  red error bubble instead of a silent empty one.

## What was tried and ruled out

1. Stale `dist/` bundle — ruled out (hash `index-D26jlzbr.js`, post-dates src).
2. Stale backend process — ruled out (live `/api/providers` route exists only
   in new code).
3. Browser cache/extensions — ruled out (incognito reproduces).
4. `file:///` console error ("Content at http://127.0.0.1:8000/ may not load
   or link to file:///") — red herring; no `file://` string exists anywhere
   in `src/`, `index.html`, `vite.config.ts`, `public/`, or `dist/index.html`.
   Likely an extension in the normal profile; incognito reproduces without it.
5. Dead `Screenshots` provider (`http://127.0.0.1:50920/v1`, leftover from
   `scripts/shoot.mjs`) — NOT connected, harmless unless selected.
6. Direct upstream probing with the real key was BLOCKED by the harness
   (credential-materialization policy) — raw upstream chunk shapes in the
   empty case were never observed. This is the biggest open evidence gap.

## Potential fixes / next steps (pick one)

A. **Confirm the empty-chunk shape** (recommended first). In the user's own
   terminal — key never leaves their machine:
   ```bash
   KEY=$(python -c "import sqlite3;print(sqlite3.connect('backend/data/relay.db').execute(\"SELECT api_key FROM providers WHERE name='ai.flaz.id'\").fetchone()[0])"); for i in 1 2 3 4 5 6; do echo "=== try $i ==="; curl -s -m 60 -N -X POST https://ai.flaz.id/v1/chat/completions -H 'content-type: application/json' -H "Authorization: Bearer $KEY" -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"say hi"}],"stream":true}' | head -12; done
   ```
   Look for: chunks with only `delta.reasoning_content` and null `content`
   (backend's `_extract_delta` drops those → fix = also harvest
   `reasoning_content`); vs. literally zero data lines before `[DONE]`
   (pure upstream flake → fix B/C).
B. **Retry-with-fallback**: if a streaming attempt yields zero text, retry
   the same request once with `"stream": false` and deliver
   `_extract_nonstream_content` as a single delta+done. Proven the
   non-streaming path works. Watch out: the user message is already
   persisted, so a retry must not duplicate it; and only retry once.
C. **Report-only** (already implemented, pending user confirmation): keep the
   red "empty reply" error bubble so failures are visible and retryable.
   Cheapest, but leaves the flake hitting users ~half the time.
D. **Model-specific**: user also saved provider `TP`
   (`https://tokenportal.id/v1`, model `grok-47-unli`). If ai.flaz.id's
   `deepseek-v4-flash` streaming stays flaky, try another model on the same
   endpoint (e.g. `qwen3.7-flash-2026-07-15`) to see if the flake is
   model-specific or endpoint-wide.

## Cleanup owed to the user

- My live probes created junk sessions in the REAL `backend/data/relay.db`
  (titles: several "say hi", "hi", "count to five slowly", one "New chat";
  ids at debug time: `505ec034…`, `c2989bda…`, `f6ac3f3c…`, `a73547d6…`,
  `159e840e…`, `af14c364…`, `e3b09313…`). A bulk DELETE was blocked by
  policy — ask the user before deleting, or have them delete from the UI.
  The user's real chats ("HELLO", "I", "what's a cpu", "Here's a stack
  trace…") were NOT touched.
- Suggested UI deletions do not exist yet: no per-chat delete was used.

## Exact verification commands

```bash
# backend suite (uses scratch RELAY_DB, never touches real data)
cd backend && uv run python tests/smoke.py        # expect ALL 50 CHECKS PASSED
# frontend
npm run build                                     # tsc -b + vite build, expect clean
npm run lint                                      # warnings only (some pre-existing)
# live: npm run dev:api  →  curl http://127.0.0.1:8000/api/health
```
