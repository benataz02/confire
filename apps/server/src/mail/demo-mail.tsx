import { CONFIRE, H1, Layout, P } from "./layout.tsx";

// The marketing site's demo request (spec 2026-10-30 §9), to Confire's own inbox. Plain fields on
// purpose: it is read once, by the owner, and answered with Reply.

export type DemoRequest = { name: string; email: string; company: string; setup: string; message: string; lang: "en" | "es" | "eu" };

export function DemoRequestMail({ name, email, company, setup, message, lang, utm }: DemoRequest & { utm: Record<string, string> }) {
  const rows: [string, string][] = [["Name", name], ["Email", email], ["Company", company], ["Setup", setup || "—"], ["Language", lang]];
  return (
    <Layout brand={CONFIRE} preview={`${company} asks for a demo`} replyable>
      <H1>Demo request: {company}</H1>
      {rows.map(([k, v]) => <P key={k}><b>{k}:</b> {v}</P>)}
      <P><b>What they quote today:</b></P>
      <P>{message || "—"}</P>
      {Object.keys(utm).length ? <P><b>Campaign:</b></P> : null}
      {Object.entries(utm).map(([k, v]) => <P key={k}>{k}: {v}</P>)}
    </Layout>
  );
}
