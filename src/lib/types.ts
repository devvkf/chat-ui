/** Shared types mirroring the FastAPI backend contract. */

export type Role = "user" | "assistant";
export type MessageStatus = "complete" | "error" | "aborted";

export interface Message {
  id: string;
  session_id: string;
  role: Role;
  content: string;
  created_at: string;
  status: MessageStatus;
  error: string | null;
  model: string | null;
  elapsed_ms: number | null;
}

export interface Session {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  model: string | null;
  /** Which saved provider this chat talks to; null until the first send. */
  provider_id: string | null;
  message_count?: number;
}

/** A saved upstream connection. `connected` marks the one currently in use. */
export interface Provider {
  id: string;
  name: string;
  endpoint: string;
  api_key: string;
  model: string;
  created_at: string;
  updated_at: string;
  connected: boolean;
}

export type ThemeValue = "system" | "light" | "dark";

export interface Settings {
  endpoint: string;
  api_key: string;
  model: string;
  temperature: number;
  system_prompt: string;
  theme: ThemeValue;
  stream: boolean;
  /** Id of the connected provider; empty means none is connected yet. */
  active_provider_id: string;
}

export const DEFAULT_SETTINGS: Settings = {
  endpoint: "",
  api_key: "",
  model: "",
  temperature: 0.7,
  system_prompt: "",
  theme: "system",
  stream: true,
  active_provider_id: "",
};

/** SSE events emitted by POST /api/sessions/{id}/chat. */
export type ChatEvent =
  | { type: "start"; message_id: string; created_at: string }
  | { type: "delta"; text: string }
  | { type: "done"; message_id: string; elapsed_ms: number; content: string; model: string | null }
  | { type: "error"; message: string };
