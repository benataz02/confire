import type { ReactNode } from "react";
import { AuthLayout as Frame } from "@confire/ui/auth/AuthLayout.tsx";
import { siteUrl } from "@confire/ui/host.ts";
import { useLanguage, useUiI18n } from "@confire/ui/i18n.ts";

// Confire's frame for login / signup / password / setup: the logo goes home to confire.ai, and the
// footer is the site's legal pages, both in the app's language.
export function AuthLayout({ wide, children }: { wide?: boolean; children: ReactNode }) {
  const ui = useUiI18n();
  const { language } = useLanguage();
  const site = (path: string) => siteUrl(path, language);
  return (
    <Frame
      wide={wide}
      brand={<a className="auth-brand" href={site("/")}><img src="/confire-logo.png" alt="" /><span>Confire</span></a>}
      foot={
        <>
          <span>© {new Date().getFullYear()} Confire</span>
          <a href={site("/privacy/")}>{ui.getText("UI_AUTH_PRIVACY")}</a>
          <a href={site("/legal-notice/")}>{ui.getText("UI_AUTH_LEGAL")}</a>
          <a href={site("/cookies/")}>{ui.getText("UI_AUTH_COOKIES")}</a>
        </>
      }
    >
      {children}
    </Frame>
  );
}
