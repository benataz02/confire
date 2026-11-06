import { adminProcedure, userProcedure } from "../base.ts";
import { disconnectMail, mailSettings, mailStatus, saveMailSettings, SettingsZ } from "../../document-mail.ts";

// Settings → Email (document-mail spec §5.2): the workspace's Microsoft 365 mailbox and each document
// type's "Notify the client" default and sender. Connecting is the two plain routes in
// document-mail.ts (a full page load to Microsoft and back); everything else is here. Admins only,
// but `status`, which the create pages read to draw their switch.

export const documentMailRouter = {
  settings: adminProcedure.handler(({ context }) => mailSettings(context.tenantId)),
  save: adminProcedure.input(SettingsZ).handler(({ input, context }) => saveMailSettings(context.tenantId, input)),
  disconnect: adminProcedure.handler(({ context }) => disconnectMail(context.tenantId)),
  status: userProcedure.handler(({ context }) => mailStatus(context.tenantId)),
};
