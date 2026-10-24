import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProjectEvent, member, portalCompany, type PortalRole } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { devOutbox, mailDomain } from "../src/mail/mailer.ts";
import { notificationsSettled } from "../src/notify.ts";
import { NOTIFICATION_TYPES } from "../src/notifications.ts";
import { fileRoutes, imageType, cleanName } from "../src/files.ts";
import { contrastOnWhite } from "../src/portal/settings.ts";
import {
  call, insertSeat, makePortalSeat, makePortalUser, makeTenant, makeUser, tenantHeaders, TEST_MODEL,
} from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// Who hears about a project event and how (notifications spec 2026-10-22 §4, §12: bell and mail, each
// user's own switches), reassigning a request (§6), files on the timeline (D14), branding (D20) and
// the portal home. Every hop goes through the real routers and file routes.

const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

let agent: MockAgent;
beforeAll(() => { agent = startMockAgent({}); });
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

async function seat(cardCode: string, tenantId: string, role: PortalRole) {
  const u = await makePortalUser();
  await insertSeat(tenantId, cardCode, u.userId, role);
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
  const colleague = await seat(company.cardCode, t.tenantId, "owner");
  const viewer = await seat(company.cardCode, t.tenantId, "viewer");
  const [model] = await db.insert(configModel)
    .values({ tenantId: t.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true, portalPricing: "request" })
    .returning();
  const as = (cookie: string) => ({ context: { headers: tenantHeaders(t.slug, cookie) } });
  const on = (cookie: string) => ({ context: { headers: tenantHeaders(t.slug, cookie) } });
  /** A project the buyer created and calculated, still a draft. */
  const draft = async () => {
    const { id } = await call(portalRouter.projects.create, { modelId: model!.id, name: "Kabel 1" }, on(buyer.cookie));
    await call(portalRouter.projects.calculate, { id, entries: { material: "steel" } }, on(buyer.cookie));
    return id;
  };
  /** A user's bell at this tenant, newest first, through their own app's router, once every
   *  notification in flight has landed. */
  const bell = async (u: { userId: string; cookie: string }) => {
    await notificationsSettled();
    return [owner, admin, rep].some((x) => x.userId === u.userId)
      ? call(router.notifications.list, undefined, as(u.cookie))
      : call(portalRouter.notifications.list, undefined, on(u.cookie));
  };
  return { ...t, owner, admin, rep, buyer, colleague, viewer, company, as, on, draft, bell };
}

