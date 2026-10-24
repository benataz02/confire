import { actionPath, crossJoinPath, entityPath, entitySetPath, metadataPath } from "./query.ts";
import type {
  B1MetadataParams, B1Requester, B1Response, B1Transport, CrossJoinSpec, Key, Prefer, QueryOptions,
} from "./types.ts";

const etagOf = (data: unknown): string | undefined => {
  const v = (data as Record<string, unknown> | null)?.["@odata.etag"];
  return typeof v === "string" && v ? v : undefined;
};

/** `$top=N` alone is a trap: the Service Layer pages server-side at **20 rows by default**, so a
 *  `$top=100` read answers with 20 and `@odata.nextLink`, and no caller can tell that truncation
 *  from the end of the collection. Asking for `$top` therefore implies asking for a page that big.
 *  An explicit `maxPageSize` still wins — including 0, which disables server paging entirely. */
const pageHeader = (q?: QueryOptions): Record<string, string> | undefined => {
  const size = q?.maxPageSize ?? q?.top;
  return size === undefined ? undefined : { Prefer: `odata.maxpagesize=${size}` };
};

/** Expanded port of b1-mcp-server's B1Client (MIT). Every capability Confire needs is a named,
 *  typed method, and every path comes from query.ts. It runs in the cloud over the agent's one
 *  `/request` route (remote.ts `agentRequester`); the agent holds the session and allowlists what
 *  it forwards, so a cloud bug still cannot reach past it. Added over the sample: etag, prefer,
 *  expand, count, readNext, crossJoin, metadata. */
export class DirectTransport implements B1Transport {
  constructor(private readonly send: B1Requester) {}

  private async get(path: string, headers?: Record<string, string>): Promise<B1Response> {
    const res = await this.send({ path, method: "GET", headers });
    return { status: res.status, data: res.data, etag: etagOf(res.data) };
  }

  readEntitySet(entitySet: string, q?: QueryOptions): Promise<B1Response> {
    return this.get(entitySetPath(entitySet, q), pageHeader(q));
  }

  readEntity(entitySet: string, key: Key, q?: QueryOptions): Promise<B1Response> {
    return this.get(entityPath(entitySet, key, q));
  }

  crossJoin(spec: CrossJoinSpec): Promise<B1Response> {
    return this.get(crossJoinPath(spec));
  }

  /** The one method that passes a B1-supplied link on. The agent resolves every path under the
   *  service's base and refuses one that lands outside it, so a link cannot point it elsewhere. */
  readNext(nextLink: string, maxPageSize?: number): Promise<B1Response> {
    // Prefer is per-request, not sticky to the collection: without re-sending it every page after
    // the first comes back at the Service Layer's default of 20.
    return this.get(nextLink, pageHeader({ maxPageSize }));
  }

  async createEntity(entitySet: string, data: unknown, o?: { prefer?: Prefer }): Promise<B1Response> {
    // The sample only ever asked for return-no-content. Quote write-back needs the created
    // document (DocEntry, DocNum, totals) back in one call.
    const prefer = o?.prefer === "no-content" ? "return-no-content" : "return-representation";
    const res = await this.send({
      path: entitySetPath(entitySet), method: "POST", body: data, headers: { Prefer: prefer },
    });
    return { status: res.status, data: res.data, etag: etagOf(res.data) };
  }

  async updateEntity(
    entitySet: string, key: Key, data: unknown, o?: { etag?: string; replaceCollections?: boolean },
  ): Promise<B1Response> {
    const res = await this.send({
      path: entityPath(entitySet, key), method: "PATCH", body: data,
      headers: {
        ...(o?.etag ? { "If-Match": o.etag } : {}),
        ...(o?.replaceCollections ? { "B1S-ReplaceCollectionsOnPatch": "true" } : {}),
      },
    });
    return { status: res.status, data: res.data };
  }

  async action(entitySet: string, key: Key, name: string): Promise<B1Response> {
    const res = await this.send({ path: actionPath(entitySet, key, name), method: "POST" });
    return { status: res.status, data: res.data };
  }

  async deleteEntity(entitySet: string, key: Key, o?: { etag?: string }): Promise<B1Response> {
    const res = await this.send({
      path: entityPath(entitySet, key), method: "DELETE",
      headers: o?.etag ? { "If-Match": o.etag } : undefined,
    });
    return { status: res.status, data: res.data };
  }

  /** EDMX, as text: the agent asks for XML on a `$metadata` path and relays a non-JSON body as is. */
  async metadata(p?: B1MetadataParams): Promise<string> {
    return String((await this.send({ path: metadataPath(p), method: "GET" })).data ?? "");
  }
}
