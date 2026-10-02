import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, ne, or } from "drizzle-orm";
import {
  db, uiUserState, uiView, user, ObjectViewStateZ, OBJECT_TABLE_SUFFIX, ViewStateZ,
  type ObjectViewState, type ViewState,
} from "@confire/db";
import { userProcedure } from "../base.ts";

// Saved views, a copy of the Beas GridViews API (list / create / update / delete) plus the
// UserGridStates half: the active view per table, and the value-help dialog layouts. System views
// are not here — a feature declares them in code and the client prepends them.
//
// Rules: shared views are admin-only to create or change; a personal view belongs to whoever
// created it; names are unique per scope (one user's personal views, or the tenant's shared ones).

const VisibilityZ = z.enum(["personal", "shared"]);
const TableIdZ = z.string().min(1).max(200);

const isAdminRole = (role: string) => role === "admin" || role === "owner";

/** A list view's state or an object view's, decided by the table id — so a list can never be
 *  saved with an object page's layout and the other way round. */
function parseState(tableId: string, state: unknown): ViewState | ObjectViewState {
  const r = (tableId.endsWith(OBJECT_TABLE_SUFFIX) ? ObjectViewStateZ : ViewStateZ).safeParse(state);
  if (!r.success) throw new ORPCError("BAD_REQUEST", { message: `Invalid view state: ${r.error.message}` });
  return r.data;
}

const activeKey = (tableId: string) => `${tableId}::activeView`;

async function getUserState(tenantId: string, userId: string, key: string): Promise<unknown> {
  const [row] = await db
    .select({ value: uiUserState.value })
    .from(uiUserState)
    .where(and(eq(uiUserState.tenantId, tenantId), eq(uiUserState.userId, userId), eq(uiUserState.key, key)))
    .limit(1);
  return row?.value ?? null;
}

async function setUserState(tenantId: string, userId: string, key: string, value: unknown): Promise<void> {
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
async function editable(id: string, ctx: { tenantId: string; userId: string; role: string }) {
  const [row] = await db
    .select()
    .from(uiView)
    .where(and(eq(uiView.id, id), eq(uiView.tenantId, ctx.tenantId)))
    .limit(1);
  if (!row) throw new ORPCError("NOT_FOUND");
  const canEdit = row.visibility === "shared" ? isAdminRole(ctx.role) : row.userId === ctx.userId;
  if (!canEdit) throw new ORPCError("FORBIDDEN", { message: "Not allowed to change this view" });
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
      message: v.visibility === "shared" ? "A shared view with this name already exists" : "A personal view with this name already exists",
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

export const viewsRouter = {
  /** The caller's personal views plus every shared one, and which view they last had active. */
  list: userProcedure
    .input(z.object({ tableId: TableIdZ }))
    .handler(async ({ input, context }) => {
      const isAdmin = isAdminRole(context.role);
      const rows = await db
        .select({
          id: uiView.id, name: uiView.name, visibility: uiView.visibility, isDefault: uiView.isDefault,
          state: uiView.state, userId: uiView.userId, author: user.name, updatedAt: uiView.updatedAt,
        })
        .from(uiView)
        .innerJoin(user, eq(user.id, uiView.userId))
        .where(and(
          eq(uiView.tenantId, context.tenantId),
          eq(uiView.tableId, input.tableId),
          or(eq(uiView.userId, context.userId), eq(uiView.visibility, "shared")),
        ))
        .orderBy(uiView.name);
      const activeId = await getUserState(context.tenantId, context.userId, activeKey(input.tableId));
      return {
        views: rows.map(({ userId, ...r }) => ({
          ...r,
          canEdit: r.visibility === "shared" ? isAdmin : userId === context.userId,
        })),
        activeId: typeof activeId === "string" ? activeId : null,
        isAdmin,
      };
    }),

  create: userProcedure
    .input(z.object({
      tableId: TableIdZ,
      name: z.string().trim().min(1).max(100),
      visibility: VisibilityZ,
      isDefault: z.boolean().default(false),
      state: z.unknown(),
    }))
    .handler(async ({ input, context }) => {
      if (input.visibility === "shared" && !isAdminRole(context.role))
        throw new ORPCError("FORBIDDEN", { message: "Only admins can publish shared views" });
      const state = parseState(input.tableId, input.state);
      await assertNameFree(context, input);
      const [ins] = await db
        .insert(uiView)
        .values({
          tenantId: context.tenantId, userId: context.userId, tableId: input.tableId,
          name: input.name, visibility: input.visibility, isDefault: input.isDefault, state,
        })
        .returning({ id: uiView.id });
      if (input.isDefault) await clearOtherDefaults(context, { ...input, id: ins!.id });
      // A new view becomes the active one, as Beas' Save As does.
      await setUserState(context.tenantId, context.userId, activeKey(input.tableId), ins!.id);
      return { id: ins!.id };
    }),

  update: userProcedure
    .input(z.object({
      id: z.uuid(),
      name: z.string().trim().min(1).max(100).optional(),
      visibility: VisibilityZ.optional(),
      isDefault: z.boolean().optional(),
      state: z.unknown().optional(),
    }))
    .handler(async ({ input, context }) => {
      const row = await editable(input.id, context);
      const visibility = input.visibility ?? row.visibility;
      if (visibility === "shared" && !isAdminRole(context.role))
        throw new ORPCError("FORBIDDEN", { message: "Only admins can publish shared views" });
      const name = input.name ?? row.name;
      await assertNameFree(context, { tableId: row.tableId, name, visibility, id: row.id });
      await db.update(uiView).set({
        name, visibility,
        ...(input.isDefault === undefined ? {} : { isDefault: input.isDefault }),
        ...(input.state === undefined ? {} : { state: parseState(row.tableId, input.state) }),
        updatedAt: new Date(),
      }).where(eq(uiView.id, row.id));
      if (input.isDefault) await clearOtherDefaults(context, { tableId: row.tableId, visibility, id: row.id });
      return { ok: true };
    }),

  remove: userProcedure
    .input(z.object({ id: z.uuid() }))
    .handler(async ({ input, context }) => {
      await editable(input.id, context);
      await db.delete(uiView).where(eq(uiView.id, input.id));
      return { ok: true };
    }),

  /** The view this user last selected on a table — a saved id or a `system:<key>`. */
  setActive: userProcedure
    .input(z.object({ tableId: TableIdZ, id: z.string().min(1).max(200) }))
    .handler(async ({ input, context }) => {
      await setUserState(context.tenantId, context.userId, activeKey(input.tableId), input.id);
      return { ok: true };
    }),

  /** Free-form per-user state under a key: today, the value-help dialogs' grid layouts
   *  (`cfl:<source>`). Never another user's, never another tenant's. */
  getState: userProcedure
    .input(z.object({ key: z.string().min(1).max(200) }))
    .handler(({ input, context }) => getUserState(context.tenantId, context.userId, input.key)),

  /** `null` deletes the entry, so a layout reset to the defaults leaves nothing behind. */
  setState: userProcedure
    .input(z.object({ key: z.string().min(1).max(200), value: z.unknown() }))
    .handler(async ({ input, context }) => {
      if (input.key.endsWith("::activeView"))
        throw new ORPCError("BAD_REQUEST", { message: "Use setActive for the active view" });
      // ponytail: one jsonb blob per key, size-capped here rather than modelled.
      if (JSON.stringify(input.value ?? null).length > 64_000)
        throw new ORPCError("BAD_REQUEST", { message: "State too large" });
      await setUserState(context.tenantId, context.userId, input.key, input.value ?? null);
      return { ok: true };
    }),
};
