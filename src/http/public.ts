/**
 * The public reads (public rooms spec D3, D4): a room its creator marked public when it started,
 * read by anyone with its link. `GET` under `/public/rooms/:id`: the room's name and purpose, its
 * byline when its creator signed it (bylines spec D4), its surface with the surface cursor as an
 * ETag, its log, and the bytes of a blob an item on its surface names. And `GET
 * /public/handles/:handle`: the public rooms a handle has signed (D5). And `GET /public/rooms`: the
 * named public rooms, for the sitemap at bellman.sh/r/sitemap.xml and the directory at bellman.sh/r/. And `GET
 * /public/rooms/:id/agent-card.json`, the room's A2A card (src/a2a/cards.ts), and the same room's 0.3 card at `GET
 * /a2a/:id/.well-known/agent-card.json`, where a 0.3 resolver looks from the room's 0.3 URL. Nothing else.
 *
 * No credential is read here, by design. A cookie or a bearer changes nothing, so a member's
 * credential cannot open a private room through these paths, and every origin is answered
 * (`access-control-allow-origin: *`, never with credentials). A room that is not publicly readable
 * (private, made private, unknown or purged) is one 404 with one body, decided before anything else
 * about the room is read. The link is the room's id, a random UUID.
 *
 * What a reader is shown is what a member is, less every brief (`publicReadEvent`), and with every
 * member named by number rather than by label (`byNumber`): a label is how a member signed in, an
 * email address for most, and a reader with the link is not owed it. The hosted seat is `host`
 * there, its own label, `host@bellman`, reading as an address too (`publicNames`). Runtime-free,
 * like rooms.ts beside it: a web Request in, a Response out, for both servers and the tests.
 *
 * The surface and events reads take `?query=` (room search spec, D3): a card search over the
 * surface, a message search over the newest `MAX_EVENTS_READ` events, bounded as the plain reads
 * are and named by number as they are. The surface read also takes `?window=` and `?next=` (surface
 * frames spec, D5): one window of the surface with its frames, under a validator of its own, each
 * answer named by number as the plain read is.
 */
import { cardResponse, roomCard, roomCard03 } from "../a2a/cards.js";
import { v03CardTenant } from "../a2a/routes.js";
import { isBlobId, type BlobStore } from "../blobs.js";
import { publicRoomUrl } from "../codes.js";
import { handleFromSegment } from "../handles.js";
import { publicNames } from "../member-names.js";
import { retentionOf, untrusted } from "../projections.js";
import { publicReadEvent } from "../public-event.js";
import { PUBLIC_NAME, heldName, holdsName, roomNamed } from "../public-names.js";
import { isPublic, readSurface, readSurfaceWindow, roomLink, searchLog, searchSurface, sessionStatus } from "../rooms.js";
import { checkQuery } from "../search.js";
import type { BellmanStore } from "../store.js";
import type { StoredSession } from "../stored-session.js";
import { surfaceCursor } from "../surface.js";
import {
  AFTER_WITH_QUERY, MAX_EVENTS_READ, MAX_ROOMS_LISTED, blobResponse, etagMatches, searchTag, surfaceBody, surfaceTag, windowParams, windowTag,
} from "./rooms.js";

export interface PublicRouteDeps {
  store: BellmanStore;
  blobs: BlobStore;
  /** Whether this server's `/a2a` takes OAuth, which a room card then says. The Worker does; the Node server, with bearer keys only, does not. */
  oauth?: boolean;
}

/** `/public/rooms/:id`, then `/surface`, `/events`, `/agent-card.json` or `/blobs/:blobId`. */
const PATH = /^\/public\/rooms\/([^/]+)(?:\/(surface|events|agent-card\.json)|\/blobs\/([^/]+))?$/;

/** `/public/handles/:handle`: a handle's signed public rooms (bylines spec D5). */
const HANDLE_PAGE = /^\/public\/handles\/([^/]+)$/;

/**
 * How many of a handle's signatures one page request looks at, newest first, each costing a `getSession`
 * (a Durable Object call) on a request anyone can make. A signature outlives its room, because closing,
 * unpublishing and purging a room leave the row, so what a handle holds is not what a request may spend.
 * ponytail: a handle whose newest `HANDLE_PAGE_SCAN` signatures are all dead loses its older live rooms from
 * the page. The upgrade is to drop the row when a room closes or goes private, or a summary the page reads.
 */
export const HANDLE_PAGE_SCAN = 200;

