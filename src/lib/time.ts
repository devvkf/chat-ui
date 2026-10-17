/** Date helpers for session grouping and message timestamps. */

const DAY = 86_400_000;

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today", "Yesterday", "Mon", or "Mar 3" — for session group headers. */
export function dayLabel(iso: string): string {
  const then = new Date(iso);
  const now = new Date();
  const diffDays = Math.round((startOfDay(now) - startOfDay(then)) / DAY);
  if (diffDays <= 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  if (diffDays < 7) return then.toLocaleDateString(undefined, { weekday: "long" });
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export interface SessionGroup<T> {
  label: string;
  items: T[];
}

/** Buckets sessions into time groups, preserving order (newest first). */
export function groupSessions<
  T extends { id: string; title: string; updated_at: string; model: string | null },
>(sessions: T[]): SessionGroup<T>[] {
  const buckets = new Map<string, T[]>();
  for (const s of sessions) {
    const label = dayLabel(s.updated_at);
    const list = buckets.get(label);
    if (list) list.push(s);
    else buckets.set(label, [s]);
  }
  return [...buckets].map(([label, items]) => ({ label, items }));
}

/** "14:32" — for the timestamp beside a message. */
export function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** "just now", "12m ago", "3h ago", "Mar 3" — for session list items. */
export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return dayLabel(iso);
}

/** Time-aware greeting for the empty state. */
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return "Still up?";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

/** Host-only view of an endpoint URL, for compact display. */
export function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
