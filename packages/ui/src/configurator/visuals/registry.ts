import { lazy, type ComponentType, type LazyExoticComponent } from "react";

// The drawing half of each tenant visual, by the kind its calculation (config-engine's VISUALS)
// declares — registry.test.ts keeps the two lists equal. Each drawing loads only where a model places
// it, so one tenant's picture (or a future 3D one) costs nobody else a download. No UI5 import here:
// the test runs without a browser.

type Drawing = LazyExoticComponent<ComponentType<{ view: unknown }>>;

export const VISUAL_VIEWS: Record<string, Drawing> = {
  "hera.sheetLayout": lazy(() => import("./hera/SheetLayoutView.tsx").then((m) => ({ default: m.SheetLayoutView }))),
};
