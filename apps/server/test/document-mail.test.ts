import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, configModel, configProject, documentMail, projectFile } from "@confire/db";
import { router } from "../src/orpc/router.ts";
import { portalRouter } from "../src/portal/orpc/router.ts";
import { encryptSecret } from "../src/crypto.ts";
import { documentOutbox, recipientsOf } from "../src/document-mail.ts";
import { devOutbox } from "../src/mail/mailer.ts";
import { notificationsSettled } from "../src/notify.ts";
import { call, makePortalSeat, makePortalUser, makeTenant, makeUser, tenantHeaders, TEST_MODEL } from "./harness.ts";
import { connectTenant, startMockAgent, type MockAgent } from "./mock-agent.ts";

// Document mail (spec docs/superpowers/specs/2026-11-06-document-mail-design.md): whom a posted
// document goes to (§5.4), and the one post's three channels (§5.5) — the document mail from the
// tenant's mailbox (documentOutbox: tests never reach Microsoft), the project timeline's entry with
// the PDF as sent, and the portal client's notification.

describe("recipientsOf", () => {
  const bp = {
    EmailAddress: "general@kunde.example",
    LanguageCode: 23,
    ContactEmployees: [
      { InternalCode: 878, Name: "FACTURAS", E_Mail: "facturaprov@agui.com", Active: "tYES" },
      { InternalCode: 879, Name: "Old", E_Mail: "old@kunde.example", Active: "tNO" },
      { InternalCode: 880, Name: "No mail", E_Mail: null, Active: "tYES" },
      { InternalCode: 881, Name: "Several", E_Mail: "a@kunde.example; b@kunde.example, not-an-address", Active: "Y" },
    ],
  };
  test("the document's contact, when active and with an email", () => {
    expect(recipientsOf({ ContactPersonCode: 878 }, bp)).toEqual({ to: ["facturaprov@agui.com"], lang: "es" });
  });
  test("an inactive contact, or one without an email, falls back to the BP's address", () => {
    expect(recipientsOf({ ContactPersonCode: 879 }, bp).to).toEqual(["general@kunde.example"]);
    expect(recipientsOf({ ContactPersonCode: 880 }, bp).to).toEqual(["general@kunde.example"]);
  });
  test("several addresses split on ; and , with junk dropped; a $crossjoin's `Y` is active", () => {
    expect(recipientsOf({ ContactPersonCode: 881 }, bp).to).toEqual(["a@kunde.example", "b@kunde.example"]);
  });
  test("no contact (0) is the BP's address; nothing anywhere is none", () => {
    expect(recipientsOf({ ContactPersonCode: 0 }, bp).to).toEqual(["general@kunde.example"]);
    expect(recipientsOf({ ContactPersonCode: 0 }, { ...bp, EmailAddress: null })).toEqual({ to: [], lang: "es" });
    expect(recipientsOf({}, { EmailAddress: "x@y.example", LanguageCode: 3 })).toEqual({ to: ["x@y.example"], lang: "en" });
  });
});

let agent: MockAgent;
beforeAll(() => { agent = startMockAgent({}); });
afterAll(() => agent.stop());

/** What went out since `before` (by identity: both outboxes keep the last 50). */
const since = <T,>(box: T[], before: Set<T>) => box.filter((m) => !before.has(m));

async function setup({ email = "ap@kunde.example" as string | null } = {}) {
  agent.pldLayouts.clear();
  const t = await makeTenant();
  await connectTenant(t.tenantId, agent);
  const admin = await makeUser("admin", t.tenantId);
  const buyer = await makePortalUser();
  const company = await makePortalSeat(t.tenantId, buyer.userId, "buyer");
  // The customer as SAP has it: no contact on the documents the mock posts, so its general address.
  (agent.store.BusinessPartners ??= []).push({ CardCode: company.cardCode, EmailAddress: email, LanguageCode: 23, ContactEmployees: [] });
  const [model] = await db.insert(configModel)
    .values({ tenantId: t.tenantId, name: TEST_MODEL.name, definition: TEST_MODEL, portal: true, portalPricing: "request" })
    .returning();
  const staff = { context: { headers: tenantHeaders(t.slug, admin.cookie) } };
  const client = { context: { headers: tenantHeaders(t.slug, buyer.cookie) } };
  const connect = () => db.insert(documentMail).values({
    tenantId: t.tenantId, account: "sales@supplier.example", refreshToken: encryptSecret("refresh"), connectedBy: admin.userId, connectedAt: new Date(),
  });
  /** A client's request, quoted by staff: its project id and quotation. */
  const quoted = async (notify?: boolean) => {
    const { id } = await call(portalRouter.projects.create, { modelId: model!.id, name: "Kabel 1" }, client);
    await call(portalRouter.projects.calculate, { id, set: { material: "steel" } }, client);
    await call(portalRouter.projects.submit, { id }, client);
    await call(router.requests.accept, { id }, staff);
    const { candidates } = await call(router.configs.calculate, { id }, staff);
    await call(router.configs.select, {
      projectId: id, selection: candidates.rows[0]!.perBatch.map((b) => ({ candidateIdx: 0, batchQty: b.batchQty })),
    }, staff);
    const d = await call(router.configs.quoteDraft, { projectId: id }, staff);
    const posted = await call(router.configs.createQuote, { projectId: id, commandId: d.commandId, notify }, staff);
    return { id, posted };
  };
  const copy = (sourceEntity: string, targetEntity: string, docEntry: number, notify?: boolean) =>
    call(router.entities.copy, { sourceEntity, targetEntity, docEntries: [docEntry], notify }, staff);
  const timeline = async (id: string, side: "staff" | "client") => {
    await notificationsSettled();
    return side === "staff"
      ? (await call(router.timeline.list, { projectId: id }, staff)).events
      : (await call(portalRouter.timeline.list, { projectId: id }, client)).events;
  };
  const bell = async (who: "admin" | "buyer") => {
    await notificationsSettled();
    return who === "admin" ? call(router.notifications.list, undefined, staff) : call(portalRouter.notifications.list, undefined, client);
  };
  return { ...t, admin, buyer, company, model: model!, staff, connect, quoted, copy, timeline, bell };
}