/**
 * How many of those sessions the page reads at once. A reader waits for each batch's slowest read rather
 * than the sum of every read, and a page that fills early stops after the batch it filled in.
 */
export const HANDLE_PAGE_BATCH = 25;

/** Every origin, and no credentials: there is nothing here a credential could grant. */
const OPEN: Record<string, string> = { "access-control-allow-origin": "*" };

const answer = (status: number, body: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...OPEN, ...extra },
  });

const notFound = (description: string) => answer(404, { error: "not_found", error_description: description });

/** Every string held under a `label` key in `value`, at any depth: the labels a page names. */
function labelsIn(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) labelsIn(v, into);
  else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "label" && typeof v === "string") into.add(v);
      else labelsIn(v, into);
    }
  }
  return into;
}

/**
 * `page` with every member's label as the name a reader is shown (`byNumber`), from the names
 * `publicNames` gives the labels the page holds. The page's own reads and the hosted seat's prompt
 * name members through that one function, so a member is called the same thing in both.
 */
const numbered = async (store: BellmanStore, sessionId: string, page: unknown): Promise<unknown> =>
  byNumber(page, await publicNames(store, sessionId, labelsIn(page)));

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

/** The room a key names, a public name or a session id (public names spec, D6), while it is publicly readable. */
async function publicRoom(store: BellmanStore, key: string): Promise<StoredSession | null> {
  // A name has no `_`, and an id always has one. A name goes through the index and its room's record, so one nobody
  // holds reads no room at all.
  const session = PUBLIC_NAME.test(key) ? await roomNamed(store, key) : await store.getSession(key);
  return session && isPublic(session) ? session : null;
}

/**
 * A room's A2A card (ADR 0033), in 1.0's shape or 0.3's. A room that answers is public and open: every other room,
 * and a key that names none, is the one 404, in the same words, so a card says nothing about a room that is not one.
 */
async function agentCard(session: StoredSession | null, shape: "1.0" | "0.3", request: Request, deps: PublicRouteDeps): Promise<Response> {
  if (!session || session.closed) return notFound("no such public room");
  // The tenant `/a2a` takes: the name, if the index still gives it to this room, else the id.
  const name = heldName(session);
  const tenant = name !== null && (await deps.store.publicNameEntry(name))?.id === session.id ? name : session.id;
  const view = { tenant, name: session.manifest.room, purpose: session.manifest.purpose };
  const origin = new URL(request.url).origin;
  const how = { oauth: deps.oauth ?? true };
  return cardResponse(shape === "0.3" ? roomCard03(view, origin, how) : roomCard(view, origin, how), request.headers.get("if-none-match"), OPEN);
}

/**
 * The public routes. `undefined` for a path outside `/public`, so a server carries on to the next
 * module; everything under it is answered here, a path this module does not know and a throw included.
 */
