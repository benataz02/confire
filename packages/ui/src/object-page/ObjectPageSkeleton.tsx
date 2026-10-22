import { MessageStrip, ObjectPage } from "@ui5/webcomponents-react";
import { useUiI18n } from "../i18n.ts";

/** The object page while its record loads. Bars copy AnalyticalTable's TablePlaceholder (not a
 *  public export); the styles are global.css' confire-op-skel-*. */
export function ObjectPageSkeleton() {
  const i18n = useUiI18n();
  return (
    <ObjectPage placeholder={
      <div className="confire-op-skel" role="progressbar" aria-valuetext={i18n.getText("UI_BUSY")} title={i18n.getText("UI_PLEASE_WAIT")}>
        <div aria-hidden="true">
          <div className="confire-op-skel-header">
            <div className="confire-op-skel-heading">
              <span className="confire-op-skel-bar confire-op-skel-bar--title" />
              <span className="confire-op-skel-bar confire-op-skel-bar--sub" />
            </div>
            <div className="confire-op-skel-actions">
              <span className="confire-op-skel-bar confire-op-skel-bar--chip" />
              <span className="confire-op-skel-bar confire-op-skel-bar--chip" />
            </div>
          </div>
          <div className="confire-op-skel-tabs">
            <span className="confire-op-skel-bar confire-op-skel-bar--tab" />
            <span className="confire-op-skel-bar confire-op-skel-bar--tab" />
            <span className="confire-op-skel-bar confire-op-skel-bar--tab" />
          </div>
          <div className="confire-op-skel-section">
            <span className="confire-op-skel-bar confire-op-skel-bar--section" />
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="confire-op-skel-field">
                <span className="confire-op-skel-bar confire-op-skel-bar--label" />
                <span className="confire-op-skel-bar confire-op-skel-bar--value" />
              </div>
            ))}
          </div>
        </div>
      </div>
    } />
  );
}

/** A page that could not load: what went wrong, in place of the page. */
export const PageError = ({ error }: { error: Error }) => (
  <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{error.message}</MessageStrip>
);
