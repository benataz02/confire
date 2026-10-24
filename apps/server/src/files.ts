import { Hono, type Context } from "hono";
import { ORPCError } from "@orpc/server";
import * as Sentry from "@sentry/bun";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectFile } from "@confire/db";
import { auth } from "./auth.ts";
import { membershipOf } from "./orpc/base.ts";
import { isInternalMember, seatOf } from "./portal/members.ts";
import { tenantOf } from "./portal/orpc/base.ts";
import { addFile, projectFileFor, type Actor, type Side } from "./project-lifecycle.ts";
import { errorStatus } from "./serve.ts";

// Files (spec D14): plain Hono routes, not oRPC — the RPC body cap is 2 MB. Both processes mount
// them, each with its own side: the same session and the same tenant → membership (staff) or seat
// (portal) boundary as their procedures, and project-lifecycle.ts's project fence. The tenant is the
// route's first segment (`/files/<slug>/…`), because a download is a plain link and a link carries no
// `x-tenant` header. A download is always an attachment with nosniff and a sandbox CSP, so an upload
// can never run as a page on either origin. The one file served without a session — and without a
// tenant in its path — is a tenant's branding logo (D20): a mail needs an absolute public URL for it.

export const FILE_MAX = 10 * 1024 * 1024;
export const LOGO_MAX = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The body, counted on the stream: null as soon as it passes `max`, never buffered past it (the
 *  loop's early exit cancels the stream). */
export async function readCapped(req: Request, max: number): Promise<Buffer | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body ?? []) {
    size += chunk.byteLength;
    if (size > max) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/** What the browser named the file, minus control characters and path separators. */
export const cleanName = (name: string | undefined) =>
  (name ?? "").replace(/[\u0000-\u001f\u007f/\\]/g, "_").trim().slice(0, 200) || "file";

/** The type the browser sent, if it looks like one. Only ever served as an attachment, never sniffed. */
const cleanMime = (header: string | undefined) => {
  const m = (header ?? "").split(";")[0]!.trim().toLowerCase();
  return /^[\w.+-]+\/[\w.+-]+$/.test(m) ? m : "application/octet-stream";
};

/** A logo is a PNG or a JPEG, by its first bytes — not by what the upload claims. */
export const imageType = (b: Buffer): "image/png" | "image/jpeg" | null =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? "image/png"
  : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? "image/jpeg"
  : null;

type Who = { tenantId: string; actor: Actor; canUpload: boolean; isAdmin: boolean };

/** The procedures' own boundary, for a plain route: a session, then the path's tenant joined to this
 *  user's membership (staff) or seat (portal — and never the supplier's own staff). */
async function whoFor(side: Side, c: Context): Promise<Who> {
  const headers = c.req.raw.headers;
  const data = await auth.api.getSession({ headers, query: { disableCookieCache: true } });
  if (!data) throw new ORPCError("UNAUTHORIZED");
  const userId = data.user.id;
  if (side === "internal") {
    const m = await membershipOf(c.req.param("tenant"), userId);
    return { tenantId: m.tenantId, actor: { userId, side }, canUpload: true, isAdmin: m.role === "admin" || m.role === "owner" };
  }
  const tenant = await tenantOf(c.req.param("tenant"));
  if (await isInternalMember(tenant.id, userId)) throw new ORPCError("FORBIDDEN", { message: "You work for this supplier: use its internal app" });
  const seat = await seatOf(tenant.id, userId);
  if (!seat) throw new ORPCError("FORBIDDEN", { message: "Not a member of a company on this portal" });
  // Viewers read and comment; buyers and owners upload (§4.2).
  return { tenantId: tenant.id, actor: { userId, side, cardCode: seat.cardCode }, canUpload: seat.role !== "viewer", isAdmin: false };
}

const asciiName = (name: string) => name.replace(/[^\u0020-\u007e]|["\\]/g, "_");

function fileResponse(f: { name: string; mime: string; data: Buffer }, disposition: "inline" | "attachment", cache: string) {
  return new Response(new Uint8Array(f.data), {
    headers: {
      "Content-Type": f.mime,
      "Content-Disposition": `${disposition}; filename="${asciiName(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "X-Content-Type-Options": "nosniff",
      // Never a document on either origin, even if a browser decides to render it.
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Cache-Control": cache,
    },
  });
}

/** An ORPCError as the procedures would answer it; anything else a 500. */
const handle = (fn: (c: Context) => Promise<Response>) => async (c: Context) => {
  try {
    return await fn(c);
  } catch (e) {
    if (e instanceof ORPCError) return c.json({ message: e.message }, errorStatus(e) as 400);
    console.error("[files]", e);
    Sentry.captureException(e);
    return c.json({ message: "Something went wrong" }, 500);
  }
};

export function fileRoutes(side: Side): Hono {
  const app = new Hono();

  if (side === "internal") {
    /** The branding logo (D20), admins only: PNG or JPEG, ≤ 1 MB. It shows once Settings saves its
     *  id. ponytail: a logo uploaded and never saved stays behind (≤ 1 MB each); sweep rows no
     *  settings name if that ever adds up. */
    app.post("/files/:tenant/logo", handle(async (c) => {
      const who = await whoFor(side, c);
      if (!who.isAdmin) throw new ORPCError("FORBIDDEN", { message: "Admins only" });
      const data = await readCapped(c.req.raw, LOGO_MAX);
      if (!data) throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "A logo can be up to 1 MB" });
      const mime = imageType(data);
      if (!mime) throw new ORPCError("UNSUPPORTED_MEDIA_TYPE", { message: "A logo is a PNG or JPEG image" });
      const [row] = await db.insert(projectFile).values({
        tenantId: who.tenantId, projectId: null, name: `logo.${mime === "image/png" ? "png" : "jpg"}`, mime,
        size: data.length, data, uploadedBy: who.actor.userId,
      }).returning({ id: projectFile.id });
      return c.json({ id: row!.id }, 201);
    }));
  }

  /** Upload to a project's timeline: the raw body, `?name=` the file name, `&internal=1` (staff) an
   *  internal-only file. ≤ 10 MB, any type. */
  app.post("/files/:tenant/:projectId", handle(async (c) => {
    const projectId = c.req.param("projectId")!;
    if (!UUID.test(projectId)) throw new ORPCError("NOT_FOUND");
    const who = await whoFor(side, c);
    if (!who.canUpload) throw new ORPCError("FORBIDDEN", { message: "Buyers and owners only" });
    const data = await readCapped(c.req.raw, FILE_MAX);
    if (!data) throw new ORPCError("PAYLOAD_TOO_LARGE", { message: "A file can be up to 10 MB" });
    if (!data.length) throw new ORPCError("BAD_REQUEST", { message: "The file is empty" });
    const r = await addFile(who.tenantId, projectId, who.actor, {
      name: cleanName(c.req.query("name")), mime: cleanMime(c.req.header("content-type")), data,
    }, c.req.query("internal") === "1");
    return c.json(r, 201);
  }));

  /** A logo is public by design and never changes under its id. */
  app.get("/files/:id", handle(async (c) => {
    const id = c.req.param("id")!;
    if (!UUID.test(id)) throw new ORPCError("NOT_FOUND");
    const [logo] = await db.select({ name: projectFile.name, mime: projectFile.mime, data: projectFile.data })
      .from(projectFile).where(and(eq(projectFile.id, id), isNull(projectFile.projectId))).limit(1);
    if (!logo) throw new ORPCError("NOT_FOUND");
    return fileResponse(logo, "inline", "public, max-age=31536000, immutable");
  }));

  app.get("/files/:tenant/:id", handle(async (c) => {
    const id = c.req.param("id")!;
    if (!UUID.test(id)) throw new ORPCError("NOT_FOUND");
    const who = await whoFor(side, c);
    return fileResponse(await projectFileFor(who.tenantId, id, who.actor), "attachment", "private, max-age=3600");
  }));

  return app;
}
