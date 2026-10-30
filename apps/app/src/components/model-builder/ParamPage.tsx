import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button } from "@ui5/webcomponents-react";
import type { Param } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import { PageError } from "@confire/ui/object-page/ObjectPageSkeleton.tsx";
import type { Row } from "@confire/ui/types.ts";
import { sameState } from "@confire/ui/views.ts";
import { commitParam, emptyParam, paramIssues, paramSections } from "../../features/model/parameter.ts";
import { modelWithParam } from "./exprHelpers.ts";
import { useI18n } from "../../i18n.ts";
import type { Translate } from "./builderMessages.ts";
import { builderControls } from "./controls.tsx";
import { useModelDraft } from "./draftScope.tsx";
import { ParamDomain } from "./ParamForm.tsx";
import type { ParamSearch } from "./paramRoute.ts";
import { copyKeys, deleteNodes, duplicateNodes, type RowRef } from "./structureOps.ts";

/** One parameter of the open model, a record of its own. Save writes it into the model record,
 *  saves the model and returns; a model that still fails elsewhere keeps it and shows why there. */
export function ParamPage({ search }: { search: ParamSearch }) {
  const m = useModelDraft();
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const isNew = search.key === undefined;
  // Read once: a new object resets the record, and a Save renames the parameter in the model.
  const [initial] = useState(() => (isNew ? emptyParam() : m.def.parameters.find((x) => x.key === search.key)));
  const [data] = useState<Row | undefined>(() => initial && structuredClone(initial));
  const sections = useMemo(() => paramSections(t), [i18n]);
  const validate = useCallback((r: Row) => paramIssues(r, m.def, m.tableCols, isNew, t), [m.def, m.tableCols, isNew, i18n]);

  if (!initial || !data) return <PageError error={new Error(t("MODEL_MISSING_PARAM"))} />;
  const heading = isNew ? t("MODEL_NEW_PARAM") : initial.label || initial.key;

  const toModel = { section: "params" as const };
  const self: RowRef = { kind: "param", key: initial.key };
  // A Delete leaves past the discard guard: its own confirm already asked.
  const back = (ignoreBlocker?: boolean) => m.id
    ? navigate({ to: "/$slug/models/$id", params: { id: m.id }, search: toModel, ignoreBlocker })
    : navigate({ to: "/$slug/models/new", search: toModel, ignoreBlocker });

  // The copy is taken from the model, which still has the last Save: copying an edited record would
  // miss what is on screen, so the button waits.
  const duplicate = () => {
    const keys = copyKeys(m.def, [self]);
    if (!keys.length) return;
    const next = duplicateNodes(m.def, [self], keys);
    m.editModel(() => next);
    const to = { key: keys[0]!.key };
    void (m.id
      ? navigate({ to: "/$slug/models/$id/parameter", params: { id: m.id }, search: to })
      : navigate({ to: "/$slug/models/new/parameter", search: to }));
  };
  const remove = async () => {
    if (!await confirm({ title: t("MODEL_DELETE"), message: t("MODEL_DELETE_PARAM_MSG", heading), actionText: t("MODEL_DELETE"), destructive: true }))
      return;
    m.editModel((d) => deleteNodes(d, [self]));
    void back(true);
  };

  return (
    <ObjectPage entity="ModelParam" localViews data={data} sections={sections} validate={validate}
      isNew={isNew} alwaysEdit
      header={{
        titleField: "label",
        createTitle: heading,
        actions: isNew ? undefined : (ctx) => (
          <>
            <Button icon="copy" design="Transparent" disabled={!sameState(ctx.formData, initial)}
              onClick={duplicate}>{t("MODEL_DUPLICATE")}</Button>
            <Button icon="delete" design="Transparent" onClick={() => void remove()}>{t("MODEL_DELETE")}</Button>
          </>
        ),
      }}
      breadcrumbs={[
        { text: t("NAV_MODELS"), to: "/models" },
        { text: m.def.name.trim() || t("MODEL_NEW"), to: m.id ? `/models/${m.id}` : "/models/new", search: toModel },
      ]}
      // Expressions read the model with this parameter spliced in, so an unsaved rename resolves.
      controls={builderControls({ scope: (c) => modelWithParam(m.def, c.formData as Param), tables: m.tableCols })}
      sectionTemplates={{
        domain: (ctx) => (
          <ParamDomain p={ctx.formData as Param} tables={m.tableCols}
            set={(patch) => ctx.update((r) => ({ ...r, ...patch }))} />
        ),
      }}
      onLeave={() => back()}
      onSave={async (_diff, { formData }) => {
        const place = search.s !== undefined && search.g !== undefined ? { s: search.s, g: search.g } : undefined;
        m.saveModel(commitParam(m.def, formData as Param, isNew ? undefined : initial.key, place));
        await back();
      }} />
  );
}
