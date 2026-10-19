import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { db, configModel, configProjectEvent, portalMember, type PortalRole } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { devOutbox } from "../src/mail/mailer.ts";
import { notificationsSettled } from "../src/notify.ts";
import { fileRoutes, imageType, cleanName } from "../src/files.ts";
import { contrastOnWhite } from "../src/portal/settings.ts";
import { senderNameProblem } from "../src/portal/sender-domain.ts";
import {
  call, makePortalSeat, makePortalUser, makeTenant, makeUser, portalHeaders, tenantHeaders, TEST_MODEL,
} from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// P7: who hears about a project event (spec §12, D22, D27), files on the timeline (D14), branding
// (D20) and the portal home. Every hop goes through the real routers and file routes.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

let agent: MockAgent;
beforeAll(() => { agent = startMockAgent({ BusinessPartners: [], SalesPersons: [] }); });
afterAll(() => agent.stop());

/** The mail each address got since `mark`, once every notification in flight has gone out. By
 *  identity, not index: the outbox keeps the last 50 only, so a full run shifts it. */
async function mailSince(before: Set<unknown>) {
  await notificationsSettled();
  const got = devOutbox.filter((m) => !before.has(m));
  return (email: string) => got.filter((m) => m.to === email);
}
/** A snapshot taken once every earlier send has landed — a send still rendering would otherwise
 *  arrive after the mark and count as the next step's mail. */
const mark = async () => {
  await notificationsSettled();
  return new Set<unknown>(devOutbox);
};

async function seat(companyId: string, tenantId: string, role: PortalRole) {
  const u = await makePortalUser();
  await db.insert(portalMember).values({ companyId, userId: u.userId, tenantId, role });
  return u;
}

async function setup() {
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  const owner = await makeUser("owner", t.tenantId);
  const admin = await makeUser("admin", t.tenantId);
  const rep = await makeUser("member", t.tenantId);
  const buyer = await makePortalUser();
  const company = await makePortalSeat(t.tenantId, buyer.userId, "buyer");
  const colleague = await seat(company.id, t.tenantId, "owner");
  const viewer = await seat(company.id, t.tenantId, "viewer");
  const [model] = await db.insert(configModel)
    .values({ tenantId: t.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true, portalPricing: "request" })
    .returning();
  const as = (cookie: string) => ({ context: { headers: tenantHeaders(t.slug, cookie) } });
  const on = (cookie: string) => ({ context: { headers: portalHeaders(t.slug, cookie) } });
  /** A project the buyer created and calculated, still a draft. */
  const draft = async () => {
    const { id } = await call(portalRouter.projects.create, { modelId: model!.id, name: "Kabel 1" }, on(buyer.cookie));
    await call(portalRouter.projects.calculate, { id, entries: { material: "steel" } }, on(buyer.cookie));
    return id;
  };
  return { ...t, owner, admin, rep, buyer, colleague, viewer, company, as, on, draft };
}

