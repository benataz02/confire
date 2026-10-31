import { useReducer, useRef, useState } from "react";
import type { Entries, FormState, TableRows } from "@confire/config-engine";

// What a configuration page sends: the fields that changed, nothing else — the same shape the
// staff `configs.calculate` and the portal's `projects.calculate` take. Both pages queue it here.

export type InputPatch = {
  name?: string;
  customer?: { cardCode: string; cardName: string } | null;
  set?: Entries;
  unset?: string[];
  batches?: number[];
  tables?: TableRows;
  /** staff only: the configuration's margin in percent; null = the model's */
  margin?: number | null;
};
type Sel = { candidateIdx: number; batchQty: number };

/** `b` after `a`, as one patch: a later value wins, a cleared key stops being set and a set key
 *  stops being cleared, tables replace per table. Within one patch a key both set and cleared ends
 *  up cleared, as the server merges it. */
export function mergePatch(a: InputPatch, b: InputPatch): InputPatch {
  const out: InputPatch = { ...a };
  if (b.name !== undefined) out.name = b.name;
  if (b.customer !== undefined) out.customer = b.customer;
  if (b.batches !== undefined) out.batches = b.batches;
  if (b.margin !== undefined) out.margin = b.margin;
  if (b.tables) out.tables = { ...a.tables, ...b.tables };
  if (b.set || b.unset) {
    const set: Entries = { ...a.set };
    const unset = new Set(a.unset);
    for (const [k, v] of Object.entries(b.set ?? {})) { set[k] = v; unset.delete(k); }
    for (const k of b.unset ?? []) { delete set[k]; unset.add(k); }
    if (Object.keys(set).length) out.set = set; else delete out.set;
    if (unset.size) out.unset = [...unset]; else delete out.unset;
  }
  return out;
}

/** The fields a page shows while a patch is on its way: what the user entered, laid over the last
 *  answer. An echo of input — every derived value keeps the last answer until the next one lands. */
export function overlay<P extends { name: string; customer: InputPatch["customer"]; entries: Entries; batches: number[]; tables: TableRows }>(
  project: P, p: InputPatch | null,
): P {
  if (!p) return project;
  const entries = { ...project.entries, ...p.set };
  for (const k of p.unset ?? []) delete entries[k];
  return {
    ...project,
    entries,
    name: p.name ?? project.name,
    customer: p.customer !== undefined ? p.customer : project.customer,
    batches: p.batches ?? project.batches,
    tables: p.tables ? { ...project.tables, ...p.tables } : project.tables,
  };
}

/** The form with the typed values over it, the same echo for the fields: a set value shows as typed
 *  (no longer a default), a cleared one as empty. Options, visibility and badges stay the answer's. */
export function overlayForm(form: FormState, p: InputPatch | null): FormState {
  if (!p?.set && !p?.unset) return form;
  const fields = { ...form.fields };
  for (const [k, v] of Object.entries(p.set ?? {})) {
    const { defaulted: _d, ...f } = fields[k] ?? { visible: true, required: false };
    fields[k] = { ...f, value: v };
  }
  for (const k of p.unset ?? []) {
    const { defaulted: _d, value: _v, ...f } = fields[k] ?? { visible: true, required: false };
    fields[k] = f;
  }
  return { ...form, fields };
}

export type QueueOp = { patch: InputPatch } | { select: Sel[] };

/** Codes that mean the server could not answer, not that it refused: worth a retry. */
const FAILURES = new Set(["INTERNAL_SERVER_ERROR", "BAD_GATEWAY", "SERVICE_UNAVAILABLE", "GATEWAY_TIMEOUT"]);
/** A 4xx from the server: an ORPCError carries its code; a network failure throws without one. */
const isRefusal = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z_]+$/.test(code) && !FAILURES.has(code);
};

/**
 * One call in flight per page. Commits made meanwhile merge into one pending patch, sent when the
 * call returns; a pick (staff) waits behind nothing but the call in flight — the page stops taking
 * picks while an edit is pending, so a pick never lands on a candidate list an edit is about to
 * replace. A commit is sent at once: commit events (change, blur, Enter, a pick) already group the
 * typing, so there is no timer.
 *
 * A refusal (4xx) drops what is pending and calls `refused`, for the page to refetch what the server
 * holds; a failure to reach the server keeps it, merged in front of anything newer, for `retry`.
 */
export function usePatchQueue<A>(send: (op: QueueOp) => Promise<A>, on: { answer: (a: A) => void; refused: () => void }) {
  const st = useRef<{ flight: QueueOp | null; patch: InputPatch | null; select: Sel[] | null }>({ flight: null, patch: null, select: null });
  const [, render] = useReducer((n: number) => n + 1, 0);
  const [error, setError] = useState<{ refused: boolean; error: Error } | null>(null);
  const latest = useRef({ send, on });
  latest.current = { send, on };

  const pump = () => {
    const s = st.current;
    if (s.flight) return;
    const op: QueueOp | null = s.select ? { select: s.select } : s.patch ? { patch: s.patch } : null;
    if (!op) return;
    if ("select" in op) s.select = null; else s.patch = null;
    s.flight = op;
    render();
    latest.current.send(op).then(
      (a) => {
        s.flight = null;
        latest.current.on.answer(a);
        render();
        pump();
      },
      (e: unknown) => {
        s.flight = null;
        const err = e instanceof Error ? e : new Error(String(e));
        if (isRefusal(e)) {
          s.patch = null;
          s.select = null;
          setError({ refused: true, error: err });
          latest.current.on.refused();
        } else {
          if ("patch" in op) s.patch = s.patch ? mergePatch(op.patch, s.patch) : op.patch;
          else s.select ??= op.select;
          setError({ refused: false, error: err });
        }
        render();
      },
    );
  };

  const s = st.current;
  const flightPatch = s.flight && "patch" in s.flight ? s.flight.patch : null;
  const pending = flightPatch && s.patch ? mergePatch(flightPatch, s.patch) : flightPatch ?? s.patch;
  return {
    commit: (p: InputPatch) => {
      s.patch = s.patch ? mergePatch(s.patch, p) : p;
      setError(null);
      pump();
      render();
    },
    pick: (selection: Sel[]) => {
      s.select = selection;
      setError(null);
      pump();
      render();
    },
    retry: () => { setError(null); pump(); },
    /** what the user entered and the server has not answered yet, as one patch */
    pending,
    /** the picks on their way, or null */
    picks: s.select ?? (s.flight && "select" in s.flight ? s.flight.select : null),
    /** an edit is pending or in flight: the candidates on screen are about to be replaced */
    editing: pending !== null,
    /** a call is out — the spinner; after a failure nothing is, though `busy` holds until a retry */
    sending: s.flight !== null,
    /** something the user did is not stored yet */
    busy: s.flight !== null || s.patch !== null || s.select !== null,
    error,
  };
}
