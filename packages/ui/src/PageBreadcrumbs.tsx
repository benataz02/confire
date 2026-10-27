import { useNavigate, useRouter } from "@tanstack/react-router";
import { Breadcrumbs, BreadcrumbsItem } from "@ui5/webcomponents-react";

/** One step up: `to` is tenant-relative (`/configs`). `search` is that page's query, when the
 *  trail has to reopen a tab rather than the page's first section. */
export type Crumb = { text: string; to: string; search?: Record<string, unknown> };

/**
 * An Object Page's trail, for `ObjectPageTitle`'s `breadcrumbs` slot: the pages above as links, then
 * `current` — the record's name or code — as plain text. Each link is a real href, so a modified
 * click opens a tab; a plain click stays in the router, where the page's unsaved-changes blocker
 * still sees it. The last item is the current page: Breadcrumbs' Standard design draws it bold
 * and without a separator.
 */
export function PageBreadcrumbs({ slot, items, current }: {
  /** filled in by ObjectPageTitle's slot handling — forward it or the trail is never slotted */
  slot?: string;
  items: Crumb[];
  current: string;
}) {
  const router = useRouter();
  const navigate = useNavigate();
  return (
    <Breadcrumbs
      slot={slot}
      onItemClick={(e) => {
        const { altKey, ctrlKey, metaKey, shiftKey, item } = e.detail;
        const index = item.dataset.index; // none on the current page, which fires too
        if (index === undefined || altKey || ctrlKey || metaKey || shiftKey) return;
        const crumb = items[Number(index)];
        if (!crumb) return;
        e.preventDefault();
        void navigate({
          to: `/$slug${crumb.to}` as string,
          ...(crumb.search ? { search: crumb.search } : {}),
        });
      }}>
      {items.map((c, i) => (
        <BreadcrumbsItem key={`${c.to}:${i}`} data-index={String(i)}
          href={router.buildLocation({
            to: `/$slug${c.to}` as string,
            ...(c.search ? { search: c.search } : {}),
          }).href}>
          {c.text}
        </BreadcrumbsItem>
      ))}
      <BreadcrumbsItem key="current">{current}</BreadcrumbsItem>
    </Breadcrumbs>
  );
}
