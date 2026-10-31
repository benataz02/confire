import { useLayoutEffect, useRef, useState } from "react";
import { Bar, Button, BusyIndicator, MessageStrip, Title, type ButtonDomRef } from "@ui5/webcomponents-react";
import { formState, propagate, type Entries, type ModelDef, type ResolvedLookups, type TableRows } from "@confire/config-engine";
import { configuratorForms } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { setEntry } from "@confire/ui/configurator/formHelpers.ts";
import { useI18n } from "../../i18n.ts";

const SLIDE: Keyframe[] = [{ transform: "translateX(100%)" }, { transform: "none" }];

/** The live preview: the model's form, sliding in over the Object Page's right half. The page opens it only
 *  while the form half of the model is valid, so it always draws the draft as it is. */
export function PreviewOverlay({ modelId, draft, lookups, lookupsError, onRetry, onClose }: {
  /** empty while the model itself is unsaved */
  modelId: string;
  draft: ModelDef;
  lookups?: ResolvedLookups;
  lookupsError: Error | null;
  onRetry: () => void;
  /** after the slide out; focus goes back to the opener, which is the caller's */
  onClose: () => void;
}) {
  const i18n = useI18n();
  const root = useRef<HTMLElement>(null);
  const closeButton = useRef<ButtonDomRef>(null);
  const [box, setBox] = useState<DOMRect>();
  const [entries, setEntries] = useState<Entries>({});
  const [tables, setTables] = useState<TableRows>({});
  const duration = matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;

  const close = () =>
    void root.current!.animate([...SLIDE].reverse(), { duration, easing: "ease-in", fill: "forwards" }).finished.then(onClose);

  // Over the page and nothing else, so the ShellBar and the side nav stay in reach. ObjectPage has no
  // slot for an overlay: this is its sibling in the shell's content slot, fixed at its box, which a
  // side nav collapsing or a resized window moves. Escape is left alone: UI5's Select and ComboBox let
  // the Escape that closes their list bubble on, and it would close the preview with it.
  // A press anywhere else closes it, as a Popover's light dismiss. The composed path, not the target:
  // a UI5 control's list opens in its own shadow root, which is still inside this section. Pointerdown,
  // not click: the click that opened the preview is still bubbling when this effect runs.
  useLayoutEffect(() => {
    const el = root.current!;
    const page = el.parentElement?.querySelector<HTMLElement>(':scope > [data-component-name="ObjectPage"]');
    const ro = new ResizeObserver(() => page && setBox(page.getBoundingClientRect()));
    if (page) {
      setBox(page.getBoundingClientRect());
      ro.observe(page);
    }
    const outside = (e: PointerEvent) => { if (!e.composedPath().includes(el)) close(); };
    document.addEventListener("pointerdown", outside);
    el.animate(SLIDE, { duration, easing: "ease-out" });
    closeButton.current?.focus();
    return () => { ro.disconnect(); document.removeEventListener("pointerdown", outside); };
  }, []);

  // The one place the engine still runs in the browser: an unsaved model has no row on the server,
  // and nothing previewed here is stored or quoted. Same form state the server builds, so the form
  // has one input shape. ponytail: a value picked off a query field's first page binds no derived
  // columns here (the server binds them from the stored entry); a preview has none stored.
  const form = lookups ? formState(draft, lookups, propagate(draft, lookups, entries, tables), tables) : null;

  return (
    <section ref={root} aria-label={i18n.getText("MODEL_PREVIEW")} style={{
      // Half the page, its full height. The viewport's half only if the page could not be found, which
      // leaves the ShellBar its own z-index above.
      position: "fixed", inset: "0 0 0 50%", zIndex: 1,
      ...(box ? { top: box.top, left: box.left + box.width / 2, width: box.width / 2, height: box.height } : {}),
      display: "flex", flexDirection: "column",
      background: "var(--sapBackgroundColor)", boxShadow: "var(--sapContent_Shadow2)",
    }}>
      <Bar startContent={<Title level="H4">{i18n.getText("MODEL_PREVIEW")}</Title>}
        endContent={
          <Button ref={closeButton} icon="decline" design="Transparent" tooltip={i18n.getText("ADMIN_CLOSE")}
            accessibleName={i18n.getText("ADMIN_CLOSE")} onClick={close} />
        } />
      <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "1rem", display: "flex", flexDirection: "column", gap: "0.75rem" }}>
        {lookupsError ? (
          <>
            <MessageStrip design="Negative" hideCloseButton>{lookupsError.message}</MessageStrip>
            <Button icon="refresh" style={{ alignSelf: "flex-start" }} onClick={onRetry}>{i18n.getText("MODEL_RETRY_OPTIONS")}</Button>
          </>
        ) : null}
        {/* Forms only: the configuration page's anchor bar is its ObjectPage, and this preview has none. */}
        {lookups && form ? configuratorForms({
          model: draft, form, tables: lookups.tables, formulaOverride: true,
          onChange: (key, v) => setEntries((e) => setEntry(e, key, v)),
          querySource: { modelId },
          rows: tables, onRowsChange: (key, rows) => setTables((cur) => ({ ...cur, [key]: rows })),
        }) : lookupsError ? null : <BusyIndicator active delay={0} />}
      </div>
    </section>
  );
}
