import { createContext, useContext } from "react";
import { Outlet, useBlocker } from "@tanstack/react-router";
import { BusyIndicator, MessageStrip } from "@ui5/webcomponents-react";
import type { ModelDef } from "@confire/config-engine";
import { confirm } from "@confire/ui/confirm.ts";
import { useI18n } from "../../i18n.ts";
import type { Translate } from "./builderMessages.ts";
import { sameModelPath } from "./paramRoute.ts";
import { useDraftModel } from "./useDraftModel.ts";

type DraftModel = ReturnType<typeof useDraftModel>;
type ReadyDraft = Omit<DraftModel, "draft"> & { draft: ModelDef };

const DraftContext = createContext<ReadyDraft | null>(null);

/** The model draft. Only rendered once `ModelDraftScope` has a definition, so `draft` is present. */
export function useModelDraft(): ReadyDraft {
  const value = useContext(DraftContext);
  if (!value) throw new Error("useModelDraft outside ModelDraftScope");
  return value;
}

/** Owns the unsaved model for the builder and the parameter page. The layout stays mounted, so
 *  opening a parameter does not drop the draft or ask to discard it. */
export function ModelDraftScope({ id }: { id?: string }) {
  const m = useDraftModel(id);
  const i18n = useI18n();
  const t: Translate = (key, ...params) => i18n.getText(key, ...params);

  // Switching models remounts this scope (`key={id}` on the route). Leaving the model — the list,
  // another model — still confirms. The parameter page is the same model, so it must not.
  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (sameModelPath(current.pathname, next.pathname)) return false;
      if (!m.dirty || m.saving) return false;
      return !(await confirm({
        title: t("MODEL_DISCARD_TITLE"),
        message: t("MODEL_DISCARD_MSG"),
        actionText: t("MODEL_DISCARD"),
        destructive: true,
      }));
    },
    enableBeforeUnload: () => m.dirty,
  });

  if (m.loading || !m.draft) {
    return m.loadError
      ? <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{m.loadError.message}</MessageStrip>
      : <BusyIndicator active delay={0} style={{ width: "100%", marginTop: "4rem" }} />;
  }

  const ready: ReadyDraft = { ...m, draft: m.draft };
  return (
    <DraftContext.Provider value={ready}>
      <Outlet />
    </DraftContext.Provider>
  );
}
