import { Bug, Database, ListChecks } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { greeting, hostOf } from "@/lib/time";

const SUGGESTIONS = [
  {
    Icon: Bug,
    title: "Debug a stack trace",
    draft: "Here's a stack trace. What's the likely cause, and how do I fix it?\n\n",
  },
  {
    Icon: Database,
    title: "Explain a query",
    draft: "Explain this SQL query line by line, and the indexes it would want:\n\n",
  },
  {
    Icon: ListChecks,
    title: "Plan a refactor",
    draft: "Help me plan this refactor — steps, risks, and what to migrate first.\n\n",
  },
];

export function EmptyState({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { activeProvider, connected } = useChatStore();

  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center py-10 text-center">
      <h2 className="font-display text-[2rem] leading-tight text-foreground sm:text-[2.4rem]">
        {greeting()}.
      </h2>
      <p className="mt-3 max-w-sm text-[0.9rem] leading-relaxed text-muted-foreground">
        {connected && activeProvider ? (
          <>
            Talking to{" "}
            <span className="font-mono text-foreground/80">
              {activeProvider.model || "no model set"}
            </span>{" "}
            at <span className="font-mono text-foreground/80">{hostOf(activeProvider.endpoint)}</span>
            .
          </>
        ) : (
          <>Connect an OpenAI-compatible provider in settings and every chat goes through it.</>
        )}
      </p>

      <div className="mt-8 grid w-full max-w-xl gap-2 sm:grid-cols-3">
        {SUGGESTIONS.map(({ Icon, title, draft }) => (
          <button
            key={title}
            type="button"
            onClick={() => onChange(value ? `${value}\n${draft}` : draft)}
            className="group flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-3 text-left transition-colors hover:border-primary/40 hover:bg-accent/50"
          >
            <span className="flex size-7 items-center justify-center rounded-md bg-primary/10 text-primary ring-1 ring-primary/20 ring-inset">
              <Icon className="size-3.5" />
            </span>
            <span className="text-[0.82rem] font-medium text-foreground">{title}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
