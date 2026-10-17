# Postmortem: the silent empty assistant bubble

Date: 2026-10-12. App: Relay (local OpenAI-compatible chat client).
Backend: `backend/app/routers/chat.py`. Provider: `ai.flaz.id`
(`https://ai.flaz.id/v1`), a **LiteLLM proxy** (`x-litellm-version: 1.99.1`).

This is the learning writeup. The older `EMPTY-REPLY-DEBUG.md` is the original
handoff doc — read it for the investigation trail, but note its headline theory
("upstream streaming flake") was **wrong** and is corrected here.

---

## 1. The symptom

Sending a message in the UI produced an **assistant bubble that was empty but
not errored**. No red text, no crash — just a blank reply with the sparkle
icon. Connection tests and model lists worked fine; only
`/chat/completions` streaming misbehaved.

The maddening part: **it was intermittent.** The same request sometimes
returned a normal reply and sometimes an empty one. Intermittent bugs tempt you
to blame "flakiness" and move on. That's exactly the trap we fell into first.

---

## 2. The wrong first theory (and why it was seductive)

Initial observation: the upstream sometimes returned a stream that ended
normally with **zero text chunks**:

```
data: {"type": "start", ...}
                                    # ~1.5 s gap, no deltas
data: {"type": "done", ..., "content": "", "model": "deepseek-v4-flash"}
```

And with `"stream": false`, the *same* model returned a perfectly good answer.
Conclusion drawn at the time: "the upstream's streaming path is flaky; it
closes with no content. Not our bug."

Why this was seductive:
- It matched the intermittency.
- The non-streaming path working "proved" the upstream was fine *sometimes*.
- The empty stream was a real, observed event — it just wasn't the **cause**.

**Lesson:** "I saw an empty stream" is an observation, not a root cause. The
empty stream was a *symptom downstream of* the real bug, not the bug itself.
We were looking at the wreckage and calling it the driver.

---

## 3. Finding the real cause

The turning point was refusing to accept the flake and instead **capturing the
raw bytes the upstream actually sent** on a failing request.

What the captured failing response looked like:

```
first bytes: 1f 8b 08 ...        # 0x1f 0x8b = the gzip magic number
data: lines: 0                   # zero SSE lines found
```

Those bytes are **gzip**. `gzip.decompress(...)` on the same bytes produced a
perfectly valid SSE stream — **202 `data:` lines** including the real answer.

So the upstream was never "empty." It was sending the answer **gzip-compressed**,
intermittently, and our code was reading the compressed bytes as if they were
plain text.

### The reproduction that nailed it

Same request, two ways of reading the response body:

| method           | `data:` lines found |
|------------------|---------------------|
| `aiter_raw()`    | ~0                  |
| `aiter_bytes()`  | 205                 |

Correlation with response length: short/fast replies were never compressed;
a long one (`"Write 250 words about mountains. Be verbose."`) reliably came
back gzipped. That's why it *looked* random — it depended on payload size and
whatever the proxy's compression heuristic decided.

---

## 4. The root cause (the one line)

In `backend/app/routers/chat.py`, `_read_sse()` iterated the stream with:

```python
async for chunk in resp.aiter_raw():
```

`httpx` has two streaming iterators and they differ in a way that's easy to miss:

- **`aiter_raw()`** — yields the bytes **exactly as they came off the wire**.
  It does **not** decode `Content-Encoding`. A gzip body arrives still gzipped.
- **`aiter_bytes()`** — yields the body **after applying `Content-Encoding`**
  (gzip / deflate / brotli / zstd). It decompresses for you.

`aread()` (the non-streaming read) internally uses `aiter_bytes()`, which is
exactly why **non-streaming worked and streaming didn't** — the two code paths
disagreed about decompression, and nobody noticed because the difference only
shows up when the server actually compresses.

### The failure chain

1. Proxy sends SSE body with `Content-Encoding: gzip` (intermittently, more
   likely on longer bodies).
2. Backend reads it with `aiter_raw()` → gets **compressed** bytes.
3. Code does `chunk.decode("utf-8", "replace")` → the gzip bytes become
   **garbage text** (replacement chars), containing **no `data:` lines**.
4. `_consume_sse()` finds no `data:` lines → yields **zero deltas**.
5. The stream ends normally with no content → the UI renders a silent,
   un-errored **empty bubble**.

Every step is "correct" in isolation. The bug is the *composition*: a
transparent-decompression assumption that `aiter_raw()` quietly violates.

### The fix

```python
async for chunk in resp.aiter_bytes():   # was: resp.aiter_raw()
```

One line. `aiter_bytes()` decompresses the gzip body, so the `data:` lines are
visible again and deltas flow.

---

## 5. Why it took so long (the real lessons)

**1. "It's the upstream's fault" is a hypothesis, not a verdict.**
We proved the upstream was flaky *before* we proved it was *the cause*. An
intermittent upstream problem can coexist with a deterministic client bug and
mask it. Capture the raw wire bytes before blaming the other side.

**2. Know your library's decompression semantics.**
`aiter_raw` vs `aiter_bytes` is a genuine footgun. `raw` sounds like "the real
data"; it actually means "before content-encoding is applied." Whenever you
stream an HTTP body, know which one you're using and whether the response can
be compressed. The same class of bug exists in `requests` (`stream=True` +
`.raw` vs `.iter_content`), `curl --raw`, Node's `http` (no auto-gunzip at all),
etc.

**3. "It works sometimes" usually means an untested branch, not randomness.**
The two branches here were *compressed* vs *uncompressed*. The bug was 100%
deterministic given a compressed response; it only *looked* random because the
compression trigger was probabilistic. Ask "what varies between the working and
failing runs?" — here it was response size → compression.

**4. Non-streaming and streaming are separate code paths; test both.**
The non-streaming path used `aread()` (which decompresses) and worked, which
lent false confidence. A path that shares *intent* doesn't share *code*.

**5. Write the failing test before the fix.**
The regression test is a fake upstream (`GzipUpstream` in
`backend/tests/smoke.py`) that gzips its SSE body and sets
`Content-Encoding: gzip`. It fails against `aiter_raw()` and passes against
`aiter_bytes()`. Without it, a future refactor could silently reintroduce this.
Suite went from 50 → **51 checks, all passing**.

**6. Don't hide the failure.**
Separately from the root cause, the code now converts a genuinely-empty
completed stream into a visible error bubble ("The provider returned an empty
reply…") instead of a silent blank one. Even after fixing the real bug, failing
loudly beats failing invisibly — it's what would have shortened this hunt.

---

## 6. Transferable checklist

- Symptom of "empty response, no error" on a streamed body → suspect
  **encoding/decoding**, not the server's logic.
- Check the **first bytes** of the failing payload. `1f 8b` = gzip, `78 9c`/`78 01`
  = zlib/deflate, `28 b5 2f fd` = zstd. Magic numbers tell you the truth fast.
- Verify you're reading with an iterator that **honors `Content-Encoding`**.
- Compare **streaming vs non-streaming** paths for asymmetric decode behavior.
- Reproduce with a **deliberately compressed fake server** and keep it as a test.

---

## 7. Verification commands

```bash
# backend suite (scratch DB; includes the gzip regression test)
cd backend && uv run python tests/smoke.py        # expect ALL 51 CHECKS PASSED
# frontend
npm run build                                      # tsc -b + vite build
npm run lint
```
