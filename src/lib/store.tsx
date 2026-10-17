import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { toast } from "sonner";
import { api } from "./api";
import { readChatStream } from "./sse";
import { DEFAULT_SETTINGS, type Message, type Provider, type Session, type Settings } from "./types";

interface ChatStore {
  ready: boolean;
  /** Whether the backend answered our last call. */
  backendOnline: boolean;
  settings: Settings;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  /** Saved provider configs; exactly one may be `connected`. */
  providers: Provider[];
  activeProvider: Provider | null;
  /** True when some provider is connected, i.e. chats can be sent. */
  connected: boolean;
  refreshProviders: () => Promise<void>;
  connectProvider: (id: string) => Promise<void>;
  createProvider: (draft: Partial<Provider>) => Promise<Provider>;
  saveProvider: (id: string, patch: Partial<Provider>) => Promise<void>;
  /** Returns how many chats fell back to the connected provider. */
  deleteProvider: (id: string) => Promise<number>;
  /** Pick the model used by the connected provider. */
  setModel: (model: string) => Promise<void>;
  sessions: Session[];
  activeSessionId: string | null;
  activeSession: Session | null;
  messages: Message[];
  loadingMessages: boolean;
  streaming: boolean;
  send: (text: string, model?: string | null) => Promise<void>;
  stop: () => void;
  retry: () => Promise<void>;
  selectSession: (id: string | null) => void;
  newSession: () => Promise<Session>;
  renameSession: (id: string, title: string) => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
  deleteAllSessions: () => Promise<{ sessions: number; messages: number }>;
  refreshSessions: () => Promise<void>;
}

const StoreContext = createContext<ChatStore | null>(null);

let localSeq = 0;
const localId = () => `local-${Date.now().toString(36)}-${(localSeq++).toString(36)}`;

