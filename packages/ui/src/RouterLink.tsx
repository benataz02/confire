import { forwardRef } from "react";
import { createLink } from "@tanstack/react-router";
import { Link, type LinkDomRef, type LinkPropTypes } from "@ui5/webcomponents-react";

// UI5's Link as a router link: the real href (middle-click, open in new tab), the router's
// navigation on a plain click, and its preload on hover/focus. ui5-link's click is a CustomEvent
// carrying the modifier keys on `detail` and no `button`, both of which the router's handler reads
// off the event itself — without this it never navigates and the href reloads the whole app.
const UiLink = forwardRef<LinkDomRef, LinkPropTypes>(({ onClick, ...props }, ref) => (
  <Link ref={ref} {...props} onClick={(e) => onClick?.(Object.assign(e, { button: 0, ...e.detail }))} />
));

export const RouterLink = createLink(UiLink);
