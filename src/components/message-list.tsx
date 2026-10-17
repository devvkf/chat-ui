import { useEffect, useRef } from "react";
import { LoaderCircle } from "lucide-react";
import { MessageItem } from "@/components/message-item";
import { EmptyState } from "@/components/empty-state";
import { useChatStore } from "@/lib/store";

export function MessageList({
  draft,
  onDraftChange,
}: {
  draft: string;
  onDraftChange: (value: string) => void;
}) {
  const { messages, loadingMessages, streaming } = useChatStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  /* Keep the latest message in view unless the reader scrolled up. */
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottom.current) return;
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming]);

  return (
    <div
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      }}
      className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden"
    >
      <div className="mx-auto w-full max-w-3xl px-4 py-6">
        {loadingMessages ? (
          <div className="flex justify-center py-16 text-muted-foreground">
            <LoaderCircle className="size-5 animate-spin" />
          </div>
        ) : messages.length === 0 ? (
          <EmptyState value={draft} onChange={onDraftChange} />
        ) : (
          <div className="space-y-6">
            {messages.map((message, i) => (
              <MessageItem
                key={message.id}
                message={message}
                isLast={i === messages.length - 1}
                streaming={
                  streaming &&
                  i === messages.length - 1 &&
                  message.role === "assistant"
                }
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
