import { userProcedure } from "../base.ts";
import {
  CreateInputZ, GetStateInputZ, IdInputZ, ListInputZ, SetActiveInputZ, SetStateInputZ, UpdateInputZ, views,
  type ViewCtx,
} from "../../ui-views.ts";

// Saved views for the internal app: the rules live in ui-views.ts, shared with the portal.

const ctxOf = (c: { tenantId: string; userId: string; role: string }): ViewCtx =>
  ({ tenantId: c.tenantId, userId: c.userId, isAdmin: c.role === "admin" || c.role === "owner", shared: true });

export const viewsRouter = {
  list: userProcedure.input(ListInputZ).handler(({ input, context }) => views.list(ctxOf(context), input)),
  create: userProcedure.input(CreateInputZ).handler(({ input, context }) => views.create(ctxOf(context), input)),
  update: userProcedure.input(UpdateInputZ).handler(({ input, context }) => views.update(ctxOf(context), input)),
  remove: userProcedure.input(IdInputZ).handler(({ input, context }) => views.remove(ctxOf(context), input)),
  setActive: userProcedure.input(SetActiveInputZ).handler(({ input, context }) => views.setActive(ctxOf(context), input)),
  getState: userProcedure.input(GetStateInputZ).handler(({ input, context }) => views.getState(ctxOf(context), input)),
  setState: userProcedure.input(SetStateInputZ).handler(({ input, context }) => views.setState(ctxOf(context), input)),
};
