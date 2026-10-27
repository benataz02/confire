import { useRef, useState } from "react";
import { useBlocker, useNavigate } from "@tanstack/react-router";
import {
  Bar, Button, MessageStrip, ObjectPage, ObjectPageSection, ObjectPageTitle, Title,
  Toolbar, ToolbarButton,
} from "@ui5/webcomponents-react";
import type { ModelDef, Param } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import { PageBreadcrumbs } from "@confire/ui/PageBreadcrumbs.tsx";
import { useI18n } from "../../i18n.ts";
import type { Translate } from "./builderMessages.ts";
import { useModelDraft } from "./draftScope.tsx";
import { ParamBehavior, ParamDefinition, ParamDomain, paramBlocked, useParamFields } from "./ParamForm.tsx";
import { sameJson, type ParamSearch } from "./paramRoute.ts";
import { deleteNode, duplicateParam, placeParam } from "./structureOps.ts";

// mandatory by default: an unanswered field is the usual mistake, and unticking it is one click.
const emptyParam = (): Param => ({ key: "", label: "", type: "string", ui: "select", mandatory: true });

/** One parameter of the open model. Save writes it into the draft and returns; the model's own
 *  Save is what persists. `modelId` absent means the model itself is still unsaved. */
export function ParamPage({ modelId, search }: { modelId?: string; search: ParamSearch }) {
  const m = useModelDraft();
  const draft = m.draft;
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);
  const navigate = useNavigate({ from: "/$slug" });
  const isNew = search.key === undefined;
  const found = search.key === undefined ? undefined : draft.parameters.find((x) => x.key === search.key);
  const missing = search.key !== undefined && !found;
  const [initial] = useState<Param>(() => (found ? structuredClone(found) : emptyParam()));
  const [p, setP] = useState<Param>(initial);
  // Save stays disabled until the buffer differs from what the page opened on. A dirty parameter
  // that cannot be written still takes the click: that click is what reveals the errors.
  const [tried, setTried] = useState(false);
  // Set before the navigate that follows a successful Save, or the buffer still differs from
  // `initial` and the blocker asks to discard the edit that was just committed.
  const leave = useRef(false);
  const set = (patch: Partial<Param>) => setP((x) => ({ ...x, ...patch }));
  const bufferDirty = !missing && !sameJson(p, initial);
  // The blocker keeps the callback it first saw. The ref is what a later keystroke updates.
  const bufferDirtyRef = useRef(bufferDirty);
  bufferDirtyRef.current = bufferDirty;

  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (leave.current || current.pathname === next.pathname || !bufferDirtyRef.current) return false;
      return !(await confirm({
        title: t("MODEL_DISCARD_TITLE"),
        message: t("MODEL_DISCARD_MSG"),
        actionText: t("MODEL_DISCARD"),
        destructive: true,
      }));
    },
    enableBeforeUnload: () => !leave.current && bufferDirtyRef.current,
  });

  const modelName = draft.name.trim() || t("MODEL_NEW");
  const heading = missing ? (search.key ?? "") : isNew ? t("MODEL_NEW_PARAM") : (p.label || p.key);

  const back = () => {
    const section = { section: "params" as const };
    if (modelId) void navigate({ to: "/$slug/models/$id", params: { id: modelId }, search: section });
    else void navigate({ to: "/$slug/models/new", search: section });
  };

  const save = () => {
    if (paramBlocked(p, draft, isNew, t)) { setTried(true); return; }
    const place = search.s !== undefined && search.g !== undefined ? { s: search.s, g: search.g } : undefined;
    const originalKey = search.key;
    m.update((d) => commitParam(d, p, isNew, originalKey, place));
    leave.current = true;
    back();
  };

  const openParam = (key: string) => {
    const next = { key };
    if (modelId) void navigate({ to: "/$slug/models/$id/parameter", params: { id: modelId }, search: next });
    else void navigate({ to: "/$slug/models/new/parameter", search: next });
  };

  // The copy is taken from the draft, which still has the last Save. Copying a dirty buffer
  // would miss what is on screen, so the button waits.
  const duplicate = () => {
    const key = search.key;
    if (!key || bufferDirty) return;
    const next = duplicateParam(draft, key);
    const copy = next.parameters.find((x) => !draft.parameters.some((y) => y.key === x.key));
    if (!copy) return;
    m.update(() => next);
    openParam(copy.key);
  };

  const remove = async () => {
    const key = search.key;
    if (!key) return;
    if (!await confirm({
      title: t("MODEL_DELETE"),
      message: t("MODEL_DELETE_PARAM_MSG", heading),
      actionText: t("MODEL_DELETE"),
      destructive: true,
    })) return;
    m.update((d) => deleteNode(d, { kind: "param", key }));
    leave.current = true;
    back();
  };

  const fields = useParamFields({ draft, tables: m.tableCols, p, set, tried, isNew });
  // ObjectPage counts its direct children to decide whether the anchor bar exists. A fragment is
  // one child, so the three sections are an array, which that count flattens.
  const sections = missing ? (
    <ObjectPageSection id="missing" titleText={heading} hideTitleText>
      <MessageStrip design="Negative" hideCloseButton>{t("MODEL_MISSING_PARAM")}</MessageStrip>
    </ObjectPageSection>
  ) : [
    <ObjectPageSection key="definition" id="definition" titleText={t("MODEL_DEFINITION")}>
      <ParamDefinition f={fields} />
    </ObjectPageSection>,
    <ObjectPageSection key="domain" id="domain" titleText={t("MODEL_DOMAIN")}>
      <ParamDomain f={fields} />
    </ObjectPageSection>,
    <ObjectPageSection key="behavior" id="behavior" titleText={t("MODEL_BEHAVIOR")}>
      <ParamBehavior f={fields} />
    </ObjectPageSection>,
  ];
  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <ObjectPage
        hidePinButton
        style={{ flex: 1, minHeight: 0, height: "100%" }}
        titleArea={
          <ObjectPageTitle
            breadcrumbs={
              <PageBreadcrumbs
                items={[
                  { text: t("NAV_MODELS"), to: "/models" },
                  {
                    text: modelName,
                    to: modelId ? `/models/${modelId}` : "/models/new",
                    search: { section: "params" },
                  },
                ]}
                current={heading}
              />
            }
            header={<Title level="H4">{heading}</Title>}
            actionsBar={!isNew && !missing ? (
              <Toolbar design="Transparent">
                <ToolbarButton icon="copy" design="Transparent" disabled={bufferDirty}
                  tooltip={bufferDirty ? t("MODEL_SAVE_FIRST") : t("MODEL_DUPLICATE_PARAM")}
                  text={t("MODEL_DUPLICATE")}
                  onClick={duplicate} />
                <ToolbarButton icon="delete" design="Transparent" text={t("MODEL_DELETE")}
                  tooltip={t("MODEL_DELETE")}
                  onClick={() => void remove()} />
              </Toolbar>
            ) : undefined}
          />
        }
        footerArea={missing ? undefined : (
          // ObjectPage asks for a Bar here, and FloatingFooter is the design that keeps it on the page.
          <Bar design="FloatingFooter" endContent={
            <>
              <Button design="Emphasized" disabled={!bufferDirty} onClick={save}>{t("MODEL_SAVE")}</Button>
              <Button onClick={() => void back()}>{t("MODEL_CANCEL")}</Button>
            </>
          } />
        )}
      >
        {sections}
      </ObjectPage>
    </div>
  );
}

function commitParam(d: ModelDef, p: Param, isNew: boolean, originalKey: string | undefined, place?: { s: number; g: number }): ModelDef {
  const parameters = isNew
    ? [...d.parameters, p]
    : d.parameters.map((x) => (x.key === originalKey || x.key === p.key ? p : x));
  const out = { ...d, parameters };
  return isNew && place ? placeParam(out, p.key, place.s, place.g) : out;
}
