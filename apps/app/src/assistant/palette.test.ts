import { expect, test } from "bun:test";
import { paletteFor, paletteVars, type Palette } from "./palette.ts";

// Joule's colours (Joule spec §3) in Horizon and Horizon Dark; every other theme keeps its own.

test("Horizon is Joule's light, Horizon Dark its dark, Horizon Auto follows the OS", () => {
  expect(paletteFor("sap_horizon", true)).toBe("light");
  expect(paletteFor("sap_horizon_dark", false)).toBe("dark");
  expect(paletteFor("sap_horizon_auto", false)).toBe("light");
  expect(paletteFor("sap_horizon_auto", true)).toBe("dark");
});
test("high contrast and Quartz keep the theme's own parameters", () => {
  for (const th of ["sap_horizon_hcb", "sap_horizon_hcw", "sap_horizon_hc_auto", "sap_fiori_3", "sap_fiori_3_dark"]) expect(paletteFor(th, true)).toBeNull();
});
test("every palette sets the same properties; Joule's values are SAP for Me's", () => {
  const keys = (p: Palette) => Object.keys(paletteVars(p)).sort();
  expect(keys("light")).toEqual(keys("dark"));
  expect(keys(null)).toEqual(keys("dark"));
  expect(keys("dark")).toHaveLength(18);
  expect(paletteVars("dark")).toMatchObject({ "--cf-a-head": "#140069", "--cf-a-question": "#12171c", "--cf-a-accent": "#4db1ff", "--cf-a-send": "#0070f2" });
  expect(paletteVars("light")).toMatchObject({ "--cf-a-head": "#f4f2ff", "--cf-a-question": "#eae5ff", "--cf-a-accent": "#5d36ff", "--cf-a-send-empty": "#beafff" });
});
