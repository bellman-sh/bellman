/**
 * OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document-00), which MCP 2026-07-28 asks
 * authorization servers to support in place of Dynamic Client Registration. A client's `client_id` is an https URL;
 * the document at that URL names the client and its redirect URIs, so a client needs no registration with us.
 *
 * This module decides whether a `client_id` is one, fetches and validates its document, and caches the result. It is
 * runtime-free: `routes.ts` hands it the fetch, so Node, workerd and vitest share it.
 *
 * Fetching a URL a stranger chose is server-side request forgery waiting to happen (the draft's §6), so the URL and
 * the response are held tight: https on the default port, a DNS name that is not local, no credentials, query or
 * fragment, no redirects followed, 5 seconds, 5 KiB, JSON. In production the fetch leaves from Cloudflare's edge,
 * which cannot reach a private network, so a name that resolves to one fails there too.
 */
import type { RegisteredClient } from "./storage.js";

/** The longest document we read. Real ones are a few hundred bytes. */
export const CIMD_MAX_BYTES = 5 * 1024;
export const CIMD_TIMEOUT_MS = 5_000;
/** How long a fetched document is trusted, whatever its headers say: never under the floor, never over the ceiling. */
export const CIMD_TTL_FLOOR_MS = 5 * 60 * 1000;
export const CIMD_TTL_CEILING_MS = 24 * 60 * 60 * 1000;
/** Fetches one host may cause in a minute, across all its documents; past it, a lookup fails until the minute moves on. */
export const CIMD_FETCHES_PER_HOST_PER_MINUTE = 20;
/** Cached documents kept; past it the oldest goes. */
export const CIMD_CACHE_ENTRIES = 1000;

const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

/**
 * Whether `clientId` is a Client ID Metadata Document URL we would fetch: https, the default port, a public DNS
 * name (no IP literal, no `localhost` or local suffix), a path other than `/` with no `.` or `..` segment, and no
 * credentials, query or fragment. Anything else is looked up as a registered client instead.
 */
export function isCimdClientId(clientId: string): boolean {
  if (!clientId.startsWith("https://")) return false;
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username || url.password) return false;
  if (url.search || url.hash || clientId.includes("#") || clientId.includes("?")) return false;
  // The URL parser normalises, so compare against the original: a client_id must be exactly the document's URL.
  if (url.href !== clientId) return false;
  if (url.pathname === "/" || url.pathname.split("/").some((s) => s === "." || s === "..")) return false;
  const host = url.hostname;
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host) || !host.includes(".")) return false;
  if (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s))) return false;
  return true;
}

/** Why a document was refused, in words the authorize page can show. */
export type CimdResult = { client: RegisteredClient } | { error: string };

interface CacheEntry {
  client: RegisteredClient;
  expiresAt: number;
}

/** Per-isolate memory: fetched documents and the per-host fetch window. Losing it costs a refetch, nothing more. */
export class CimdCache {
  readonly #entries = new Map<string, CacheEntry>();
  readonly #fetches = new Map<string, number[]>();