function userMessage(sessionId: string, content: string): Message {
  return {
    id: localId(),
    session_id: sessionId,
    role: "user",
    content,
    created_at: new Date().toISOString(),
    status: "complete",
    error: null,
    model: null,
    elapsed_ms: null,
  };
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  /** Whether the backend answered the last call. Offline is not the same as
      "no provider connected" — see `connected`. */
  const [backendOnline, setBackendOnline] = useState(true);
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [streaming, setStreaming] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  /** Latest settings, readable from long-lived callbacks without re-creating them. */
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);
  /** Latest providers, for the same reason. */
  const providersRef = useRef(providers);
  useEffect(() => {
    providersRef.current = providers;
  }, [providers]);
  /** Which session the current `messages` state belongs to. */
  const messagesSessionRef = useRef<string | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const list = await api.listSessions();
      setSessions(list);
      setBackendOnline(true);
    } catch {
      setBackendOnline(false);
    }
  }, []);

  /* Initial load: settings + providers + sessions, selecting the most recent chat. */
  useEffect(() => {
    (async () => {
      const [loadedSettings, loadedProviders, loadedSessions] = await Promise.all([
        api.getSettings().catch(() => null),
        api.listProviders().catch(() => null),
        api.listSessions().catch(() => null),
      ]);
      // A single reachable call is enough to know the backend is up.
      setBackendOnline(
        loadedSettings !== null || loadedProviders !== null || loadedSessions !== null,
      );
      if (loadedSettings) setSettings({ ...DEFAULT_SETTINGS, ...loadedSettings });
      if (loadedProviders) setProviders(loadedProviders);
      if (loadedSessions) {
        setSessions(loadedSessions);
        if (loadedSessions.length > 0) setActiveSessionId(loadedSessions[0].id);
      }
      setReady(true);
    })();
  }, []);

  /* Load messages whenever the active session changes. Skips sessions whose
     messages are already in local state (e.g. one just created by send()),
     so an in-flight stream is never clobbered by the server response. */
  useEffect(() => {
    if (!activeSessionId) {
      setMessages([]);
      messagesSessionRef.current = null;
      return;
    }
    if (messagesSessionRef.current === activeSessionId) return;
    let cancelled = false;
    setLoadingMessages(true);
    api
      .listMessages(activeSessionId)
      .then((list) => {
        if (cancelled) return;
        setMessages(list);
        messagesSessionRef.current = activeSessionId;
      })
      .catch((err: Error) => toast.error(`Could not load messages: ${err.message}`))
      .finally(() => {
        if (!cancelled) setLoadingMessages(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSessionId]);

  const activeSession = useMemo(
    () => sessions.find((s) => s.id === activeSessionId) ?? null,
    [sessions, activeSessionId],
  );

  const activeProvider = useMemo(
    () => providers.find((p) => p.connected) ?? null,
    [providers],
  );

  /* Re-read providers and settings after a provider mutation, so the sidebar,
     the model picker, and the settings form all agree with the backend. */
  const refreshProviders = useCallback(async () => {
    const [loadedProviders, loadedSettings] = await Promise.all([
      api.listProviders().catch(() => null),
      api.getSettings().catch(() => null),
    ]);
    setBackendOnline(loadedProviders !== null || loadedSettings !== null);
    if (loadedProviders) setProviders(loadedProviders);
    // Replace rather than merge: the settings form re-syncs from this, and the
    // server is the truth for anything the provider table now owns.
    if (loadedSettings) setSettings({ ...DEFAULT_SETTINGS, ...loadedSettings });
  }, []);

  const connectProvider = useCallback(
    async (id: string) => {
      try {
        await api.connectProvider(id);
      } catch (err) {
        toast.error(`Could not connect: ${(err as Error).message}`);
        throw err;
      }
      await refreshProviders();
    },
    [refreshProviders],
  );

  const createProvider = useCallback(
    async (draft: Partial<Provider>) => {
      const created = await api.createProvider(draft);
      await refreshProviders();
      return created;
    },
    [refreshProviders],
  );

  const saveProvider = useCallback(
    async (id: string, patch: Partial<Provider>) => {
      try {
        await api.updateProvider(id, patch);
      } catch (err) {
        toast.error(`Could not save the provider: ${(err as Error).message}`);
        throw err;
      }
      await refreshProviders();
    },
    [refreshProviders],
  );

  const deleteProvider = useCallback(
    async (id: string) => {
      try {
        const result = await api.deleteProvider(id);
        await refreshProviders();
        // The backend cleared provider_id on this provider's chats.
        await refreshSessions();
        return result.rehomed_sessions;
      } catch (err) {
        toast.error(`Could not delete the provider: ${(err as Error).message}`);
        throw err;
      }
    },
    [refreshProviders, refreshSessions],
  );

  const updateSettings = useCallback(async (patch: Partial<Settings>) => {
    const next = { ...settingsRef.current, ...patch };
    setSettings(next);
    try {
      await api.saveSettings(next);
    } catch (err) {
      toast.error(`Could not save settings: ${(err as Error).message}`);
    }
  }, []);

  /**
   * Choose the model the connected provider uses. With no provider connected
   * there is nothing to write it to, so it falls back to the legacy settings
   * row — the state a database is in before any provider has been saved.
   */
  const setModel = useCallback(
    async (model: string) => {
      const active = providersRef.current.find((p) => p.connected);
      if (active) {
        setProviders((prev) =>
          prev.map((p) => (p.id === active.id ? { ...p, model } : p)),
        );
        try {
          await api.updateProvider(active.id, { model });
        } catch (err) {
          toast.error(`Could not change the model: ${(err as Error).message}`);
        }
        await refreshProviders();
        return;
      }
      await updateSettings({ model });
    },
    [refreshProviders, updateSettings],
  );

  const newSession = useCallback(async () => {
    try {
      const session = await api.createSession();
      setSessions((prev) => [session, ...prev.filter((s) => s.id !== session.id)]);
      setActiveSessionId(session.id);
      return session;
    } catch (err) {
      toast.error(`Could not create a chat: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Sends a user message to the backend and streams the assistant reply into
   * the message list. The assistant bubble is created when the first SSE
   * `start` event arrives and updated by each `delta`.
   */
  const runStream = useCallback(
    async (sessionId: string, content: string, model?: string | null) => {
      const controller = new AbortController();
      abortRef.current = controller;
      setStreaming(true);

      let assistantId: string | null = null;
      let finalized = false;

      const patchAssistant = (
        patch: Partial<Message> | ((m: Message) => Partial<Message>),
      ) => {
        setMessages((prev) =>
          prev.map((m) => {
            if (!assistantId || m.id !== assistantId) return m;
            return typeof patch === "function" ? { ...m, ...patch(m) } : { ...m, ...patch };
          }),
        );
      };

      try {
        const res = await api.chat(
          sessionId,
          { content, stream: settingsRef.current.stream, model: model ?? null },
          controller.signal,
        );
        if (!res.ok || !res.body) {
          const text = await res.text().catch(() => "");
          throw new Error(text || `The server returned ${res.status}.`);
        }

        for await (const ev of readChatStream(res)) {
          if (controller.signal.aborted) break;
          switch (ev.type) {
            case "start":
              assistantId = ev.message_id;
              setMessages((prev) => [
                ...prev,
                {
                  id: ev.message_id,
                  session_id: sessionId,
                  role: "assistant",
                  content: "",
                  created_at: ev.created_at,
                  status: "complete",
                  error: null,
                  model: null,
                  elapsed_ms: null,
                },
              ]);
              break;
            case "delta":
              patchAssistant((m) => ({ content: m.content + ev.text }));
              break;
            case "done":
              finalized = true;
              patchAssistant({
                content: ev.content,
                status: "complete",
                elapsed_ms: ev.elapsed_ms,
                model: ev.model,
              });
              break;
            case "error":
              finalized = true;
              patchAssistant({ status: "error", error: ev.message });
              toast.error(ev.message);
              break;
          }
        }
        if (controller.signal.aborted && assistantId && !finalized) {
          patchAssistant({ status: "aborted", error: "Stopped before the reply finished." });
        }
      } catch (err) {
        const aborted = controller.signal.aborted || (err as Error).name === "AbortError";
        const message = aborted
          ? "Stopped before the reply finished."
          : (err as Error).message || "The request failed.";
        if (assistantId) {
          patchAssistant({ status: aborted ? "aborted" : "error", error: message });
        } else {
          // The request failed before any reply arrived — surface a local error bubble.
          setMessages((prev) => [
            ...prev,
            {
              id: localId(),
              session_id: sessionId,
              role: "assistant",
              content: "",
              created_at: new Date().toISOString(),
              status: "error",
              error: message,
              model: null,
              elapsed_ms: null,
            },
          ]);
        }
        if (!aborted) toast.error(message);
      } finally {
        setStreaming(false);
        abortRef.current = null;
        // Refresh the list so auto-generated titles, counts, and ordering catch up.
        void refreshSessions();
      }
    },
    [refreshSessions],
  );

  const send = useCallback(
    async (text: string, model?: string | null) => {
      const content = text.trim();
      if (!content || streaming) return;

      let sessionId = activeSessionId;
      if (!sessionId) {
        try {
          const session = await newSession();
          sessionId = session.id;
        } catch {
          return;
        }
      }

      setMessages((prev) => [...prev, userMessage(sessionId!, content)]);
      messagesSessionRef.current = sessionId;
      await runStream(sessionId, content, model);
    },
    [activeSessionId, newSession, runStream, streaming],
  );

  const retry = useCallback(async () => {
    if (streaming || !activeSessionId) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    // Keep everything up to and including that user message; drop the failed turn.
    const idx = messages.findIndex((m) => m.id === lastUser.id);
    setMessages(messages.slice(0, idx + 1));
    await runStream(activeSessionId, lastUser.content);
  }, [activeSessionId, messages, runStream, streaming]);

  const selectSession = useCallback((id: string | null) => {
    abortRef.current?.abort();
    setActiveSessionId(id);
  }, []);

  const renameSession = useCallback(
    async (id: string, title: string) => {
      const trimmed = title.trim();
      if (!trimmed) return;
      setSessions((prev) => prev.map((s) => (s.id === id ? { ...s, title: trimmed } : s)));
      try {
        await api.renameSession(id, trimmed);
      } catch (err) {
        toast.error(`Could not rename: ${(err as Error).message}`);
        void refreshSessions();
      }
    },
    [refreshSessions],
  );

  const deleteSession = useCallback(
    async (id: string) => {
      setSessions((prev) => prev.filter((s) => s.id !== id));
      if (activeSessionId === id) setActiveSessionId(null);
      try {
        await api.deleteSession(id);
      } catch (err) {
        toast.error(`Could not delete: ${(err as Error).message}`);
        void refreshSessions();
      }
    },
    [activeSessionId, refreshSessions],
  );

  const deleteAllSessions = useCallback(async () => {
    try {
      const result = await api.deleteAllSessions();
      setSessions([]);
      setActiveSessionId(null);
      setMessages([]);
      return { sessions: result.deleted_sessions, messages: result.deleted_messages };
    } catch (err) {
      toast.error(`Could not delete chats: ${(err as Error).message}`);
      throw err;
    }
  }, []);

  const value: ChatStore = {
    ready,
    backendOnline,
    settings,
    updateSettings,
    providers,
    activeProvider,
    connected: activeProvider !== null,
    refreshProviders,
    connectProvider,
    createProvider,
    saveProvider,
    deleteProvider,
    setModel,
    sessions,
    activeSessionId,
    activeSession,
    messages,
    loadingMessages,
    streaming,
    send,
    stop,
    retry,
    selectSession,
    newSession,
    renameSession,
    deleteSession,
    deleteAllSessions,
    refreshSessions,
  };

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useChatStore(): ChatStore {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useChatStore must be used inside <ChatProvider>");
  return ctx;
}
