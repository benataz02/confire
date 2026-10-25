import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AssistantPanel } from "./AssistantPanel.tsx";

// The panel is shell state, not page state (assistant spec §4.2): open or not, the page's unsaved
// edit, and each configuration's open questions live here, around the whole app shell, so a thread
// survives navigation. Once opened the panel stays mounted (hidden when closed): closing it must not
// cut off an answer still streaming.

type AssistantShell = {
  open: boolean;
  toggle(): void;
  close(): void;
  /** the configuration page has an edit still on its way to the server */
  dirty: boolean;
  setDirty(b: boolean): void;
  /** per configuration: the fields with a question open in the panel (the page marks them) */
  questionKeys: Record<string, string[]>;
  setQuestionKeys(projectId: string, keys: string[]): void;
};

const Ctx = createContext<AssistantShell | null>(null);

export function useAssistantShell(): AssistantShell {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAssistantShell outside AssistantProvider");
  return c;
}

export function AssistantProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [questionKeys, setAll] = useState<Record<string, string[]>>({});
  const toggle = useCallback(() => { setMounted(true); setOpen((o) => !o); }, []);
  const close = useCallback(() => setOpen(false), []);
  const setQuestionKeys = useCallback((projectId: string, keys: string[]) =>
    setAll((all) => (sameKeys(all[projectId], keys) ? all : { ...all, [projectId]: keys })), []);
  const value = useMemo(() => ({ open, toggle, close, dirty, setDirty, questionKeys, setQuestionKeys }),
    [open, toggle, close, dirty, questionKeys, setQuestionKeys]);
  return (
    <Ctx.Provider value={value}>
      {children}
      {mounted ? <AssistantPanel /> : null}
    </Ctx.Provider>
  );
}

const sameKeys = (a: string[] | undefined, b: string[]) => (a ?? []).join("\u0000") === b.join("\u0000");
