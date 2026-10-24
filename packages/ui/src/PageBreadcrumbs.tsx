import { useRouter } from "@tanstack/react-router";
import { Breadcrumbs, BreadcrumbsItem } from "@ui5/webcomponents-react";
import { useEntityNav } from "./EntityLink.tsx";

/** One step up: `to` is tenant-relative (`/configs`), as `useEntityNav` takes it. */
export type Crumb = { text: string; to: string };

/**
 * An Object Page's trail, for `ObjectPageTitle`'s `breadcrumbs` slot: the pages above as links, then
 * `current` — the record's name or code — as plain text. Each link is a real href, so a modified
 * click opens a tab; a plain click stays in the router, where the page's unsaved-changes blocker
 * still sees it.
 */
export function PageBreadcrumbs({ items, current }: { items: Crumb[]; current: string }) {
  const router = useRouter();
  const go = useEntityNav();
  return (
    <Breadcrumbs
      onItemClick={(e) => {
        const { altKey, ctrlKey, metaKey, shiftKey, item } = e.detail;
        const to = item.dataset.to; // none on the current page, which fires too
        if (!to || altKey || ctrlKey || metaKey || shiftKey) return;
        e.preventDefault();
        go(to);
      }}>
      {items.map((c) => (
        <BreadcrumbsItem key={c.to} data-to={c.to}
          href={router.buildLocation({ to: `/$slug${c.to}` as string }).href}>
          {c.text}
        </BreadcrumbsItem>
      ))}
      <BreadcrumbsItem key="current">{current}</BreadcrumbsItem>
    </Breadcrumbs>
  );
}
