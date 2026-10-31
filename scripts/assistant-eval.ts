/**
 * The assistant's test set (spec §6), run by hand because it spends real money. A case is a
 * configuration with a client's drawing attached: its readable files (PDF, PNG, JPEG) are read
 * against its model as if the configuration were empty, and the reading is scored against what the
 * configuration holds now. Only workspaces with the assistant switched on: their drawings already go
 * to Anthropic, so the eval sends nothing new out.
 *
 *   bun --env-file=.env scripts/assistant-eval.ts                 # count and estimated cost, spends nothing
 *   bun --env-file=.env scripts/assistant-eval.ts --yes           # run it
 *   bun --env-file=.env scripts/assistant-eval.ts --model claude-haiku-5-5 --limit 30 --yes
 *
 * Stored entries are the final values, which the client may have revised after the drawing: every
 * difference is listed with its source for a person to mark misread or revised. Misreads are the bar.
 */
import type { Entries, Val } from "@confire/config-engine";
import type { Extraction, FileSource } from "../apps/server/src/assistant/extract.ts";

const canon = (v: unknown) => JSON.stringify(v);
/** The tenant and user the eval's usage rows are filed under. */
const EVAL = "assistant-eval";
const empty = (v: unknown) => v === undefined || v === null || v === "";

/** One case's score: `total` writable keys with a stored value, `filled` readings equal to it,
 *  `asked` keys sent to `unsure`, and every reading unlike its stored value. */
