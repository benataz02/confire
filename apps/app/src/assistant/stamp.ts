// The time above each turn (Joule spec §5.9): when the server stored it (`metadata.at`, threads.ts
// `stamped`), else a live message's own time; messages stored before stamps show none.

export function timeOf(m: { metadata?: Record<string, unknown>; createdAt?: Date | number | string }): Date | null {
  const v = m.metadata?.at ?? m.createdAt;
  if (v == null) return null;
  const d = new Date(v as string | number | Date);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** "Today 13:34", "Yesterday 23:59", else the date and time. */
export function stampText(at: Date, now: Date, locale: string, t: (key: string, ...a: string[]) => string): string {
  const today = dayOf(now);
  const yesterday = dayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1));
  const time = () => new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(at);
  if (dayOf(at) === today) return t("ASSISTANT_TODAY", time());
  if (dayOf(at) === yesterday) return t("ASSISTANT_YESTERDAY", time());
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(at);
}
