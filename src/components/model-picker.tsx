import { useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, RefreshCw } from "lucide-react";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { api } from "@/lib/api";
import { useChatStore } from "@/lib/store";
import { hostOf } from "@/lib/time";

/**
 * Model selector. Models come from GET /api/models, which asks the connected
 * provider for its list; anything can also be typed by hand.
 */
export function ModelPicker() {
  const { activeProvider, connected, setModel } = useChatStore();
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");
  const [custom, setCustom] = useState("");

  const model = activeProvider?.model ?? "";
  const activeId = activeProvider?.id ?? null;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.listModels();
      setModels(res.models);
    } catch (err) {
      setError((err as Error).message);
      setModels(null);
    } finally {
      setLoading(false);
    }
  }, []);

  /* A different provider means a different upstream, so the cached list and
     the filter no longer describe anything. */
  useEffect(() => {
    setModels(null);
    setError(null);
    setFilter("");
  }, [activeId]);

  useEffect(() => {
    if (open && connected) void load();
  }, [open, connected, load]);

  const choose = (value: string) => {
    void setModel(value);
    setOpen(false);
  };

  const shown = (models ?? []).filter((m) =>
    m.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="max-w-48 gap-1 font-mono text-[0.72rem] text-muted-foreground"
            aria-label="Choose model"
          />
        }
      >
        <span className="truncate">{model || "no model"}</span>
        <ChevronDown className="size-3 shrink-0" />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[0.78rem] font-medium">Model</span>
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={() => void load()}
            aria-label="Refresh models"
            className="text-muted-foreground"
          >
            <RefreshCw className={cn("size-3", loading && "animate-spin")} />
          </Button>
        </div>

        {!connected ? (
          <div className="px-3 py-4 text-center text-[0.78rem] text-muted-foreground">
            Connect an endpoint to list its models.
          </div>
        ) : (
          <>
            <div className="border-b border-border p-2">
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter models…"
                aria-label="Filter models"
                className="h-7 text-[0.78rem]"
              />
            </div>
            <div className="max-h-52 overflow-y-auto p-1">
              {loading && shown.length === 0 && (
                <p className="px-2 py-3 text-center text-[0.75rem] text-muted-foreground">
                  Loading models…
                </p>
              )}
              {error && !loading && (
                <p className="px-2 py-3 text-center text-[0.75rem] text-destructive">
                  {error}
                </p>
              )}
              {!loading && !error && shown.length === 0 && (
                <p className="px-2 py-3 text-center text-[0.75rem] text-muted-foreground">
                  No models found.
                </p>
              )}
              {shown.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => choose(m)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left font-mono text-[0.75rem] transition-colors hover:bg-accent",
                    model === m && "text-primary",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{m}</span>
                  {model === m && <Check className="size-3.5 shrink-0" />}
                </button>
              ))}
            </div>
          </>
        )}

        <div className="border-t border-border p-2">
          <form
            className="flex gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              const value = custom.trim();
              if (value) choose(value);
            }}
          >
            <Input
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              placeholder="Type a model name"
              aria-label="Custom model name"
              className="h-7 font-mono text-[0.75rem]"
            />
            <Button type="submit" size="sm" variant="outline" disabled={!custom.trim()}>
              Use
            </Button>
          </form>
          {connected && activeProvider && (
            <p className="mt-2 truncate px-0.5 font-mono text-[0.65rem] text-muted-foreground/70">
              {hostOf(activeProvider.endpoint)}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
