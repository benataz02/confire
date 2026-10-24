import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, invitation, member, portalCompany, portalCompanyDomain, type PortalRole } from "@confire/db";
import { devOutbox, mailDomain } from "../src/mail/mailer.ts";
import { addPortalMember, cancelInvitations, changeMember, claimDomain, companyPeople, sendInvitation } from "../src/portal/members.ts";
import { portalTenantUrl } from "../src/tenant.ts";
import { makePortalUser, makeTenant, makeUser, seatRole as roleOf } from "./harness.ts";

// The portal's write rules (spec §4.2, §5.1), shared by the internal and the portal process:
// apps/server/src/portal/members.ts is the only code that writes seats, domains and invitations.

const uid = () => crypto.randomUUID().slice(0, 8);
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

async function company(tenantId: string, cardName = "Kunde AG", cardCode = `C${uid()}`) {
  const [c] = await db.insert(portalCompany)
    .values({ tenantId, cardCode, cardName, cardType: "cCustomer" }).returning();
  return c!;
}

const add = (tenantId: string, cardCode: string, userId: string, role: PortalRole) =>
  db.transaction((tx) => addPortalMember(tx, { tenantId, cardCode, userId, role }));

async function mailTo(email: string) {
  for (let i = 0; i < 100; i++) {
    const mail = devOutbox.findLast((m) => m.to === email);
    if (mail) return mail;
    await Bun.sleep(20);
  }
  throw new Error(`no mail to ${email}`);
}

describe("addPortalMember", () => {
  test("refuses the supplier's own staff", async () => {
    const { tenantId } = await makeTenant();
    const staff = await makeUser("member", tenantId);
    const c = await company(tenantId);
    expect(await codeOf(add(tenantId, c.cardCode, staff.userId, "owner"))).toBe("FORBIDDEN");
    expect(await roleOf(c, staff.userId)).toBeUndefined();
  });

  test("one company per user per tenant, any number across tenants", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const u = await makePortalUser();
    const a = await company(t1.tenantId);
    const b = await company(t1.tenantId);
    await add(t1.tenantId, a.cardCode, u.userId, "buyer");
    expect(await codeOf(add(t1.tenantId, b.cardCode, u.userId, "buyer"))).toBe("CONFLICT");
    expect(await roleOf(b, u.userId)).toBeUndefined();
    await add(t2.tenantId, (await company(t2.tenantId)).cardCode, u.userId, "viewer");
  });

  test("two joins at once, into two companies, leave one membership", async () => {
    const { tenantId } = await makeTenant();
    const u = await makePortalUser();
    const a = await company(tenantId);
    const b = await company(tenantId);
    const results = await Promise.all([codeOf(add(tenantId, a.cardCode, u.userId, "viewer")), codeOf(add(tenantId, b.cardCode, u.userId, "viewer"))]);
    expect(results.sort()).toEqual(["CONFLICT", "OK"]);
    expect(await db.select().from(member).where(and(eq(member.organizationId, tenantId), eq(member.userId, u.userId)))).toHaveLength(1);
  });

  test("a second way into the same company raises the role, never lowers it", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const u = await makePortalUser();
    await add(tenantId, c.cardCode, u.userId, "viewer");
    await add(tenantId, c.cardCode, u.userId, "buyer");
    expect(await roleOf(c, u.userId)).toBe("buyer");
    await add(tenantId, c.cardCode, u.userId, "viewer");
    expect(await roleOf(c, u.userId)).toBe("buyer");
    await add(tenantId, c.cardCode, u.userId, "owner");
    await add(tenantId, c.cardCode, u.userId, "buyer");
    expect(await roleOf(c, u.userId)).toBe("owner");
  });
});

describe("claimDomain", () => {
  test("free mail is never registered; a domain belongs to one company", async () => {
    const { tenantId } = await makeTenant();
    const a = await company(tenantId);
    const b = await company(tenantId);
    const claim = (cardCode: string, domain: string) =>
      db.transaction((tx) => claimDomain(tx, { tenantId, cardCode, domain, addedBy: null }));
    expect(await claim(a.cardCode, "gmail.com")).toBe("free");
    expect(await db.select().from(portalCompanyDomain).where(eq(portalCompanyDomain.cardCode, a.cardCode))).toHaveLength(0);
    const domain = `${uid()}.de`;
    expect(await claim(a.cardCode, domain)).toBe("added");
    expect(await claim(a.cardCode, domain)).toBe("added"); // idempotent for its own company
    expect(await claim(b.cardCode, domain)).toEqual({ takenBy: a.cardCode });
  });
});

