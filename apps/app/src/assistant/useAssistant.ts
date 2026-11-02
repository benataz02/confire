import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchServerSentEvents, useChat, type UIMessage } from "@tanstack/ai-react";
import { callHeaders } from "@confire/ui/host.ts";
import { orpc } from "../orpc.ts";

// The panel's data: this user's thread for the page's configuration (or their general one), and a
// chat over it. History is the server's — `initialMessages` only paints it; every send carries just
// the new text and the page it came from.

export type Thread = { id: string; projectId: string | null; messages: UIMessage[] };

const threadInput = (projectId: string | null) => (projectId ? { projectId } : {});

export function useAssistantThread(projectId: string | null) {
  return useQuery({ ...orpc.assistant.thread.queryOptions({ input: threadInput(projectId) }), staleTime: Infinity });
}

/** What changed after a run or a direct write: the configuration, the lists, the AI page's chat list. */
export function useAssistantInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: orpc.configs.get.key() });
    void qc.invalidateQueries({ queryKey: orpc.configs.rows.key() });
    void qc.invalidateQueries({ queryKey: orpc.assistant.status.key() });
    void qc.invalidateQueries({ queryKey: orpc.assistant.threads.key() });
  };
}

/** A coded refusal from the route (off, over budget, busy…): the panel says why, not just "failed". */
export type Refusal = { code: string; message: string } | null;

/** The server's CUSTOM event for a declined answer (`stop_reason: "refusal"`, route.ts REFUSAL_EVENT). */
const REFUSAL_EVENT = "confire.refusal";

/** The chat over one thread. Mount it keyed by the thread id: a new configuration is a new chat. */
export function useAssistantChat(thread: Thread) {
  const invalidate = useAssistantInvalidate();
  const [refusal, setRefusal] = useState<Refusal>(null);
  // The model declined the last turn: the run ends with no answer, so the chat says so.
  const [declined, setDeclined] = useState(false);
  // One connection per chat: a new one would recreate the client and drop the conversation.
  const connection = useMemo(() => fetchServerSentEvents("/api/assistant", () => ({
    headers: callHeaders(),
    fetchClient: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fetch(input, init);
      setDeclined(false);
      if (res.ok) setRefusal(null);
      else setRefusal(await res.clone().json().catch(() => ({ code: "ERROR", message: res.statusText })) as Refusal);
      return res;
    }) as typeof fetch,
  })), []);
  const chat = useChat({
    connection,
    threadId: thread.id,
    initialMessages: thread.messages,
    onFinish: invalidate,
    onCustomEvent: (name) => { if (name === REFUSAL_EVENT) setDeclined(true); },
  });
  return { chat, refusal, declined, clearRefusal: () => { setRefusal(null); setDeclined(false); } };
}
