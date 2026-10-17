import type { ChatEvent } from "./types";

/**
 * Parses an SSE response body (`data: {json}\n\n` frames) into chat events.
 * Yields as events arrive so the UI can stream tokens live.
 */
export async function* readChatStream(
  response: Response,
): AsyncGenerator<ChatEvent> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 2);
        const data = frame.startsWith("data:")
          ? frame.slice(5).trim()
          : "";
        if (!data || data === "[DONE]") continue;
        try {
          yield JSON.parse(data) as ChatEvent;
        } catch {
          /* skip frames that are not JSON */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
