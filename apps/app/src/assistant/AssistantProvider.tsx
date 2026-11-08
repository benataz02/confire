import { useCallback, useMemo, useState, type ReactNode } from "react";
import { AssistantPanel } from "./AssistantPanel.tsx";
import { AssistantShellContext as Ctx } from "./shell.ts";

// The panel is shell state, not page state (assistant spec §4.2): open or not, the page's unsaved
// edit, and each configuration's open questions live here, around the whole app shell, so a thread
// survives navigation. Once opened the panel stays mounted (hidden when closed): closing it must not
// cut off an answer still streaming. It is the one place a chat is drawn (Joule spec §5.1), so one
// thread is never live in two places. The context itself is `shell.ts` (why there: its comment).

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [questionKeys, setAll] = useState<Record<string, string[]>>({});
  const toggle = useCallback(() => { setMounted(true); setOpen((o) => !o); }, []);
  const close = useCallback(() => setOpen(false), []);
  const [asked, setAsked] = useState<{ text?: string; at: number } | null>(null);
  const openChat = useCallback((text?: string) => { setMounted(true); setOpen(true); setAsked({ text, at: Date.now() }); }, []);
  const setQuestionKeys = useCallback((projectId: string, keys: string[]) =>
    setAll((all) => (sameKeys(all[projectId], keys) ? all : { ...all, [projectId]: keys })), []);
  const value = useMemo(() => ({ open, toggle, close, openChat, asked, dirty, setDirty, questionKeys, setQuestionKeys }),
    [open, toggle, close, openChat, asked, dirty, questionKeys, setQuestionKeys]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {mounted ? <AssistantPanel /> : null}
    </Ctx.Provider>
  );
}

const sameKeys = (a: string[] | undefined, b: string[]) => (a ?? []).join("\u0000") === b.join("\u0000");
