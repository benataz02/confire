import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { Text } from "@ui5/webcomponents-react";
import { VISUALS, visualOutputKey, visualsFor } from "@confire/config-engine";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import type { Row } from "@confire/ui/types.ts";
import { commitVisual, fromVisualRecord, toVisualRecord, visualIssues, visualSections, withoutStub } from "../../features/model/visual.ts";
import { useI18n } from "../../i18n.ts";
import type { Translate } from "./builderMessages.ts";
import { builderControls } from "./controls.tsx";
import { useModelDraft } from "./draftScope.tsx";
import type { TableSearch } from "./paramRoute.ts";

/** One tenant visual of the open model, a record of its own: its kind and a formula per input. Save
 *  writes it into the model record, saves the model and returns; placement is the structure tree's. */
export function VisualPage({ search }: { search: TableSearch }) {
  const m = useModelDraft();
  const i18n = useI18n();
  const tr: Translate = (key, ...params) => i18n.getText(key, ...params);
  const { slug } = useParams({ from: "/$slug" });
  const navigate = useNavigate({ from: "/$slug" });
  // Read once: a Save renames the visual in the model.
  const [initial] = useState(() => (m.def.visuals ?? []).find((x) => x.key === search.key));
  const [data] = useState<Row | undefined>(() => initial && toVisualRecord(initial));
  // The workspace's kinds, plus the visual's own if it is not among them (the save check names that).
  const kinds = useMemo(() => {
    const own = initial ? VISUALS[initial.kind] : undefined;
    const mine = visualsFor(slug);
    return own && !mine.includes(own) ? [...mine, own] : mine;
  }, [slug, initial]);
  const sections = useMemo(() => visualSections(tr, kinds), [i18n, kinds]);
  const validate = useCallback((r: Row) => visualIssues(r, m.def, m.tableCols, initial?.key ?? "", tr), [m.def, m.tableCols, initial, i18n]);

  if (!initial || !data) return <PageError error={new Error(tr("MODEL_MISSING_VISUAL"))} />;
  const back = () => m.id
    ? navigate({ to: "/$slug/models/$id", params: { id: m.id }, search: { section: "params" } })
    : navigate({ to: "/$slug/models/new", search: { section: "params" } });

  return (
    <ObjectPage entity="ModelVisual" localViews data={data} sections={sections} validate={validate} alwaysEdit
      header={{
        titleField: "title",
        createTitle: tr("MODEL_DETAIL_TABLE", VISUALS[initial.kind]?.label ?? initial.kind, initial.title || initial.key),
      }}
      breadcrumbs={[
        { text: tr("NAV_MODELS"), to: "/models" },
        { text: m.def.name.trim() || tr("MODEL_NEW"), to: m.id ? `/models/${m.id}` : "/models/new", search: { section: "params" } },
      ]}
      // An input resolves against the model with this visual's unsaved edits spliced in.
      controls={builderControls({ scope: (c) => commitVisual(m.def, initial.key, fromVisualRecord(c.formData)), tables: m.tableCols })}
      sectionTemplates={{
        // What the rest of the model's formulas read off this visual.
        outputs: (ctx) => {
          const v = fromVisualRecord(ctx.formData);
          const outs = Object.entries(VISUALS[v.kind]?.outputs ?? {});
          return (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem" }}>
              {outs.map(([out, o]) => <Text key={out}><b>{visualOutputKey(v.key, out)}</b> · {o.label}</Text>)}
            </div>
          );
        },
      }}
      // A visual just added and left without a formula goes back out (see withoutStub).
      onLeave={() => {
        m.editModel((d) => withoutStub(d, initial.key));
        return back();
      }}
      onSave={async (_diff, { formData }) => {
        m.saveModel(commitVisual(m.def, initial.key, fromVisualRecord(formData)));
        await back();
      }} />
  );
}
