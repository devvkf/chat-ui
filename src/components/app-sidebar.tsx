import { useMemo, useState } from "react";
import {
  Check,
  ChevronsUpDown,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Wordmark } from "@/components/wordmark";
import { ThemeToggle } from "@/components/theme-toggle";
import { useChatStore } from "@/lib/store";
import { groupSessions, hostOf, relativeTime } from "@/lib/time";
import type { Provider, Session } from "@/lib/types";

interface SidebarProps {
  onOpenSettings: () => void;
  onOpenPrivacy: () => void;
}

/** Desktop rail. The mobile version lives in the top bar's slide-over sheet. */
export function AppSidebar({ onOpenSettings, onOpenPrivacy }: SidebarProps) {
  const store = useChatStore();
  return (
    <aside className="hidden w-72 shrink-0 border-r border-sidebar-border bg-sidebar md:flex md:flex-col">
      <SidebarContent
        sessions={store.sessions}
        activeSessionId={store.activeSessionId}
        onSelectSession={store.selectSession}
        onNewSession={store.newSession}
        onRenameSession={store.renameSession}
        onDeleteSession={store.deleteSession}
        onOpenSettings={onOpenSettings}
        onOpenPrivacy={onOpenPrivacy}
      />
    </aside>
  );
}

interface SidebarContentProps extends SidebarProps {
  sessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewSession: () => void;
  onRenameSession: (id: string, title: string) => Promise<void>;
  onDeleteSession: (id: string) => Promise<void>;
}

/** The full sidebar body, shared by the desktop rail and the mobile sheet. */
export function SidebarContent({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onRenameSession,
  onDeleteSession,
  onOpenSettings,
  onOpenPrivacy,
}: SidebarContentProps) {
  const [query, setQuery] = useState("");
  const { providers, activeProvider, connectProvider } = useChatStore();

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? sessions.filter((s) => s.title.toLowerCase().includes(q)) : sessions;
    return groupSessions(list);
  }, [sessions, query]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header: wordmark + new chat */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Wordmark />
        <Button
          size="sm"
          onClick={() => void onNewSession()}
          className="gap-1"
        >
          <Plus className="size-4" />
          New chat
        </Button>
      </div>

      {/* Search */}
      <div className="px-4 pb-3">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search chats"
            aria-label="Search chats"
            className="h-8 bg-background/60 pl-8 text-[0.82rem]"
          />
        </div>
      </div>

      {/* Session list */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {groups.length === 0 && (
          <p className="px-2 py-6 text-center text-[0.8rem] text-muted-foreground">
            {sessions.length === 0
              ? "No chats yet. Start one with New chat."
              : `No chats match “${query}”.`}
          </p>
        )}
        {groups.map((group) => (
          <section key={group.label} className="mb-1">
            <h2 className="px-2 py-1.5 text-[0.68rem] font-medium tracking-wide text-muted-foreground/80">
              {group.label}
            </h2>
            <ul className="space-y-0.5">
              {group.items.map((session) => (
                <SessionItem
                  key={session.id}
                  session={session}
                  active={session.id === activeSessionId}
                  providers={providers}
                  activeProviderId={activeProvider?.id ?? null}
                  onSelect={() => onSelectSession(session.id)}
                  onRename={(title) => void onRenameSession(session.id, title)}
                  onDelete={() => void onDeleteSession(session.id)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* Footer: provider quick-switch + actions */}
      <div className="border-t border-sidebar-border px-2 py-2">
        <DropdownMenu>
          {/* Not called "Settings": the gear in the top bar owns that name. */}
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                aria-label="Switch provider"
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left transition-colors hover:bg-sidebar-accent"
              />
            }
          >
            <span
              className={cn(
                "size-2 shrink-0 rounded-full",
                activeProvider ? "bg-emerald-500" : "bg-amber-500",
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.8rem] font-medium text-sidebar-foreground">
                {activeProvider?.name || "Not connected"}
              </span>
              <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">
                {activeProvider
                  ? activeProvider.model || "no model set"
                  : "choose a provider"}
              </span>
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            {providers.length === 0 ? (
              <DropdownMenuItem onClick={onOpenSettings}>
                <Plus className="size-3.5" />
                Add a provider
              </DropdownMenuItem>
            ) : (
              providers.map((provider) => (
                <DropdownMenuItem
                  key={provider.id}
                  disabled={provider.connected}
                  onClick={() => void connectProvider(provider.id)}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[0.82rem]">{provider.name}</span>
                    <span className="block truncate font-mono text-[0.68rem] text-muted-foreground">
                      {hostOf(provider.endpoint)}
                      {provider.model ? ` · ${provider.model}` : ""}
                    </span>
                  </span>
                  {provider.connected && <Check className="size-3.5 shrink-0 text-primary" />}
                </DropdownMenuItem>
              ))
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onOpenSettings}>
              <Settings className="size-3.5" />
              Manage providers…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center justify-between px-1 pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1.5 px-2 text-[0.75rem] text-muted-foreground"
            onClick={onOpenPrivacy}
          >
            <ShieldCheck className="size-3.5" />
            Privacy
          </Button>
          <ThemeToggle />
        </div>
      </div>
    </div>
  );
}

function SessionItem({
  session,
  active,
  providers,
  activeProviderId,
  onSelect,
  onRename,
  onDelete,
}: {
  session: Session;
  active: boolean;
  providers: Provider[];
  activeProviderId: string | null;
  onSelect: () => void;
  onRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.title);

  /* A chat keeps the provider it was started on, so say which one when it
     isn't the connected one. Unnamed when its provider has been deleted. */
  const otherProvider =
    session.provider_id && session.provider_id !== activeProviderId
      ? providers.find((p) => p.id === session.provider_id)
      : undefined;

  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft !== session.title) onRename(draft);
  };

  if (editing) {
    return (
      <li>
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(session.title);
              setEditing(false);
            }
          }}
          className="h-8 text-[0.82rem]"
          aria-label="Chat name"
        />
      </li>
    );
  }

  return (
    <li>
      <div
        className={cn(
          "group relative flex items-center rounded-md transition-colors",
          active ? "bg-sidebar-accent" : "hover:bg-sidebar-accent/60",
        )}
      >
        {active && (
          <span
            className="absolute top-1/2 left-0 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
            aria-hidden
          />
        )}
        <button
          type="button"
          onClick={onSelect}
          className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
        >
          <span
            className={cn(
              "block truncate text-[0.84rem]",
              active
                ? "font-medium text-sidebar-accent-foreground"
                : "text-sidebar-foreground",
            )}
          >
            {session.title}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5 text-[0.68rem] text-muted-foreground">
            <span>{relativeTime(session.updated_at)}</span>
            {session.model && (
              <>
                <span aria-hidden>·</span>
                <span className="max-w-24 truncate font-mono">{session.model}</span>
              </>
            )}
            {otherProvider && (
              <>
                <span aria-hidden>·</span>
                <span className="max-w-24 truncate">via {otherProvider.name}</span>
              </>
            )}
          </span>
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Actions for ${session.title}`}
                className="mr-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[popup-open]:opacity-100"
              />
            }
          >
            <MoreHorizontal className="size-3.5" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem
              onClick={() => {
                setDraft(session.title);
                setEditing(true);
              }}
            >
              <Pencil className="size-3.5" />
              Rename
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onDelete}>
              <Trash2 className="size-3.5" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </li>
  );
}