export function scoreCase(stored: Entries, x: Extraction, writable: string[]) {
  const scored = new Set(writable.filter((k) => !empty(stored[k])));
  const differs: { key: string; read: Val; stored: Val; source: FileSource }[] = [];
  let filled = 0;
  for (const r of x.set) {
    if (!scored.has(r.key)) continue;
    if (canon(r.value) === canon(stored[r.key])) filled++;
    else differs.push({ key: r.key, read: r.value, stored: stored[r.key]!, source: r.source });
  }
  const asked = new Set(x.unsure.map((u) => u.key).filter((k) => scored.has(k))).size;
  return { filled, asked, total: scored.size, differs };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  // The model is read when model.ts loads, so it is set before the server modules are imported.
  if (arg("model")) process.env.ASSISTANT_MODEL = arg("model");
  const limit = Number(arg("limit") ?? 30);
  const go = process.argv.includes("--yes");

  const { and, eq, gte, inArray, isNotNull, sql } = await import("drizzle-orm");
  const { db, pool, aiUsage, assistantSettings, configProject, projectFile } = await import("@confire/db");
  const { formState, propagate } = await import("@confire/config-engine");
  const { liveEngine } = await import("../apps/server/src/config-project.ts");
  const { modelBlock, readExtraction } = await import("../apps/server/src/assistant/extract.ts");
  const { docType, fileParts } = await import("../apps/server/src/assistant/files.ts");
  const { readRequest } = await import("../apps/server/src/assistant/intake.ts");
  const { ASSISTANT_MODEL } = await import("../apps/server/src/assistant/model.ts");
  const { costOf } = await import("../apps/server/src/assistant/usage.ts");

  // Files first, sniffed: a case is a configuration with at least one file the assistant reads.
  const files = await db.select({
    id: projectFile.id, name: projectFile.name, mime: projectFile.mime, data: projectFile.data,
    projectId: projectFile.projectId, tenantId: projectFile.tenantId,
  }).from(projectFile)
    .innerJoin(assistantSettings, and(eq(assistantSettings.tenantId, projectFile.tenantId), eq(assistantSettings.assistant, true)))
    .where(isNotNull(projectFile.projectId));
  const byProject = new Map<string, typeof files>();
  for (const f of files) if (docType(f.data)) byProject.set(f.projectId!, [...(byProject.get(f.projectId!) ?? []), f]);
  const ids = [...byProject.keys()].slice(0, limit);
  const projects = ids.length
    ? await db.select({ id: configProject.id, tenantId: configProject.tenantId, modelId: configProject.modelId, name: configProject.name, entries: configProject.entries })
      .from(configProject).where(inArray(configProject.id, ids))
    : [];

  // ~1.5k tokens a page (an image is a page), plus the model block, plus ~1k out.
  const pagesOf = (b: Buffer) => (docType(b) === "application/pdf" ? Math.max(1, (b.toString("latin1").match(/\/Type\s*\/Page(?!s)/g) ?? []).length) : 1);
  let estimate = 0;
  const cases = [];
  for (const p of projects) {
    const { model, lookups } = await liveEngine(p.tenantId, { modelId: p.modelId, entries: {}, margin: null });
    const form = formState(model.definition, lookups, propagate(model.definition, lookups, {}, {}), {});
    const pages = byProject.get(p.id)!.reduce((n, f) => n + pagesOf(f.data), 0);
    // twice: the intake proposal reads the same pages
    estimate += 2 * costOf(ASSISTANT_MODEL, { input: pages * 1500 + modelBlock(model.definition, form).length / 4, cacheRead: 0, cacheWrite: 0, output: 1000 });
    cases.push({ p, model, form });
  }
  console.log(`${cases.length} case(s) on ${ASSISTANT_MODEL}, estimated $${estimate.toFixed(2)}`);
  if (!go) {
    console.log("Nothing sent. Re-run with --yes to read them (this spends real money).");
    await pool.end();
    return;
  }

  const started = new Date();
  const totals = { filled: 0, asked: 0, total: 0, differs: 0, proposed: 0 };
  for (const { p, model, form } of cases) {
    const refs = byProject.get(p.id)!.map((f) => ({ kind: "project" as const, id: f.id, name: f.name, mime: f.mime }));
    const parts = await fileParts(p.tenantId, refs, { projectId: p.id });
    // Confire's own spend, metered apart: it never counts against the workspace's limit or its
    // assisted configurations.
    const meter = { tenantId: EVAL, userId: EVAL, threadId: null, projectId: null, kind: "extract" as const };
    const x = await readExtraction({ def: model.definition, form, parts, text: "", meter });
    // The first call too: does it propose the model the configuration was made with? No SAP read is
    // wanted here, so its headers name no session and the customer lookup fails quietly.
    const proposal = await readRequest({ headers: new Headers(), tenantId: p.tenantId }, { parts, text: "", meter });
    const writable = model.definition.parameters.filter((q) => !q.readonly).map((q) => q.key);
    const r = scoreCase(p.entries, x, writable);
    totals.filled += r.filled; totals.asked += r.asked; totals.total += r.total; totals.differs += r.differs.length;
    if (proposal.model?.id === p.modelId) totals.proposed++;
    console.log(`\n${p.name} (${model.name}): filled ${r.filled}/${r.total}, asked ${r.asked}, differs ${r.differs.length}, proposed ${proposal.model?.name ?? "no model"}`);
    for (const d of r.differs)
      console.log(`  ${d.key}: read ${canon(d.read)}, stored ${canon(d.stored)} — ${d.source.file} p.${d.source.page ?? "-"} "${d.source.quote}"  [misread / revised?]`);
  }
  const [spent] = await db.select({ cost: sql<string>`coalesce(sum(${aiUsage.cost}), 0)` }).from(aiUsage)
    .where(and(eq(aiUsage.tenantId, EVAL), eq(aiUsage.kind, "extract"), gte(aiUsage.at, started)));
  const share = totals.total ? Math.round((totals.filled / totals.total) * 100) : 0;
  console.log(`\nfilled ${share}% (${totals.filled}/${totals.total}), asked ${totals.asked}, differs ${totals.differs}, model proposed ${totals.proposed}/${cases.length}, spent $${Number(spent?.cost ?? 0).toFixed(4)}`);
  await pool.end();
}

if (import.meta.main) await main();
