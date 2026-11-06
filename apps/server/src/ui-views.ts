import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, ne, or } from "drizzle-orm";
import {
  db, uiUserState, uiView, user, ObjectViewStateZ, OBJECT_TABLE_SUFFIX, ViewStateZ,
  type ListQuery, type ObjectViewState, type ViewState,
} from "@confire/db";
import { t } from "./i18n/index.ts";

// Saved views, a copy of the Beas GridViews API (list / create / update / delete) plus the
// UserGridStates half: the active view per table, and the value-help dialog layouts. System views
// are not here — a feature declares them in code and the client prepends them. The shared views
// every workspace starts with are (SEEDED_VIEWS, below).
//
// Rules: shared views are admin-only to create or change; a personal view belongs to whoever
// created it; names are unique per scope (one user's personal views, or the tenant's shared ones).
//
// Builder-agnostic: the internal router and the customer portal's (spec §9: personal views only,
// no shared ones) call the same handlers with their own context. `ViewCtx.isAdmin` is the only
// way to publish a shared view, and the portal never sets it — a portal company *owner* is not
// a tenant admin.

/** Who is asking. `shared`: whether the caller sees the tenant's shared views at all. */
export type ViewCtx = { tenantId: string; userId: string; isAdmin: boolean; shared: boolean };

export const VisibilityZ = z.enum(["personal", "shared"]);
export const TableIdZ = z.string().min(1).max(200);

/** A list view's state or an object view's, decided by the table id — so a list can never be
 *  saved with an object page's layout and the other way round. */
function parseState(tableId: string, state: unknown): ViewState | ObjectViewState {
  const r = (tableId.endsWith(OBJECT_TABLE_SUFFIX) ? ObjectViewStateZ : ViewStateZ).safeParse(state);
  if (!r.success) throw new ORPCError("BAD_REQUEST", { message: t("VIEW_STATE_INVALID", r.error.message) });
  return r.data;
}

const activeKey = (tableId: string) => `${tableId}::activeView`;

export async function getUserState(tenantId: string, userId: string, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: uiUserState.value })
    .from(uiUserState)
    .where(and(eq(uiUserState.tenantId, tenantId), eq(uiUserState.userId, userId), eq(uiUserState.key, key)))
    .limit(1);
  return row?.value ?? null;
}

export async function setUserState(tenantId: string, userId: string, key: string, value: unknown): Promise<void> {
  if (value === null) {
    await db.delete(uiUserState)
      .where(and(eq(uiUserState.tenantId, tenantId), eq(uiUserState.userId, userId), eq(uiUserState.key, key)));
    return;
  }
  await db
    .insert(uiUserState)
    .values({ tenantId, userId, key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [uiUserState.tenantId, uiUserState.userId, uiUserState.key],
      set: { value, updatedAt: new Date() },
    });
}

