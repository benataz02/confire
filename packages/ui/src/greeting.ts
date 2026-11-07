import { firstName, formatLocale } from "./format.ts";
import { useUiI18n } from "./i18n.ts";

/** Both homes' title: "Good morning, Ana" by the hour, and today ("Friday, 6 November"). */
export function useGreeting(user?: Parameters<typeof firstName>[0]) {
  const i18n = useUiI18n();
  const now = new Date();
  const hour = now.getHours();
  const key = hour < 12 ? "UI_GREETING_MORNING" : hour < 18 ? "UI_GREETING_AFTERNOON" : "UI_GREETING_EVENING";
  return {
    greeting: i18n.getText(key, firstName(user)),
    today: now.toLocaleDateString(formatLocale(), { weekday: "long", day: "numeric", month: "long" }),
  };
}
