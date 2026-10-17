import { useEffect, useState } from "react";
import { getTheme, setTheme as applyTheme } from "@ui5/webcomponents-base/dist/config/Theme.js";

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

const bodyDensity = (): Density =>
  document.body.classList.contains("ui5-content-density-compact") ? "compact" : "cozy";

export function useAppearance() {
  const [density, setDensity] = useState<Density>(() => (localStorage.getItem("density") as Density) ?? bodyDensity());
  const [theme, setTheme] = useState<string>(() => localStorage.getItem("theme") ?? getTheme());

  useEffect(() => {
    document.body.classList.toggle("ui5-content-density-compact", density === "compact");
    document.body.classList.toggle("ui5-content-density-cozy", density !== "compact");
    localStorage.setItem("density", density);
  }, [density]);

  useEffect(() => {
    applyTheme(theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  return { theme, setTheme, density, setDensity };
}
