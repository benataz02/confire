import type { ConfigView } from "../components/configurator/useConfigProcess.ts";

// Quick replies under the last answer (Joule: at most a few, short): worked out from the page's own
// state, so they cost no model call and never suggest what the configuration contradicts.
// ponytail: model-written replies would cost a round trip per turn; add them if users ask for more
// than next steps.

export type ReplyView = Pick<ConfigView, "missing"> & {
  candidates: Pick<ConfigView["candidates"], "rows">;
  selection: Pick<ConfigView["selection"], "picks">;
  project: Pick<ConfigView["project"], "status">;
};

const MAX = 4;

export function nextReplies(a: { kind: "configure" | "general" | "model"; view?: ReplyView }, t: (key: string) => string): string[] {
  if (a.kind === "general") return [t("ASSISTANT_REPLY_WAITING"), t("ASSISTANT_REPLY_DRAFTS")];
  if (a.kind === "model") return [];
  const v = a.view;
  const keys = [
    v?.missing.length ? "ASSISTANT_REPLY_MISSING" : null,
    v?.candidates.rows.length && !v.selection.picks.length ? "ASSISTANT_REPLY_CANDIDATES" : null,
    v?.selection.picks.length && v.project.status !== "quoted" ? "ASSISTANT_REPLY_QUOTE" : null,
    "ASSISTANT_REPLY_SIMILAR",
  ].filter((k): k is string => !!k);
  return keys.slice(0, MAX).map(t);
}
