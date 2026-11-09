import { Suspense } from "react";
import { BusyIndicator, Text } from "@ui5/webcomponents-react";
import { useUiI18n } from "../../i18n.ts";
import { VISUAL_VIEWS } from "./registry.ts";

/** A visual's picture, or what stands in for it: a short note while its inputs are undecided. */
export function VisualPanel({ kind, view }: { kind: string; view: unknown | undefined }) {
  const i18n = useUiI18n();
  const Drawing = VISUAL_VIEWS[kind];
  if (view === undefined || !Drawing)
    return <Text style={{ color: "var(--sapContent_LabelColor)" }}>{i18n.getText("UI_VISUAL_EMPTY")}</Text>;
  return (
    <Suspense fallback={<BusyIndicator active style={{ inlineSize: "100%" }} />}>
      <Drawing view={view} />
    </Suspense>
  );
}
