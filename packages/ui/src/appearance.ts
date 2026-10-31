import { useEffect, useState } from "react";
import { setTheme as applyTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";
import { boot } from "@ui5/webcomponents-base/dist/Boot.js";

// Theme and content density, remembered per browser — the user menu of both apps offers them.

export const THEMES = [
  { id: "sap_horizon", label: "Morning Horizon" },
  { id: "sap_horizon_dark", label: "Evening Horizon" },
  { id: "sap_horizon_hcb", label: "Horizon High Contrast Black" },
  { id: "sap_horizon_hcw", label: "Horizon High Contrast White" },
  { id: "sap_horizon_auto", label: "Horizon Auto" },
  { id: "sap_horizon_hc_auto", label: "Horizon High Contrast Auto" },
  { id: "sap_fiori_3", label: "Quartz Light" },
  { id: "sap_fiori_3_dark", label: "Quartz Dark" },
  { id: "sap_fiori_3_hcb", label: "Quartz High Contrast Black" },
  { id: "sap_fiori_3_hcw", label: "Quartz High Contrast White" },
] as const;

export type Density = "cozy" | "compact";

/** The theme the user picked in a user menu, else Horizon Auto: Morning or Evening by the OS, as
 *  confire.ai. Nothing is stored until someone picks, so the OS keeps deciding for whoever never did. */
const storedTheme = () => localStorage.getItem("theme") ?? "sap_horizon_auto";

/** Each SPA awaits it before its first render. UI5 always boots in Morning: the bundle runs UI5's
 *  shared chunks, whose components boot it, before main.tsx's own imports register the other
 *  themes — and UI5 drops a theme registered mid-boot. So the theme is set once UI5 has booted, and
 *  nothing is drawn until it is in: the first frame is already Evening on a dark OS. */
export async function applyStoredTheme() {
  await boot();
  await applyTheme(storedTheme());
}

const bodyDensity = (): Density =>
  document.body.classList.contains("ui5-content-density-compact") ? "compact" : "cozy";

export function useAppearance() {
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem("density") as Density) ?? bodyDensity());
  const [theme, setThemeState] = useState(storedTheme);

  useEffect(() => {
    document.body.classList.toggle("ui5-content-density-compact", density === "compact");
    document.body.classList.toggle("ui5-content-density-cozy", density !== "compact");
    localStorage.setItem("density", density);
  }, [density]);

  const setTheme = (id: string) => {
    localStorage.setItem("theme", id);
    setThemeState(id);
    void applyTheme(id);
  };

  return { theme, setTheme, density, setDensity };
}
