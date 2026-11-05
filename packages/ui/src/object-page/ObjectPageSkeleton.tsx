import {
  FlexBox, Form, FormGroup, FormItem, Label, MessageStrip, ObjectPage, ObjectPageHeader, ObjectPageTitle, Text, Title,
} from "@ui5/webcomponents-react";
import { FORM_LAYOUT } from "../formLayout.ts";
import { useUiI18n } from "../i18n.ts";

/** One shimmer bar, `w` wide. Inside a UI5 text component (Title, Label, Text) it stands in for a
 *  glyph run, so that component's own line box sets the row height and the page keeps its rhythm. */
const Bar = ({ w, h }: { w: string; h?: string }) => (
  <span className="confire-op-skel-bar" style={{ width: w, height: h }} />
);

/** Two form columns of [label, value] widths (rem): ragged, like real fields. */
const COLUMNS: Array<Array<[number, number]>> = [
  [[6, 5], [7, 14], [9, 8], [8, 10], [5, 4]],
  [[10, 6], [9, 6], [5, 5]],
];

/** The object page while its record loads, drawn with the real page's parts: ObjectPageTitle,
 *  ObjectPageHeader and the sections' Form hold bars instead of text, so header colour, paddings,
 *  the collapse button and the form card are UI5's own. Only the tab strip is ours — ObjectPage
 *  drops its tab bar while `placeholder` is set. Bars copy AnalyticalTable's TablePlaceholder (not
 *  a public export); the styles are global.css' confire-op-skel-*. */
export function ObjectPageSkeleton() {
  const i18n = useUiI18n();
  return (
    <ObjectPage
      hidePinButton
      titleArea={
        <ObjectPageTitle
          breadcrumbs={<div className="confire-op-skel-crumbs"><Bar w="9rem" /></div>}
          header={<Title><Bar w="8rem" h="1.25rem" /></Title>}
          subHeader={<Text><Bar w="16rem" /></Text>}
          actionsBar={
            <div className="confire-op-skel-actions">
              <span className="confire-op-skel-bar confire-op-skel-bar--button" style={{ width: "5rem" }} />
              <span className="confire-op-skel-bar confire-op-skel-bar--button" style={{ width: "6.5rem" }} />
              <span className="confire-op-skel-bar confire-op-skel-bar--button" style={{ width: "5.5rem" }} />
            </div>
          }
        />
      }
      headerArea={
        <ObjectPageHeader>
          <FlexBox style={{ gap: "2rem" }}>
            {[[3, 4], [2.5, 6]].map(([l, v], i) => (
              <FlexBox key={i} direction="Column" style={{ gap: "0.25rem" }}>
                <Label><Bar w={`${l}rem`} /></Label>
                <Title level="H4"><Bar w={`${v}rem`} /></Title>
              </FlexBox>
            ))}
          </FlexBox>
        </ObjectPageHeader>
      }
      placeholder={
        <div role="progressbar" aria-valuetext={i18n.getText("UI_BUSY")} title={i18n.getText("UI_PLEASE_WAIT")}>
          <div aria-hidden="true">
            <div className="confire-op-skel-tabs">
              <Bar w="3.75rem" /><Bar w="3.25rem" /><Bar w="7.5rem" />
            </div>
            <div className="confire-op-skel-section">
              <div className="confire-op-skel-section-title"><Bar w="7rem" h="1.125rem" /></div>
              <Form layout={FORM_LAYOUT} accessibleMode="Display" itemSpacing="Large">
                {COLUMNS.map((rows, g) => (
                  <FormGroup key={g}>
                    {rows.map(([l, v], i) => (
                      <FormItem key={i} labelContent={<Label><Bar w={`${l}rem`} /></Label>}>
                        <Text><Bar w={`${v}rem`} /></Text>
                      </FormItem>
                    ))}
                  </FormGroup>
                ))}
              </Form>
            </div>
          </div>
        </div>
      }
    />
  );
}

/** A page that could not load: what went wrong, in place of the page. */
export const PageError = ({ error }: { error: Error }) => (
  <MessageStrip design="Negative" hideCloseButton style={{ margin: "1rem" }}>{error.message}</MessageStrip>
);