/** The row, tenant-fenced, plus whether the caller may change it. */
async function editable(id: string, ctx: ViewCtx) {
  const [row] = await db
    .select()
    .from(uiView)
    .where(and(eq(uiView.id, id), eq(uiView.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) throw new ORPCError("NOT_FOUND");
  const canEdit = row.visibility === "shared" ? ctx.isAdmin : row.userId === ctx.userId;
  if (!canEdit) throw new ORPCError("FORBIDDEN", { message: t("VIEW_NOT_YOURS") });
  return row;
}

/** One name per scope, case-insensitive. */
async function assertNameFree(
  ctx: { tenantId: string; userId: string },
  v: { tableId: string; name: string; visibility: "personal" | "shared"; id?: string },
) {
  const scope = v.visibility === "shared"
    ? and(eq(uiView.tenantId, ctx.tenantId), eq(uiView.tableId, v.tableId), eq(uiView.visibility, "shared"))
    : and(eq(uiView.tenantId, ctx.tenantId), eq(uiView.tableId, v.tableId), eq(uiView.visibility, "personal"),
      eq(uiView.userId, ctx.userId));
  const peers = await db.select({ id: uiView.id, name: uiView.name }).from(uiView).where(scope);
  const key = v.name.trim().toLowerCase();
  if (peers.some((p) => p.id !== v.id && p.name.trim().toLowerCase() === key))
    throw new ORPCError("CONFLICT", {
      message: t(v.visibility === "shared" ? "VIEW_SHARED_NAME_TAKEN" : "VIEW_PERSONAL_NAME_TAKEN"),
    });
}

/** At most one default per scope: setting one clears the others. */
async function clearOtherDefaults(
  ctx: { tenantId: string; userId: string },
  v: { tableId: string; visibility: "personal" | "shared"; id: string },
) {
  await db.update(uiView).set({ isDefault: false }).where(and(
    eq(uiView.tenantId, ctx.tenantId), eq(uiView.tableId, v.tableId), ne(uiView.id, v.id),
    v.visibility === "shared"
      ? eq(uiView.visibility, "shared")
      : and(eq(uiView.visibility, "personal"), eq(uiView.userId, ctx.userId)),
  ));
}


// --- the seeded views -----------------------------------------------------------------------------

/** A list state that is the declared defaults plus these filters: empty `columns` and
 *  `adaptFilterKeys` resolve to the feature's own (`resolveListState`), so a column added later
 *  still shows. */
const seeded = (filterValues: ViewState["filterValues"] = {}, sortBy: ViewState["sortBy"] = []): ViewState => ({
  columns: [], knownColumns: [], sortBy, groupBy: [], adaptFilterKeys: [], filterValues, searchTerm: "",
});
const NEWEST: ViewState["sortBy"] = [{ field: "DocEntry", direction: "desc" }];
/** Each list's Open (or Active) filters; its Mine view is the same plus `mine` — what is still
 *  the user's to do. */
const OPEN_DOC = { DocumentStatus: ["bost_Open"] };
const ACTIVE = { Frozen: ["tNO"] };
const OPEN_CONFIG = { status: ["draft"] };
const OPEN_REQUEST = { status: ["submitted", "in_review", "returned"] };
const MINE = { mine: ["yes"] };
// Open first: a document list opens on what is still to do.
const DOCUMENTS = [
  ["Open", seeded(OPEN_DOC, NEWEST)],
  ["All", seeded({}, NEWEST)],
  ["Assigned to me", seeded({ ...OPEN_DOC, ...MINE }, NEWEST)],
] as const;

/** Every workspace's starting views: shared rows, the first of each table its default (the list
 *  shows them by name, so the order says nothing else), which
 *  replaces the declared Standard (`useViews`). `mine` is no column: each list's server reads it
 *  per caller — the sales employee the user picked (B1, `withMine`), the configuration's creator,
 *  the request's assignee. Migration 0016 gave them to the workspaces made before; keep the two
 *  in step.
 *  The names are stored in English and shown translated while unchanged (`viewLabel`, @confire/ui). */
export const SEEDED_VIEWS: Record<string, readonly (readonly [string, ViewState])[]> = {
  "b1:Quotations": DOCUMENTS,
  "b1:Orders": DOCUMENTS,
  "b1:DeliveryNotes": DOCUMENTS,
  "b1:BusinessPartners": [
    ["All", seeded()],
    ["Active", seeded(ACTIVE)],
    ["Assigned to me", seeded({ ...ACTIVE, ...MINE })],
  ],
  // An item has no sales employee: no "mine".
  "b1:Items": [["All", seeded()], ["Active", seeded(ACTIVE)]],
  configs: [
    ["All", seeded()],
    ["Open", seeded(OPEN_CONFIG)],
    ["Created by me", seeded({ ...OPEN_CONFIG, ...MINE })],
  ],
  requests: [
    ["All", seeded()],
    ["Open", seeded(OPEN_REQUEST)],
    ["Assigned to me", seeded({ ...OPEN_REQUEST, ...MINE })],
  ],
};

/** A new workspace's shared views, authored by whoever created it (auth.ts' hook). */
export async function seedViews(tenantId: string, userId: string): Promise<void> {
  await db.insert(uiView).values(Object.entries(SEEDED_VIEWS).flatMap(([tableId, vs]) =>
    vs.map(([name, state], i) => ({ tenantId, userId, tableId, name, visibility: "shared" as const, isDefault: i === 0, state }))));
}

/** The user's own SAP sales employee (`{ code, name }`, picked in the user menu), under a
 *  `ui_user_state` key: it only narrows a list, so it is the user's to set. */
export const SALES_PERSON_KEY = "b1:salesPerson";

/** `mine` on a B1 list is no SAP field: it becomes SalesPersonCode against the caller's own sales
 *  employee — `yes` eq, `no` ne, both nothing. `code` undefined = none picked yet, refused. */
export function withMine(q: ListQuery, code: number | undefined): ListQuery {
  const mine = q.filter.filter((c) => c.field === "mine");
  if (!mine.length) return q;
  const filter = q.filter.filter((c) => c.field !== "mine");
  for (const c of mine) {
    const v = [c.value].flat();
    const yes = v.includes("yes"), no = v.includes("no");
    if (yes === no) continue;
    if (code === undefined) throw new ORPCError("BAD_REQUEST", { message: t("VIEW_MINE_NO_SALES_PERSON") });
    filter.push({ field: "SalesPersonCode", op: yes ? "eq" : "ne", value: code });
  }
  return { ...q, filter };
}

export async function salesPersonOf(tenantId: string, userId: string): Promise<number | undefined> {
  const v = await getUserState(tenantId, userId, SALES_PERSON_KEY) as { code?: unknown } | null;
  return typeof v?.code === "number" ? v.code : undefined;
}

export const ListInputZ = z.object({ tableId: TableIdZ });
export const CreateInputZ = z.object({
  tableId: TableIdZ,
  name: z.string().trim().min(1).max(100),
  visibility: VisibilityZ,
  isDefault: z.boolean().default(false),
  state: z.unknown(),
});
export const UpdateInputZ = z.object({
  id: z.uuid(),
  name: z.string().trim().min(1).max(100).optional(),
  visibility: VisibilityZ.optional(),
  isDefault: z.boolean().optional(),
  state: z.unknown().optional(),
});
export const IdInputZ = z.object({ id: z.uuid() });
export const SetActiveInputZ = z.object({ tableId: TableIdZ, id: z.string().min(1).max(200) });
export const GetStateInputZ = z.object({ key: z.string().min(1).max(200) });
export const SetStateInputZ = z.object({ key: z.string().min(1).max(200), value: z.unknown() });

export const views = {
  /** The caller's personal views plus every shared one, and which view they last had active. */
  async list(ctx: ViewCtx, input: z.infer<typeof ListInputZ>) {
    const rows = await db
      .select({
        id: uiView.id, name: uiView.name, visibility: uiView.visibility, isDefault: uiView.isDefault,
        state: uiView.state, userId: uiView.userId, author: user.name, updatedAt: uiView.updatedAt,
      })
      .from(uiView)
      .innerJoin(user, eq(user.id, uiView.userId))
      .where(and(
        eq(uiView.tenantId, ctx.tenantId),
        eq(uiView.tableId, input.tableId),
        ctx.shared ? or(eq(uiView.userId, ctx.userId), eq(uiView.visibility, "shared")) : eq(uiView.userId, ctx.userId),
      ))
      .orderBy(uiView.name);
    const activeId = await getUserState(ctx.tenantId, ctx.userId, activeKey(input.tableId));
    return {
      views: rows.map(({ userId, ...r }) => ({
        ...r,
        canEdit: r.visibility === "shared" ? ctx.isAdmin : userId === ctx.userId,
      })),
      activeId: typeof activeId === "string" ? activeId : null,
      isAdmin: ctx.isAdmin,
    };
  },

  async create(ctx: ViewCtx, input: z.infer<typeof CreateInputZ>) {
    if (input.visibility === "shared" && !ctx.isAdmin)
      throw new ORPCError("FORBIDDEN", { message: t("VIEW_SHARED_ADMINS") });
    const state = parseState(input.tableId, input.state);
    await assertNameFree(ctx, input);
    const [ins] = await db
      .insert(uiView)
      .values({
        tenantId: ctx.tenantId, userId: ctx.userId, tableId: input.tableId,
        name: input.name, visibility: input.visibility, isDefault: input.isDefault, state,
      })
      .returning({ id: uiView.id });
    if (input.isDefault) await clearOtherDefaults(ctx, { ...input, id: ins!.id });
    // A new view becomes the active one, as Beas' Save As does.
    await setUserState(ctx.tenantId, ctx.userId, activeKey(input.tableId), ins!.id);
    return { id: ins!.id };
  },

  async update(ctx: ViewCtx, input: z.infer<typeof UpdateInputZ>) {
    const row = await editable(input.id, ctx);
    const visibility = input.visibility ?? row.visibility;
    if (visibility === "shared" && !ctx.isAdmin)
      throw new ORPCError("FORBIDDEN", { message: t("VIEW_SHARED_ADMINS") });
    const name = input.name ?? row.name;
    await assertNameFree(ctx, { tableId: row.tableId, name, visibility, id: row.id });
    await db.update(uiView).set({
      name, visibility,
      ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
      ...(input.state === undefined ? {} : { state: parseState(row.tableId, input.state) }),
      updatedAt: new Date(),
    }).where(eq(uiView.id, row.id));
    if (input.isDefault) await clearOtherDefaults(ctx, { tableId: row.tableId, visibility, id: row.id });
    return { ok: true };
  },

  async remove(ctx: ViewCtx, input: z.infer<typeof IdInputZ>) {
    await editable(input.id, ctx);
    await db.delete(uiView).where(eq(uiView.id, input.id));
    return { ok: true };
  },

  /** The view this user last selected on a table — a saved id or a `system:<key>`. */
  async setActive(ctx: ViewCtx, input: z.infer<typeof SetActiveInputZ>) {
    await setUserState(ctx.tenantId, ctx.userId, activeKey(input.tableId), input.id);
    return { ok: true };
  },

  /** Free-form per-user state under a key: today, the value-help dialogs' grid layouts
   *  (`cfl:<source>`). Never another user's, never another tenant's. */
  getState: (ctx: ViewCtx, input: z.infer<typeof GetStateInputZ>) => getUserState(ctx.tenantId, ctx.userId, input.key),

  /** `null` deletes the entry, so a layout reset to the defaults leaves nothing behind. */
  async setState(ctx: ViewCtx, input: z.infer<typeof SetStateInputZ>) {
    if (input.key.endsWith("::activeView"))
      throw new ORPCError("BAD_REQUEST", { message: t("VIEW_USE_SET_ACTIVE") });
    // ponytail: one jsonb blob per key, size-capped here rather than modelled.
    if (JSON.stringify(input.value ?? null).length > 64_000)
      throw new ORPCError("BAD_REQUEST", { message: t("VIEW_STATE_TOO_LARGE") });
    await setUserState(ctx.tenantId, ctx.userId, input.key, input.value ?? null);
    return { ok: true };
  },
};
