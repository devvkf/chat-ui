import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import {
  Check,
  ChevronDown,
  Download,
  Eye,
  EyeOff,
  KeyRound,
  Link2,
  Plus,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Thermometer,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { cn } from "cn";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api } from "@/lib/api";
import { useChatStore } from "@/lib/store";
import { hostOf } from "@/lib/time";
import type { Settings, ThemeValue } from "@/lib/types";

type Tab = "connection" | "chat" | "appearance" | "data" | "privacy";

const TABS: { id: Tab; label: string; Icon: typeof Link2 }[] = [
  { id: "connection", label: "Connection", Icon: Link2 },
  { id: "chat", label: "Chat", Icon: SlidersHorizontal },
  { id: "appearance", label: "Appearance", Icon: Sun },
  { id: "data", label: "Data", Icon: Download },
  { id: "privacy", label: "Privacy", Icon: ShieldCheck },
];

export function SettingsDialog({
  open,
  onOpenChange,
  onOpenPrivacy,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenPrivacy: () => void;
}) {
  const {
    settings,
    updateSettings,
    sessions,
    deleteAllSessions,
    providers,
    connectProvider,
    createProvider,
    saveProvider,
    deleteProvider,
  } = useChatStore();
  const { setTheme } = useTheme();
  const [tab, setTab] = useState<Tab>("connection");
  const [form, setForm] = useState<Settings>(settings);
  const [showKey, setShowKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
    models: string[];
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmProvider, setConfirmProvider] = useState(false);

  /* --- connection tab state --- */
  /** Which provider the form edits: an id, "new" for an unsaved one, or null
      until the list has loaded. */
  const [selection, setSelection] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState({ name: "", endpoint: "", api_key: "", model: "" });
  const [providerBusy, setProviderBusy] = useState(false);

  /* Re-sync the form from saved settings each time the dialog opens. */
  useEffect(() => {
    if (open) {
      setForm(settings);
      setTestResult(null);
      setSelection(null);
    }
  }, [open, settings]);

  const editing = providers.find((p) => p.id === selection);

  /* Show the connected provider (else the first) and keep the form in step
     with it. Also covers providers arriving after the dialog opened, and the
     selected provider being deleted underneath us. */
  useEffect(() => {
    if (!open) return;
    if (selection === null || (selection !== "new" && !editing)) {
      setSelection(providers.find((p) => p.connected)?.id ?? providers[0]?.id ?? "new");
      return;
    }
    setDraft({
      name: editing?.name ?? "",
      endpoint: editing?.endpoint ?? "",
      api_key: editing?.api_key ?? "",
      model: editing?.model ?? "",
    });
    setTestResult(null);
    // Only re-sync when the selection or the provider rows actually change;
    // dragging this on every keystroke would undo the user's typing.
  }, [open, providers, selection, editing]);

  const patchDraft = (p: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...p }));

  const patch = (p: Partial<Settings>) => setForm((f) => ({ ...f, ...p }));

  const save = async () => {
    setSaving(true);
    await updateSettings(form);
    setSaving(false);
    toast.success("Settings saved");
    onOpenChange(false);
  };

  const testConnection = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      // The form, not the row: this works for a provider that isn't saved yet.
      const res = await api.testConnection(draft.endpoint, draft.api_key);
      if (res.ok) {
        const models = res.models ?? [];
        setTestResult({
          ok: true,
          message: `Connected — ${models.length} model${models.length === 1 ? "" : "s"} available.`,
          models,
        });
      } else {
        setTestResult({ ok: false, message: res.error ?? "Connection failed.", models: [] });
      }
    } catch (err) {
      setTestResult({ ok: false, message: (err as Error).message, models: [] });
    } finally {
      setTesting(false);
    }
  };

  /* Save, or add for an unsaved provider. */
  const saveProviderRow = async () => {
    if (!draft.endpoint.trim()) {
      toast.error("An endpoint URL is required.");
      return;
    }
    setProviderBusy(true);
    try {
      if (editing) {
        await saveProvider(editing.id, draft);
        toast.success(`Saved ${draft.name || hostOf(draft.endpoint)}`);
      } else {
        const created = await createProvider(draft);
        setSelection(created.id);
        toast.success("Provider added");
      }
    } catch {
      /* the store already reported it */
    } finally {
      setProviderBusy(false);
    }
  };

  const connectSelected = async () => {
    if (!draft.endpoint.trim()) {
      toast.error("An endpoint URL is required.");
      return;
    }
    setProviderBusy(true);
    try {
      const id = editing ? editing.id : (await createProvider(draft)).id;
      if (!editing) setSelection(id);
      await connectProvider(id);
      toast.success("Connected");
    } catch {
      /* the store already reported it */
    } finally {
      setProviderBusy(false);
    }
  };

  const removeSelected = async () => {
    if (!editing) return;
    setProviderBusy(true);
    try {
      const rehomed = await deleteProvider(editing.id);
      setSelection(null);
      toast.success(
        rehomed > 0
          ? `Deleted ${editing.name}. ${rehomed} chat${rehomed === 1 ? "" : "s"} now use the connected provider.`
          : `Deleted ${editing.name}.`,
      );
    } catch {
      /* the store already reported it */
    } finally {
      setProviderBusy(false);
      setConfirmProvider(false);
    }
  };

  const exportData = async () => {
    try {
      const res = await fetch("/api/export");
      if (!res.ok) throw new Error(`Export failed with ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `relay-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success("Export downloaded");
    } catch (err) {
      toast.error((err as Error).message);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0" showCloseButton>
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="font-display text-[1.4rem]">Settings</DialogTitle>
          <DialogDescription>
            Everything here is stored locally on this machine.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 pb-5 sm:flex-row">
          {/* Section nav */}
          <nav className="flex gap-1 overflow-x-auto sm:w-36 sm:flex-col sm:overflow-visible">
            {TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[0.82rem] transition-colors",
                  tab === id
                    ? "bg-accent font-medium text-accent-foreground"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" />
                {label}
              </button>
            ))}
          </nav>

          <div className="min-w-0 flex-1 sm:border-l sm:border-border sm:pl-5">
            {tab === "connection" && (
              <div className="space-y-4">
                {/* Provider switcher */}
                <div className="flex items-center gap-2">
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="outline"
                          size="sm"
                          className="min-w-0 flex-1 justify-between"
                        />
                      }
                    >
                      <span className="truncate">
                        {editing ? editing.name : "New provider"}
                      </span>
                      <span className="flex items-center gap-1.5">
                        {editing?.connected && <Check className="size-3.5 text-primary" />}
                        <ChevronDown className="size-3.5 text-muted-foreground" />
                      </span>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start" className="w-64">
                      {providers.map((provider) => (
                        <DropdownMenuItem
                          key={provider.id}
                          onClick={() => setSelection(provider.id)}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[0.82rem]">{provider.name}</span>
                            <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">
                              {hostOf(provider.endpoint)}
                            </span>
                          </span>
                          {provider.connected && (
                            <Check className="size-3.5 shrink-0 text-primary" />
                          )}
                        </DropdownMenuItem>
                      ))}
                      {providers.length > 0 && <DropdownMenuSeparator />}
                      <DropdownMenuItem onClick={() => setSelection("new")}>
                        <Plus className="size-3.5" />
                        New provider
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>

                <Field label="Name" hint="Yours to rename — only used to tell providers apart.">
                  <Input
                    value={draft.name}
                    onChange={(e) => patchDraft({ name: e.target.value })}
                    placeholder={hostOf(draft.endpoint) || "Home server"}
                    className="text-[0.82rem]"
                    autoComplete="off"
                  />
                </Field>

                <Field
                  label="Endpoint URL"
                  hint="Any OpenAI-compatible base URL — it must expose /chat/completions and /models."
                >
                  <Input
                    value={draft.endpoint}
                    onChange={(e) => patchDraft({ endpoint: e.target.value })}
                    placeholder="https://api.openai.com/v1"
                    className="font-mono text-[0.82rem]"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <Field
                  label="API key"
                  hint="Sent only to the endpoint above, and stored in this machine's local database."
                >
                  <div className="relative">
                    <KeyRound className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      type={showKey ? "text" : "password"}
                      value={draft.api_key}
                      onChange={(e) => patchDraft({ api_key: e.target.value })}
                      placeholder="sk-…"
                      className="pr-9 pl-8 font-mono text-[0.82rem]"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
                      aria-label={showKey ? "Hide key" : "Show key"}
                    >
                      {showKey ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                    </button>
                  </div>
                </Field>

                <Field label="Model" hint="Or pick one from the model menu in the top bar.">
                  <Input
                    value={draft.model}
                    onChange={(e) => patchDraft({ model: e.target.value })}
                    placeholder="gpt-4o-mini"
                    className="font-mono text-[0.82rem]"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </Field>

                <div className="flex flex-wrap items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void testConnection()}
                    disabled={testing || !draft.endpoint.trim()}
                  >
                    {testing ? "Testing…" : "Test connection"}
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void saveProviderRow()}
                    disabled={providerBusy || !draft.endpoint.trim()}
                  >
                    {editing ? "Save provider" : "Add provider"}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void connectSelected()}
                    disabled={providerBusy || !draft.endpoint.trim() || !!editing?.connected}
                  >
                    <Plug className="size-3.5" />
                    {editing?.connected ? "Connected" : "Connect"}
                  </Button>
                  {editing && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto text-destructive hover:bg-destructive/10 hover:text-destructive"
                      onClick={() => setConfirmProvider(true)}
                      disabled={providerBusy}
                    >
                      <Trash2 className="size-3.5" />
                      Delete
                    </Button>
                  )}
                </div>

                {testResult && (
                  <div className="flex flex-col gap-2">
                    <span
                      className={cn(
                        "text-[0.78rem]",
                        testResult.ok
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-destructive",
                      )}
                    >
                      {testResult.message}
                    </span>
                    {testResult.ok && testResult.models.length > 0 && (
                      <div className="flex flex-wrap gap-1.5">
                        {testResult.models.map((model) => (
                          <button
                            key={model}
                            type="button"
                            onClick={() => patchDraft({ model })}
                            className={cn(
                              "rounded-full border border-border px-2 py-0.5 font-mono text-[0.7rem] transition-colors hover:border-primary/50 hover:bg-accent",
                              draft.model === model && "border-primary/50 text-primary",
                            )}
                          >
                            {model}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {tab === "chat" && (
              <div className="space-y-5">
                <Field
                  label={
                    <span className="flex items-center gap-1.5">
                      <Thermometer className="size-3.5" />
                      Temperature
                      <span className="ml-1 font-mono text-[0.72rem] text-muted-foreground">
                        {form.temperature.toFixed(1)}
                      </span>
                    </span>
                  }
                  hint="Lower is focused and repeatable; higher is more varied."
                >
                  <input
                    type="range"
                    min={0}
                    max={2}
                    step={0.1}
                    value={form.temperature}
                    onChange={(e) => patch({ temperature: Number(e.target.value) })}
                    className="w-full accent-primary"
                    aria-label="Temperature"
                  />
                </Field>

                <Field
                  label="System prompt"
                  hint="Prepended to every chat to set the assistant's behavior."
                >
                  <textarea
                    value={form.system_prompt}
                    onChange={(e) => patch({ system_prompt: e.target.value })}
                    rows={4}
                    placeholder="You are a concise, precise assistant."
                    className="w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-[0.85rem] leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25"
                  />
                </Field>

                <div className="flex items-center justify-between gap-4 rounded-md border border-border px-3 py-2.5">
                  <div>
                    <Label className="text-[0.85rem]">Stream responses</Label>
                    <p className="mt-0.5 text-[0.75rem] text-muted-foreground">
                      Show replies as they are generated. Turning this off returns the whole
                      message at once.
                    </p>
                  </div>
                  <Switch
                    checked={form.stream}
                    onCheckedChange={(checked: boolean) => patch({ stream: checked })}
                    aria-label="Stream responses"
                  />
                </div>
              </div>
            )}

            {tab === "appearance" && (
              <div className="space-y-4">
                <Field label="Theme" hint="Applies to this browser.">
                  <div className="flex gap-1.5">
                    {(["system", "light", "dark"] as ThemeValue[]).map((value) => (
                      <Button
                        key={value}
                        variant={form.theme === value ? "default" : "outline"}
                        size="sm"
                        onClick={() => {
                          patch({ theme: value });
                          setTheme(value); // apply immediately, before saving
                        }}
                        className="capitalize"
                      >
                        {value}
                      </Button>
                    ))}
                  </div>
                </Field>
                <p className="text-[0.78rem] leading-relaxed text-muted-foreground">
                  The interface uses an ink-and-bronze palette, Satoshi-style type for the
                  interface, a serif display face for headings, and monospace for model and
                  endpoint names.
                </p>
              </div>
            )}

            {tab === "data" && (
              <div className="space-y-4">
                <div className="rounded-md border border-border px-3 py-2.5">
                  <p className="text-[0.85rem] font-medium">
                    {sessions.length} chat{sessions.length === 1 ? "" : "s"} stored locally
                  </p>
                  <p className="mt-0.5 text-[0.78rem] text-muted-foreground">
                    Database: <span className="font-mono">backend/data/relay.db</span>
                  </p>
                </div>

                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={() => void exportData()}>
                    <Download className="size-3.5" />
                    Export all data
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive"
                    onClick={() => setConfirmDelete(true)}
                    disabled={sessions.length === 0}
                  >
                    <Trash2 className="size-3.5" />
                    Delete all chats
                  </Button>
                </div>
                <p className="text-[0.78rem] leading-relaxed text-muted-foreground">
                  Exports are plain JSON and include your API key, so keep them somewhere
                  private.
                </p>
              </div>
            )}

            {tab === "privacy" && (
              <div className="space-y-3 text-[0.85rem] leading-relaxed">
                <p>
                  Relay is a local application. Your chats live in a SQLite file on this
                  machine — nothing is uploaded to us, and there is no account.
                </p>
                <p>
                  Messages are sent only to the endpoint you configure above, exactly as any
                  API client would. That provider's own privacy policy then applies to what
                  it receives.
                </p>
                <Button variant="outline" size="sm" onClick={onOpenPrivacy}>
                  <ShieldCheck className="size-3.5" />
                  Read the full policy
                </Button>
              </div>
            )}

            {/* The connection tab owns its actions — save, connect and delete
                each act at once, like the privacy tab. */}
            {tab !== "privacy" && tab !== "connection" && (
              <div className="mt-5 flex justify-end gap-2 border-t border-border pt-4">
                <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => void save()} disabled={saving}>
                  {saving ? "Saving…" : "Save changes"}
                </Button>
              </div>
            )}
          </div>
        </div>
      </DialogContent>

      <AlertDialog open={confirmProvider} onOpenChange={setConfirmProvider}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-destructive" />
              Delete {editing?.name || "this provider"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Its chats stay, and from now on they follow whichever provider is
              connected — which may be a different endpoint than the one they
              started on.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void removeSelected()}>
              Delete provider
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <TriangleAlert className="size-4 text-destructive" />
              Delete all {sessions.length} chat{sessions.length === 1 ? "" : "s"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Every message in every chat is removed from this machine. This cannot be
              undone — export first if you might want the history.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep chats</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={async () => {
                const result = await deleteAllSessions();
                toast.success(
                  `Deleted ${result.sessions} chat${result.sessions === 1 ? "" : "s"} and ${result.messages} message${result.messages === 1 ? "" : "s"}.`,
                );
                setConfirmDelete(false);
                onOpenChange(false);
              }}
            >
              Delete everything
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: React.ReactNode;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-[0.85rem] font-medium">{label}</Label>
      {children}
      {hint && <p className="text-[0.75rem] leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}
