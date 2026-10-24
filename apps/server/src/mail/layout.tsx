import type { ReactNode } from "react";
import { Body, Button, Column, Container, Head, Heading, Html, Img, Preview, Row, Section, Text } from "react-email";
import { authUrl } from "../tenant.ts";

// The one frame every mail is drawn in. Inline styles rather than <Tailwind>: email clients drop
// <style> blocks and `rem`, and inline objects need no CSS compile per render. Tables, not flexbox
// (Row/Column), because Outlook renders with Word.

/** Whose mail this is (spec D20): Confire's own, or a tenant's on its portal. */
export type Brand = {
  name: string;
  /** absolute URL: a mail has no origin to resolve a relative one against */
  logoUrl?: string | null;
  /** button colour; white text on it must reach 4.5:1 */
  accent?: string;
  /** the From address's local part, `<sender>@mail.<domain>`: a tenant's slug; absent = notify */
  sender?: string;
};

// The staff app serves apps/app/public, so the logo URL is its own.
export const CONFIRE: Brand = { name: "Confire", logoUrl: `${authUrl}/confire-logo.png` };

/** A client mail's language: its company's SAP language, `BusinessPartners.LanguageCode` →
 *  `UserLanguages.Code`, whose codes are SAP's built-in languages (3 English, 23 Spanish, 25 Spanish
 *  (LA), …). Only English and Spanish are written; any other language reads English. The SPAs
 *  also offer Basque, which has no built-in SAP code, so a Basque UI still sends this mail in English.
 *  ponytail: built-in codes only — a user-defined UserLanguages row (its own Code, pointing at 23
 *  through RelatedSystemLanguage) reads English; resolve it through UserLanguages if one shows up. */
export type MailLang = "en" | "es";
export const mailLang = (languageCode: number | null | undefined): MailLang =>
  languageCode === 23 || languageCode === 25 ? "es" : "en";
/** The other way, for a new client: the inviter's app language (`LANGUAGES` ids) as an SAP language. */
export const sapLanguage = (appLanguage: string): number => (appLanguage === "es" ? 23 : 3);
/** Dates and amounts in the mail's language. */
export const MAIL_LOCALE: Record<MailLang, string> = { en: "en-GB", es: "es-ES" };

const FOOTER: Record<MailLang, { sentWith: string; noReply: string }> = {
  en: { sentWith: "sent with Confire", noReply: "This is an automated message. Replies to this address are not received." },
  es: { sentWith: "enviado con Confire", noReply: "Este es un mensaje automático. No se reciben respuestas en esta dirección." },
};

// SAP Horizon blue, the auth pages' link colour: 4.9:1 against white.
const DEFAULT_ACCENT = "#0a6ed1";
const font = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function Layout({ brand, preview, lang = "en", children }: { brand: Brand; preview: string; lang?: MailLang; children: ReactNode }) {
  return (
    <Html lang={lang}>
      <Head />
      <Body style={{ backgroundColor: "#f5f7fb", fontFamily: font, margin: 0, padding: "24px 0" }}>
        <Preview>{preview}</Preview>
        <Container style={{ backgroundColor: "#ffffff", border: "1px solid #e2e6ee", borderRadius: 8, maxWidth: 560 }}>
          <Section style={{ backgroundColor: "#0a0e1a", borderRadius: "8px 8px 0 0", padding: "16px 32px" }}>
            <Row>
              {brand.logoUrl ? (
                <Column style={{ width: 44 }}>
                  <Img src={brand.logoUrl} alt="" width="32" height="32" style={{ borderRadius: 6 }} />
                </Column>
              ) : null}
              <Column>
                <Text style={{ color: "#eaf0fb", fontSize: 18, fontWeight: 600, margin: 0 }}>{brand.name}</Text>
              </Column>
            </Row>
          </Section>
          <Section style={{ padding: "8px 32px 24px" }}>{children}</Section>
        </Container>
        {/* Every mail is a no-reply notification: mail.<domain> receives nothing (mailer.ts). */}
        <Text style={{ color: "#8a97b8", fontSize: 12, lineHeight: "18px", textAlign: "center", margin: "16px 0 0" }}>
          {brand.name === CONFIRE.name ? "Confire" : `${brand.name} · ${FOOTER[lang].sentWith}`}
          <br />
          {FOOTER[lang].noReply}
        </Text>
      </Body>
    </Html>
  );
}

export const H1 = ({ children }: { children: ReactNode }) => (
  <Heading as="h1" style={{ color: "#0c1326", fontSize: 22, fontWeight: 600, margin: "24px 0 8px" }}>{children}</Heading>
);

export const P = ({ children }: { children: ReactNode }) => (
  <Text style={{ color: "#41495c", fontSize: 15, lineHeight: "24px", margin: "8px 0" }}>{children}</Text>
);

/** Small print under the action: the link spelled out for clients that strip buttons. */
export const Fine = ({ children }: { children: ReactNode }) => (
  <Text style={{ color: "#5b6478", fontSize: 13, lineHeight: "20px", margin: "8px 0", wordBreak: "break-all" }}>{children}</Text>
);

export const Action = ({ brand, href, children }: { brand: Brand; href: string; children: ReactNode }) => (
  <Section style={{ margin: "20px 0" }}>
    <Button
      href={href}
      style={{
        backgroundColor: brand.accent ?? DEFAULT_ACCENT, borderRadius: 6, boxSizing: "border-box",
        color: "#ffffff", fontSize: 15, fontWeight: 600, padding: "12px 20px", textDecoration: "none",
      }}
    >
      {children}
    </Button>
  </Section>
);
