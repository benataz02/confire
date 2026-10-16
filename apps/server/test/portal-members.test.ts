import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db, portalCompany, portalCompanyDomain, portalInvitation, portalMember, type PortalRole } from "@confire/db";
import { devOutbox } from "../src/mail/mailer.ts";
import { addPortalMember, cancelInvitations, changeMember, claimDomain, sendInvitation } from "../src/portal/members.ts";
import { makePortalUser, makeTenant, makeUser } from "./harness.ts";

// The portal's write rules (spec §4.2, §5.1), shared by the internal and the portal process:
// apps/server/src/portal/members.ts is the only code that writes seats, domains and invitations.

const uid = () => crypto.randomUUID().slice(0, 8);
const codeOf = (p: Promise<unknown>) => p.then(() => "OK", (e: { code?: string }) => e.code);
const messageOf = (p: Promise<unknown>) => p.then(() => "", (e: Error) => e.message);

async function company(tenantId: string, cardName = "Kunde AG") {
  const [c] = await db.insert(portalCompany)
    .values({ tenantId, cardCode: `C${uid()}`, cardName, cardType: "cCustomer" }).returning();
  return c!;
}

const add = (tenantId: string, companyId: string, userId: string, role: PortalRole) =>
  db.transaction((tx) => addPortalMember(tx, { tenantId, companyId, userId, role }));

const roleOf = async (companyId: string, userId: string) =>
  (await db.select({ role: portalMember.role }).from(portalMember)
    .where(and(eq(portalMember.companyId, companyId), eq(portalMember.userId, userId))))[0]?.role;

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
    expect(await codeOf(add(tenantId, c.id, staff.userId, "owner"))).toBe("FORBIDDEN");
    expect(await roleOf(c.id, staff.userId)).toBeUndefined();
  });

  test("one company per user per tenant, any number across tenants", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const u = await makePortalUser();
    const a = await company(t1.tenantId);
    const b = await company(t1.tenantId);
    await add(t1.tenantId, a.id, u.userId, "buyer");
    expect(await codeOf(add(t1.tenantId, b.id, u.userId, "buyer"))).toBe("CONFLICT");
    expect(await roleOf(b.id, u.userId)).toBeUndefined();
    await add(t2.tenantId, (await company(t2.tenantId)).id, u.userId, "viewer");
  });

  test("a second way into the same company raises the role, never lowers it", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const u = await makePortalUser();
    await add(tenantId, c.id, u.userId, "viewer");
    await add(tenantId, c.id, u.userId, "buyer");
    expect(await roleOf(c.id, u.userId)).toBe("buyer");
    await add(tenantId, c.id, u.userId, "viewer");
    expect(await roleOf(c.id, u.userId)).toBe("buyer");
    await add(tenantId, c.id, u.userId, "owner");
    await add(tenantId, c.id, u.userId, "buyer");
    expect(await roleOf(c.id, u.userId)).toBe("owner");
  });
});

describe("claimDomain", () => {
  test("free mail is never registered; a domain belongs to one company", async () => {
    const { tenantId } = await makeTenant();
    const a = await company(tenantId);
    const b = await company(tenantId);
    const claim = (companyId: string, domain: string) =>
      db.transaction((tx) => claimDomain(tx, { tenantId, companyId, domain, addedBy: null }));
    expect(await claim(a.id, "gmail.com")).toBe("free");
    expect(await db.select().from(portalCompanyDomain).where(eq(portalCompanyDomain.companyId, a.id))).toHaveLength(0);
    const domain = `${uid()}.de`;
    expect(await claim(a.id, domain)).toBe("added");
    expect(await claim(a.id, domain)).toBe("added"); // idempotent for its own company
    expect(await claim(b.id, domain)).toEqual({ takenBy: a.cardCode });
  });
});

