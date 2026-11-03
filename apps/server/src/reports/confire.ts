import { and, eq, sql, type Column, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, configModel, configProject, user, type FilterCond } from "@confire/db";
import { compileQuery, TOTAL, type SqlFields } from "../list-sql.ts";
import { internalVisible } from "../project-lifecycle.ts";

// Confire's own data as a report source (reports spec §3.5): configurations, client requests among
// them (`channel` portal). Its own field map, not the configurations list's: a report reads figures
// the list does not show. Tenant-filtered, and an internal read never sees a client's draft.

const creator = alias(user, "report_creator");
const assignee = alias(user, "report_assignee");

export const CONFIRE_FIELDS = {
  Configurations: {
    name: { col: configProject.name, kind: "string" },
    model: { col: configModel.name, kind: "string" },
    customerCode: { col: sql<string>`${configProject.customer}->>'cardCode'`, kind: "string" },
    customerName: { col: sql<string>`${configProject.customer}->>'cardName'`, kind: "string" },
    status: { col: configProject.status, kind: "enum" },
    channel: { col: sql<string>`case when ${configProject.portalCardCode} is null then 'internal' else 'portal' end`, kind: "enum" },
    createdAt: { col: configProject.createdAt, kind: "date" },
    updatedAt: { col: configProject.updatedAt, kind: "date" },
    quotedAt: { col: configProject.quotedAt, kind: "date" },
    quotedValue: { col: sql<number>`${configProject.quotedValue}::float8`, kind: "number" },
    quotedCost: { col: sql<number>`${configProject.quotedCost}::float8`, kind: "number" },
    margin: { col: configProject.margin, kind: "number" },
    createdBy: { col: creator.name, kind: "string" },
    assignee: { col: assignee.name, kind: "string" },
  },
} satisfies Record<string, SqlFields>;
export type ConfireEntity = keyof typeof CONFIRE_FIELDS;

/** At most `cap` rows of the named fields (dates as ISO text, as B1 sends them), and how many match. */
export async function readConfire(
  tenantId: string, entity: string, filter: FilterCond[], select: string[], cap: number,
  orderby: { field: string; dir: "asc" | "desc" }[] = [],
): Promise<{ rows: Record<string, unknown>[]; total: number }> {
  const fields: SqlFields = CONFIRE_FIELDS[entity as ConfireEntity];
  if (!fields) throw new Error(`${entity} is not a Confire source`);
  const { where, orderBy } = compileQuery(fields, { select: [], filter, orderby });
  const names = (select.length ? select : Object.keys(fields)).filter((n) => fields[n]);
  const cols: Record<string, Column | SQL> = Object.fromEntries(names.map((n) => [n, fields[n]!.col]));
  const rows = await db.select({ ...cols, _total: TOTAL }).from(configProject)
    .innerJoin(configModel, eq(configModel.id, configProject.modelId))
    .leftJoin(creator, eq(creator.id, configProject.createdBy))
    .leftJoin(assignee, eq(assignee.id, configProject.assigneeId))
    .where(and(eq(configProject.tenantId, tenantId), internalVisible, where))
    .orderBy(...orderBy)
    .limit(cap);
  const total = Number((rows[0] as { _total?: number } | undefined)?._total ?? 0);
  return {
    rows: rows.map(({ _total, ...r }) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v instanceof Date ? v.toISOString() : v]))),
    total,
  };
}
