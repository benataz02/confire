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
};

// The staff app serves apps/app/public, so the logo URL is its own.
export const CONFIRE: Brand = { name: "Confire", logoUrl: `${authUrl}/confire-logo.png` };

// SAP Horizon blue, the auth pages' link colour: 4.9:1 against white.
const DEFAULT_ACCENT = "#0a6ed1";
const font = '-apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function Layout({ brand, preview, children }: { brand: Brand; preview: string; children: ReactNode }) {
  return (
    <Html lang="en">
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
        <Text style={{ color: "#8a97b8", fontSize: 12, textAlign: "center", margin: "16px 0 0" }}>
          {brand.name === CONFIRE.name ? "Confire" : `${brand.name} · sent with Confire`}
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
