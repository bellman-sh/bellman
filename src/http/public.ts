/**
 * The public reads (public rooms spec D3, D4): a room its creator marked public when it started,
 * read by anyone with its link. `GET` under `/public/rooms/:id` and nothing else: the room's name
 * and purpose, its surface with the surface cursor as an ETag, its log, and the bytes of a blob an
 * item on its surface names.
 *
 * No credential is read here, by design. A cookie or a bearer changes nothing, so a member's
 * credential cannot open a private room through these paths, and every origin is answered
 * (`access-control-allow-origin: *`, never with credentials). A room that is not publicly readable
 * (private, made private, unknown or purged) is one 404 with one body, decided before anything else
 * about the room is read. The link is the room's id, a random UUID.
 *
 * What a reader is shown is what a member is, less every brief (`publicReadEvent`), and with every
 * member named by number rather than by label (`byNumber`): a label is how a member signed in, an
 * email address for most, and a reader with the link is not owed it. Runtime-free, like rooms.ts
 * beside it: a web Request in, a Response out, for both servers and the tests.
 */
import { isBlobId, type BlobStore } from "../blobs.js";
import { retentionOf, untrusted } from "../projections.js";
import { publicReadEvent } from "../public-event.js";
import { isPublic, readSurface, sessionStatus } from "../rooms.js";
import { HOST_USER_ID, type BellmanStore } from "../store.js";
import type { StoredSession } from "../stored-session.js";
import { surfaceCursor } from "../surface.js";
import { MAX_EVENTS_READ, blobResponse, etagMatches, surfaceTag } from "./rooms.js";

export interface PublicRouteDeps {
  store: BellmanStore;
  blobs: BlobStore;
}

/** `/public/rooms/:id`, then `/surface`, `/events` or `/blobs/:blobId`. */
const PATH = /^\/public\/rooms\/([^/]+)(?:\/(surface|events)|\/blobs\/([^/]+))?$/;

/** Every origin, and no credentials: there is nothing here a credential could grant. */
const OPEN: Record<string, string> = { "access-control-allow-origin": "*" };

const answer = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...OPEN, ...extra },
  });

const notFound = (description: string) => answer(404, { error: "not_found", error_description: description });

/**
 * The name a public reader is shown for each member's label: "member 1", "member 2", in the order
 * they joined, which never changes because members are only ever appended. The hosted seat keeps its
 * own label, which names no person. One person's handles share a label, and so share a number.
 */
function publicNames(s: StoredSession): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of s.members) {
    if (m.userId !== HOST_USER_ID && !names.has(m.label)) names.set(m.label, `member ${names.size + 1}`);
  }
  return names;
}

/**
 * `value` with every property named `label` that holds a member's label replaced by that member's
 * number, at any depth (plan B's final review, Critical). The key is the rule, not a list of where
 * labels sit: envelopes' origins, events' senders, the joins, leaves, evictions and ticks that name a
 * member, and whatever payload names one next.
 */
function byNumber(value: unknown, names: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((v) => byNumber(v, names));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [
    k, k === "label" && typeof v === "string" && names.has(v) ? names.get(v) : byNumber(v, names),
  ]));
}

/**
 * The public routes. `undefined` for a path outside `/public`, so a server carries on to the next
 * module; everything under it is answered here, a path this module does not know and a throw included.
 */
export async function publicRoutes(request: Request, deps: PublicRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (path !== "/public" && !path.startsWith("/public/")) return undefined;
  // A page polling the surface sends If-None-Match, which is not a CORS-safelisted header, so the browser asks first.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...OPEN, "access-control-allow-methods": "GET", "access-control-allow-headers": "if-none-match", "access-control-max-age": "600" },
    });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET", ...OPEN } });

  try {
    const m = PATH.exec(path);
    if (!m) return notFound("no such route");
    const [, id, part, blobId] = m;
    const session = await deps.store.getSession(id);
    if (!session || !isPublic(session)) return notFound("no such public room");
    const names = publicNames(session);

    if (blobId !== undefined) {
      // Only a blob an item on the surface names: one uploaded and never placed, or one whose
      // item went, stays the members' (D3).
      const named = isBlobId(blobId) && (await deps.store.surfaceOf(id)).some((r) => r.blob?.id === blobId);
      if (!named) return notFound("no such blob");
      const got = await deps.blobs.get(id, blobId, request.headers.get("if-none-match") ?? undefined);
      return got === null ? notFound("no such blob") : blobResponse(got, OPEN);
    }

    if (part === "surface") {
      // As the member route answers a seat still in the room: from the record alone on a match.
      const exposed = { "access-control-expose-headers": "etag" };
      const tag = surfaceTag(surfaceCursor(session));
      if (etagMatches(request.headers.get("if-none-match"), tag)) {
        return new Response(null, { status: 304, headers: { ...OPEN, ...exposed, "cache-control": "no-store", etag: tag } });
      }
      const block = await readSurface(deps.store, session);
      return answer(200, byNumber({ surface_cursor: block.cursor, items: block.items }, names), { ...exposed, etag: surfaceTag(block.cursor) });
    }

    if (part === "events") {
      const raw = url.searchParams.get("after");
      if (raw !== null && !/^\d{1,15}$/.test(raw)) {
        return answer(400, { error: "invalid_request", error_description: "after is a cursor: a whole number, 0 or more" });
      }
      const after = raw === null ? undefined : Number(raw);
      const read = after === undefined
        ? await deps.store.recentEvents(id, MAX_EVENTS_READ)
        : await deps.store.eventsAfter(id, after, MAX_EVENTS_READ);
      const events = read.flatMap((e) => {
        const shown = publicReadEvent(e);
        return shown ? [untrusted({ memberId: e.fromMemberId, label: e.fromLabel }, shown)] : [];
      });
      // The last event read, a brief left out included, so a page of nothing but briefs still
      // moves the next poll past it.
      return answer(200, byNumber({ events, cursor: read.at(-1)?.cursor ?? after ?? 0 }, names));
    }

    const creator = session.members[0];
    return answer(200, byNumber({
      id: session.id,
      status: sessionStatus(session),
      closed_at: retentionOf(session).closed_at,
      mode: session.manifest.mode,
      text: untrusted(
        { memberId: creator.memberId, label: creator.label },
        { room: session.manifest.room, purpose: session.manifest.purpose },
      ),
    }, names));
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return answer(500, { error: "internal", error_description: "the request failed on the server" });
  }
}
