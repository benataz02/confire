import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { DynamicPage, DynamicPageHeader, DynamicPageTitle, Label, Title, Toolbar, type DynamicPageDomRef, type DynamicPageHeaderDomRef } from "@ui5/webcomponents-react";
import type { ProjectStatus } from "@confire/db";
import { formatLocale } from "../format.ts";
import { JourneyBar } from "../journey/JourneyBar.tsx";
import type { JourneyNext, Side } from "../journey/ring.ts";
import { ProjectStatusTag } from "../timeline/ProjectStatus.tsx";
import { ProjectTimeline, TimelineComposer, type ProjectTimelineProps, type TimelineComposerProps } from "../timeline/ProjectTimeline.tsx";
import { chaptersOf, mergeEntries, stepDates } from "../timeline/chapters.ts";

// A client project's page, in both apps (client-project-page spec, "The project page"): the title and
// its actions, the progress bar as the header, the timeline in chapters as the content and its comment
// box as the floating footer. A DynamicPage, not an ObjectPage: Fiori's object page is an object in
// sections, and this page is one thing — the conversation. Props-driven like ProjectTimeline: each
// app's route passes its data, texts and calls.

export function ProjectOverview({ side, title, subtitle, breadcrumbs, status, actions, journey, timeline }: {
  side: Side;
  /** the project's name, and the line under it (the portal: the model; staff: client and assignee) */
  title: string; subtitle: string;
  /** a PageBreadcrumbs: a slot, so an element that forwards `slot` */
  breadcrumbs: ReactElement;
  /** One tag, the status alone: the quote's answer is the progress bar's next step and a timeline entry. */
  status: ProjectStatus;
  /** ToolbarButtons; the configuration's comes first */
  actions: ReactNode;
  journey: { step: number; next: JourneyNext; labels: string[]; nextText: string; ariaLabel: string };
  timeline: Omit<ProjectTimelineProps, "chapters"> & Omit<TimelineComposerProps, "side">;
}) {
  const page = useRef<DynamicPageDomRef>(null);
  const { onComment, onUpload, ...feed } = timeline;

  // The footer floats over the content, which ends in a spacer of UI5's to scroll the last entry clear of
  // it — 4rem, a Bar's height. The comment box is taller and grows as one types, so the spacer follows it:
  // its height, the footer's own .5rem under it, and .5rem of air.
  // ponytail: UI5's private variable; re-check on a UI5 upgrade, drop if the footer ever sizes its spacer.
  const footer = useRef<HTMLDivElement>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  // A short timeline still scrolls a little, but not past the header, where UI5 snaps it (scrollTop >
  // header + 10): the header stopped half hidden. The scroll range is the content's height less the
  // content area's, so content at least the area plus the header (+12 px) always reaches the snap point.
  // Pinned, nothing snaps, and the content needs no more than the area.
  const header = useRef<DynamicPageHeaderDomRef>(null);
  const [headerHeight, setHeaderHeight] = useState(0);
  const [pinned, setPinned] = useState(false);
  useLayoutEffect(() => {
    const f = footer.current, h = header.current;
    if (!f || !h) return;
    const ro = new ResizeObserver(() => { setFooterHeight(f.offsetHeight); setHeaderHeight(h.offsetHeight); });
    ro.observe(f);
    ro.observe(h);
    return () => ro.disconnect();
  }, []);

  // A done step's date: its chapter's milestone (stepDates), drawn as "29 Oct".
  const dates = useMemo(() => stepDates(chaptersOf(mergeEntries(feed.events, feed.documents)))
    .map((t) => (t === undefined ? undefined : new Date(t).toLocaleDateString(formatLocale(), { day: "numeric", month: "short" }))),
  [feed.events, feed.documents]);

  // The title stays over the top of the scrolling content, and the header with it only while pinned
  // (unpinned, it scrolls away and snaps), so a chapter starts under them: its scroll margin is their height.
  const toChapter = (i: number) => {
    const p = page.current;
    const chapter = p?.querySelector<HTMLElement>(`[data-chapter="${i}"]`);
    if (!p || !chapter) return;
    const sticky = p.headerPinned ? ":scope > [ui5-dynamic-page-title], :scope > [ui5-dynamic-page-header]" : ":scope > [ui5-dynamic-page-title]";
    chapter.style.scrollMarginTop = `${[...p.querySelectorAll(sticky)].reduce((h, el) => h + el.getBoundingClientRect().height, 0)}px`;
    chapter.scrollIntoView({ block: "start" });
  };

  // The name in UI5's object-header size, its tag beside it and centred on it as the configuration page's
  // ObjectPageTitle has them. In the heading slot, not the title's content: that stretches to the actions'
  // row and sits its content lower and further off. Wrapped, the Title loses the slot's styling of a bare
  // one, so its font, colour and top padding are set here.
  // ponytail: UI5's private padding variable (fallback its 2.24 value); re-check on a UI5 upgrade.
  const heading = (fontSize: string) => (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "0.5rem",
      paddingTop: "var(--_ui5_dynamic_page_title_heading_padding_top, .3125rem)" }}>
      <Title style={{ fontSize, fontFamily: "var(--sapObjectHeader_Title_FontFamily)", color: "var(--sapObjectHeader_Title_TextColor)" }}>
        {title}
      </Title>
      <ProjectStatusTag status={status} />
    </div>
  );
  const subheading = <Label>{subtitle}</Label>;
  return (
    // The bar snaps away on scroll; its pin keeps it. The comment box stays in view.
    <DynamicPage ref={page} showFooter onPinButtonToggle={(e) => setPinned(e.target.headerPinned)}
      style={{ "--_ui5_dynamic_page_footer_spacer": `calc(${footerHeight}px + 1rem)` } as CSSProperties}
      footerArea={
        // The box floats itself, in a floating footer's colours, as wide as the timeline's column so its
        // edges are the column's. Not a Bar: its height is fixed and it clips what it holds.
        <div ref={footer} style={{ maxWidth: "60rem", marginInline: "auto" }}>
          <TimelineComposer side={side} onComment={onComment} onUpload={onUpload}
            look={{ background: "var(--sapPageFooter_Background)", border: "var(--sapPageFooter_BorderColor)", shadow: "var(--sapContent_Shadow1)" }} />
        </div>
      }
      titleArea={
        // Expanded and snapped (UI5 draws the snapped slots instead, and empty ones lose the name); on a
        // phone, snapped, the name alone.
        <DynamicPageTitle heading={heading("var(--sapObjectHeader_Title_FontSize)")}
          snappedHeading={heading("var(--sapObjectHeader_Title_SnappedFontSize)")}
          snappedTitleOnMobile={<Title>{title}</Title>} subheading={subheading} snappedSubheading={subheading}
          breadcrumbs={breadcrumbs} actionsBar={<Toolbar design="Transparent">{actions}</Toolbar>} />
      }
      headerArea={
        <DynamicPageHeader ref={header}>
          {/* The timeline's column, so the bar sits over it. */}
          <div style={{ width: "100%", maxWidth: "60rem", marginInline: "auto" }}>
            <JourneyBar step={journey.step} next={journey.next} side={side} labels={journey.labels} dates={dates}
              nextText={journey.nextText} ariaLabel={journey.ariaLabel} onStep={toChapter} />
          </div>
        </DynamicPageHeader>
      }>
      <div style={{ minHeight: pinned ? undefined : `calc(100% + ${headerHeight + 12}px)` }}>
        <ProjectTimeline {...feed} chapters={{ labels: journey.labels, draft: journey.next === "finish" }} />
      </div>
    </DynamicPage>
  );
}
