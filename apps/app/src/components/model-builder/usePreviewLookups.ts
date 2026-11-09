import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ModelDef } from "@confire/config-engine";
import { orpc } from "../../orpc.ts";
import { linkedForPreview } from "./lines.ts";

// Only domain refs affect lookup resolution. Sending this skeleton (instead of the full draft)
// keeps the TanStack query key stable while the admin types expressions, so the agent is only hit
// when a lookup source actually changes.
export function lookupSkeleton(d: ModelDef): ModelDef {
  return {
    name: "",
    parameters: d.parameters.map((p) => ({ key: p.key, label: "", type: p.type, ui: p.ui, domain: p.domain })),
    structure: { sections: [] },
    computed: [],
    constraints: [],
    bom: [],
    // The literal operations and their source: the line dialog shows each one's catalog figures
    // ("Beas: 5"), which only a resolve can read. A pick changes the key — rare, unlike typing.
    routing: linkedForPreview(d.routing),
    pricing: { margin: 0, quoteItemCode: "X", ...(d.pricing.operationTable ? { operationTable: d.pricing.operationTable } : {}) },
    batchDefaults: [1],
  };
}

export function usePreviewLookups(draft: ModelDef) {
  return useQuery({
    ...orpc.models.previewLookups.queryOptions({ input: { definition: lookupSkeleton(draft) } }),
    staleTime: 5 * 60_000, // rows move only when a sync refills them
    retry: false, // agent-offline should show its message, not spin
    placeholderData: keepPreviousData, // editing a query source keeps loaded fields visible instead of blanking
  });
}
