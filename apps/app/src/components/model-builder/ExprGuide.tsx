import { useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Icon, List, ListItemCustom, Popover, Text, type IconDomRef,
} from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";
import { FUNC_GUIDE, OP_GUIDE } from "./exprGuide.ts";

// Zero the popover padding so the lists sit flush, and cap the host so a field near the
// bottom of the page still scrolls to the last operator instead of losing it off-screen.
if (typeof document !== "undefined" && !document.getElementById("confire-expr-guide-style")) {
  const el = document.createElement("style");
  el.id = "confire-expr-guide-style";
  el.textContent = ".confire-expr-guide{max-height:min(26rem, calc(100vh - 1rem));}"
    + ".confire-expr-guide::part(content){padding:0;overflow:auto;}"
    + ".confire-expr-guide ui5-li-custom::part(content){align-items:flex-start;white-space:normal;}";
  document.head.appendChild(el);
}

const MONO = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" } as const;
const MUTED = { color: "var(--sapContent_LabelColor)" } as const;

/** The guide, opened from an icon the caller places inside the field. A sibling button would
 *  shrink the input, which a grid cell feels as a narrower column. */
export function ExprHelp({ children }: { children: (icon: ReactElement) => ReactNode }) {
  const i18n = useI18n();
  const t = (key: string) => i18n.getText(key);
  const icon = useRef<IconDomRef>(null);
  const [open, setOpen] = useState(false);
  const title = t("MODEL_EXPR_GUIDE");

  return (
    <div style={{ position: "relative", width: "100%" }}>
      {children(
        <Icon ref={icon} name="sys-help" mode="Interactive" design="Neutral" showTooltip
          accessibleName={title} data-expr-guide
          onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }} />,
      )}
      <Popover className="confire-expr-guide" headerText={title} placement="Bottom" horizontalAlign="End"
        opener={icon.current ?? undefined} open={open && !!icon.current} onClose={() => setOpen(false)}>
        <div style={{ width: "min(30rem, 80vw)" }}>
          <Text style={{ display: "block", padding: "0.75rem 1rem", ...MUTED }}>{t("MODEL_EXPR_GUIDE_LEAD")}</Text>
          <List headerText={t("MODEL_EXPR_GUIDE_FUNCS")} separators="Inner">
            {FUNC_GUIDE.map((f) => (
              <ListItemCustom key={f.name} type="Inactive">
                <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem", paddingBlock: "0.25rem" }}>
                  <span style={MONO}>{f.sig}</span>
                  <span>{t(f.meaning)}</span>
                  <span style={{ ...MONO, ...MUTED }}>{f.example}</span>
                </div>
              </ListItemCustom>
            ))}
          </List>
          <List headerText={t("MODEL_EXPR_GUIDE_OPS")} separators="Inner">
            {OP_GUIDE.map((o) => (
              <ListItemCustom key={o.meaning} type="Inactive">
                <div style={{ display: "flex", flexDirection: "column", gap: "0.125rem", paddingBlock: "0.25rem" }}>
                  <span style={MONO}>{o.symbols}</span>
                  <span style={MUTED}>{t(o.meaning)}</span>
                </div>
              </ListItemCustom>
            ))}
          </List>
        </div>
      </Popover>
    </div>
  );
}
