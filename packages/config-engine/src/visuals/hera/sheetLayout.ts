import type { Val } from "../../model.ts";
import type { VisualCalc } from "../types.ts";

// Hera (ALUMIGRAF): how many identical rectangular pieces fit on a sheet, each free to sit upright or
// turned 90°, mixed in one layout. Gap X/Y separate neighbours along the sheet's own axes whichever
// way a piece faces; margin X is kept at both ends of the length, margin Y at both sides of the width.
// Spec: docs/superpowers/specs/2026-11-09-tenant-visuals-design.md.

export type SheetInputs = {
  sheetLength: number; sheetWidth: number; pieceLength: number; pieceWidth: number;
  gapX: number; gapY: number; marginX: number; marginY: number;
};

/** `columns` × `rows` identical pieces from (`x`, `y`), in mm from the sheet's top-left corner. */
export type SheetBlock = { x: number; y: number; columns: number; rows: number; rotated: boolean };

/** A guillotine layout is a few blocks of identical pieces, so this stays small however many pieces
 *  fit. `piece` is [length, width] as given: a rotated block's pieces lie [width, length]. */
export type SheetView = {
  sheet: [number, number]; margin: [number, number]; piece: [number, number]; gap: [number, number];
  blocks: SheetBlock[];
  count: number;
  /** pieces' area ÷ the whole sheet's (margins included), in whole percent */
  used: number;
};

const EPS = 1e-9;
/** Sums one pass may enumerate into its raster before the search is judged too big. */
const RASTER_CAP = 150_000;
/** Raster points × strip heights over both passes: what fits the spec's 50 ms per calculation. */
const STEP_BUDGET = 5_000_000;
/** Floor that keeps a decimal exact fit (0.3 / 0.1) from losing its last piece to float error. */
const fl = (v: number) => Math.floor(v + EPS);

/** Sorted distinct sums i·s1 + j·s2 ≤ max, 0 included: every place a strip can end. */
function raster(max: number, s1: number, s2: number): Float64Array {
  const seen = new Set<number>();
  for (let i = 0; i * s1 <= max + EPS; i++)
    for (let j = 0; i * s1 + j * s2 <= max + EPS; j++) seen.add(Math.round((i * s1 + j * s2) * 1e6) / 1e6);
  return Float64Array.from(seen).sort();
}

type Strip = { h: number; upright: number; value: number };

/**
 * The best stack of strips along Y, each spanning X: a strip of height h holds `upright` columns of
 * upright cells (a × b), then as many columns of rotated cells (c × d) as the rest of X takes, each
 * column stacking ⌊h/b⌋ or ⌊h/d⌋ cells. Cells are inflated by the gaps (see `nest`). Returns the
 * strips chosen, bottom-up, and their piece count.
 */
function stripStack(X: number, Y: number, a: number, b: number, c: number, d: number, R: Float64Array): { strips: Strip[]; count: number } {
  const heights = new Set<number>();
  for (let k = 1; k * b <= Y + EPS; k++) heights.add(Math.round(k * b * 1e6) / 1e6);
  for (let k = 1; k * d <= Y + EPS; k++) heights.add(Math.round(k * d * 1e6) / 1e6);
  const strips: Strip[] = [...heights].sort((p, q) => p - q).map((h) => {
    const ub = fl(h / b), rd = fl(h / d);
    let best = { h, upright: 0, value: -1 };
    for (let i = 0; i * a <= X + EPS; i++) {
      const value = i * ub + fl((X - i * a) / c) * rd;
      if (value > best.value) best = { h, upright: i, value };
    }
    return best;
  });

  // g[j]: most pieces in a stack no taller than R[j] (R = raster(Y, b, d)). Each strip keeps a pointer
  // to ⌊R[j] − h⌋, which only moves forward as j grows — no search per step.
  const g = new Int32Array(R.length);
  const choice = new Int32Array(R.length).fill(-1);
  const prev = new Int32Array(R.length);
  const ptr = new Int32Array(strips.length);
  for (let j = 1; j < R.length; j++) {
    const r = R[j]!;
    for (let s = 0; s < strips.length; s++) {
      const st = strips[s]!;
      if (st.h > r + EPS) break;
      let p = ptr[s]!;
      while (p + 1 < R.length && R[p + 1]! <= r - st.h + EPS) p++;
      ptr[s] = p;
      const v = st.value + g[p]!;
      if (v > g[j]!) { g[j] = v; choice[j] = s; prev[j] = p; }
    }
  }
  const chosen: Strip[] = [];
  for (let j = R.length - 1; j > 0 && choice[j]! >= 0; j = prev[j]!) chosen.push(strips[choice[j]!]!);
  return { strips: chosen, count: g[R.length - 1] ?? 0 };
}

