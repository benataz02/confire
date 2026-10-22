import { ROLE_LABEL } from "@confire/ui/portal/CompanyPeople.tsx";
import { PROJECT_STATUS } from "@confire/ui/timeline/projectStatus.ts";

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

/** Client-facing project status. The colour stays `PROJECT_STATUS[s].state`. */
export const PROJECT_STATUS_KEY: Record<keyof typeof PROJECT_STATUS, string> = {
  draft: "PORTAL_STATUS_DRAFT",
  submitted: "PORTAL_STATUS_SUBMITTED",
  in_review: "PORTAL_STATUS_IN_REVIEW",
  returned: "PORTAL_STATUS_RETURNED",
  declined: "PORTAL_STATUS_DECLINED",
  quoted: "PORTAL_STATUS_QUOTED",
};