export async function publicRoutes(request: Request, deps: PublicRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const room03 = v03CardTenant(path);
  if (room03 === undefined && path !== "/public" && !path.startsWith("/public/")) return undefined;
  // A page polling the surface sends If-None-Match, which is not a CORS-safelisted header, so the browser asks first.
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...OPEN, "access-control-allow-methods": "GET", "access-control-allow-headers": "if-none-match", "access-control-max-age": "600" },
    });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: { allow: "GET", ...OPEN } });

  try {
    if (room03 !== undefined) return await agentCard(await publicRoom(deps.store, room03), "0.3", request, deps);
    const page = HANDLE_PAGE.exec(path);
    if (page) return await handlePage(page[1], deps);
    if (path === "/public/rooms") return await namedRooms(deps);
    const m = PATH.exec(path);
    if (!m) return notFound("no such route");
    const [, key, part, blobId] = m;
    const session = await publicRoom(deps.store, key);
    if (!session) return notFound("no such public room");
    const id = session.id;

    if (part === "agent-card.json") return await agentCard(session, "1.0", request, deps);

    if (blobId !== undefined) {
      // Only a blob an item on the surface names: one uploaded and never placed, or one whose
      // item went, stays the members' (D3).
      const named = isBlobId(blobId) && (await deps.store.surfaceNamesBlob(id, blobId));
      if (!named) return notFound("no such blob");
      const got = await deps.blobs.get(id, blobId, request.headers.get("if-none-match") ?? undefined);
      return got === null ? notFound("no such blob") : blobResponse(got, OPEN);
    }

    const query = url.searchParams.get("query");
    const checked = query === null ? undefined : checkQuery(query);

    if (part === "surface") {
      // `?window=` and `?next=` take the member read's grammar (surface frames spec, D5); `query` beside either is refused first.
      const ask = windowParams(url.searchParams, query !== null);
      if (!ask.ok) return answer(400, { error: "invalid_request", error_description: ask.reason });
      if (checked !== undefined && !checked.ok) return answer(400, { error: "invalid_request", error_description: checked.reason });
      const words = checked?.ok ? checked.words : undefined;
      // As the member route answers a seat still in the room: from the record alone on a match. A
      // search's tag carries the link and the words, a window's the window and the token asked, so a
      // poll's tag never answers either (R20, R16).
      const exposed = { "access-control-expose-headers": "etag" };
      const tag = (cursor: number) => words !== undefined ? searchTag(cursor, roomLink(session), words)
        : ask.asked === null ? surfaceTag(cursor) : windowTag(cursor, ask.name, ask.next);
      if (etagMatches(request.headers.get("if-none-match"), tag(surfaceCursor(session)))) {
        return new Response(null, { status: 304, headers: { ...OPEN, ...exposed, "cache-control": "no-store", etag: tag(surfaceCursor(session)) } });
      }
      let block: { cursor: number; body: unknown };
      if (words !== undefined) {
        block = await searchSurface(deps.store, session, words).then(({ cursor, total, results }) => ({ cursor, body: { surface_cursor: cursor, total, results } }));
      } else if (ask.asked === null) {
        block = await readSurface(deps.store, session).then((b) => ({ cursor: b.cursor, body: surfaceBody(b.cursor, b) }));
      } else {
        const read = await readSurfaceWindow(deps.store, session, ask.asked);
        if (!read.ok) return answer(400, { error: "invalid_request", error_description: read.reason });
        block = { cursor: read.block.cursor, body: surfaceBody(read.block.cursor, read.block) };
      }
      return answer(200, await numbered(deps.store, id, block.body), { ...exposed, etag: tag(block.cursor) });
    }

    if (part === "events") {
      const raw = url.searchParams.get("after");
      if (raw !== null && !/^\d{1,15}$/.test(raw)) {
        return answer(400, { error: "invalid_request", error_description: "after is a cursor: a whole number, 0 or more" });
      }
      const after = raw === null ? undefined : Number(raw);
      if (checked !== undefined) {
        if (after !== undefined) return answer(400, { error: "invalid_request", error_description: AFTER_WITH_QUERY });
        if (!checked.ok) return answer(400, { error: "invalid_request", error_description: checked.reason });
        // R14: the public bound is the newest MAX_EVENTS_READ, what the plain read takes with no `after`.
        const window = await deps.store.recentEvents(id, MAX_EVENTS_READ);
        return answer(200, await numbered(deps.store, id, searchLog(window, checked.words)));
      }
      const read = after === undefined
        ? await deps.store.recentEvents(id, MAX_EVENTS_READ)
        : await deps.store.eventsAfter(id, after, MAX_EVENTS_READ);
      const events = read.flatMap((e) => {
        const shown = publicReadEvent(e);
        return shown ? [untrusted({ memberId: e.fromMemberId, label: e.fromLabel }, shown)] : [];
      });
      // The last event read, a brief left out included, so a page of nothing but briefs still
      // moves the next poll past it.
      return answer(200, await numbered(deps.store, id, { events, cursor: read.at(-1)?.cursor ?? after ?? 0 }));
    }

    const creator = session.creator;
    const room = {
      id: session.id,
      status: sessionStatus(session),
      closed_at: retentionOf(session).closed_at,
      mode: session.manifest.mode,
      // Which built-in preset the room cites, or null for an authored manifest or a saved preset (topic rooms spec, R5). Top
      // level and outside the envelope, like `view`: the page tells a topic room by this, since `view: "page"` says nothing
      // about a room's roles.
      preset: session.manifest.preset,
      // How the room opens (room pages spec D3): top level, beside `mode` and outside the envelope, since it is a value the
      // server checked and not the creator's prose (R9).
      view: session.publicView,
      // The room's one link: its name's while it holds one, its id's otherwise, whichever the read went by.
      // The dash's Worker writes it as the page's canonical link and og:url.
      public_url: publicRoomUrl(session),
      text: untrusted(
        { memberId: creator.memberId, label: creator.label },
        { room: session.manifest.room, purpose: session.manifest.purpose },
      ),
    };
    // The byline (D4): the creator's handle while they hold one and have signed this room, with the
    // number byNumber gives the creator, which the page swaps for @handle wherever it appears. The
    // names are read off the room's own labels, as `numbered` reads them, and serve both.
    const [names, handle] = await Promise.all([
      publicNames(deps.store, id, labelsIn(room)),
      deps.store.bylineFor(session.createdBy, id),
    ]);
    const as = names.get(creator.label);
    return answer(200, byNumber({ ...room, by: handle !== undefined && as !== undefined ? { handle, as } : null }, names));
  } catch (err) {
    console.error(`${request.method} ${path} failed:`, err);
    return answer(500, { error: "internal", error_description: "the request failed on the server" });
  }
}