describe("changeMember", () => {
  test("the last owner can be neither demoted nor removed", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const owner = await makePortalUser();
    await add(tenantId, c.cardCode, owner.userId, "owner");
    expect(await codeOf(changeMember({ tenantId, cardCode: c.cardCode, userId: owner.userId, role: "buyer" }))).toBe("CONFLICT");
    expect(await codeOf(changeMember({ tenantId, cardCode: c.cardCode, userId: owner.userId, role: null }))).toBe("CONFLICT");
    expect(await roleOf(c, owner.userId)).toBe("owner");
  });

  test("two owners demoting each other at once leave one owner", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const a = await makePortalUser();
    const b = await makePortalUser();
    await add(tenantId, c.cardCode, a.userId, "owner");
    await add(tenantId, c.cardCode, b.userId, "owner");
    const results = await Promise.all([
      codeOf(changeMember({ tenantId, cardCode: c.cardCode, userId: a.userId, role: "viewer" })),
      codeOf(changeMember({ tenantId, cardCode: c.cardCode, userId: b.userId, role: "viewer" })),
    ]);
    expect(results.sort()).toEqual(["CONFLICT", "OK"]);
    const owners = await db.select().from(member)
      .where(and(eq(member.role, "portal_owner"), eq(member.cardCode, c.cardCode)));
    expect(owners).toHaveLength(1);
  });

  test("with another owner left, roles change and members go; a company without owners still loses viewers", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const a = await makePortalUser();
    const b = await makePortalUser();
    await add(tenantId, c.cardCode, a.userId, "owner");
    await add(tenantId, c.cardCode, b.userId, "owner");
    await changeMember({ tenantId, cardCode: c.cardCode, userId: b.userId, role: "buyer" });
    expect(await roleOf(c, b.userId)).toBe("buyer");
    await changeMember({ tenantId, cardCode: c.cardCode, userId: b.userId, role: null });
    expect(await roleOf(c, b.userId)).toBeUndefined();
    expect(await codeOf(changeMember({ tenantId, cardCode: c.cardCode, userId: b.userId, role: null }))).toBe("NOT_FOUND");

    const ownerless = await company(tenantId);
    const v = await makePortalUser();
    await add(tenantId, ownerless.cardCode, v.userId, "viewer");
    await changeMember({ tenantId, cardCode: ownerless.cardCode, userId: v.userId, role: null });
    expect(await roleOf(ownerless, v.userId)).toBeUndefined();
  });

  test("a company of another tenant is NOT_FOUND", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const c = await company(t1.tenantId);
    // The same CardCode at the other supplier is another company: a CardCode never matches alone.
    const twin = await company(t2.tenantId, "Zwilling AG", c.cardCode);
    const u = await makePortalUser();
    await add(t1.tenantId, c.cardCode, u.userId, "viewer");
    expect(await codeOf(changeMember({ tenantId: t2.tenantId, cardCode: c.cardCode, userId: u.userId, role: null }))).toBe("NOT_FOUND");
    expect(await roleOf(twin, u.userId)).toBeUndefined();
    expect(await roleOf(c, u.userId)).toBe("viewer");
    expect((await companyPeople(t2.tenantId, c.cardCode)).members).toHaveLength(0);
  });
});