/** The layout's blocks from its strips, in inflated coordinates along the run's own axes. */
function blocksOf(strips: Strip[], X: number, a: number, b: number, c: number, d: number): SheetBlock[] {
  const out: SheetBlock[] = [];
  let y = 0;
  for (const s of strips) {
    const rest = fl((X - s.upright * a) / c);
    out.push({ x: 0, y, columns: s.upright, rows: fl(s.h / b), rotated: false });
    out.push({ x: s.upright * a, y, columns: rest, rows: fl(s.h / d), rotated: true });
    y += s.h;
  }
  return out.filter((k) => k.columns > 0 && k.rows > 0);
}

/**
 * Most pieces per sheet over guillotine layouts, mixing orientations. Undefined for inputs that make
 * no sense; a piece that does not fit is a decided 0.
 *
 * Every gap is folded into the cells: a piece takes its own size plus the gap after it along each
 * axis, and the usable sheet gains one gap, so n pieces fit wherever n·(piece + gap) ≤ usable + gap.
 * The search is three-stage — strips, then columns, then stacked pieces — tried with strips along
 * either axis.
 * ponytail: three-stage guillotine — matched the full guillotine search on both reference cases and
 * 300 random sheets in the planning probe; a deeper search only if a real quote shows a gap.
 */
export function nest(i: SheetInputs): SheetView | undefined {
  const vals = Object.values(i);
  if (vals.some((v) => typeof v !== "number" || !Number.isFinite(v))) return undefined;
  if (i.sheetLength <= 0 || i.sheetWidth <= 0 || i.pieceLength <= 0 || i.pieceWidth <= 0) return undefined;
  if (i.gapX < 0 || i.gapY < 0 || i.marginX < 0 || i.marginY < 0) return undefined;

  const view = (blocks: SheetBlock[]): SheetView => {
    const count = blocks.reduce((n, k) => n + k.columns * k.rows, 0);
    return {
      sheet: [i.sheetLength, i.sheetWidth], margin: [i.marginX, i.marginY],
      piece: [i.pieceLength, i.pieceWidth], gap: [i.gapX, i.gapY],
      blocks, count,
      used: Math.round((count * i.pieceLength * i.pieceWidth * 100) / (i.sheetLength * i.sheetWidth)),
    };
  };
  const X = i.sheetLength - 2 * i.marginX + i.gapX;
  const Y = i.sheetWidth - 2 * i.marginY + i.gapY;
  if (X <= 0 || Y <= 0) return view([]);
  const a = i.pieceLength + i.gapX, b = i.pieceWidth + i.gapY; // upright cell
  const c = i.pieceWidth + i.gapX, d = i.pieceLength + i.gapY; // rotated cell
  const place = (k: SheetBlock): SheetBlock => ({ ...k, x: k.x + i.marginX, y: k.y + i.marginY });

  // The search costs about (raster points × strip heights) per pass, and it runs on the server inside
  // every calculation: small decimal pieces on a big sheet (distinct sums everywhere) would take
  // seconds. So the budget is checked before it starts — enumerating the raster first only while that
  // is cheap — and past it the best uniform layout stands in: still valid, and with that many pieces
  // rarely far off. Integer pieces of 6 mm on a 3000×1500 sheet still run the search (≈1.4M steps).
  // ponytail: uniform fallback past the budget; a coarser raster (strip heights rounded up) if a real
  // quote ever needs mixing there.
  const heights = (span: number, s1: number, s2: number) => fl(span / s1) + fl(span / s2);
  const sums = (span: number, s1: number, s2: number) => (fl(span / s1) + 1) * (fl(span / s2) + 1);
  const rasters = sums(Y, b, d) <= RASTER_CAP && sums(X, a, c) <= RASTER_CAP
    ? [raster(Y, b, d), raster(X, a, c)] as const : undefined;
  if (!rasters || rasters[0].length * heights(Y, b, d) + rasters[1].length * heights(X, a, c) > STEP_BUDGET) {
    const up = fl(X / a) * fl(Y / b), rot = fl(X / c) * fl(Y / d);
    const k: SheetBlock = up >= rot
      ? { x: 0, y: 0, columns: fl(X / a), rows: fl(Y / b), rotated: false }
      : { x: 0, y: 0, columns: fl(X / c), rows: fl(Y / d), rotated: true };
    return view(k.columns > 0 && k.rows > 0 ? [place(k)] : []);
  }

  const along = stripStack(X, Y, a, b, c, d, rasters[0]);
  // The same search with the axes swapped: strips stacked along X. In that run the upright cell is
  // (b, a) and the rotated one (d, c); a block found at (u, v), p × q, is (v, u), q × p on the sheet.
  const across = stripStack(Y, X, b, a, d, c, rasters[1]);
  const blocks = along.count >= across.count
    ? blocksOf(along.strips, X, a, b, c, d)
    : blocksOf(across.strips, Y, b, a, d, c).map((k) => ({ x: k.y, y: k.x, columns: k.rows, rows: k.columns, rotated: k.rotated }));
  return view(blocks.map(place));
}

