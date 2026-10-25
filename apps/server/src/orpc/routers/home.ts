import { openapi } from "@orpc/openapi";
import { and, count, eq, sql } from "drizzle-orm";
import { db, configMasterdata, configModel, configProject, invitation } from "@confire/db";
import { userProcedure } from "../base.ts";
import { openInvitation, portalInvitationOf } from "../../portal/members.ts";

// The workspace home: the caller's own figures for the HeroBanner, and one to-do count per tile.
// Postgres only — a home page that waited on the agent would be down whenever the agent is.
// Each count is what its tile's list shows under the filter the tile links with.

const n = (cond: ReturnType<typeof sql>) => sql<number>`count(*) filter (where ${cond})::int`;

export const homeRouter = {
  overview: userProcedure
    .meta(openapi({
      summary: "The caller's month at a glance",
      description: "The caller's own figures: their drafts, the requests they hold in review, what they quoted this month (count and value), plus the workspace's drafts and new client requests waiting. Postgres only, so it answers with SAP offline.",
    }))
    .handler(async ({ context: { tenantId, userId } }) => {
    const internal = sql`${configProject.portalCardCode} is null`;
    const mine = sql`${configProject.createdBy} = ${userId}`;
    // Mine = an internal configuration I started, or a client's request I hold.
    const myQuote = sql`((${internal} and ${mine}) or ${configProject.assigneeId} = ${userId})`;
    // ponytail: the month is the database's (UTC), not the user's; a user's time zone if it ever matters.
    const thisMonth = sql`${configProject.quotedAt} >= date_trunc('month', now())`;

    const [[p], [models], [md], [inv]] = await Promise.all([
      db.select({
        myDrafts: n(sql`${internal} and ${mine} and ${configProject.status} = 'draft'`),
        myInReview: n(sql`${configProject.assigneeId} = ${userId} and ${configProject.status} = 'in_review'`),
        myQuoted: n(sql`${myQuote} and ${thisMonth}`),
        myQuotedValue: sql<number>`coalesce(sum(${configProject.quotedValue}) filter (where ${myQuote} and ${thisMonth}), 0)::float8`,
        drafts: n(sql`${internal} and ${configProject.status} = 'draft'`),
        newRequests: n(sql`${configProject.portalCardCode} is not null and ${configProject.status} = 'submitted'`),
      }).from(configProject).where(eq(configProject.tenantId, tenantId)),
      db.select({ n: count() }).from(configModel).where(eq(configModel.tenantId, tenantId)),
      db.select({ syncErrors: count(configMasterdata.syncError) }).from(configMasterdata)
        .where(eq(configMasterdata.tenantId, tenantId)),
      db.select({ n: count() }).from(invitation).where(and(portalInvitationOf(tenantId), openInvitation())),
    ]);
    return { ...p!, models: models!.n, syncErrors: md!.syncErrors, openInvitations: inv!.n };
  }),
};
