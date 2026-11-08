import { ROLE_LABEL } from "@confire/ui/portal/CompanyPeople.tsx";

/** `I18nBundle.getText`. Call it as `i18n.getText.bind(i18n)` — the method reads `this`. */
export type TextFn = (key: string, ...params: Array<string | number>) => string;

/** Portal role names. `CompanyPeople` still draws its own copy from `ROLE_LABEL`. */
export const ROLE_KEY: Record<keyof typeof ROLE_LABEL, string> = {
  owner: "PORTAL_ROLE_OWNER",
  buyer: "PORTAL_ROLE_BUYER",
  viewer: "PORTAL_ROLE_VIEWER",
};

export const ROLE_HELP_KEY: Record<keyof typeof ROLE_LABEL, string> = {
  owner: "PORTAL_ROLE_HELP_OWNER",
  buyer: "PORTAL_ROLE_HELP_BUYER",
  viewer: "PORTAL_ROLE_HELP_VIEWER",
};