describe("notifications", () => {
  test("staff: the assignee, else the BP's sales employee, else the fallback list, else admins and owners", async () => {
    const s = await setup();
    const id = await s.draft();

    // A client's draft is private: a comment on it reaches nobody at the supplier.
    let m = await mark();
    await call(portalRouter.timeline.comment, { projectId: id, note: "Hm" }, s.on(s.buyer.cookie));
    let to = await mailSince(m);
    expect([s.owner, s.admin, s.rep].flatMap((u) => to(u.email))).toHaveLength(0);

    // No assignee, the BP has no sales employee in SAP, no fallback: the admins and owners.
    m = await mark();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    to = await mailSince(m);
    expect(to(s.owner.email).map((x) => x.subject)).toEqual([`New request from Kunde GmbH: Kabel 1`]);
    expect(to(s.admin.email)).toHaveLength(1);
    expect(to(s.rep.email)).toHaveLength(0);
    // Internal mail is Confire's own, and replies to the client who acted.
    expect(to(s.owner.email)[0]).toMatchObject({ from: '"Confire" <notify@mail.lvh.me>', replyTo: s.buyer.email });
    expect(to(s.owner.email)[0]!.text).toContain(`/configs/${id}`);

    // The fallback list picks who instead.
    await call(router.portalSettings.save, { notifyFallback: [s.admin.userId] }, s.as(s.owner.cookie));
    m = await mark();
    await call(portalRouter.timeline.comment, { projectId: id, note: "Any news?" }, s.on(s.buyer.cookie));
    to = await mailSince(m);
    expect(to(s.admin.email).map((x) => x.subject)).toEqual([`${s.buyer.email} (Kunde GmbH) commented on Kabel 1`]);
    expect(to(s.admin.email)[0]!.text).toContain("Any news?");
    expect(to(s.owner.email)).toHaveLength(0);

    // The BP's sales employee in SAP, matched to a member by email, comes before the list.
    agent.store.BusinessPartners!.push({ CardCode: s.company.cardCode, SalesPersonCode: 7 });
    agent.store.SalesPersons!.push({ SalesEmployeeCode: 7, Email: s.rep.email.toUpperCase() });
    m = await mark();
    await call(portalRouter.timeline.comment, { projectId: id, note: "Hello?" }, s.on(s.buyer.cookie));
    to = await mailSince(m);
    expect(to(s.rep.email)).toHaveLength(1);
    expect(to(s.admin.email)).toHaveLength(0);

    // Once accepted, the assignee.
    await call(router.requests.accept, { id }, s.as(s.owner.cookie));
    m = await mark();
    await call(portalRouter.timeline.comment, { projectId: id, note: "Thanks" }, s.on(s.buyer.cookie));
    to = await mailSince(m);
    expect(to(s.owner.email)).toHaveLength(1);
    expect(to(s.rep.email)).toHaveLength(0);
    const [ev] = await db.select().from(configProjectEvent).where(eq(configProjectEvent.projectId, id))
      .orderBy(asc(configProjectEvent.at));
    expect(ev!.mailError).toBeNull();
  });

  test("client: buyers by default, the creator or nobody by setting, the company's override first; revisions folded in", async () => {
    const s = await setup();
    const id = await s.draft();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));

    // Default `buyers`: the creator and every buyer and owner, never a viewer who didn't create it.
    let m = await mark();
    await call(router.requests.accept, { id, note: "On it" }, s.as(s.admin.cookie));
    let to = await mailSince(m);
    expect(to(s.buyer.email).map((x) => x.subject)).toEqual([`${s.slug} is reviewing Kabel 1`]);
    expect(to(s.colleague.email)).toHaveLength(1);
    expect(to(s.viewer.email)).toHaveLength(0);
    // Client mail: the supplier's name, Confire's domain (no sender domain), replies to whoever acted.
    expect(to(s.buyer.email)[0]).toMatchObject({ from: `"${s.slug}" <notify@mail.lvh.me>`, replyTo: s.admin.email });
    expect(to(s.buyer.email)[0]!.text).toContain(`/projects/${id}`);

    // An internal note mails nobody; a comment for the client does.
    m = await mark();
    await call(router.timeline.comment, { projectId: id, note: "Check the margin", internalOnly: true }, s.as(s.admin.cookie));
    await call(router.timeline.comment, { projectId: id, note: "Steel is late this month" }, s.as(s.admin.cookie));
    to = await mailSince(m);
    expect(to(s.buyer.email).map((x) => x.text).join()).not.toContain("margin");
    expect(to(s.buyer.email)).toHaveLength(1);
    expect(to(s.buyer.email)[0]!.text).toContain("Steel is late this month");

    // Tenant setting `creator`, the tenant's Reply-To; the company override `off` wins over the tenant.
    await call(router.portalSettings.save, { notify: { returned: "creator", comment: "buyers" }, replyTo: "Sales@Example.com" }, s.as(s.owner.cookie));
    await call(router.portalCompanies.setNotify, { cardCode: s.company.cardCode, notify: { comment: "off" } }, s.as(s.owner.cookie));
    m = await mark();
    await call(router.timeline.comment, { projectId: id, note: "Silent" }, s.as(s.admin.cookie));
    // `revised` sends no mail of its own: the send-back's lists the change.
    await call(router.configs.calculate, { id, entries: { material: "alu" } }, s.as(s.admin.cookie));
    await call(router.requests.sendBack, { id, note: "Aluminium is what we can do" }, s.as(s.admin.cookie));
    to = await mailSince(m);
    expect(to(s.colleague.email)).toHaveLength(0);
    expect(to(s.buyer.email).map((x) => x.subject)).toEqual(["Changes requested on Kabel 1"]);
    const sent = to(s.buyer.email)[0]!;
    expect(sent.replyTo).toBe("sales@example.com");
    expect(sent.text).toContain("Material: steel → alu");
    expect(sent.text).toContain("Aluminium is what we can do");

    const company = await call(router.portalCompanies.get, { cardCode: s.company.cardCode }, s.as(s.owner.cookie));
    expect(company.notify).toMatchObject({ company: { comment: "off" }, tenant: { returned: "creator", comment: "buyers" } });
  });
});