/** Every piece of a layout as a rectangle in mm — for the drawing, and for checking a layout. */
export function sheetPieces(v: SheetView): { x: number; y: number; w: number; h: number; rotated: boolean }[] {
  const out: { x: number; y: number; w: number; h: number; rotated: boolean }[] = [];
  for (const k of v.blocks) {
    const [w, h] = k.rotated ? [v.piece[1], v.piece[0]] : v.piece;
    for (let col = 0; col < k.columns; col++)
      for (let row = 0; row < k.rows; row++)
        out.push({ x: k.x + col * (w + v.gap[0]), y: k.y + row * (h + v.gap[1]), w, h, rotated: k.rotated });
  }
  return out;
}

/** One drawable tile per block: its outline, and the cell its piece repeats in (piece + gap) — so a
 *  drawing fills each tile with one repeating pattern and costs a shape per block, not per piece. */
export type SheetTile = {
  x: number; y: number; width: number; height: number;
  cellW: number; cellH: number; pieceW: number; pieceH: number;
  columns: number; rows: number; rotated: boolean;
};

export function sheetTiles(v: SheetView): SheetTile[] {
  return v.blocks.map((k) => {
    const [pieceW, pieceH] = k.rotated ? [v.piece[1], v.piece[0]] : v.piece;
    const cellW = pieceW + v.gap[0], cellH = pieceH + v.gap[1];
    return {
      x: k.x, y: k.y, width: k.columns * cellW - v.gap[0], height: k.rows * cellH - v.gap[1],
      cellW, cellH, pieceW, pieceH, columns: k.columns, rows: k.rows, rotated: k.rotated,
    };
  });
}

const mm = (label: string) => ({ type: "number" as const, label });

export const sheetLayout: VisualCalc = {
  kind: "hera.sheetLayout",
  tenants: ["hera"],
  label: "Piezas en formato",
  inputs: {
    sheetLength: mm("Largo formato"), sheetWidth: mm("Ancho formato"),
    pieceLength: mm("Largo pieza"), pieceWidth: mm("Ancho pieza"),
    gapX: mm("Paso X"), gapY: mm("Paso Y"),
    marginX: mm("Margen X"), marginY: mm("Margen Y"),
  },
  outputs: {
    piezas: { type: "number", label: "Piezas por formato" },
    aprovechamiento: { type: "number", label: "Aprovechamiento (%)" },
  },
  compute: (inputs: Record<string, Val>) => {
    const keys = ["sheetLength", "sheetWidth", "pieceLength", "pieceWidth", "gapX", "gapY", "marginX", "marginY"] as const;
    if (keys.some((k) => typeof inputs[k] !== "number")) return undefined;
    const v = nest(Object.fromEntries(keys.map((k) => [k, inputs[k]])) as SheetInputs);
    return v && { outputs: { piezas: v.count, aprovechamiento: v.used }, view: v };
  },
};