describe("notifications", () => {
  test("staff: a first submit reaches every staff member by their own switches; once assigned, the assignee only", async () => {
    const s = await setup();
    const id = await s.draft();
    // rep keeps mail only; admin switches both channels off.
    for (const [u, channel] of [[s.rep, "bell"], [s.admin, "bell"], [s.admin, "mail"]] as const) {
      await call(router.notifications.setPreference, { type: "request.submitted", channel, enabled: false }, s.as(u.cookie));
    }

    // A client's draft is private: a comment on it reaches nobody at the supplier.
    let m = await mark();
    await call(portalRouter.timeline.comment, { projectId: id, note: "Hm" }, s.on(s.buyer.cookie));
    let to = await mailSince(m);
    expect([s.owner, s.admin, s.rep].flatMap((u) => to(u.email))).toHaveLength(0);
    expect(await s.bell(s.owner)).toHaveLength(0);

    // No assignee yet: every staff member, minus each one's own switch-offs.
    m = await mark();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    to = await mailSince(m);
    expect(to(s.owner.email).map((x) => x.subject)).toEqual([`New request from Kunde GmbH: Kabel 1`]);
    // Internal mail is Confire's own, from notify@.
    expect(to(s.owner.email)[0]).toMatchObject({ from: `"Confire" <notify@${mailDomain}>` });
    expect(to(s.owner.email)[0]!.text).toContain(`/configs/${id}`);
    expect(to(s.rep.email)).toHaveLength(1);
    expect(to(s.admin.email)).toHaveLength(0);
    expect(await s.bell(s.owner)).toMatchObject([{
      type: "request.submitted", path: `/configs/${id}`, read: false,
      params: { projectName: "Kabel 1", companyName: "Kunde GmbH", actorName: s.buyer.email },
    }]);
    expect(await s.bell(s.rep)).toHaveLength(0);
    expect(await s.bell(s.admin)).toHaveLength(0);
    expect(await call(router.notifications.unreadCount, undefined, s.as(s.owner.cookie))).toEqual({ count: 1 });

    // Accepted: the acceptor holds it, and hears the client's activity alone.
    await call(router.requests.accept, { id }, s.as(s.rep.cookie));
    m = await mark();
    await call(portalRouter.timeline.comment, { projectId: id, note: "Any news?" }, s.on(s.buyer.cookie));
    to = await mailSince(m);
    expect(to(s.rep.email).map((x) => x.subject)).toEqual([`${s.buyer.email} (Kunde GmbH) commented on Kabel 1`]);
    expect(to(s.rep.email)[0]!.text).toContain("Any news?");
    expect([s.owner, s.admin].flatMap((u) => to(u.email))).toHaveLength(0);
    expect(await s.bell(s.rep)).toMatchObject([{ type: "request.comment", params: { note: "Any news?" } }]);
    expect(await s.bell(s.owner)).toHaveLength(1);
    const events = await db.select().from(configProjectEvent).where(eq(configProjectEvent.projectId, id));
    expect(events.every((e) => e.mailError === null)).toBe(true);

    // An assignee who has left counts as none: the request falls back to everyone, never silent.
    await db.delete(member).where(and(eq(member.organizationId, s.tenantId), eq(member.userId, s.rep.userId)));
    m = await mark();
    await call(portalRouter.timeline.comment, { projectId: id, note: "Hello?" }, s.on(s.buyer.cookie));
    to = await mailSince(m);
    expect(to(s.owner.email)).toHaveLength(1);
    expect(to(s.admin.email)).toHaveLength(1);
    expect(to(s.rep.email)).toHaveLength(0);
  });

  test("client mail is in the company's SAP language; staff mail stays English", async () => {
    const s = await setup();
    await db.update(portalCompany).set({ languageCode: 23 })
      .where(and(eq(portalCompany.tenantId, s.tenantId), eq(portalCompany.cardCode, s.company.cardCode)));
    const id = await s.draft();
    let m = await mark();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    let to = await mailSince(m);
    expect(to(s.owner.email)[0]!.subject).toContain("New request from");

    m = await mark();
    await call(router.requests.accept, { id, note: "On it" }, s.as(s.admin.cookie));
    to = await mailSince(m);
    expect(to(s.buyer.email).map((x) => x.subject)).toEqual([`${s.slug} está revisando Kabel 1`]);
    expect(to(s.buyer.email)[0]!.text).toContain("Abrir el proyecto");
  });

  test("client: the creator only, while still at the company; internal notes never; revisions folded in", async () => {
    const s = await setup();
    const id = await s.draft();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));

    let m = await mark();
    await call(router.requests.accept, { id, note: "On it" }, s.as(s.admin.cookie));
    let to = await mailSince(m);
    expect(to(s.buyer.email).map((x) => x.subject)).toEqual([`${s.slug} is reviewing Kabel 1`]);
    expect([s.colleague, s.viewer].flatMap((u) => to(u.email))).toHaveLength(0);
    // Client mail: the supplier's name, Confire's domain, the project's portal page.
    expect(to(s.buyer.email)[0]).toMatchObject({ from: `"${s.slug}" <${s.slug}@${mailDomain}>` });
    expect(to(s.buyer.email)[0]!.text).toContain(`/projects/${id}`);
    expect(await s.bell(s.buyer)).toMatchObject([{ type: "project.accepted", path: `/projects/${id}`, params: { note: "On it" } }]);
    expect(await s.bell(s.colleague)).toHaveLength(0);

    // An internal note tells nobody; a comment for the client tells its creator.
    m = await mark();
    await call(router.timeline.comment, { projectId: id, note: "Check the margin", internalOnly: true }, s.as(s.admin.cookie));
    await call(router.timeline.comment, { projectId: id, note: "Steel is late this month" }, s.as(s.admin.cookie));
    to = await mailSince(m);
    expect(to(s.buyer.email)).toHaveLength(1);
    expect(to(s.buyer.email)[0]!.text).toContain("Steel is late this month");
    expect(JSON.stringify(await s.bell(s.buyer))).not.toContain("margin");

    // `revised` sends nothing of its own: the send-back lists the change.
    m = await mark();
    await call(router.configs.calculate, { id, entries: { material: "alu" } }, s.as(s.admin.cookie));
    await call(router.requests.sendBack, { id, note: "Aluminium is what we can do" }, s.as(s.admin.cookie));
    to = await mailSince(m);
    expect(to(s.buyer.email).map((x) => x.subject)).toEqual(["Changes requested on Kabel 1"]);
    const sent = to(s.buyer.email)[0]!;
    expect(sent).not.toHaveProperty("replyTo"); // no-reply notification mail
    expect(sent.text).toContain("Material: steel → alu");
    expect(sent.text).toContain("Aluminium is what we can do");
    expect((await s.bell(s.buyer)).map((n) => n.type)).toEqual(["project.returned", "project.comment", "project.accepted"]);
  });

  test("client: a staff quote tells the creator; once they have left the company, nobody", async () => {
    const s = await setup();
    const id = await s.draft();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    await call(router.requests.accept, { id }, s.as(s.admin.cookie));
    const { project } = await call(router.configs.calculate, { id }, s.as(s.admin.cookie));
    await call(router.configs.select, {
      projectId: id, selection: project.candidates[0]!.perBatch.map((b) => ({ candidateIdx: 0, batchQty: b.batchQty })),
    }, s.as(s.admin.cookie));
    const d = await call(router.configs.quoteDraft, { projectId: id }, s.as(s.admin.cookie));
    let m = await mark();
    const posted = await call(router.configs.createQuote, { projectId: id, commandId: d.commandId }, s.as(s.admin.cookie));
    let to = await mailSince(m);
    expect(to(s.buyer.email).map((x) => x.subject)).toEqual([`Quotation ${posted.docNum} for Kabel 1`]);
    expect([s.colleague, s.viewer].flatMap((u) => to(u.email))).toHaveLength(0);
    expect((await s.bell(s.buyer))[0]).toMatchObject({ type: "project.quoted", params: { docNum: posted.docNum } });

    await db.delete(member).where(and(eq(member.organizationId, s.tenantId), eq(member.userId, s.buyer.userId)));
    m = await mark();
    await call(router.timeline.comment, { projectId: id, note: "Any questions?" }, s.as(s.admin.cookie));
    to = await mailSince(m);
    expect([s.buyer, s.colleague, s.viewer].flatMap((u) => to(u.email))).toHaveLength(0);
  });

  test("reassign: staff only, never a draft, never told to the actor; accept keeps it", async () => {
    const s = await setup();
    const id = await s.draft();
    const assign = (userId: string, as = s.admin) => call(router.requests.assign, { projectId: id, userId }, s.as(as.cookie));
    // A draft is not the supplier's to see, let alone assign.
    expect(await codeOf(assign(s.rep.userId))).toBe("NOT_FOUND");
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    // Only the workspace's staff: not its client, not someone else's staff.
    const stranger = await makeUser("owner", (await makeTenant()).tenantId);
    expect(await codeOf(assign(s.buyer.userId))).toBe("BAD_REQUEST");
    expect(await codeOf(assign(stranger.userId))).toBe("BAD_REQUEST");
    // A client cannot reach the staff router at all.
    expect(await codeOf(call(router.requests.assign, { projectId: id, userId: s.buyer.userId }, s.as(s.buyer.cookie)))).toBe("FORBIDDEN");

    // Reassigned before anyone accepted: the new assignee hears, the actor does not.
    let m = await mark();
    expect(await assign(s.rep.userId)).toEqual({ assigneeId: s.rep.userId, assigneeName: s.rep.email });
    let to = await mailSince(m);
    expect(to(s.rep.email).map((x) => x.subject)).toEqual([`${s.admin.email} assigned Kabel 1 (Kunde GmbH) to you`]);
    expect([s.owner, s.admin].flatMap((u) => to(u.email))).toHaveLength(0);
    expect((await s.bell(s.rep))[0]).toMatchObject({ type: "request.assigned", path: `/configs/${id}`, params: { actorName: s.admin.email } });
    // An internal event: the staff timeline has it, the client's doesn't.
    const staffTl = await call(router.timeline.list, { projectId: id }, s.as(s.owner.cookie));
    expect(staffTl.events.find((e) => e.kind === "assigned")).toMatchObject({
      visibility: "internal", payload: { assigneeId: s.rep.userId, assigneeName: s.rep.email },
    });
    const clientTl = await call(portalRouter.timeline.list, { projectId: id }, s.on(s.buyer.cookie));
    expect(clientTl.events.some((e) => e.kind === "assigned")).toBe(false);

    // Accept keeps an existing assignee: the request stays rep's, and accept tells no one it was assigned.
    m = await mark();
    await call(router.requests.accept, { id }, s.as(s.admin.cookie));
    expect((await call(router.configs.get, { id }, s.as(s.admin.cookie))).request?.assigneeName).toBe(s.rep.email);
    to = await mailSince(m);
    expect([s.owner, s.admin, s.rep].flatMap((u) => to(u.email))).toHaveLength(0);

    // Self-reassign: nobody is told; the current assignee again: nothing is written.
    m = await mark();
    await assign(s.admin.userId);
    to = await mailSince(m);
    expect([s.owner, s.admin, s.rep].flatMap((u) => to(u.email))).toHaveLength(0);
    expect((await s.bell(s.admin)).some((n) => n.type === "request.assigned")).toBe(false);
    const count = async () => (await db.select().from(configProjectEvent).where(eq(configProjectEvent.projectId, id))).length;
    const before = await count();
    await assign(s.admin.userId);
    expect(await count()).toBe(before);
  });

  test("the fence: own rows, the path's tenant, the caller's side of the catalog", async () => {
    const s = await setup();
    const id = await s.draft();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    await notificationsSettled();
    const [row] = await s.bell(s.owner);

    // Another user's id is a silent no-op, both ways.
    await call(router.notifications.markRead, { ids: [row!.id] }, s.as(s.admin.cookie));
    await call(router.notifications.dismiss, { id: row!.id }, s.as(s.admin.cookie));
    expect(await s.bell(s.owner)).toMatchObject([{ id: row!.id, read: false }]);
    // A client is refused the staff router outright (the membership join), whatever x-tenant says.
    expect(await codeOf(call(router.notifications.list, undefined, s.as(s.buyer.cookie)))).toBe("FORBIDDEN");

    // The same person at another workspace sees that workspace's rows only.
    const other = await makeTenant();
    await db.insert(member).values({ id: crypto.randomUUID(), organizationId: other.tenantId, userId: s.owner.userId, role: "member", createdAt: new Date() });
    const there = { context: { headers: tenantHeaders(other.slug, s.owner.cookie) } };
    expect(await call(router.notifications.list, undefined, there)).toHaveLength(0);
    expect(await call(router.notifications.unreadCount, undefined, there)).toEqual({ count: 0 });

    // Read, then gone.
    await call(router.notifications.markRead, {}, s.as(s.owner.cookie));
    expect(await s.bell(s.owner)).toMatchObject([{ id: row!.id, read: true }]);
    await call(router.notifications.dismiss, { id: row!.id }, s.as(s.owner.cookie));
    expect(await s.bell(s.owner)).toHaveLength(0);

    // Each side lists its own types, all on by default, and refuses the other side's.
    const staffSettings = await call(router.notifications.settings, undefined, s.as(s.rep.cookie));
    expect(staffSettings.map((t) => t.id)).toEqual(NOTIFICATION_TYPES.filter((t) => t.audience === "staff").map((t) => t.id));
    expect(staffSettings.every((t) => t.bell && t.mail && t.group === "portal")).toBe(true);
    expect(await codeOf(call(router.notifications.setPreference, { type: "project.quoted", channel: "mail", enabled: false }, s.as(s.rep.cookie)))).toBe("BAD_REQUEST");
    expect(await codeOf(call(portalRouter.notifications.setPreference, { type: "request.submitted", channel: "mail", enabled: false }, s.on(s.buyer.cookie)))).toBe("BAD_REQUEST");
    await call(portalRouter.notifications.setPreference, { type: "project.quoted", channel: "mail", enabled: false }, s.on(s.buyer.cookie));
    await call(portalRouter.notifications.setPreference, { type: "project.quoted", channel: "mail", enabled: false }, s.on(s.buyer.cookie));
    const quoted = () => call(portalRouter.notifications.settings, undefined, s.on(s.buyer.cookie)).then((r) => r.find((t) => t.id === "project.quoted"));
    expect(await quoted()).toEqual({ id: "project.quoted", group: "portal", bell: true, mail: false });
    await call(portalRouter.notifications.setPreference, { type: "project.quoted", channel: "mail", enabled: true }, s.on(s.buyer.cookie));
    expect(await quoted()).toMatchObject({ bell: true, mail: true });
  });
});

