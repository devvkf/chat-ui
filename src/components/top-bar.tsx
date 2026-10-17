import { useState } from "react";
import { MessageSquare, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Wordmark } from "@/components/wordmark";
import { SidebarContent } from "@/components/app-sidebar";
import { ModelPicker } from "@/components/model-picker";
import { ThemeToggle } from "@/components/theme-toggle";
import { useChatStore } from "@/lib/store";

export function TopBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const store = useChatStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const title = store.activeSession?.title ?? "New chat";

  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
      {/* Mobile: chats slide-over */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetTrigger
          render={
            <Button
              variant="ghost"
              size="icon"
              className="md:hidden"
              aria-label="Open chats"
            />
          }
        >
          <MessageSquare className="size-4" />
        </SheetTrigger>
        <SheetContent side="left" className="w-72 gap-0 bg-sidebar p-0">
          <SheetTitle className="sr-only">Chats</SheetTitle>
          <SidebarContent
            sessions={store.sessions}
            activeSessionId={store.activeSessionId}
            onSelectSession={(id) => {
              store.selectSession(id);
              setMobileOpen(false);
            }}
            onNewSession={async () => {
              await store.newSession();
              setMobileOpen(false);
            }}
            onRenameSession={store.renameSession}
            onDeleteSession={store.deleteSession}
            onOpenSettings={() => {
              setMobileOpen(false);
              onOpenSettings();
            }}
            onOpenPrivacy={() => setMobileOpen(false)}
          />
        </SheetContent>
      </Sheet>

      <span className="md:hidden">
        <Wordmark compact />
      </span>

      <h1 className="hidden min-w-0 truncate text-[0.88rem] font-medium text-foreground md:block">
        {title}
      </h1>

      <div className="ml-auto flex items-center gap-1">
        <ModelPicker />
        <ThemeToggle />
        <Button
          variant="ghost"
          size="icon"
          onClick={onOpenSettings}
          aria-label="Settings"
        >
          <Settings className="size-4" />
        </Button>
      </div>
    </header>
  );
}