const mark = async () => {
  await notificationsSettled();
  return { docs: new Set(documentOutbox), mails: new Set(devOutbox) };
};

describe("document mail", () => {
  test("the switch off sends nothing and writes nothing", async () => {
    const s = await setup();
    await s.connect();
    const m = await mark();
    const { id, posted } = await s.quoted();
    expect(posted.mail).toBeNull();
    await notificationsSettled();
    expect(since(documentOutbox, m.docs)).toHaveLength(0);
    expect((await s.timeline(id, "staff")).some((e) => e.kind === "document_sent")).toBe(false);
  });

  test("an invoice copied under a portal project: the document mail, the PDF on both timelines, the client's bell", async () => {
    const s = await setup();
    const { id, posted } = await s.quoted();
    const order = await s.copy("Quotations", "Orders", posted.docEntry);
    await s.connect();
    const m = await mark();

    const invoice = await s.copy("Orders", "Invoices", order.docEntry, true);
    // Read during the request, so the toast can say it.
    expect(invoice.mail).toEqual({ to: ["ap@kunde.example"] });
    await notificationsSettled();

    // 1. From the tenant's mailbox, to SAP's address, the PDF attached, in the customer's language.
    const [letter, ...more] = since(documentOutbox, m.docs);
    expect(more).toHaveLength(0);
    expect(letter).toMatchObject({
      tenantId: s.tenantId, from: "sales@supplier.example", to: ["ap@kunde.example"],
      subject: `${s.slug} — Factura ${invoice.docNum}`, attachment: { name: `Factura ${invoice.docNum}.pdf` },
    });
    expect(letter!.html).toContain(`Le adjuntamos nuestra factura ${invoice.docNum}`);

    // 2. On the timeline: which document, to whom, the PDF as sent — on the portal's too.
    const sent = (await s.timeline(id, "staff")).find((e) => e.kind === "document_sent");
    expect(sent).toMatchObject({
      actorSide: "internal", visibility: "external",
      payload: { entity: "Invoices", docEntry: invoice.docEntry, docNum: invoice.docNum, company: "SBODEMO", to: ["ap@kunde.example"] },
    });
    const fileId = (sent!.payload as { fileId: string }).fileId;
    const [file] = await db.select().from(projectFile).where(and(eq(projectFile.id, fileId), eq(projectFile.projectId, id)));
    expect(file).toMatchObject({ mime: "application/pdf", visibility: "external", name: `Factura ${invoice.docNum}.pdf` });
    expect(file!.data.toString()).toStartWith("%PDF-1.4\nInvoices:");
    expect((await s.timeline(id, "client")).find((e) => e.kind === "document_sent")?.payload).toMatchObject({ fileId, to: ["ap@kunde.example"] });

    // 3. The client's bell and Confire's mail for the step the invoice is (the project is invoiced now),
    // by their own switches: no attachment, a link to the project, in the company's stored language
    // (unset here, so English) — not the letter's. Once: the mail itself tells nobody.
    expect((await s.bell("buyer")).slice(0, 2)).toMatchObject([
      { type: "project.invoice", path: `/projects/${id}`, params: { docNum: invoice.docNum } },
      { type: "project.order", params: { docNum: order.docNum } },
    ]);
    expect((await db.select({ status: configProject.status }).from(configProject).where(eq(configProject.id, id)))[0]!.status).toBe("invoiced");
    const notice = since(devOutbox, m.mails).filter((x) => x.to === s.buyer.email);
    expect(notice.map((x) => x.subject)).toEqual([`Invoice ${invoice.docNum} for Kabel 1`]);
    expect(notice[0]!.text).toContain(`/projects/${id}`);
  });

  test("a client's request quoted with notify on: Confire's quoted notice only, never the tenant's mailbox", async () => {
    const s = await setup();
    await s.connect();
    const m = await mark();
    const { id, posted } = await s.quoted(true);
    expect(posted.mail).toBeNull();
    await notificationsSettled();
    expect(since(documentOutbox, m.docs)).toHaveLength(0);
    expect((await s.timeline(id, "staff")).some((e) => e.kind === "document_sent")).toBe(false);
    expect((await s.bell("buyer")).map((n) => n.type)).toEqual(["project.quoted", "project.accepted"]);
  });

  test("an internal configuration's quotation goes from the tenant's mailbox", async () => {
    const s = await setup();
    await s.connect();
    const m = await mark();
    const { id } = await call(router.configs.create, {
      modelId: s.model.id, name: "Kabel 2", customer: { cardCode: s.company.cardCode, cardName: "Kunde" },
    }, s.staff);
    const { candidates } = await call(router.configs.calculate, { id, set: { material: "steel" } }, s.staff);
    await call(router.configs.select, {
      projectId: id, selection: candidates.rows[0]!.perBatch.map((b) => ({ candidateIdx: 0, batchQty: b.batchQty })),
    }, s.staff);
    const d = await call(router.configs.quoteDraft, { projectId: id }, s.staff);
    const posted = await call(router.configs.createQuote, { projectId: id, commandId: d.commandId, notify: true }, s.staff);
    expect(posted.mail).toEqual({ to: ["ap@kunde.example"] });
    await notificationsSettled();
    expect(since(documentOutbox, m.docs).map((x) => x.subject)).toEqual([`${s.slug} — Oferta ${posted.docNum}`]);

    // An order off its quotation moves it on as it would a client's request: the status, and the
    // step's event naming the order and who made it — mailed or not.
    const order = await s.copy("Quotations", "Orders", posted.docEntry);
    const ordered = (await s.timeline(id, "staff")).find((e) => e.kind === "ordered");
    expect(ordered).toMatchObject({ actorSide: "internal", payload: { entity: "Orders", docEntry: order.docEntry, docNum: order.docNum } });
    expect(ordered!.actorName).not.toBeNull();
    const [row] = await db.select().from(configProject).where(eq(configProject.id, id));
    expect(row!.status).toBe("ordered");
    // Past draft, it is locked like a quoted one.
    expect(await call(router.configs.calculate, { id, set: { material: "copper" } }, s.staff).catch((e) => e.code)).toBe("CONFLICT");
  });

  test("no email in SAP: said at once, and the project side still runs — the reason for staff only", async () => {
    const s = await setup({ email: null });
    const { id, posted } = await s.quoted();
    await s.connect();
    const m = await mark();
    const order = await s.copy("Quotations", "Orders", posted.docEntry, true);
    expect(order.mail).toEqual({ skipped: "NO_EMAIL" });
    await notificationsSettled();
    expect(since(documentOutbox, m.docs)).toHaveLength(0);
    expect((await s.timeline(id, "staff")).find((e) => e.kind === "document_sent")?.payload).toMatchObject({ to: [], error: "NO_EMAIL" });
    expect((await s.timeline(id, "client")).find((e) => e.kind === "document_sent")?.payload).not.toHaveProperty("error");
    expect((await s.bell("buyer"))[0]).toMatchObject({ type: "project.order" });
    // Not a failure: the toast said it.
    expect((await s.bell("admin")).some((n) => n.type === "document.mail_failed")).toBe(false);
  });

  test("a failing print writes no document event and tells the poster", async () => {
    const s = await setup();
    const { id, posted } = await s.quoted();
    await s.connect();
    agent.defaultLayouts.RDR2 = "RDR20009";
    agent.pldLayouts.add("RDR20009");
    const m = await mark();
    try {
      const order = await s.copy("Quotations", "Orders", posted.docEntry, true);
      expect(order.mail).toEqual({ to: ["ap@kunde.example"] });
      await notificationsSettled();
      expect(since(documentOutbox, m.docs)).toHaveLength(0);
      expect((await s.timeline(id, "staff")).some((e) => e.kind === "document_sent")).toBe(false);
      // The order itself still moved the project on, and the client heard of that once.
      expect((await s.bell("buyer")).filter((n) => n.type === "project.order")).toHaveLength(1);
      const [failed] = await s.bell("admin");
      expect(failed).toMatchObject({
        type: "document.mail_failed", path: `/b1/Orders/${order.docEntry}`,
        params: { entity: "Orders", docNum: String(order.docNum), cardCode: s.company.cardCode },
      });
      expect(String(failed!.params.note)).toContain("RDR20009");
      expect(since(devOutbox, m.mails).filter((x) => x.to === s.admin.email).map((x) => x.subject))
        .toEqual([`Order ${order.docNum} was not emailed`]);
    } finally {
      delete agent.defaultLayouts.RDR2;
    }
  });

  test("create refuses notify for a document that is not printable", async () => {
    const s = await setup();
    await expect(call(router.entities.create, { entity: "BusinessPartners", data: { CardName: "X" }, notify: true }, s.staff))
      .rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
