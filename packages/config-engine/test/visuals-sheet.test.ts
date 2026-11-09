import { describe, expect, test } from "bun:test";
import { nest, sheetLayout, sheetPieces, type SheetInputs } from "../src/visuals/hera/sheetLayout.ts";

const laser: SheetInputs = { sheetLength: 1000, sheetWidth: 500, pieceLength: 120, pieceWidth: 70, gapX: 3, gapY: 3, marginX: 10, marginY: 10 };
const punz: SheetInputs = { ...laser, gapX: 5, gapY: 12, marginX: 45, marginY: 50 };

/** Every piece inside the margins; any two pieces apart by at least gapX along X or gapY along Y. */
function assertValid(i: SheetInputs) {
  const v = nest(i)!;
  const ps = sheetPieces(v);
  expect(ps.length).toBe(v.count);
  const e = 1e-6;
  for (const p of ps) {
    expect(p.x).toBeGreaterThanOrEqual(i.marginX - e);
    expect(p.y).toBeGreaterThanOrEqual(i.marginY - e);
    expect(p.x + p.w).toBeLessThanOrEqual(i.sheetLength - i.marginX + e);
    expect(p.y + p.h).toBeLessThanOrEqual(i.sheetWidth - i.marginY + e);
  }
  for (let a = 0; a < ps.length; a++) for (let b = a + 1; b < ps.length; b++) {
    const p = ps[a]!, q = ps[b]!;
    const apartX = p.x + p.w + i.gapX <= q.x + e || q.x + q.w + i.gapX <= p.x + e;
    const apartY = p.y + p.h + i.gapY <= q.y + e || q.y + q.h + i.gapY <= p.y + e;
    expect(apartX || apartY).toBe(true);
  }
}

describe("hera sheet layout", () => {
  test("mixes orientations: 48 on the laser reference (42 all one way)", () => {
    expect(nest(laser)!.count).toBe(48);
    expect(nest(laser)!.used).toBe(81);
    assertValid(laser);
  });
  test("punzonado esq. redondeadas reference: 36", () => {
    expect(nest(punz)!.count).toBe(36);
    assertValid(punz);
  });
  test("decimal millimetres keep a valid layout", () => assertValid({ ...laser, pieceLength: 120.5, pieceWidth: 70.25 }));
  test("an exact fit counts its last piece", () => {
    expect(nest({ sheetLength: 100, sheetWidth: 50, pieceLength: 50, pieceWidth: 25, gapX: 0, gapY: 0, marginX: 0, marginY: 0 })!.count).toBe(4);
  });
  test("a piece bigger than the usable sheet is 0 pieces, not undecided", () => {
    const v = nest({ ...laser, pieceLength: 2000 })!;
    expect(v.count).toBe(0);
    expect(v.blocks).toEqual([]);
  });
  test("nonsense inputs are undecided", () => {
    expect(nest({ ...laser, pieceLength: 0 })).toBeUndefined();
    expect(nest({ ...laser, gapX: -1 })).toBeUndefined();
    expect(nest({ ...laser, sheetWidth: Number.NaN })).toBeUndefined();
  });
  test("big sheets stay within 50 ms", () => {
    const big: SheetInputs = { sheetLength: 3000, sheetWidth: 1500, pieceLength: 40, pieceWidth: 6, gapX: 3, gapY: 3, marginX: 10, marginY: 10 };
    nest(big); // warm the JIT
    const t = performance.now();
    expect(nest(big)!.count).toBeGreaterThanOrEqual(11428);
    expect(performance.now() - t).toBeLessThan(50);
    expect(nest({ ...big, pieceLength: 37, pieceWidth: 23 })!.count).toBeGreaterThanOrEqual(4249);
  });
  test("compute: outputs and view from one run; non-numbers undecided", () => {
    const r = sheetLayout.compute({ ...laser })!;
    expect(r.outputs).toEqual({ piezas: 48, aprovechamiento: 81 });
    expect((r.view as { count: number }).count).toBe(48);
    expect(sheetLayout.compute({ ...laser, pieceLength: "120" })).toBeUndefined();
  });
});