/**
 * A handle's page (D5): its signed rooms that are still public and open, newest signature first,
 * each wrapped as the creator's words under the handle (plan ruling R2), never their label.
 * A path segment whose shape breaks the handle grammar names no one, so it is a 404 before the registry
 * is asked anything. Only the shape: the reserved list governs claims, and a read still reaches a name
 * reserved after someone took it, as the byline on that holder's rooms still does. Signatures are keyed
 * by user, so a freed handle someone else claims lists only their rooms. At most `HANDLE_PAGE_SCAN`
 * signatures are looked at, one session read each, `HANDLE_PAGE_BATCH` read at once and in order, and at
 * most `MAX_ROOMS_LISTED` rooms listed.
 */
async function handlePage(raw: string, deps: PublicRouteDeps): Promise<Response> {
  const handle = handleFromSegment(raw);
  if (handle === undefined) return notFound("no such handle");
  const userId = await deps.store.userOfHandle(handle);
  if (userId === undefined) return notFound("no such handle");
  // The scan's cut is the newest signatures, so the page orders them itself and does not lean on the registry's order.
  const newest = [...(await deps.store.signedRooms(userId))].sort((a, b) => b.signedAt - a.signedAt).slice(0, HANDLE_PAGE_SCAN);
  const rooms: unknown[] = [];
  for (let at = 0; at < newest.length && rooms.length < MAX_ROOMS_LISTED; at += HANDLE_PAGE_BATCH) {
    const batch = newest.slice(at, at + HANDLE_PAGE_BATCH);
    const sessions = await Promise.all(batch.map(({ sessionId }) => deps.store.getSession(sessionId)));
    for (const [k, s] of sessions.entries()) {
      if (rooms.length === MAX_ROOMS_LISTED) break;
      if (!s || !isPublic(s) || sessionStatus(s) === "closed" || s.createdBy !== userId) continue;
      rooms.push({
        id: s.id,
        text: untrusted({ memberId: s.creator.memberId, label: `@${handle}` }, { room: s.manifest.room, purpose: s.manifest.purpose }),
        public_url: publicRoomUrl(s),
        signed_at: new Date(batch[k].signedAt).toISOString(),
      });
    }
  }
  return answer(200, { handle, rooms });
}

/**
 * The named public rooms, name order, at most `MAX_ROOMS_LISTED`: each index entry checked against its room's
 * record, as a read by name is, so a name whose room closed or went private is left out. A room public by its id
 * alone is in no index and so not here: its link is shared, not listed. `HANDLE_PAGE_BATCH` rooms are read at once.
 * Each carries its name and purpose in the envelope its own read gives, creator named by number, for bellman.sh/r/.
 * ponytail: the first MAX_ROOMS_LISTED names of the index, dead ones included; a cursor when the index outgrows it.
 */
async function namedRooms(deps: PublicRouteDeps): Promise<Response> {
  const entries = await deps.store.publicNameEntries(MAX_ROOMS_LISTED);
  const rooms: unknown[] = [];
  for (let at = 0; at < entries.length; at += HANDLE_PAGE_BATCH) {
    const batch = entries.slice(at, at + HANDLE_PAGE_BATCH);
    const sessions = await Promise.all(batch.map(({ entry }) => deps.store.getSession(entry.id)));
    const listed = sessions.flatMap((s, k) => (holdsName(s, batch[k].name) ? [{ s: s!, name: batch[k].name }] : []));
    rooms.push(...(await Promise.all(listed.map(({ s, name }) => numbered(deps.store, s.id, {
      id: s.id,
      name,
      public_url: publicRoomUrl(s),
      text: untrusted({ memberId: s.creator.memberId, label: s.creator.label }, { room: s.manifest.room, purpose: s.manifest.purpose }),
    })))));
  }
  return answer(200, { rooms });
}