describe("files", () => {
  const internal = fileRoutes("internal");
  const external = fileRoutes("external");
  // The tenant is the route's first segment (a download is a plain link: no x-tenant header).
  const upload = (app: typeof internal, slug: string, cookie: string, projectId: string, body: Uint8Array | string, q = "name=Zeichnung%20%C3%BC.pdf") =>
    app.request(`/files/${slug}/${projectId}?${q}`, { method: "POST", body, headers: { cookie, "content-type": "application/pdf" } });
  const download = (app: typeof internal, slug: string, fileId: string, cookie?: string) =>
    app.request(`/files/${slug}/${fileId}`, { headers: cookie ? { cookie } : {} });

  test("upload on the timeline, download as an attachment, fenced per side; viewers read only; 10 MB", async () => {
    const s = await setup();
    const id = await s.draft();
    await call(portalRouter.projects.submit, { id }, s.on(s.buyer.cookie));
    await call(router.requests.accept, { id }, s.as(s.admin.cookie));

    let m = await mark();
    const res = await upload(external, s.slug, s.buyer.cookie, id, "%PDF-1.4 drawing");
    expect(res.status).toBe(201);
    const { id: fileId } = (await res.json()) as { id: string };
    const to = await mailSince(m);
    expect(to(s.admin.email).map((x) => x.subject)).toEqual([`${s.buyer.email} (Kunde GmbH) added a file to Kabel 1`]);
    expect((await s.bell(s.admin))[0]).toMatchObject({ type: "request.file", params: { fileName: "Zeichnung ü.pdf" } });

    const tl = await call(portalRouter.timeline.list, { projectId: id }, s.on(s.buyer.cookie));
    expect(tl.events.find((e) => e.kind === "file")!.payload).toEqual({ fileId, name: "Zeichnung ü.pdf", size: 16 });

    for (const [app, cookie] of [[external, s.viewer.cookie], [internal, s.rep.cookie]] as const) {
      const got = await download(app, s.slug, fileId, cookie);
      expect(got.status).toBe(200);
      expect(got.headers.get("content-disposition")).toBe(`attachment; filename="Zeichnung _.pdf"; filename*=UTF-8''Zeichnung%20%C3%BC.pdf`);
      expect(got.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await got.text()).toBe("%PDF-1.4 drawing");
    }

    // Staff may keep a file internal: the portal cannot list it, fetch it or hear of it.
    m = await mark();
    const secret = await upload(internal, s.slug, s.admin.cookie, id, "costing", "name=calc.xlsx&internal=1");
    const { id: secretId } = (await secret.json()) as { id: string };
    expect((await download(external, s.slug, secretId, s.buyer.cookie)).status).toBe(404);
    expect((await mailSince(m))(s.buyer.email)).toHaveLength(0);
    const seen = await call(portalRouter.timeline.list, { projectId: id }, s.on(s.buyer.cookie));
    expect(seen.events.filter((e) => e.kind === "file")).toHaveLength(1);

    // Viewers don't upload; another company's buyer sees nothing; no session, nothing.
    expect((await upload(external, s.slug, s.viewer.cookie, id, "x")).status).toBe(403);
    const stranger = await makePortalUser();
    await makePortalSeat(s.tenantId, stranger.userId, "buyer", "Other GmbH");
    expect((await download(external, s.slug, fileId, stranger.cookie)).status).toBe(404);
    expect((await upload(external, s.slug, stranger.cookie, id, "x")).status).toBe(404);
    expect((await download(external, s.slug, fileId)).status).toBe(401);
    // Another tenant in the path: the buyer has no seat there, and staff no membership.
    const other = await makeTenant();
    expect((await download(external, other.slug, fileId, s.buyer.cookie)).status).toBe(403);
    expect((await download(internal, other.slug, fileId, s.rep.cookie)).status).toBe(403);
    // Staff on the portal's routes, a customer on the staff app's: each side refuses the other.
    expect((await download(external, s.slug, fileId, s.rep.cookie)).status).toBe(403);
    expect((await download(internal, s.slug, fileId, s.buyer.cookie)).status).toBe(403);

    // Counted on the stream, not on what the request claims.
    expect((await upload(external, s.slug, s.buyer.cookie, id, new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
  });

  test("the logo: admins upload a PNG or JPEG, anyone may fetch it, branding shows on the portal and in mail", async () => {
    const s = await setup();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const post = (cookie: string, body: Uint8Array | string) =>
      internal.request(`/files/${s.slug}/logo`, { method: "POST", body, headers: { cookie } });
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
    expect(mail.from).toBe(`"Müller & Söhne" <${s.slug}@${mailDomain}>`);
    expect(mail.html).toContain(`/files/${logoId}`);
    expect(mail.html).toContain("#0a6ed1");
  });
});

describe("settings and home", () => {
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

  test("files: a logo by its bytes, names without paths", () => {
    expect(imageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(imageType(Buffer.from("GIF89a"))).toBeNull();
    expect(cleanName("../../etc/passwd")).toBe(".._.._etc_passwd");
    expect(cleanName("")).toBe("file");
  });
});
