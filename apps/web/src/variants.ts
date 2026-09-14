import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "./orpc.ts";
import { EMPTY_SPEC, sameDef, type ListVariantDef } from "./listSpec.ts";

// The pure list-view logic lives in listSpec.ts (no orpc import, so it's unit-testable); re-exported
// here so pages have a single import path.
export * from "./listSpec.ts";

// The applied view: it drives the query, the dirty marker and what a Save persists. Owned here so
// the page can run its own query off `spec` while ListReport renders the chrome from the same state.
//
// A `portal:` entity is served by portal.variants instead: variants.list is userProcedure, which
// fences client accounts out entirely. Both queries are declared unconditionally (hooks rules) and
// exactly one is enabled — the disabled one never fetches and is never read.
export function useListSpec(entity: string) {
  const qc = useQueryClient();
  /** a portal client cannot create, edit or delete a view — the chrome for it is hidden */
  const readOnly = entity.startsWith("portal:");

  const opts = orpc.variants.list.queryOptions({ input: { page: "list", entity } });
  const internal = useQuery({ ...opts, enabled: !readOnly });
  const portal = useQuery({
    ...orpc.portal.variants.queryOptions({ input: { page: "list", entity } }),
    enabled: readOnly,
  });
  const data = readOnly ? portal.data : internal.data;
  const isLoading = readOnly ? portal.isPending : internal.isPending;
  const variants = data?.variants ?? [];

  const invalidate = () => qc.invalidateQueries({ queryKey: opts.queryKey });
  const save = useMutation(orpc.variants.save.mutationOptions({ onSuccess: invalidate }));
  const remove = useMutation(orpc.variants.remove.mutationOptions({ onSuccess: invalidate }));

  const [spec, setSpec] = useState<ListVariantDef>(EMPTY_SPEC);
  const [selectedName, setSelectedName] = useState("");
  // Which entity `spec` was initialised for. Gates the query so an entity switch can't fire one
  // render's worth of requests carrying the previous entity's field names.
  const [initedFor, setInitedFor] = useState("");

  const applyVariant = (name: string) => {
    setSelectedName(name);
    setSpec((variants.find((v) => v.name === name)?.definition as ListVariantDef) ?? EMPTY_SPEC);
  };

  /** Apply the default view: a personal default wins over the shared Standard. `exclude` covers the
   *  Manage Views case where the applied view was just deleted and its row is still in the cache.
   *  No variant at all (seed never ran) falls back to an unnamed empty view rather than blocking the
   *  page forever — the user can still filter and Save As. */
  const applyDefault = (exclude: string[] = []) => {
    const rows = variants.filter((v) => !exclude.includes(v.name));
    const def = rows.find((v) => v.isDefault && !v.shared) ?? rows.find((v) => v.isDefault) ?? rows[0];
    applyVariant(def?.name ?? "");
  };

  useEffect(() => {
    if (isLoading || initedFor === entity) return;
    applyDefault();
    setInitedFor(entity);
  }, [isLoading, entity, initedFor, variants]);

  const selectedDef = (variants.find((v) => v.name === selectedName)?.definition as ListVariantDef) ?? null;

  return {
    entity,
    spec,
    setSpec,
    /** variants loaded and a view applied — gate the page's query on this */
    ready: initedFor === entity,
    variants,
    selectedName,
    setSelectedName,
    applyVariant,
    applyDefault,
    // No selected row (no seed, Save As before the refetch, a rename that outran setSelectedName)
    // is "nothing to compare against", not "everything changed" — an asterisk there offers a Save
    // that has no row to write to.
    dirty: !!selectedDef && !sameDef(spec, selectedDef),
    isAdmin: data?.isAdmin ?? false,
    readOnly,
    save,
    remove,
  };
}

export type ListSpec = ReturnType<typeof useListSpec>;