  get(clientId: string, now: number): RegisteredClient | undefined {
    const entry = this.#entries.get(clientId);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      this.#entries.delete(clientId);
      return undefined;
    }
    return entry.client;
  }

  set(clientId: string, client: RegisteredClient, expiresAt: number): void {
    this.#entries.delete(clientId);
    this.#entries.set(clientId, { client, expiresAt });
    while (this.#entries.size > CIMD_CACHE_ENTRIES) this.#entries.delete(this.#entries.keys().next().value!);
  }

  /** Count a fetch against its host; false when the host is past its minute's allowance. */
  admitFetch(host: string, now: number): boolean {
    const recent = (this.#fetches.get(host) ?? []).filter((t) => t > now - 60_000);
    if (recent.length >= CIMD_FETCHES_PER_HOST_PER_MINUTE) {
      this.#fetches.set(host, recent);
      return false;
    }
    recent.push(now);
    this.#fetches.set(host, recent);
    if (this.#fetches.size > CIMD_CACHE_ENTRIES) this.#fetches.delete(this.#fetches.keys().next().value!);
    return true;
  }
}

/** The one cache an isolate keeps, unless a caller passes its own. */
export const sharedCimdCache = new CimdCache();

/** How long to keep a document: its `max-age`, clamped to the floor and ceiling; the floor when it gives none. */
export function cimdTtl(cacheControl: string | null): number {
  const match = /(?:^|,)\s*max-age\s*=\s*(\d+)/i.exec(cacheControl ?? "");
  const ms = match ? Number(match[1]) * 1000 : 0;
  return Math.min(CIMD_TTL_CEILING_MS, Math.max(CIMD_TTL_FLOOR_MS, ms));
}

/** Read at most `limit` bytes of a body; null when it is longer. */
async function readCapped(res: Response, limit: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

/**
 * Validate a parsed document against the URL it came from: an object whose `client_id` is that URL exactly, with a
 * non-empty `client_name` and `redirect_uris`, every redirect usable by `usable` (https, or http on loopback), and a
 * `token_endpoint_auth_method` of `none` when it names one, since public clients are all this server takes.
 */
export function validateCimdDocument(
  doc: unknown,
  clientId: string,
  usable: (uri: string) => boolean,
  now: number,
): CimdResult {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { error: "the client metadata is not a JSON object" };
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) return { error: "the client metadata's client_id is not its own URL" };
  if (typeof d.client_name !== "string" || !d.client_name.trim()) return { error: "the client metadata has no client_name" };
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || !uris.every((u) => typeof u === "string")) {
    return { error: "the client metadata has no redirect_uris" };
  }
  if (!uris.every((u) => usable(u))) return { error: "the client metadata names a redirect URI that is neither https nor loopback" };
  const method = d.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") {
    return { error: "this server accepts only public clients (token_endpoint_auth_method none)" };
  }
  return {
    client: {
      client_id: clientId,
      client_name: d.client_name.trim().slice(0, 200),
      redirect_uris: uris as string[],
      created_at: now,
      expires_at: null,
    },
  };
}

/**
 * The client a Client ID Metadata Document URL names: from the cache while it is fresh, else fetched and validated.
 * A failure is never cached, and a fetch counts against its host's allowance whether or not it succeeds.
 */
export async function resolveCimdClient(
  clientId: string,
  deps: { fetchImpl: typeof fetch; usable: (uri: string) => boolean; now?: () => number; cache?: CimdCache },
): Promise<CimdResult> {
  if (!isCimdClientId(clientId)) return { error: "the client_id is not a usable metadata document URL" };
  const now = (deps.now ?? Date.now)();
  const cache = deps.cache ?? sharedCimdCache;
  const cached = cache.get(clientId, now);
  if (cached) return { client: cached };
  if (!cache.admitFetch(new URL(clientId).hostname, now)) return { error: "too many metadata fetches for this host; try again in a minute" };

  let res: Response;
  try {
    res = await deps.fetchImpl(clientId, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CIMD_TIMEOUT_MS),
    });
  } catch {
    return { error: "the client metadata could not be fetched" };
  }
  if (res.status !== 200) return { error: `the client metadata answered ${res.status}` };
  const type = res.headers.get("content-type") ?? "";
  if (!/^application\/([a-z0-9.+-]*\+)?json\b/i.test(type)) return { error: "the client metadata is not served as JSON" };
  let text: string | null;
  try {
    text = await readCapped(res, CIMD_MAX_BYTES);
  } catch {
    return { error: "the client metadata could not be read" };
  }
  if (text === null) return { error: "the client metadata is too large" };
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: "the client metadata is not valid JSON" };
  }
  const result = validateCimdDocument(doc, clientId, deps.usable, now);
  if ("client" in result) cache.set(clientId, result.client, now + cimdTtl(res.headers.get("cache-control")));
  return result;
}