describe("files", () => {
  const internal = fileRoutes("internal");
  const external = fileRoutes("external");
  const upload = (app: typeof internal, headers: Headers, projectId: string, body: Uint8Array | string, q = "name=Zeichnung%20%C3%BC.pdf") =>
    app.request(`/files/${projectId}?${q}`, { method: "POST", body, headers: new Headers([...headers, ["content-type", "application/pdf"]]) });

  test("upload on the timeline, download as an attachment, fenced per side; viewers read only; 10 MB", async () => {
    const s = await setup();
    const id = await s.draft();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    await call(router.requests.accept, { id }, s.as(s.admin.cookie));

    let m = await mark();
    const res = await upload(external, portalHeaders(s.slug, s.buyer.cookie), id, "%PDF-1.4 drawing");
    expect(res.status).toBe(201);
    const { id: fileId } = (await res.json()) as { id: string };
    const to = await mailSince(m);
    expect(to(s.admin.email).map((x) => x.subject)).toEqual([`${s.buyer.email} (Kunde GmbH) added a file to Kabel 1`]);

    const tl = await call(portalRouter.timeline.list, { projectId: id }, s.on(s.buyer.cookie));
    expect(tl.events.find((e) => e.kind === "file")!.payload).toEqual({ fileId, name: "Zeichnung ü.pdf", size: 16 });

    for (const [app, headers] of [[external, portalHeaders(s.slug, s.viewer.cookie)], [internal, tenantHeaders(s.slug, s.rep.cookie)]] as const) {
      const got = await app.request(`/files/${fileId}`, { headers });
      expect(got.status).toBe(200);
      expect(got.headers.get("content-disposition")).toBe(`attachment; filename="Zeichnung _.pdf"; filename*=UTF-8''Zeichnung%20%C3%BC.pdf`);
      expect(got.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await got.text()).toBe("%PDF-1.4 drawing");
    }

    // Staff may keep a file internal: the portal cannot list it, fetch it or hear of it.
    m = await mark();
    const secret = await upload(internal, tenantHeaders(s.slug, s.admin.cookie), id, "costing", "name=calc.xlsx&internal=1");
    const { id: secretId } = (await secret.json()) as { id: string };
    expect((await external.request(`/files/${secretId}`, { headers: portalHeaders(s.slug, s.buyer.cookie) })).status).toBe(404);
    expect((await mailSince(m))(s.buyer.email)).toHaveLength(0);
    const seen = await call(portalRouter.timeline.list, { projectId: id }, s.on(s.buyer.cookie));
    expect(seen.events.filter((e) => e.kind === "file")).toHaveLength(1);

    // Viewers don't upload; another company's buyer sees nothing; no session, nothing.
    expect((await upload(external, portalHeaders(s.slug, s.viewer.cookie), id, "x")).status).toBe(403);
    const stranger = await makePortalUser();
    await makePortalSeat(s.tenantId, stranger.userId, "buyer", "Other GmbH");
    expect((await external.request(`/files/${fileId}`, { headers: portalHeaders(s.slug, stranger.cookie) })).status).toBe(404);
    expect((await upload(external, portalHeaders(s.slug, stranger.cookie), id, "x")).status).toBe(404);
    expect((await external.request(`/files/${fileId}`, { headers: portalHeaders(s.slug) })).status).toBe(401);

    // Counted on the stream, not on what the request claims.
    expect((await upload(external, portalHeaders(s.slug, s.buyer.cookie), id, new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
  });

  test("the logo: admins upload a PNG or JPEG, anyone may fetch it, branding shows on the portal and in mail", async () => {
    const s = await setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const post = (cookie: string, body: Uint8Array | string) =>
      internal.request("/files/logo", { method: "POST", body, headers: tenantHeaders(s.slug, cookie) });
    expect((await post(s.rep.cookie, png)).status).toBe(403);
    expect((await post(s.admin.cookie, "<svg onload=alert(1)>")).status).toBe(415);
    const res = await post(s.admin.cookie, png);
    expect(res.status).toBe(201);
    const { id: logoId } = (await res.json()) as { id: string };

    const got = await external.request(`/files/${logoId}`);
    expect(got.status).toBe(200);
    expect(got.headers.get("content-type")).toBe("image/png");

    // Save refuses an accent white text can't be read on, and a logo that isn't this tenant's.
    const save = (branding: Record<string, string>) => call(router.portalSettings.save, { branding }, s.as(s.admin.cookie));
    expect(await messageOf(save({ accent: "#ffcc00" }))).toContain("contrast of 1.");
    expect(await codeOf(save({ logoFileId: crypto.randomUUID() }))).toBe("BAD_REQUEST");
    await save({ displayName: "Müller & Söhne", accent: "#0A6ED1", logoFileId: logoId });

    const me = await call(portalRouter.me, undefined, s.on(s.buyer.cookie));
    expect(me.tenant).toMatchObject({ name: "Müller & Söhne", accent: "#0a6ed1" });
    expect(me.tenant.logo).toEndWith(`/files/${logoId}`);

    const m = await mark();
    const { id } = await call(portalRouter.projects.create, { modelId: (await db.select().from(configModel).where(eq(configModel.tenantId, s.tenantId)))[0]!.id, name: "P" }, s.on(s.buyer.cookie));
    await call(portalRouter.projects.calculate, { id, entries: { material: "steel" } }, s.on(s.buyer.cookie));
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    await call(router.requests.accept, { id }, s.as(s.admin.cookie));
    const mail = (await mailSince(m))(s.buyer.email)[0]!;
    expect(mail.from).toBe('"Müller & Söhne" <notify@mail.lvh.me>');
    expect(mail.html).toContain(`/files/${logoId}`);
    expect(mail.html).toContain("#0a6ed1");
  });
});

describe("settings and home", () => {
  test("general lists staff for the fallback; the fallback refuses outsiders", async () => {
    const s = await setup();
    const g = await call(router.portalSettings.general, undefined, s.as(s.admin.cookie));
    expect(g.staff.map((x) => x.userId).sort()).toEqual([s.owner.userId, s.admin.userId, s.rep.userId].sort());
    expect(g.senderDomain).toBeNull();
    expect(g.senderDomains.enabled).toBe(false); // the test preload drops RESEND_ADMIN_KEY
    expect(await codeOf(call(router.portalSettings.save, { notifyFallback: [s.buyer.userId] }, s.as(s.admin.cookie)))).toBe("BAD_REQUEST");
    expect(await codeOf(call(router.portalSettings.general, undefined, s.as(s.rep.cookie)))).toBe("FORBIDDEN");
  });

  test("home.overview: the company's projects by status and the quotes awaiting an answer", async () => {
    const s = await setup();
    const a = await s.draft();
    await s.draft();
    await call(portalRouter.projects.submit, { id: a }, s.on(s.buyer.cookie));
    const o = await call(portalRouter.home.overview, undefined, s.on(s.viewer.cookie));
    expect(o).toEqual({ byStatus: { draft: 1, submitted: 1 }, awaiting: [] });
    const other = await makePortalUser();
    await makePortalSeat(s.tenantId, other.userId, "buyer");
    expect((await call(portalRouter.home.overview, undefined, s.on(other.cookie))).byStatus).toEqual({});
  });

  test("home.documents: CardCode-fenced, ALWAYS fields only", async () => {
    const s = await setup();
    await call(portalRouter.home.documents, undefined, s.on(s.buyer.cookie));
    const reads = agent.calls.filter((c) => c.route === "/entity-set" && ["Quotations", "Orders", "DeliveryNotes", "Invoices"].includes(c.body.entitySet as string)).slice(-4);
    for (const r of reads) {
      const q = r.body.query as { filter: string; select: string[] };
      expect(q.filter).toStartWith(`CardCode eq '${s.company.cardCode}'`);
      expect(q.select).toEqual(["DocEntry", "DocNum", "DocDate", "DocumentStatus", "DocTotal", "DocCurrency"]);
    }
  });
});

describe("pure rules", () => {
  test("contrast against white text", () => {
    expect(contrastOnWhite("#ffffff")).toBeCloseTo(1, 5);
    expect(contrastOnWhite("#000000")).toBeCloseTo(21, 5);
    expect(contrastOnWhite("#0a6ed1")).toBeGreaterThan(4.5); // Horizon blue, the default accent
    expect(contrastOnWhite("#ffcc00")).toBeLessThan(4.5);
  });

  test("a sender is a subdomain of the tenant's own domain", () => {
    expect(senderNameProblem("mail.mueller-gmbh.de")).toBeNull();
    expect(senderNameProblem("mueller-gmbh.de")).toContain("Use a subdomain");
    expect(senderNameProblem("acme.lvh.me")).toContain("belongs to Confire");
    expect(senderNameProblem("mail.lvh.me")).toContain("belongs to Confire");
    expect(senderNameProblem("mail mueller.de")).toContain("Enter a domain");
  });

  test("files: a logo by its bytes, names without paths", () => {
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(Buffer.from("GIF89a"))).toBeNull();
    expect(cleanName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(cleanName("")).toBe("file");
  });
});
