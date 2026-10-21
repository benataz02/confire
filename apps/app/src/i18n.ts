import { messageBundle } from "@confire/ui/i18n.ts";

// The staff app's texts: i18n/messagebundle_<locale>.properties, English the base (@confire/ui/i18n.ts).
export const useI18n = messageBundle("@confire/app",
  import.meta.glob<string>("./i18n/messagebundle_*.properties", { query: "?raw", import: "default" }));
