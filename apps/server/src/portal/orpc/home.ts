import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { and, eq, inArray, notInArray, or } from "drizzle-orm";
import { db, configProject } from "@confire/db";
import { escapeLiteral, rowsOf } from "@confire/b1";
import { portalMemberProcedure } from "./base.ts";
import { tenantConnector, viaB1 } from "../../b1.ts";
import { ALWAYS, type DocEntity } from "../doc-fields.ts";
import { advanceSapSteps } from "../../project-timeline.ts";
import { getUserState, setUserState } from "../../ui-views.ts";
import { figuresOf, FINISHED, isFinished, journeyOf, rankOf, type Next } from "../journey.ts";

// The portal home (spec 2026-11-06-portal-home): Postgres and live SAP in separate calls on purpose,
// so an agent that is down costs the SAP parts — the journey's refresh and the documents — never the
// page. The journey itself is portal/journey.ts; this file only reads and orders.

const doc = (entity: DocEntity, r: Record<string, unknown>) => ({
  entity, docEntry: Number(r.DocEntry), docNum: Number(r.DocNum ?? 0), docDate: String(r.DocDate ?? ""),
  docTotal: Number(r.DocTotal ?? 0), currency: String(r.DocCurrency ?? ""), status: String(r.DocumentStatus ?? ""),
});

export type HomeInquiry = { id: string; name: string; pinned: boolean; step: number; next: Next; at: string; quotedValue: number | null };

const PINS = "portal:homePins";
const UUID = z.uuid();

/** The caller's pins: a ui_user_state row anyone could have written anything into, so only uuids pass
 *  (a bad string in `id = any(…)` would throw on the uuid column). Ids outside the fence just match nothing. */
async function pinsOf(tenantId: string, userId: string): Promise<string[]> {
  const v = await getUserState(tenantId, userId, PINS);
  return Array.isArray(v) ? v.filter((x): x is string => UUID.safeParse(x).success) : [];
}

const mine = (c: { tenantId: string; cardCode: string }) =>
  and(eq(configProject.tenantId, c.tenantId), eq(configProject.portalCardCode, c.cardCode));

/** The date of the project's latest step, for the row's sub-line. */
function atOf(r: { status: string; sapStepAt: string | null; createdAt: Date; updatedAt: Date; quotedAt: Date | null; quoteRespondedAt: Date | null }): string {
  if (r.sapStepAt) return r.sapStepAt;
  if (r.status === "draft") return r.createdAt.toISOString();
  if (r.status === "quoted") return (r.quoteRespondedAt ?? r.quotedAt ?? r.updatedAt).toISOString();
  return r.updatedAt.toISOString();
}

export const homeRouter = {
  /** The company's open inquiries — not finished, plus the caller's pins, finished or not — each with
   *  its journey, in the page's order, and the banner's figures over the open ones. */
  overview: portalMemberProcedure.handler(async ({ context }) => {
    const pins = await pinsOf(context.tenantId, context.user.id);
    const open = notInArray(configProject.status, FINISHED);
    const rows = await db.select({
      id: configProject.id, name: configProject.name, status: configProject.status, quoteResponse: configProject.quoteResponse,
      sapStepAt: configProject.sapStepAt, createdAt: configProject.createdAt,
      updatedAt: configProject.updatedAt, quotedAt: configProject.quotedAt, quoteRespondedAt: configProject.quoteRespondedAt,
      quotedValue: configProject.quotedValue,
    }).from(configProject)
      .where(and(mine(context), pins.length ? or(open, inArray(configProject.id, pins)) : open));
    // ponytail: no row cap — a company's open inquiries are few; cap (with the All projects link) if one makes the page long.
    const pinned = new Set(pins);
    const all = rows.map((r) => ({ r, pinned: pinned.has(r.id), ...journeyOf(r) }));
    all.sort((a, b) => Number(b.pinned) - Number(a.pinned) || rankOf(a.next) - rankOf(b.next)
      || b.r.updatedAt.getTime() - a.r.updatedAt.getTime());
    return {
      figures: figuresOf(all.filter((x) => !isFinished(x.r)).map((x) => x.next)),
      inquiries: all.map(({ r, pinned, step, next }): HomeInquiry => ({
        id: r.id, name: r.name, pinned, step, next, at: atOf(r),
        quotedValue: r.quotedValue === null ? null : Number(r.quotedValue),
      })),
    };
  }),

  /** Pin or unpin one of the company's projects for the caller alone. */
  pin: portalMemberProcedure.input(z.object({ id: z.uuid(), pinned: z.boolean() })).handler(async ({ input, context }) => {
    const [own] = await db.select({ id: configProject.id }).from(configProject)
      .where(and(eq(configProject.id, input.id), mine(context))).limit(1);
    if (!own) throw new ORPCError("NOT_FOUND");
    const rest = (await pinsOf(context.tenantId, context.user.id)).filter((id) => id !== input.id);
    const pins = input.pinned ? [input.id, ...rest] : rest;
    await setUserState(context.tenantId, context.user.id, PINS, pins);
    return { pins };
  }),

  /** The company's five newest documents across quotations, orders, deliveries and invoices (an open
   *  invoice is the page's to flag, off `status`). ALWAYS fields only — every portal schema shows
   *  those — and the same CardCode fence as docs.rows. */
  documents: portalMemberProcedure.handler(async ({ context }) => {
    const { b1 } = await tenantConnector(context.tenantId);
    const fence = `CardCode eq '${escapeLiteral(context.cardCode)}'`;
    const read = (entity: DocEntity) =>
      viaB1(() => b1.readEntitySet(entity, { filter: fence, select: ALWAYS, orderby: "DocDate desc,DocEntry desc", top: 5 }));
    const entities: DocEntity[] = ["Quotations", "Orders", "DeliveryNotes", "Invoices"];
    const reads = await Promise.all(entities.map(read));
    const recent = reads.flatMap((r, i) => rowsOf(r.data).map((row) => doc(entities[i]!, row)))
      .sort((a, b) => b.docDate.localeCompare(a.docDate) || b.docEntry - a.docEntry).slice(0, 5);
    return { recent };
  }),

  /** How far SAP has taken the company's quoted projects (advanceSapSteps). The page refetches the
   *  overview when something changed. */
  progress: portalMemberProcedure.handler(async ({ context }) =>
    ({ changed: await advanceSapSteps(context.tenantId, eq(configProject.portalCardCode, context.cardCode)) })),
};
