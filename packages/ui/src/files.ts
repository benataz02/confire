// Files (spec D14): plain routes on each app's own origin, not oRPC — the RPC body cap is 2 MB. The
// server answers a refusal as `{ message }`, the way a procedure would. The tenant rides in the route's
// path (`/files/<slug>/…`): a download is a plain link, and a link sends no x-tenant header.
import { getI18nBundle } from "@ui5/webcomponents-base/dist/i18nBundle.js";
import { currentSlug } from "./host.ts";

export const FILE_MAX_MB = 10;

const tenantFiles = () => `/files/${currentSlug()}`;

/** A download: the server sends it as an attachment, so following the link never leaves the page. */
export const fileUrl = (fileId: string) => `${tenantFiles()}/${fileId}`;

/** The branding logo: the one file served without a session, so without a tenant in its path. */
export const logoUrl = (fileId: string) => `/files/${fileId}`;

export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function post<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error(body?.message ?? (await getI18nBundle("@confire/ui")).getText("UI_UPLOAD_FAILED", String(res.status)));
  return body as T;
}

/** One file onto a project's timeline. `internalOnly` is staff's: the portal never sees it. */
export const uploadFile = (projectId: string, file: File, internalOnly = false) =>
  post<{ id: string; eventId: string }>(`${tenantFiles()}/${projectId}?${new URLSearchParams({ name: file.name, ...(internalOnly ? { internal: "1" } : {}) })}`, file);

/** The tenant's branding logo (D20): internal admins, PNG or JPEG, 1 MB. */
export const uploadLogo = (file: File) => post<{ id: string }>(`${tenantFiles()}/logo`, file);

/** A file dropped into the assistant before there is a configuration: into the user's own thread
 *  (`assistant_file`), PDF, PNG or JPEG by its bytes. Answers the reference the thread stores. */
export const uploadAssistantFile = (threadId: string, file: File) =>
  post<{ ref: { kind: "assistant"; id: string; name: string; mime: string } }>(
    `${tenantFiles()}/assistant/${threadId}?${new URLSearchParams({ name: file.name })}`, file);
