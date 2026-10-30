import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { overlay, overlayForm, usePatchQueue, type InputPatch, type QueueOp } from "@confire/ui/configurator/patch.ts";
import { client, orpc } from "../../orpc.ts";
import type { Sel } from "./runView.ts";

/** What configs.get answers. Every write answers it too, without the model and the request (which
 *  an edit cannot change), so the cache is patched, never replaced. */
export type ConfigView = Awaited<ReturnType<typeof client.configs.get>>;
type EditAnswer = Awaited<ReturnType<typeof client.configs.calculate>>;

/**
 * The process page's server half: the view, and every `configs.*` write. Edits and picks go through
 * one queue (usePatchQueue): one call in flight, commits merged meanwhile, picks behind edits. While
 * a call is out the page shows what the user entered laid over the last answer — `project` and
 * `form` here — and every derived figure stays the last answer's until the next one lands.
 */
export function useConfigProcess(id: string, isNew: boolean, on: { left: (to: "list" | { id: string }, toast?: string) => void }) {
  const qc = useQueryClient();
  const getKey = orpc.configs.get.queryKey({ input: { id } });
  const q = useQuery({ ...orpc.configs.get.queryOptions({ input: { id } }), enabled: !isNew });
  const modelId = q.data?.project.modelId;
  const lookupsKey = orpc.configs.lookups.queryKey({ input: { modelId: modelId! } });
  // The display tables: value-help seeds and table-cell options. Moved by a sync only.
  const lookups = useQuery({
    ...orpc.configs.lookups.queryOptions({ input: { modelId: modelId! } }),
    enabled: !!modelId,
    staleTime: 5 * 60_000, // rows move only when a sync refills them; Sync data invalidates this
    retry: false, // a failure is a page message plus its own Retry button, not a spinner
  });

  const patchView = (v: EditAnswer) => qc.setQueryData(getKey, (prev) => (prev ? { ...prev, ...v } : prev));
  const refetch = () => void qc.invalidateQueries({ queryKey: getKey });
  const queue = usePatchQueue<EditAnswer>(
    (op: QueueOp) => ("patch" in op
      ? client.configs.calculate({ id, ...op.patch })
      : client.configs.select({ projectId: id, selection: op.select })),
    { answer: patchView, refused: refetch },
  );

  // A model switch answers the whole view, model included: it replaces the cache.
  const update = useMutation(orpc.configs.update.mutationOptions({ onSuccess: (v) => qc.setQueryData(getKey, v) }));
  // The actions that leave this page answer a different id, or nothing: they invalidate the lists.
  const invalidateLists = () => {
    void qc.invalidateQueries({ queryKey: orpc.configs.rows.key() });
  };
  const create = useMutation(orpc.configs.create.mutationOptions({
    onSuccess: (r) => { invalidateLists(); on.left({ id: r.id }); },
  }));
  const duplicate = useMutation(orpc.configs.duplicate.mutationOptions({
    onSuccess: (r) => { invalidateLists(); on.left({ id: r.id }, "CONFIG_TOAST_DUPLICATED"); },
  }));
  const remove = useMutation(orpc.configs.remove.mutationOptions({
    onSuccess: () => { invalidateLists(); on.left("list", "CONFIG_TOAST_DELETED"); },
  }));
  // Create quote with a single candidate picks it on the way out. Only offered while the queue is
  // idle, so it cannot overtake anything; its own call, so the page can go on once it answered.
  const pickNow = useMutation(orpc.configs.select.mutationOptions({ onSuccess: patchView }));
  // A sync moves the display tables and, being newer than the calculation, the prices: both refetch.
  const sync = useMutation(orpc.configs.sync.mutationOptions({
    onSuccess: () => { void qc.invalidateQueries({ queryKey: lookupsKey }); refetch(); },
  }));

  const view = q.data;
  return {
    q, view, lookups, queue, update, create, duplicate, remove, sync, pickNow, refetch,
    /** the project as the user sees it: their pending edit over the last answer */
    project: view ? overlay(view.project, queue.pending) : undefined,
    form: view ? overlayForm(view.form, queue.pending) : undefined,
    selection: queue.picks ?? view?.selection.picks ?? [],
    commit: (p: InputPatch) => queue.commit(p),
    pick: (s: Sel[]) => queue.pick(s),
  };
}
