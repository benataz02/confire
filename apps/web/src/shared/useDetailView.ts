import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { coerceKey, parseKeyParam, type Key } from "@confire/b1";
import { client, orpc } from "../orpc.ts";
import { toast } from "../components/toast.ts";
import { useFieldConstraints, type EntityConstraints } from "./metadata.ts";
import { entityPath } from "./navigation.ts";
import type { CreateAction } from "./object-page/ObjectPage.tsx";
import type { Row } from "./types.ts";

// BaseDetailView (LIST-REPORT-OBJECT-PAGE.md §2): one B1 record by its route key, with its ETag;
// update and create through the curated endpoints; first/prev/next/last; where a create goes next.

/** The key a route param names, typed the way the entity's metadata says (a digit-looking ItemCode
 *  is a string; DocEntry is a number). */
export const keyOf = (constraints: EntityConstraints, raw: string): Key =>
  coerceKey({ keys: constraints.keys, fields: Object.entries(constraints.fields).map(([name, m]) => ({ name, kind: m.Type })) }, parseKeyParam(raw));

export function useDetailView({ entity, routeKey, route, isNew = false }: {
  entity: string;
  /** the `$key` route param; absent in create mode */
  routeKey?: string;
  /** the list route a record path is built on, e.g. `/b1/Quotations` */
  route: string;
  isNew?: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
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
  });

  const update = useMutation(orpc.entities.update.mutationOptions());
  const create = useMutation(orpc.entities.create.mutationOptions());
  // "Create and new" lands on the same #create URL; bumping this remounts the form empty.
  const [createEpoch, setCreateEpoch] = useState(0);
  const [navBusy, setNavBusy] = useState(false);

  const seed = (k: Key, row: Row, etag: string | null) =>
    qc.setQueryData(orpc.entities.one.queryOptions({ input: { entity, key: k } }).queryKey, { row, etag });

  const save = async (diff: Row, { createAction }: { createAction: CreateAction }) => {
    if (!constraints) throw new Error("This record is read-only");
    if (isNew) {
      const r = await create.mutateAsync({ entity, data: diff });
      const field = constraints.keys[0]!;
      const newKey = keyOf(constraints, String(r.row[field] ?? ""));
      seed(newKey, r.row, r.etag);
      toast(`${constraints.label} created`);
      if (createAction === "view") void navigate({ href: entityPath(route, newKey) });
      else if (createAction === "new") setCreateEpoch((n) => n + 1);
      else void navigate({ href: route });
      return;
    }
    if (key === undefined) throw new Error("No record");
    const etag = one.data?.etag;
    if (!etag) throw new Error("SAP sent no ETag with this record, so it cannot be changed safely.");
    const r = await update.mutateAsync({ entity, key, etag, data: diff });
    seed(key, r.row, r.etag);
    toast("Saved to SAP");
  };

  /** Walk the single key field (entities.neighbor); no next/previous record means stay put. */
  const go = async (dir: "first" | "prev" | "next" | "last") => {
    setNavBusy(true);
    try {
      const r = await client.entities.neighbor({ entity, dir, ...(dir === "prev" || dir === "next" ? { key: key as string | number } : {}) });
      if (r.key === null) toast(dir === "next" || dir === "last" ? "This is the last record" : "This is the first record");
      else void navigate({ href: entityPath(route, r.key) });
    } finally {
      setNavBusy(false);
    }
  };

  return {
    constraints,
    row: one.data?.row as Row | undefined,
    etag: one.data?.etag ?? null,
    loading: meta.isPending || (!isNew && key !== undefined && one.isPending),
    error: meta.error ?? (isNew ? null : one.error) ?? (constraints && !isNew && key === undefined ? new Error("Invalid record key") : null),
    save,
    createEpoch,
    navigation: isNew ? undefined : {
      first: () => void go("first"), prev: () => void go("prev"), next: () => void go("next"), last: () => void go("last"),
      busy: navBusy,
    },
  };
}
