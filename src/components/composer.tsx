import { useEffect, useRef } from "react";
import { ArrowUp, Square } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { useChatStore } from "@/lib/store";

const MAX_HEIGHT = 200;

export function Composer({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { send, stop, streaming, connected } = useChatStore();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  /* Auto-grow with the content, up to a cap. */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`;
  }, [value]);

  const submit = () => {
    if (!value.trim() || streaming) return;
    const text = value;
    onChange("");
    void send(text);
  };

  return (
    <div className="shrink-0 px-4 pb-4">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={cn(
            "rounded-xl border border-input bg-card shadow-sm transition-shadow",
            "focus-within:border-ring/60 focus-within:ring-[3px] focus-within:ring-ring/25",
          )}
        >
          <label className="sr-only" htmlFor="composer">
            Message
          </label>
          <textarea
            id="composer"
            ref={textareaRef}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder={
              connected
                ? "Send a message…"
                : "Connect a provider in settings, then send a message…"
            }
            className="block max-h-[200px] w-full resize-none bg-transparent px-4 py-3 text-[0.92rem] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2.5">
            <p className="hidden text-[0.7rem] text-muted-foreground/70 lg:block">
              <kbd className="font-sans">Enter</kbd> to send ·{" "}
              <kbd className="font-sans">Shift</kbd>+
              <kbd className="font-sans">Enter</kbd> for a new line
            </p>
            {streaming ? (
              <Button
                size="icon"
                variant="outline"
                className="ml-auto"
                onClick={stop}
                aria-label="Stop generating"
              >
                <Square className="size-3.5 fill-current" />
              </Button>
            ) : (
              <Button
                size="icon"
                className="ml-auto"
                onClick={submit}
                disabled={!value.trim()}
                aria-label="Send message"
              >
                <ArrowUp className="size-4" />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
