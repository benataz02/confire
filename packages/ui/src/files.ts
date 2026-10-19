// Files (spec D14): plain routes on each app's own origin, not oRPC — the RPC body cap is 2 MB. The
// server answers a refusal as `{ message }`, the way a procedure would.

export const FILE_MAX_MB = 10;

/** A download: the server sends it as an attachment, so following the link never leaves the page. */
export const fileUrl = (fileId: string) => `/files/${fileId}`;

export const fileSize = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function post<T>(url: string, file: File): Promise<T> {
  const res = await fetch(url, { method: "POST", body: file, headers: { "content-type": file.type || "application/octet-stream" } });
  const body = (await res.json().catch(() => null)) as { message?: string } | null;
  if (!res.ok) throw new Error(body?.message ?? `The upload failed (${res.status})`);
  return body as T;
}

/** One file onto a project's timeline. `internalOnly` is staff's: the portal never sees it. */
export const uploadFile = (projectId: string, file: File, internalOnly = false) =>
  post<{ id: string; eventId: string }>(`/files/${projectId}?${new URLSearchParams({ name: file.name, ...(internalOnly ? { internal: "1" } : {}) })}`, file);

/** The tenant's branding logo (D20): internal admins, PNG or JPEG, 1 MB. */
export const uploadLogo = (file: File) => post<{ id: string }>("/files/logo", file);
