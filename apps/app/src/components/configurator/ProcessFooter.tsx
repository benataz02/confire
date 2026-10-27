import { Bar, Button } from "@ui5/webcomponents-react";
import { useI18n } from "../../i18n.ts";

/** The process page's floating footer: Create quote (the only Emphasized action) and a request's
 *  decisions. It is mounted only once quoting is on, and rises in / drops out (global.css). */
export function ProcessFooter({ shown, onGone, quote, decide }: {
  /** confire-footer-in/-out (global.css): rises in while shown, drops out — then `onGone` unmounts it */
  shown: boolean;
  onGone: () => void;
  quote: null | { text: string; pending: boolean; onClick: () => void };
  /** a request's decisions; null on an internal configuration */
  decide: null | {
    canAccept: boolean; disabled: boolean; unsaved: boolean;
    onAccept: () => void; onSendBack: () => void; onDecline: () => void;
  };
}) {
  const i18n = useI18n();
  const t = (key: string, ...params: string[]) => i18n.getText(key, ...params);
  // One control is not a toolbar (Bar's own rule); several decisions are.
  const controls = (quote ? 1 : 0) + (decide ? 2 + (decide.canAccept ? 1 : 0) : 0);
  return (
    <Bar design="FloatingFooter" accessibleRole={controls > 1 ? "Toolbar" : "None"}
      className={shown ? "confire-footer-in" : "confire-footer-out"}
      onAnimationEnd={(e) => { if (e.animationName === "confire-footer-out") onGone(); }}
      endContent={
        <>
          {/* A request takes it once accepted (in review); until then Accept is the positive action. */}
          {quote ? (
            <Button design="Emphasized" disabled={quote.pending} onClick={quote.onClick}>{quote.text}</Button>
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
