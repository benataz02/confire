import { createContext, useContext } from "react";

// The panel's shell state as a context, in a module of its own on purpose: `createContext` makes a new
// context each time its module runs, and the provider imports the panel, which imports the chat, which
// reads this. Kept beside the provider, that cycle made Vite re-run it on any edit to the chat, and the
// mounted provider and its readers then held two different contexts ("outside AssistantProvider").
// Importing nothing of the panel, this module only re-runs when it is itself edited.

export type AssistantShell = {
  open: boolean;
  toggle(): void;
  close(): void;
  /** Mount and open the panel on the page's own chat, `text` (if any) put in its box: a report's Edit and chips. */
  openChat(text?: string): void;
  /** The last openChat: the panel goes back to the page's chat and fills its box each time `at` changes. */
  asked: { text?: string; at: number } | null;
  /** the configuration page has an edit still on its way to the server */
  dirty: boolean;
  setDirty(b: boolean): void;
  /** per configuration: the fields with a question open in the panel (the page marks them) */
  questionKeys: Record<string, string[]>;
  setQuestionKeys(projectId: string, keys: string[]): void;
};

export const AssistantShellContext = createContext<AssistantShell | null>(null);

export function useAssistantShell(): AssistantShell {
  const c = useContext(AssistantShellContext);
  if (!c) throw new Error("useAssistantShell outside AssistantProvider");
  return c;
}
