import { useState } from "react";
import { Check, Copy, RotateCcw, Sparkles, TriangleAlert } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Markdown, MessageMeta, UserText } from "@/components/markdown";
import { useChatStore } from "@/lib/store";
import { clockTime } from "@/lib/time";
import type { Message } from "@/lib/types";

export function MessageItem({
  message,
  isLast,
  streaming,
}: {
  message: Message;
  isLast: boolean;
  streaming: boolean;
}) {
  const isUser = message.role === "user";
  const failed = message.status === "error";

  if (isUser) {
    return (
      <article className="msg-in flex justify-end">
        <div className="flex max-w-[85%] flex-col items-end gap-1">
          <div className="rounded-2xl rounded-br-md border border-primary/25 bg-primary/10 px-4 py-2.5 text-foreground">
            <UserText content={message.content} />
          </div>
          <span className="px-1 text-[0.66rem] text-muted-foreground/70">
            {clockTime(message.created_at)}
          </span>
        </div>
      </article>
    );
  }

  return (
    <article className="msg-in flex gap-3">
      <div
        className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 ring-1 ring-primary/25 ring-inset"
        aria-hidden
      >
        <Sparkles className="size-3.5 text-primary" />
      </div>

      <div className="min-w-0 flex-1">
        {failed ? (
          <div className="rounded-lg border border-destructive/30 bg-destructive/8 px-3.5 py-3">
            <div className="flex items-center gap-2 text-[0.82rem] font-medium text-destructive">
              <TriangleAlert className="size-3.5" />
              {message.error || "The request failed."}
            </div>
            {message.content && (
              <div className="mt-2 text-[0.85rem] text-muted-foreground">
                <Markdown content={message.content} />
              </div>
            )}
            {isLast && <RetryButton />}
          </div>
        ) : (
          <>
            <div className={cn("text-foreground", streaming && "stream-caret")}>
              <Markdown content={message.content} />
            </div>
            {streaming && (
              <p className="mt-1 text-[0.7rem] text-muted-foreground">
                {message.content ? "Generating…" : "Waiting for the model…"}
              </p>
            )}
            {!streaming && (message.content || message.status === "aborted") && (
              <MessageFooter message={message} isLast={isLast} />
            )}
          </>
        )}
      </div>
    </article>
  );
}

function MessageFooter({ message, isLast }: { message: Message; isLast: boolean }) {
  const { retry } = useChatStore();
  const [copied, setCopied] = useState(false);

  return (
    <div className="mt-1.5 flex items-center gap-2">
      <MessageMeta model={message.model} elapsed={message.elapsed_ms} />
      {message.status === "aborted" && (
        <span className="text-[0.68rem] text-muted-foreground">stopped</span>
      )}
      <div className="ml-auto flex items-center gap-0.5">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Copy message"
          className="text-muted-foreground"
          onClick={async () => {
            await navigator.clipboard.writeText(message.content);
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }}
        >
          {copied ? <Check className="size-3 text-foreground" /> : <Copy className="size-3" />}
        </Button>
        {isLast && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Regenerate reply"
            className="text-muted-foreground"
            onClick={() => void retry()}
          >
            <RotateCcw className="size-3" />
          </Button>
        )}
      </div>
    </div>
  );
}

function RetryButton() {
  const { retry } = useChatStore();
  return (
    <Button variant="outline" size="xs" className="mt-2.5" onClick={() => void retry()}>
      <RotateCcw className="size-3" />
      Try again
    </Button>
  );
}
