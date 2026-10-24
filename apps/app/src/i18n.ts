import { messageBundle, textsLoaded } from "@confire/ui/i18n.ts";

// The staff app's texts, English the base (@confire/ui/i18n.ts). `messagebundle_<locale>.properties`
// plus `parts/<area>.<locale>.properties` merge into one bundle. The shared shells register beside it.
export const useI18n = messageBundle("@confire/app",
  import.meta.glob<string>("./i18n/**/*.properties", { query: "?raw", import: "default" }));
messageBundle("@confire/ui",
  import.meta.glob<string>("../../../packages/ui/src/i18n/**/*.properties", { query: "?raw", import: "default" }));
await textsLoaded(); // main.tsx imports this first: the first render already has its texts
