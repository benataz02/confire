import { useNavigate, useParams, useRouter, type ErrorComponentProps, type NotFoundRouteProps } from "@tanstack/react-router";
import { Button, IllustratedMessage } from "@ui5/webcomponents-react";
import { useUiI18n } from "./i18n.ts";
import "@ui5/webcomponents-fiori/dist/illustrations/ErrorScreen.js";
import "@ui5/webcomponents-fiori/dist/illustrations/PageNotFound.js";
import "@ui5/webcomponents-fiori/dist/illustrations/tnt/CodePlaceholder.js";

// Router-wide boundaries, wired as createRouter defaults in each app's main.tsx. Any route can still
// override with its own errorComponent/notFoundComponent.

// `reset()` is router.invalidate() under the hood — it re-runs the loader, so retry is real.
export function RouteError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const i18n = useUiI18n();
  return (
    <IllustratedMessage
      name="ErrorScreen"
      design="Scene"
      titleText={i18n.getText("UI_SOMETHING_WRONG")}
      // ponytail: raw message. Map to friendlier copy per oRPC error code once we have codes users care about.
      subtitleText={error.message}
    >
      <Button design="Emphasized" onClick={() => reset()}>{i18n.getText("UI_TRY_AGAIN")}</Button>
      {/* IllustratedMessage's default slot is IButton[] with no inter-button gap in UI5 2.26. */}
      <Button style={{ marginInlineStart: "0.5rem" }} onClick={() => router.history.back()}>{i18n.getText("UI_GO_BACK")}</Button>
    </IllustratedMessage>
  );
}

// Renders for an unmatched URL and for `throw notFound()` from a loader. Home is the tenant's when the
// URL names one; the bare origin's `/` is the sign-in dispatcher.
export function RouteNotFound(_props: NotFoundRouteProps) {
  const navigate = useNavigate();
  const { slug } = useParams({ strict: false });
  const i18n = useUiI18n();
  return (
    <IllustratedMessage name="PageNotFound" design="Scene" titleText={i18n.getText("UI_PAGE_MISSING")}
      subtitleText={i18n.getText("UI_PAGE_MISSING_SUB")}>
      <Button design="Emphasized" onClick={() => navigate(slug ? { to: "/$slug", params: { slug } } : { to: "/" })}>{i18n.getText("UI_GO_HOME")}</Button>
    </IllustratedMessage>
  );
}

// Placeholder for routes that are routed but not built. Use as a route `component`.
export function ToBeDone({ what }: { what?: string }) {
  const i18n = useUiI18n();
  return (
    <IllustratedMessage name="TntCodePlaceholder" design="Scene"
      titleText={i18n.getText("UI_NOT_BUILT", what ?? i18n.getText("UI_THIS_FEATURE"))}
      subtitleText={i18n.getText("UI_NOT_BUILT_SUB")} />
  );
}
