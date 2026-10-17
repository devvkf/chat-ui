import type { Message, Provider, Session, Settings } from "./types";

const BASE = "/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    let detail = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string; detail?: string };
      detail = body.error ?? body.detail ?? detail;
    } catch {
      /* response body was not JSON — keep the status line */
    }
    throw new Error(detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ status: string; version: string }>("/health"),

  getSettings: () => request<Settings>("/settings"),
  saveSettings: (settings: Settings) =>
    request<Settings>("/settings", {
      method: "PUT",
      body: JSON.stringify(settings),
    }),
  testConnection: (endpoint: string, apiKey: string) =>
    request<{ ok: boolean; models?: string[]; error?: string }>(
      "/settings/test-connection",
      {
        method: "POST",
        body: JSON.stringify({ endpoint, api_key: apiKey }),
      },
    ),

  listProviders: () => request<Provider[]>("/providers"),
  createProvider: (draft: Partial<Provider>) =>
    request<Provider>("/providers", {
      method: "POST",
      body: JSON.stringify(draft),
    }),
  updateProvider: (id: string, patch: Partial<Provider>) =>
    request<Provider>(`/providers/${id}`, {
      method: "PUT",
      body: JSON.stringify(patch),
    }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean; rehomed_sessions: number }>(`/providers/${id}`, {
      method: "DELETE",
    }),
  connectProvider: (id: string) =>
    request<Provider>(`/providers/${id}/connect`, { method: "POST" }),

  listSessions: () => request<Session[]>("/sessions"),
  createSession: () => request<Session>("/sessions", { method: "POST" }),
  renameSession: (id: string, title: string) =>
    request<Session>(`/sessions/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    }),
  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/sessions/${id}`, { method: "DELETE" }),
  deleteAllSessions: () =>
    request<{ ok: boolean; deleted_sessions: number; deleted_messages: number }>(
      "/sessions",
      { method: "DELETE" },
    ),

  listMessages: (sessionId: string) =>
    request<Message[]>(`/sessions/${sessionId}/messages`),

  /**
   * Starts a streaming chat completion. The HTTP response is an SSE stream
   * (always, even for non-streaming requests) — use `readChatStream` on the
   * returned response.
   */
  chat: (
    sessionId: string,
    body: { content: string; stream: boolean; model?: string | null },
    signal?: AbortSignal,
  ) =>
    fetch(`${BASE}/sessions/${sessionId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    }),

  listModels: () => request<{ models: string[] }>("/models"),
};
