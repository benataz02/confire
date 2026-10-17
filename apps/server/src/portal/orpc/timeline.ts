import { z } from "zod";
import { portalMemberProcedure } from "./base.ts";
import { addComment, type Actor } from "../../project-lifecycle.ts";
import { projectDocuments, timelineEvents } from "../../project-timeline.ts";
import {
  CreateInputZ, GetStateInputZ, IdInputZ, ListInputZ, SetActiveInputZ, SetStateInputZ, UpdateInputZ, views,
  type ViewCtx,
} from "../../ui-views.ts";

// A project's timeline, client side (spec §8): external events only — the SQL filter in
// timelineEvents is the fence — and the SAP documents whose CardCode is the company's. Every seat
// may comment, viewers included; a client's comment is always external.

const actorOf = (c: { user: { id: string }; companyId: string }): Actor =>
  ({ userId: c.user.id, side: "external", companyId: c.companyId });
const ProjectZ = z.object({ projectId: z.uuid() });

export const timelineRouter = {
  list: portalMemberProcedure.input(ProjectZ).handler(({ input, context }) =>
    timelineEvents(context.tenantId, input.projectId, actorOf(context))),

  documents: portalMemberProcedure.input(ProjectZ).handler(({ input, context }) =>
    projectDocuments(context.tenantId, input.projectId, actorOf(context))),

  comment: portalMemberProcedure
    .input(z.object({ projectId: z.uuid(), note: z.string().trim().min(1).max(4000) }))
    .handler(async ({ input, context }) => ({
      id: await addComment(context.tenantId, input.projectId, actorOf(context), input.note, false),
    })),
};

/** Personal views only (spec §9): a portal user never sees or publishes a shared view — a company
 *  owner is not a tenant admin. Same rules module as the internal app. */
const ctxOf = (c: { tenantId: string; user: { id: string } }): ViewCtx =>
  ({ tenantId: c.tenantId, userId: c.user.id, isAdmin: false, shared: false });

export const viewsRouter = {
  list: portalMemberProcedure.input(ListInputZ).handler(({ input, context }) => views.list(ctxOf(context), input)),
  create: portalMemberProcedure.input(CreateInputZ).handler(({ input, context }) => views.create(ctxOf(context), input)),
  update: portalMemberProcedure.input(UpdateInputZ).handler(({ input, context }) => views.update(ctxOf(context), input)),
  remove: portalMemberProcedure.input(IdInputZ).handler(({ input, context }) => views.remove(ctxOf(context), input)),
  setActive: portalMemberProcedure.input(SetActiveInputZ).handler(({ input, context }) => views.setActive(ctxOf(context), input)),
  getState: portalMemberProcedure.input(GetStateInputZ).handler(({ input, context }) => views.getState(ctxOf(context), input)),
  setState: portalMemberProcedure.input(SetStateInputZ).handler(({ input, context }) => views.setState(ctxOf(context), input)),
};