describe("changeMember", () => {
  test("the last owner can be neither demoted nor removed", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const owner = await makePortalUser();
    await add(tenantId, c.id, owner.userId, "owner");
    expect(await codeOf(changeMember({ tenantId, companyId: c.id, userId: owner.userId, role: "buyer" }))).toBe("CONFLICT");
    expect(await codeOf(changeMember({ tenantId, companyId: c.id, userId: owner.userId, role: null }))).toBe("CONFLICT");
    expect(await roleOf(c.id, owner.userId)).toBe("owner");
  });

  test("two owners demoting each other at once leave one owner", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const a = await makePortalUser();
    const b = await makePortalUser();
    await add(tenantId, c.id, a.userId, "owner");
    await add(tenantId, c.id, b.userId, "owner");
    const results = await Promise.all([
      codeOf(changeMember({ tenantId, companyId: c.id, userId: a.userId, role: "viewer" })),
      codeOf(changeMember({ tenantId, companyId: c.id, userId: b.userId, role: "viewer" })),
    ]);
    expect(results.sort()).toEqual(["CONFLICT", "OK"]);
    const owners = await db.select().from(portalMember)
      .where(and(eq(portalMember.companyId, c.id), eq(portalMember.role, "owner")));
    expect(owners).toHaveLength(1);
  });

  test("with another owner left, roles change and members go; a company without owners still loses viewers", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const a = await makePortalUser();
    const b = await makePortalUser();
    await add(tenantId, c.id, a.userId, "owner");
    await add(tenantId, c.id, b.userId, "owner");
    await changeMember({ tenantId, companyId: c.id, userId: b.userId, role: "buyer" });
    expect(await roleOf(c.id, b.userId)).toBe("buyer");
    await changeMember({ tenantId, companyId: c.id, userId: b.userId, role: null });
    expect(await roleOf(c.id, b.userId)).toBeUndefined();
    expect(await codeOf(changeMember({ tenantId, companyId: c.id, userId: b.userId, role: null }))).toBe("NOT_FOUND");

    const ownerless = await company(tenantId);
    const v = await makePortalUser();
    await add(tenantId, ownerless.id, v.userId, "viewer");
    await changeMember({ tenantId, companyId: ownerless.id, userId: v.userId, role: null });
    expect(await roleOf(ownerless.id, v.userId)).toBeUndefined();
  });

  test("a company of another tenant is NOT_FOUND", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const c = await company(t1.tenantId);
    const u = await makePortalUser();
    await add(t1.tenantId, c.id, u.userId, "viewer");
    expect(await codeOf(changeMember({ tenantId: t2.tenantId, companyId: c.id, userId: u.userId, role: null }))).toBe("NOT_FOUND");
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
    const { id, expiresAt } = await sendInvitation({ tenantId, companyId: c.id, email, role: "buyer", registerDomain: true, inviter });
    const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThan(14.1);
    const [row] = await db.select().from(portalInvitation).where(eq(portalInvitation.id, id));
    expect(row).toMatchObject({ tenantId, companyId: c.id, role: "buyer", status: "pending", registerDomain: true, invitedBy: inviter.id });

    const mail = await mailTo(email);
    expect(mail.from).toBe(`"${slug}" <notify@${process.env.MAIL_DOMAIN ?? "mail.lvh.me"}>`);
    expect(mail.replyTo).toBe(inviter.email);
    expect(mail.text).toContain(`${slug}.portal.`);
    expect(mail.text).toContain(`/accept/${id}`);
    expect(mail.text).toContain("Ines Inviter");
    expect(mail.text).toContain("Müller & Söhne GmbH");
  });

  test("one open invitation per address, whatever its case", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const inviter = await inviterOf();
    const local = `a${uid()}`;
    await sendInvitation({ tenantId, companyId: c.id, email: `${local}@kunde.de`, role: "viewer", registerDomain: false, inviter });
    expect(await codeOf(sendInvitation({ tenantId, companyId: c.id, email: `${local.toUpperCase()}@Kunde.DE`, role: "viewer", registerDomain: false, inviter })))
      .toBe("CONFLICT");
  });

  test("an expired invitation does not block a new one: it is cancelled", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const inviter = await inviterOf();
    const email = `e${uid()}@kunde.de`;
    const [old] = await db.insert(portalInvitation).values({
      tenantId, companyId: c.id, email, role: "viewer", invitedBy: inviter.id, expiresAt: new Date(Date.now() - 1000),
    }).returning();
    const { id } = await sendInvitation({ tenantId, companyId: c.id, email, role: "buyer", registerDomain: false, inviter });
    expect(id).not.toBe(old!.id);
    const [stale] = await db.select().from(portalInvitation).where(eq(portalInvitation.id, old!.id));
    expect(stale!.status).toBe("canceled");
  });

  test("refuses staff, a member of another company, and a member of this one", async () => {
    const { tenantId } = await makeTenant();
    const c = await company(tenantId);
    const other = await company(tenantId, "Andere GmbH");
    const inviter = await inviterOf();
    const send = (email: string) => sendInvitation({ tenantId, companyId: c.id, email, role: "viewer", registerDomain: false, inviter });

    const staff = await makeUser("admin", tenantId);
    expect(await codeOf(send(staff.email.toUpperCase()))).toBe("FORBIDDEN");

    const elsewhere = await makePortalUser();
    await add(tenantId, other.id, elsewhere.userId, "buyer");
    const msg = await messageOf(send(elsewhere.email));
    expect(msg).toContain(other.cardCode);

    const here = await makePortalUser();
    await add(tenantId, c.id, here.userId, "viewer");
    expect(await messageOf(send(here.email))).toMatch(/already a member/i);
  });
});

describe("cancelInvitations", () => {
  test("cancels pending rows of this tenant (and company, when named) only", async () => {
    const t1 = await makeTenant();
    const t2 = await makeTenant();
    const a = await company(t1.tenantId);
    const b = await company(t1.tenantId);
    const row = async (tenantId: string, companyId: string, status: "pending" | "accepted" = "pending") =>
      (await db.insert(portalInvitation).values({
        tenantId, companyId, email: `${uid()}@x.de`, role: "viewer", status, expiresAt: new Date(Date.now() + 86_400_000),
      }).returning())[0]!.id;
    const pending = await row(t1.tenantId, a.id);
    const accepted = await row(t1.tenantId, a.id, "accepted");
    const otherCompany = await row(t1.tenantId, b.id);
    expect(await cancelInvitations(t2.tenantId, [pending])).toBe(0);
    expect(await cancelInvitations(t1.tenantId, [otherCompany], a.id)).toBe(0);
    expect(await cancelInvitations(t1.tenantId, [pending, accepted, otherCompany])).toBe(2);
  });
});
