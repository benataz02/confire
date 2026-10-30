import { useMemo, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Button, MessageStrip } from "@ui5/webcomponents-react";
import type { ModelDef, Param } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import type { EntityConstraints } from "@confire/ui/metadata.ts";
import { ObjectPage } from "@confire/ui/object-page/ObjectPage.tsx";
import type { FormContext, Section } from "@confire/ui/types.ts";
import { useI18n } from "../../i18n.ts";
import type { Translate } from "./builderMessages.ts";
import { useModelDraft } from "./draftScope.tsx";
import { checkParam, ParamBehavior, ParamDefinition, ParamDomain, type ParamPart } from "./ParamForm.tsx";
import { sameJson, type ParamSearch } from "./paramRoute.ts";
import { deleteNode, duplicateParam, placeParam } from "./structureOps.ts";

// mandatory by default: an unanswered field is the usual mistake, and unticking it is one click.
const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select", mandatory: true });

// The parameter is the record's one field, as in TablePage: the shared ObjectPage's buffer, dirty
// mark, discard guard and Save/Cancel cover it whole; the three sections are templates over it.
const CONSTRAINTS: EntityConstraints = {
  name: "ModelParam", label: "", keys: [], writable: true, printable: false, flows: [],
  fields: { param: { Type: "string", EdmType: "", Editable: true } },
};

/** One parameter of the open model. Save writes it into the draft, saves the model and returns.
 *  `modelId` absent means the model itself is still unsaved. */
export function ParamPage({ modelId, search }: { modelId?: string; search: ParamSearch }) {
  const m = useModelDraft();
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const isNew = search.key === undefined;
  // Read once: a new object resets the page's form, and a Save renames the parameter in the draft.
  const [initial] = useState(() => (isNew ? emptyParam() : m.draft.parameters.find((x) => x.key === search.key)));
  const [data] = useState(() => ({ param: structuredClone(initial) }));
  const [tried, setTried] = useState(false);
  const sections = useMemo<Section[]>(() => [
    { id: "definition", label: t("MODEL_DEFINITION") },
    { id: "domain", label: t("MODEL_DOMAIN") },
    { id: "behavior", label: t("MODEL_BEHAVIOR") },
  ], [i18n]);

  const toModel = { section: "params" as const };
  // A Delete leaves past the discard guard: its own confirm already asked.
  const back = (ignoreBlocker?: boolean) => modelId
    ? navigate({ to: "/$slug/models/$id", params: { id: modelId }, search: toModel, ignoreBlocker })
    : navigate({ to: "/$slug/models/new", search: toModel, ignoreBlocker });

  if (!initial)
    return <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem", width: "auto" }}>{t("MODEL_MISSING_PARAM")}</MessageStrip>;
  const heading = isNew ? t("MODEL_NEW_PARAM") : initial.label || initial.key;

  const part = (ctx: FormContext): ParamPart => {
    const p = ctx.formData.param as Param;
    return { p, set: (patch) => ctx.updateField("param", { ...p, ...patch }), draft: m.draft, tables: m.tableCols, isNew, tried };
  };

  // The copy is taken from the draft, which still has the last Save. Copying a dirty buffer
  // would miss what is on screen, so the button waits.
  const duplicate = () => {
    const next = duplicateParam(m.draft, initial.key);
    const copy = next.parameters.find((x) => !m.draft.parameters.some((y) => y.key === x.key));
    if (!copy) return;
    m.update(() => next);
    const to = { key: copy.key };
    void (modelId
      ? navigate({ to: "/$slug/models/$id/parameter", params: { id: modelId }, search: to })
      : navigate({ to: "/$slug/models/new/parameter", search: to }));
  };

  const remove = async () => {
    if (!await confirm({
      title: t("MODEL_DELETE"),
      message: t("MODEL_DELETE_PARAM_MSG", heading),
      actionText: t("MODEL_DELETE"),
      destructive: true,
    })) return;
    m.update((d) => deleteNode(d, { kind: "param", key: initial.key }));
    void back(true);
  };

  return (
    <ObjectPage
      isNew
      entity="ModelParam"
      constraints={CONSTRAINTS}
      data={data}
      sections={sections}
      header={{
        titleField: "param",
        createTitle: heading,
        actions: isNew ? undefined : (ctx) => {
          const dirty = !sameJson(ctx.formData.param, initial);
          return (
            <>
              <Button icon="copy" design="Transparent" disabled={dirty}
                tooltip={dirty ? t("MODEL_SAVE_FIRST") : t("MODEL_DUPLICATE_PARAM")}
                onClick={duplicate}>{t("MODEL_DUPLICATE")}</Button>
              <Button icon="delete" design="Transparent" onClick={() => void remove()}>{t("MODEL_DELETE")}</Button>
            </>
          );
        },
      }}
      localViews
      createLabel={t("MODEL_SAVE")}
      onCancelCreate={() => void back()}
      breadcrumbs={[
        { text: t("NAV_MODELS"), to: "/models" },
        { text: m.draft.name.trim() || t("MODEL_NEW"), to: modelId ? `/models/${modelId}` : "/models/new", search: toModel },
      ]}
      sectionTemplates={{
        definition: (ctx) => <ParamDefinition {...part(ctx)} />,
        domain: (ctx) => <ParamDomain {...part(ctx)} />,
        behavior: (ctx) => <ParamBehavior {...part(ctx)} />,
      }}
      onSave={async (diff) => {
        const p = diff.param as Param | undefined;
        if (p) {
          if (checkParam(m.draft, m.tableCols, p, isNew, t).blocked) {
            setTried(true);
            throw new Error(t("MODEL_CHECK_FIELDS"));
          }
          const place = search.s !== undefined && search.g !== undefined ? { s: search.s, g: search.g } : undefined;
          const next = commitParam(m.draft, p, isNew ? undefined : initial.key, place);
          m.update(() => next);
          // A model that still fails elsewhere (an unnamed new one, another parameter) keeps the
          // parameter in its draft and shows why on the page this returns to.
          m.save(next);
        }
        await back();
      }}
    />
  );
}

/** The parameter written back over the one the page opened, or appended (and placed) when new. */
function commitParam(d: ModelDef, p: Param, openedAs: string | undefined, place?: { s: number; g: number }): ModelDef {
  if (openedAs !== undefined) return { ...d, parameters: d.parameters.map((x) => (x.key === openedAs ? p : x)) };
  const out = { ...d, parameters: [...d.parameters, p] };
  return place ? placeParam(out, p.key, place.s, place.g) : out;
}
