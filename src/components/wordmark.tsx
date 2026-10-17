import { Radio } from "lucide-react";

/**
 * Relay wordmark: a small broadcast glyph with the name set in the serif
 * display face. `compact` drops the name for tight spaces (mobile bars).
 */
export function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <span className="flex size-7 items-center justify-center rounded-md bg-primary/12 ring-1 ring-primary/25 ring-inset">
        <Radio className="size-4 text-primary" strokeWidth={2.2} />
      </span>
      {!compact && (
        <span className="font-display text-[1.35rem] leading-none text-foreground">
          Relay
        </span>
      )}
    </span>
  );
}
