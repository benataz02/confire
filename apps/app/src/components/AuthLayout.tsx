import type { ReactNode } from "react";
import { AuthLayout as Frame, revealDelay as delay } from "@confire/ui/auth/AuthLayout.tsx";
import { useI18n } from "../i18n.ts";

// Confire's split screen for login / signup / onboarding: the brand panel is pure presentation
// (the cloud -> agent -> B1 sync motif); the frame and its CSS are shared with the customer portal.
export function AuthLayout({ children }: { children: ReactNode }) {
  const i18n = useI18n();
  return (
    <Frame
      brand={
        <>
          <h1 className="auth-brand__mark reveal" style={delay(0)}>Confire</h1>
          <p className="auth-brand__tagline reveal" style={delay(90)}>
            {i18n.getText("SHELL_AUTH_TAGLINE")}<br />
            <em>{i18n.getText("SHELL_AUTH_TAGLINE_EMPH")}</em>
          </p>
          <div className="auth-brand__pulse reveal" style={delay(180)} aria-hidden="true">
            <span className="node">{i18n.getText("SHELL_AUTH_CLOUD")}</span>
            <span className="wire"><i className="dot" /></span>
            <span className="node">{i18n.getText("SHELL_AUTH_AGENT")}</span>
            <span className="wire"><i className="dot dot--2" /></span>
            <span className="node">SAP&nbsp;B1</span>
          </div>
          <p className="auth-brand__foot reveal" style={delay(260)}>
            {i18n.getText("SHELL_AUTH_FOOT")}
          </p>
        </>
      }
    >
      {children}
    </Frame>
  );
}