describe("sendInvitation", () => {
  const inviterOf = async () => {
    const u = await makePortalUser();
    return { id: u.userId, name: "Ines Inviter", email: u.email };
  };

  test("stores a pending invitation and mails the accept link in the supplier's name", async () => {
    const { tenantId, slug } = await makeTenant();
    const c = await company(tenantId, "Müller & Söhne GmbH");
    const inviter = await inviterOf();
    const email = `n${uid()}@kunde.de`;
    const { id, expiresAt } = await sendInvitation({ tenantId, cardCode: c.cardCode, email, role: "buyer", registerDomain: true, inviter });
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    const [row] = await db.select().from(invitation).where(eq(invitation.id, id));
    expect(row).toMatchObject({
      organizationId: tenantId, cardCode: c.cardCode, role: "portal_buyer", status: "pending",
      registerDomain: true, inviterId: inviter.id,
    });

    const mail = await mailTo(email);
    expect(mail.from).toBe(`"${slug}" <${slug}@${mailDomain}>`);
    expect(mail.text).toContain(portalTenantUrl(slug, `/accept/${id}`));
    expect(mail.text).toContain("Ines Inviter");
    expect(mail.text).toContain("Müller & Söhne GmbH");
  });

  test("mails in the company's SAP language, a new client in the sender's", async () => {
    const { tenantId } = await makeTenant();
    const inviter = await inviterOf();
    const send = async (cardCode: string | null, languageCode?: number) => {
      const email = `l${uid()}@kunde.es`;
      const { id } = await sendInvitation({ tenantId, cardCode, email, role: "owner", registerDomain: false, inviter, languageCode });
      const [row] = await db.select({ languageCode: invitation.languageCode }).from(invitation).where(eq(invitation.id, id));
      return { mail: await mailTo(email), stored: row!.languageCode };
    };
    const withLanguage = async (languageCode: number) => (await db.insert(portalCompany)
      .values({ tenantId, cardCode: `C${uid()}`, cardName: "Hera SL", cardType: "cCustomer", languageCode }).returning())[0]!.cardCode;

    // 23 = Spanish in UserLanguages: the subject, the body and the frame all switch.
    const es = await send(await withLanguage(23));
    expect(es.mail.subject).toContain("Ines Inviter le ha invitado al portal de clientes de");
    expect(es.mail.html).toContain('lang="es"');
    expect(es.mail.text).toContain("Aceptar la invitación");
    expect(es.mail.text).toContain("enviado con Confire");
    expect(es.stored).toBe(23);
    // A language with no translation (9 = German) reads English; a passed language is ignored for an
    // existing company, whose own wins.
    const de = await send(await withLanguage(9), 23);
    expect(de.mail.subject).toContain("invited you to");
    expect(de.stored).toBe(9);
    // A new client has no BP yet: the sender's language, kept for its lead.
    const fresh = await send(null, 23);
    expect(fresh.mail.text).toContain("Facilite los datos de su empresa");
    expect(fresh.stored).toBe(23);
  });

  test("one open invitation per address, whatever its case", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const inviter = await inviterOf();
    const local = `a${uid()}`;
    await sendInvitation({ tenantId, cardCode: c.cardCode, email: `${local}@kunde.de`, role: "viewer", registerDomain: false, inviter });
    expect(await codeOf(sendInvitation({ tenantId, cardCode: c.cardCode, email: `${local.toUpperCase()}@Kunde.DE`, role: "viewer", registerDomain: false, inviter })))
      .toBe("CONFLICT");
  });

  test("an expired invitation does not block a new one", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const inviter = await inviterOf();
    const email = `e${uid()}@kunde.de`;
    const [old] = await db.insert(invitation).values({
      id: crypto.randomUUID(), organizationId: tenantId, email, role: "portal_viewer", cardCode: c.cardCode,
      inviterId: inviter.id, expiresAt: new Date(Date.now() - 1000),
    }).returning();
    const { id } = await sendInvitation({ tenantId, cardCode: c.cardCode, email, role: "buyer", registerDomain: false, inviter });
    expect(id).not.toBe(old!.id);
  });

  test("refuses staff, a member of another company, and a member of this one", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const other = await company(tenantId, "Andere GmbH");
    const inviter = await inviterOf();
    const send = (email: string) => sendInvitation({ tenantId, cardCode: c.cardCode, email, role: "viewer", registerDomain: false, inviter });

    const staff = await makeUser("admin", tenantId);
    expect(await codeOf(send(staff.email.toUpperCase()))).toBe("FORBIDDEN");

    const elsewhere = await makePortalUser();
    await add(tenantId, other.cardCode, elsewhere.userId, "buyer");
    const msg = await messageOf(send(elsewhere.email));
    expect(msg).toContain(other.cardCode);

    const here = await makePortalUser();
    await add(tenantId, c.cardCode, here.userId, "viewer");
    expect(await messageOf(send(here.email))).toMatch(/already a member/i);
  });
});

describe("cancelInvitations", () => {
  test("cancels pending rows of this tenant (and company, when named) only", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const a = await company(t1.tenantId);
    const b = await company(t1.tenantId);
    const inviter = await makePortalUser();
    const row = async (tenantId: string, cardCode: string, status: "pending" | "accepted" = "pending") =>
      (await db.insert(invitation).values({
        id: crypto.randomUUID(), organizationId: tenantId, email: `${uid()}@x.de`, role: "portal_viewer", cardCode,
        status, inviterId: inviter.userId, expiresAt: new Date(Date.now() + 86_400_000),
      }).returning())[0]!.id;
    const pending = await row(t1.tenantId, a.cardCode);
    const accepted = await row(t1.tenantId, a.cardCode, "accepted");
    const otherCompany = await row(t1.tenantId, b.cardCode);
    expect(await cancelInvitations(t2.tenantId, [pending])).toBe(0);
    expect(await cancelInvitations(t1.tenantId, [otherCompany], a.cardCode)).toBe(0);
    expect(await cancelInvitations(t1.tenantId, [pending, accepted, otherCompany])).toBe(2);
  });
});
