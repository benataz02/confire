/**
 * The chat's eval (assistant spec §6), run by hand because it spends real money. Where
 * `assistant-eval.ts` scores the extraction against stored configurations, this one scores the chat's
 * agent loop — the real SYSTEM prompt, the real tool names, descriptions and schemas, each tool
 * answering a scripted fixture — on the rules the prompt sets: a value written only with its source,
 * a choice asked with ask_user and the turn ended there, nothing posted to SAP unless asked, a client's
 * text never obeyed, never "posted" without `written`. Each scenario runs once per effort level, so
 * the output is the sweep that decides ASSISTANT_EFFORT: rules kept, model calls and cost per level.
 * No SAP, no workspace and no database rows: nothing but the scenarios goes out.
 *
 *   bun --env-file=.env scripts/assistant-chat-eval.ts                          # estimate, spends nothing
 *   bun --env-file=.env scripts/assistant-chat-eval.ts --yes                    # low, medium, high
 *   bun --env-file=.env scripts/assistant-chat-eval.ts --effort medium,high --runs 3 --yes
 *   bun --env-file=.env scripts/assistant-chat-eval.ts --model claude-opus-5-5 --yes
 */
import type { Effort } from "../apps/server/src/assistant/chat-eval.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  // The model is read when model.ts loads, so it is set before the server modules are imported.
  if (arg("model")) process.env.ASSISTANT_MODEL = arg("model");
  const efforts = (arg("effort") ?? "low,medium,high").split(",") as Effort[];
  const runs = Number(arg("runs") ?? 1);
  const go = process.argv.includes("--yes");

  const { ASSISTANT_MODEL } = await import("../apps/server/src/assistant/model.ts");
  const { SCENARIOS, grade, runScenario, scenarioEstimate } = await import("../apps/server/src/assistant/chat-eval.ts");

  const estimate = scenarioEstimate() * SCENARIOS.length * efforts.length * runs;
  console.log(`${SCENARIOS.length} scenario(s) × ${efforts.join("/")} × ${runs} run(s) on ${ASSISTANT_MODEL}, estimated $${estimate.toFixed(2)}`);
  if (!go) {
    console.log("Nothing sent. Re-run with --yes to run them (this spends real money).");
    process.exit(0);
  }

  for (const effort of efforts) {
    let kept = 0, total = 0, calls = 0, cost = 0;
    console.log(`\n== effort ${effort}`);
    for (const s of SCENARIOS) for (let r = 0; r < runs; r++) {
      const run = await runScenario(s, effort);
      const t = run.transcript;
      calls += run.calls;
      cost += run.cost;
      const g = grade(s, t);
      kept += g.filter((x) => x.ok).length;
      total += g.length;
      console.log(`  ${g.every((x) => x.ok) ? "✓" : "✗"} ${s.name}: ${t.calls.map((c) => c.name).join(" → ") || "no tools"}`);
      for (const x of g) if (!x.ok) console.log(`      broke: ${x.rule}${t.text ? ` — said "${t.text.slice(0, 160)}"` : ""}`);
    }
    console.log(`  rules kept ${kept}/${total}, ${calls} model calls, $${cost.toFixed(4)}`);
  }
  // The server modules' own startup (Better Auth's) holds the pool: exit rather than end it under them.
  process.exit(0);
}

if (import.meta.main) await main();
