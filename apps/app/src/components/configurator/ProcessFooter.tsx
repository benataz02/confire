import { Bar, BusyIndicator, Button, Text } from "@ui5/webcomponents-react";
import type { FormState } from "@confire/config-engine";
import { ConsistencyStatus } from "@confire/ui/configurator/ConfiguratorForm.tsx";
import { money } from "@confire/ui/money.ts";
import { useCurrency } from "../../orpc.ts";
import { useI18n } from "../../i18n.ts";

/** The process page's floating footer: the finalizing action (Create quote, the only Emphasized
 *  one on the page — the Fiori rule) and a request's decisions, beside the consistency, the busy
 *  marker and the picks' total. */
export function ProcessFooter({ shown, onGone, form, busy, selectedTotal, quote, decide }: {
  /** confire-footer-in/-out (global.css): rises in while shown, drops out — then `onGone` unmounts it */
  shown: boolean;
  onGone: () => void;
  form?: Pick<FormState, "conflicts" | "open">;
  /** a call is out or a commit is pending: the figures are the last answer's */
  busy: boolean;
  /** what the picked cells price at; null with nothing picked */
  selectedTotal: number | null;
  quote: null | { text: string; disabled: boolean; tooltip?: string; onClick: () => void };
  /** a request's decisions; null on an internal configuration */
  decide: null | {
    canAccept: boolean; disabled: boolean; unsaved: boolean;
    onAccept: () => void; onSendBack: () => void; onDecline: () => void;
  };
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  const currency = useCurrency();
  return (
    <Bar design="FloatingFooter" className={shown ? "confire-footer-in" : "confire-footer-out"}
      onAnimationEnd={(e) => { if (e.animationName === "confire-footer-out") onGone(); }}
      startContent={
        <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
          {form ? <ConsistencyStatus form={form} /> : null}
          {busy ? <BusyIndicator active delay={0} size="S" /> : null}
          {selectedTotal !== null ? <Text>{t("CONFIG_SELECTED", money(selectedTotal, currency))}</Text> : null}
        </div>
      }
      endContent={
        <>
          {/* A request takes it once accepted (in review); until then Accept is the positive action. */}
          {quote ? (
            <Button design="Emphasized" disabled={quote.disabled} tooltip={quote.tooltip} onClick={quote.onClick}>{quote.text}</Button>
          ) : null}
          {decide?.canAccept ? (
            <Button design="Positive" disabled={decide.disabled} onClick={decide.onAccept}>{t("CONFIG_ACCEPT")}</Button>
          ) : null}
          {/* Not while an edit is still saving: the decision locks the request, and the edit with it. */}
          {decide ? (
            <>
              <Button design="Default" disabled={decide.disabled || decide.unsaved} onClick={decide.onSendBack}>{t("CONFIG_SEND_BACK")}</Button>
              <Button design="Negative" disabled={decide.disabled || decide.unsaved} onClick={decide.onDecline}>{t("CONFIG_DECLINE")}</Button>
            </>
          ) : null}
        </>
      } />
  );
}
