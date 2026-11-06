import { useMemo, useRef, type ReactNode } from "react";
import {
  Button, Card, Icon, Label, Link, ObjectPage, ObjectPageHeader, ObjectPageSection, ObjectPageTitle, Text, Title, Toolbar,
  ToolbarItem, type ObjectPageDomRef,
} from "@ui5/webcomponents-react";
import { useUiI18n } from "../i18n.ts";
import { formatLocale } from "../format.ts";
import { PageMessages, type PageMessage } from "../PageMessages.tsx";
import { JourneyBar, JOURNEY_ICONS } from "../journey/JourneyBar.tsx";
import type { JourneyNext, Side } from "../journey/ring.ts";
import { ProjectTimeline, type ProjectTimelineProps } from "../timeline/ProjectTimeline.tsx";
import { chaptersOf, mergeEntries, stepDates } from "../timeline/chapters.ts";

// A client project's page, in both apps (client-project-page spec, "The project page", mockup C): the
// title with the progress bar, the configuration as one line, the timeline in chapters, then the steps
// still to come. Props-driven like ProjectTimeline: each app's route passes its data, texts and calls.

const TIMELINE = "timeline";

export function ProjectOverview({
  side, title, subtitle, breadcrumbs, tags, subHeader, actions, messages, openMessagesOn, journey, config, upcoming, timeline,
}: {
  side: Side;
  /** the project's name, and the model's */
  title: string; subtitle: string;
  breadcrumbs: ReactNode; tags: ReactNode;
  /** over the bar: staff's client and assignee, the quote-answer strip */
  subHeader?: ReactNode;
  /** ToolbarButtons, after the messages button */
  actions: ReactNode;
  messages: PageMessage[];
  /** PageMessages' `openOn` */
  openMessagesOn?: number;
  journey: { step: number; next: JourneyNext; labels: string[]; nextText: string; ariaLabel: string };
  /** `label` is the line's name ("Configuration"); `text` its open action's */
  config: { label: string; summary: string[]; text: string; emphasized: boolean; onOpen: () => void };
  /** the first not-reached step's sentence; the names come from journey.labels */
  upcoming: { sentence: string | null };
  timeline: Omit<ProjectTimelineProps, "chapters">;
}) {
  const i18n = useUiI18n();
  const page = useRef<ObjectPageDomRef>(null);

  // A done step's date: its chapter's milestone (stepDates), drawn as "29 Oct".
  const dates = useMemo(() => stepDates(chaptersOf(mergeEntries(timeline.events, timeline.documents, { docsAfterDay: true })))
    .map((t) => (t === undefined ? undefined : new Date(t).toLocaleDateString(formatLocale(), { day: "numeric", month: "short" }))),
  [timeline.events, timeline.documents]);

  // Focus first, as the portal's goSection does: wcr sets the scroller's scroll-padding (the sticky title
  // and the pinned header) only while focus is inside the content, and the bar sits outside it, so
  // without it the target scrolls under the header. The section is what takes the focus (a plain div
  // wcr makes focusable): a UI5 host's focus() is async and lands in its shadow, after the scroll.
  const scrollTo = (selector: string) => {
    page.current?.querySelector<HTMLElement>(`[id="ObjectPageSection-${TIMELINE}"]`)?.focus({ preventScroll: true });
    page.current?.querySelector<HTMLElement>(selector)?.scrollIntoView({ block: "start" });
  };

  const ahead = journey.next === "done" || journey.next === "declined"
    ? [] : journey.labels.map((label, i) => ({ label, i })).filter(({ i }) => i > journey.step);

  return (
    // Pinned: the bar is how one jumps between chapters, so the header never snaps away under the scroll,
    // nor on a title click. A jump clears it through the scroll padding (scrollTo).
    <ObjectPage hidePinButton headerPinned preserveHeaderStateOnClick ref={page}
      titleArea={
        <ObjectPageTitle header={<Title>{title}</Title>} subHeader={<Text>{subtitle}</Text>} breadcrumbs={breadcrumbs}
          actionsBar={
            <Toolbar design="Transparent">
              <ToolbarItem overflowPriority="NeverOverflow">
                <PageMessages messages={messages} openOn={openMessagesOn} onSection={() => scrollTo(`[id="ObjectPageSection-${TIMELINE}"]`)} />
              </ToolbarItem>
              {actions}
            </Toolbar>
          }>
          {tags}
        </ObjectPageTitle>
      }
      headerArea={
        <ObjectPageHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: "1rem", width: "100%", maxWidth: "60rem" }}>
            {subHeader}
            <JourneyBar step={journey.step} next={journey.next} side={side} labels={journey.labels} dates={dates}
              nextText={journey.nextText} ariaLabel={journey.ariaLabel}
              onStep={(i) => scrollTo(`[data-chapter="${i}"]`)} />
          </div>
        </ObjectPageHeader>
      }>
      <ObjectPageSection id={TIMELINE} titleText={i18n.getText("UI_TIMELINE")} hideTitleText>
        <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", width: "100%", maxWidth: "60rem", marginInline: "auto" }}>
          <Card>
            <div style={{ display: "flex", alignItems: "center", gap: "1rem", padding: "0.75rem 1rem" }}>
              <Icon name="document-text" style={{ width: "1.25rem", height: "1.25rem", color: "var(--sapContent_IconColor)", flex: "none" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <Text style={{ fontFamily: "var(--sapFontBoldFamily)" }}>{config.label}</Text>
                {/* The space outside the Label: inside, its leading space collapses ("Configuration· 500"). */}
                {config.summary.length ? <>{" "}<Label>{`· ${config.summary.join(" · ")}`}</Label></> : null}
              </div>
              {config.emphasized
                ? <Button design="Emphasized" onClick={config.onOpen}>{config.text}</Button>
                : <Link endIcon="navigation-right-arrow" onClick={config.onOpen}>{config.text}</Link>}
            </div>
          </Card>
          <ProjectTimeline {...timeline} chapters={{ labels: journey.labels, draft: journey.next === "finish" }} />
          {/* What comes next: the steps not reached yet, faded, the first saying what happens. */}
          {ahead.length ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "0.75rem", opacity: "var(--sapContent_DisabledOpacity)" }}>
              {ahead.map(({ label, i }, n) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                  <Icon name={JOURNEY_ICONS[i]!} style={{ width: "1.25rem", height: "1.25rem", color: "var(--sapContent_NonInteractiveIconColor)", flex: "none" }} />
                  <Title level="H5">{label}</Title>
                  {n === 0 && upcoming.sentence ? <Label wrappingType="Normal">{upcoming.sentence}</Label> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </ObjectPageSection>
    </ObjectPage>
  );
}
