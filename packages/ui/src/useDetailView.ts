import { useMemo, useState } from "react";
import { partialMatchKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { coerceKey, parseKeyParam, type Key } from "@confire/b1";
import { useUiI18n } from "./i18n.ts";
import { useUiSource } from "./source.tsx";
import { toast } from "./toast.ts";
import { useFieldConstraints, type EntityConstraints } from "./metadata.ts";
import { useEntityNav } from "./EntityLink.tsx";
import type { CreateAction } from "./object-page/ObjectPage.tsx";
import type { Row } from "./types.ts";

// BaseDetailView (LIST-REPORT-OBJECT-PAGE.md §2): one B1 record by its route key, with its ETag;
// update and create through the curated endpoints; first/prev/next/last; where a create goes next.

/** The key a route param names, typed the way the entity's metadata says (a digit-looking ItemCode
 *  is a string; DocEntry is a number). */
export const keyOf = (constraints: EntityConstraints, raw: string): Key =>
  coerceKey({ keys: constraints.keys, fields: Object.entries(constraints.fields).map(([name, m]) => ({ name, kind: m.Type })) }, parseKeyParam(raw));

export function useDetailView({ entity, routeKey, route, isNew = false, recordNavigation = false }: {
  entity: string;
  /** the `$key` route param; absent in create mode */
  routeKey?: string;
  /** the list route a record path is built on, e.g. `/b1/Quotations` */
  route: string;
  isNew?: boolean;
  /** first/prev/next/last, and the neighbour reads that say whether there is one */
  recordNavigation?: boolean;
}) {
  const qc = useQueryClient();
  const open = useEntityNav();
  const { client, orpc } = useUiSource();
  const i18n = useUiI18n();
  const meta = useFieldConstraints(entity);
  const constraints = meta.data;

  const key = useMemo(() => {
    if (!constraints || isNew || routeKey === undefined) return undefined;
    try {
      return keyOf(constraints, routeKey);
    } catch {
      return undefined;
    }
  }, [constraints, isNew, routeKey]);

  const oneOpts = orpc.entities.one.queryOptions({ input: { entity, key: key as Key } });
  const one = useQuery({
    ...oneOpts,
    enabled: key !== undefined,
    retry: false,
    // A row this fresh is not worth a second read: the quote page seeds this cache with SAP's own
    // return-representation and navigates straight here. Saves write the cache themselves.
    staleTime: 30_000,
    // First/prev/next/last keep the record on screen until the next one arrives, rather than the
    // skeleton. Only within the entity: the route component outlives an `$entity` change, and
    // another entity's row would be drawn under this one's sections.
    placeholderData: (prev, prevQuery) =>
      prevQuery && partialMatchKey(prevQuery.queryKey, orpc.entities.one.key({ input: { entity } })) ? prev : undefined,
  });
  // The placeholder's ETag is the previous record's: no edit until the new one is here.
  const etag = one.isPlaceholderData ? null : one.data?.etag ?? null;

  // The previous and next keys, read beside the record: a null one disables its buttons, and a
  // known one makes the click a navigation without another read. A composite key has no order to
  // walk (the server answers null), so it is not asked.
  const walkable = recordNavigation && !isNew && (typeof key === "string" || typeof key === "number");
  const neighborOpts = (dir: "prev" | "next") => ({
    ...orpc.entities.neighbor.queryOptions({ input: { entity, dir, key: key as string | number } }),
    staleTime: 30_000,
  });
  const prevKey = useQuery({ ...neighborOpts("prev"), enabled: walkable, retry: false });
  const nextKey = useQuery({ ...neighborOpts("next"), enabled: walkable, retry: false });

  const update = useMutation(orpc.entities.update.mutationOptions());
  const create = useMutation(orpc.entities.create.mutationOptions());
  // "Create and new" lands on the same #create URL; bumping this remounts the form empty.
  const [createEpoch, setCreateEpoch] = useState(0);
  const [navBusy, setNavBusy] = useState(false);

  const seed = (k: Key, row: Row, etag: string | null) =>
    qc.setQueryData(orpc.entities.one.queryOptions({ input: { entity, key: k } }).queryKey, { row, etag });

  const save = async (diff: Row, { createAction }: { createAction: CreateAction }) => {
    if (!constraints) throw new Error(i18n.getText("UI_READ_ONLY"));
    if (isNew) {
      const r = await create.mutateAsync({ entity, data: diff });
      const field = constraints.keys[0]!;
      const newKey = keyOf(constraints, String(r.row[field] ?? ""));
      seed(newKey, r.row, r.etag);
      toast(i18n.getText("UI_CREATED", constraints.label));
      if (createAction === "view") open(route, newKey);
      else if (createAction === "new") setCreateEpoch((n) => n + 1);
      else open(route);
      return;
    }
    if (key === undefined) throw new Error(i18n.getText("UI_NO_RECORD"));
    if (!etag) throw new Error(i18n.getText("UI_NO_ETAG"));
    const r = await update.mutateAsync({ entity, key, etag, data: diff });
    seed(key, r.row, r.etag);
    toast(i18n.getText("UI_SAVED_SAP"));
  };

  /** Walk the single key field (entities.neighbor); no next/previous record means stay put. */
  const go = async (dir: "first" | "prev" | "next" | "last") => {
    setNavBusy(true);
    try {
      const r = dir === "prev" || dir === "next"
        ? await qc.fetchQuery(neighborOpts(dir))
        : await client.entities.neighbor({ entity, dir });
      if (r.key === null) toast(i18n.getText(dir === "next" || dir === "last" ? "UI_LAST_RECORD" : "UI_FIRST_RECORD"));
      else open(route, r.key);
    } finally {
      setNavBusy(false);
    }
  };

  return {
    constraints,
    row: one.data?.row as Row | undefined,
    etag,
    loading: meta.isPending || (!isNew && key !== undefined && one.isPending),
    error: meta.error ?? (isNew ? null : one.error) ?? (constraints && !isNew && key === undefined ? new Error(i18n.getText("UI_INVALID_KEY")) : null),
    save,
    createEpoch,
    navigation: !recordNavigation || isNew ? undefined : {
      first: () => void go("first"), prev: () => void go("prev"), next: () => void go("next"), last: () => void go("last"),
      busy: navBusy || one.isPlaceholderData,
      // Unknown (still reading, or the read failed) stays enabled: the click asks the server itself.
      atFirst: !walkable || prevKey.data?.key === null,
      atLast: !walkable || nextKey.data?.key === null,
    },
  };
}
