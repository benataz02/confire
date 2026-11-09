import { useId } from "react";
import { Text } from "@ui5/webcomponents-react";
import { sheetTiles, type SheetView } from "@confire/config-engine";
import { useUiI18n } from "../../../i18n.ts";

// Hera's sheet: the sheet, its usable area inside the margins, its pieces (upright and rotated in two
// of the theme's chart colours) and the count. Drawn in the sheet's own millimetres. Each block of
// identical pieces is one rectangle filled with a pattern of one cell (piece + gap), so the page holds
// a few shapes however many pieces fit — small pieces on a big sheet run to tens of thousands.

export function SheetLayoutView({ view }: { view: unknown }) {
  const i18n = useUiI18n();
  // A pattern is referenced by id: one set per drawing, and url(#…) takes no punctuation React adds.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const v = view as SheetView;
  const [L, W] = v.sheet;
  const [mx, my] = v.margin;
  // Stroke widths in sheet millimetres would vanish on a 3 m sheet: scaled to its size instead.
  const stroke = Math.max(L, W) / 400;
  const tiles = sheetTiles(v);
  const caption = i18n.getText("UI_SHEET_CAPTION", String(v.count), String(v.used));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.25rem", inlineSize: "100%" }}>
      <svg viewBox={`${-stroke} ${-stroke} ${L + 2 * stroke} ${W + 2 * stroke}`} width="100%" role="img" aria-label={caption}>
        <defs>
          {tiles.map((t, i) => (
            // userSpaceOnUse anchored at the tile's corner: the pattern's cells line up with its pieces.
            <pattern key={i} id={`${uid}-${i}`} patternUnits="userSpaceOnUse" x={t.x} y={t.y} width={t.cellW} height={t.cellH}>
              <rect x={0} y={0} width={t.pieceW} height={t.pieceH}
                style={{
                  fill: t.rotated ? "var(--sapChart_OrderedColor_2)" : "var(--sapChart_OrderedColor_1)",
                  stroke: "var(--sapGroup_ContentBorderColor)", strokeWidth: stroke / 2,
                }} />
            </pattern>
          ))}
        </defs>
        <rect x={0} y={0} width={L} height={W}
          style={{ fill: "var(--sapGroup_ContentBackground)", stroke: "var(--sapGroup_ContentBorderColor)", strokeWidth: stroke }} />
        <rect x={mx} y={my} width={Math.max(0, L - 2 * mx)} height={Math.max(0, W - 2 * my)}
          style={{ fill: "none", stroke: "var(--sapContent_LabelColor)", strokeWidth: stroke, strokeDasharray: `${4 * stroke} ${3 * stroke}` }} />
        {tiles.map((t, i) => <rect key={i} x={t.x} y={t.y} width={t.width} height={t.height} fill={`url(#${uid}-${i})`} />)}
      </svg>
      <Text>{caption}</Text>
    </div>
  );
}
