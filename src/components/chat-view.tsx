import { useState } from "react";
import { Cable, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MessageList } from "@/components/message-list";
import { Composer } from "@/components/composer";
import { useChatStore } from "@/lib/store";

export function ChatView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { connected } = useChatStore();

  /* The draft lives here so empty-state suggestions can fill the composer. */
  const [draft, setDraft] = useState("");

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {!connected && (
        <div className="flex items-center gap-2 border-b border-amber-500/25 bg-amber-500/10 px-4 py-2 text-[0.8rem] text-amber-700 dark:text-amber-300">
          <Cable className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            No provider connected — connect one to start chatting.
          </span>
          <Button size="xs" variant="outline" className="shrink-0" onClick={onOpenSettings}>
            <Settings className="size-3" />
            Connect
          </Button>
        </div>
      )}
      <MessageList draft={draft} onDraftChange={setDraft} />
      <Composer value={draft} onChange={setDraft} />
    </div>
  );
}
