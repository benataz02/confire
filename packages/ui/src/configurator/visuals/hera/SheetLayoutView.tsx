import { Text } from "@ui5/webcomponents-react";
import { sheetPieces, type SheetView } from "@confire/config-engine";
import { useUiI18n } from "../../../i18n.ts";

// Hera's sheet: the sheet, its usable area inside the margins, every piece (upright and rotated in
// two of the theme's chart colours) and the count. Drawn in the sheet's own millimetres.

export function SheetLayoutView({ view }: { view: unknown }) {
  const i18n = useUiI18n();
  const v = view as SheetView;
  const [L, W] = v.sheet;
  const [mx, my] = v.margin;
  // Stroke widths in sheet millimetres would vanish on a 3 m sheet: scaled to its size instead.
  const stroke = Math.max(L, W) / 400;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", inlineSize: "100%" }}>
      <svg viewBox={`${-stroke} ${-stroke} ${L + 2 * stroke} ${W + 2 * stroke}`} width="100%" role="img"
        aria-label={i18n.getText("UI_SHEET_CAPTION", String(v.count), String(v.used))}>
        <rect x={0} y={0} width={L} height={W}
          style={{ fill: "var(--sapGroup_ContentBackground)", stroke: "var(--sapGroup_ContentBorderColor)", strokeWidth: stroke }} />
        <rect x={mx} y={my} width={Math.max(0, L - 2 * mx)} height={Math.max(0, W - 2 * my)}
          style={{ fill: "none", stroke: "var(--sapContent_LabelColor)", strokeWidth: stroke, strokeDasharray: `${4 * stroke} ${3 * stroke}` }} />
        {sheetPieces(v).map((p, i) => (
          <rect key={i} x={p.x} y={p.y} width={p.w} height={p.h}
            style={{
              fill: p.rotated ? "var(--sapChart_OrderedColor_2)" : "var(--sapChart_OrderedColor_1)",
              stroke: "var(--sapGroup_ContentBorderColor)", strokeWidth: stroke / 2,
            }} />
        ))}
      </svg>
      <Text>{i18n.getText("UI_SHEET_CAPTION", String(v.count), String(v.used))}</Text>
    </div>
  );
}
