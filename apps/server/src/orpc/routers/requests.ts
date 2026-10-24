import { z } from "zod";
import { and, eq, isNotNull, ne, sql } from "drizzle-orm";
import { db, configModel, configProject, portalCompany, user } from "@confire/db";
import { userProcedure } from "../base.ts";
import { compileQuery, listPage, ListPageZ, TOTAL, type SqlFields } from "../../list-sql.ts";
import { staffOf } from "../../notifications.ts";
import { addComment, assign, transition, type Action } from "../../project-lifecycle.ts";
import { projectDocuments, timelineEvents } from "../../project-timeline.ts";

// Portal → Requests (spec §10, §11): the clients' projects from their first submit on, and the
// three decisions staff take on one — Accept, Send back, Decline. Quote stays configs.createQuote
// (create-or-modify, §7.3). Any member: the rules are the lifecycle's, not a role's.

const QUOTE_RESPONSE = sql<string>`coalesce(${configProject.quoteResponse}, '')`;

/** The list's columns. `mine` is per caller, so the fields are too. */
const fieldsFor = (userId: string): SqlFields => ({
  name: { col: configProject.name, kind: "string" },
  cardName: { col: portalCompany.cardName, kind: "string" },
  cardCode: { col: portalCompany.cardCode, kind: "string" },
  modelName: { col: configModel.name, kind: "string" },
  status: { col: configProject.status, kind: "enum" },
  assignee: { col: user.name, kind: "string" },
  mine: { col: sql<string>`case when ${configProject.assigneeId} = ${userId} then 'yes' else 'no' end`, kind: "enum" },
  quoteResponse: { col: QUOTE_RESPONSE, kind: "enum" },
  updatedAt: { col: configProject.updatedAt, kind: "date" },
});

const DecisionZ = z.object({ id: z.uuid(), note: z.string().trim().max(2000).optional() });

const decide = (action: Action) =>
  userProcedure.input(DecisionZ).handler(async ({ input, context }) => {
    const r = await transition({
      tenantId: context.tenantId, projectId: input.id, action, note: input.note,
      actor: { userId: context.userId, side: "internal" },
    });
    return { status: r.to };
  });

export const requestsRouter = {
  rows: userProcedure.input(ListPageZ).handler(async ({ input, context }) => {
    const { where, orderBy } = compileQuery(fieldsFor(context.userId), input.query);
    const raw = await db
      .select({
        id: configProject.id, name: configProject.name, status: configProject.status,
        cardCode: portalCompany.cardCode, cardName: portalCompany.cardName, modelName: configModel.name,
        assignee: user.name, quoteResponse: QUOTE_RESPONSE, updatedAt: configProject.updatedAt, _total: TOTAL,
      })
      .from(configProject)
      .innerJoin(portalCompany, and(eq(portalCompany.tenantId, configProject.tenantId), eq(portalCompany.cardCode, configProject.portalCardCode)))
      .innerJoin(configModel, eq(configModel.id, configProject.modelId))
      .leftJoin(user, eq(user.id, configProject.assigneeId))
      // A client's draft is private: a request shows from its first submit (spec §10).
      .where(and(
        eq(configProject.tenantId, context.tenantId), isNotNull(configProject.portalCardCode),
        ne(configProject.status, "draft"), where,
      ))
      .orderBy(...orderBy, sql`${configProject.updatedAt} desc`, configProject.id)
      .limit(input.top)
      .offset(input.skip ?? 0);
    return listPage(raw, input.top, input.skip);
  }),

  accept: decide("accept"),
  sendBack: decide("sendBack"),
  decline: decide("decline"),

  /** Reassign (notifications spec §6): any staff member may hand a request to any other. */
  assign: userProcedure
    .input(z.object({ projectId: z.uuid(), userId: z.string().min(1) }))
    .handler(({ input, context }) =>
      assign(context.tenantId, input.projectId, { userId: context.userId, side: "internal" }, input.userId)),

  /** Who a request can be assigned to: the workspace's staff, for the Reassign picker. */
  assignable: userProcedure.handler(({ context }) => staffOf(context.tenantId)),
};

/** The project timeline, staff side (spec §8): every event, internal notes included. */
export const timelineRouter = {
  list: userProcedure.input(z.object({ projectId: z.uuid() })).handler(({ input, context }) =>
    timelineEvents(context.tenantId, input.projectId, { userId: context.userId, side: "internal" })),

  /** Live SAP: the quotations and what they became. Separate from `list` so a down agent costs
   *  these rows only. */
  documents: userProcedure.input(z.object({ projectId: z.uuid() })).handler(({ input, context }) =>
    projectDocuments(context.tenantId, input.projectId, { userId: context.userId, side: "internal" })),

  comment: userProcedure
    .input(z.object({ projectId: z.uuid(), note: z.string().trim().min(1).max(4000), internalOnly: z.boolean().default(false) }))
    .handler(async ({ input, context }) => ({
      id: await addComment(context.tenantId, input.projectId, { userId: context.userId, side: "internal" }, input.note, input.internalOnly),
    })),
};
