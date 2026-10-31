// The consent rule (spec 2026-10-30 §10), pure so it is tested without a browser: nothing loads
// before a choice, Reject loads nothing, and a site with no pixel configured never asks.

export type Choice = "granted" | "denied" | null;
export type Pixels = { meta: string; linkedin: string };

export function plan(choice: Choice, pixels: Pixels): { showCard: boolean; load: ("meta" | "linkedin")[] } {
  const configured = (["meta", "linkedin"] as const).filter((p) => pixels[p]);
  if (!configured.length) return { showCard: false, load: [] };
  return { showCard: choice === null, load: choice === "granted" ? [...configured] : [] };
}
