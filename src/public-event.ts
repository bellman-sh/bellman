import { isAmbient, addressedAway } from "./room/attention.js";
import type { Member, SessionEvent } from "./types.js";

// Deliberately in neither server.ts nor store-do.ts. store-do.ts imports
// `cloudflare:workers`, so the Node program cannot import it (tsconfig.json
// excludes it), and importing server.ts from the Durable Object would pull the
// whole tool layer into it. What both must agree on lives here, with no import
// beyond a type or another runtime-free module, as stored-session.ts does for
// the shape store-do.ts and the tests share.

/**
 * An event as a member is shown it: the one shape that leaves the server, over
 * a poll and over a socket alike (spec D1a).
 *
 * It is a projection, not the stored event. fromUserId is left out on purpose:
 * it is the sender's upstream identity (u_github_4242 and the like), and every
 * member of a room receives every other member's events. A peer is told who
 * spoke by member_id and label. The time is ISO 8601, not the stored epoch.
 *
 * Both transports call this function so that the shape cannot fork: a bridge
 * that reads polls and sockets parses one thing. The untrusted wrapper is not
 * part of it. The poll adds that at the tool boundary; a socket leaves it to
 * the client (D9).
 */
/**
 * What a projection knows beyond the event (seat names spec): `names`, every seat's name by member id, puts `from.name`
 * and each addressee's name on the event; `reader`, the seat reading it, makes an event addressed to other seats ambient.
 */
export interface EventView { names?: ReadonlyMap<string, string>; reader?: string }

export function publicEvent(e: SessionEvent, view: EventView = {}) {
  const fromName = view.names?.get(e.fromMemberId);
  const to = Array.isArray(e.toMemberIds) && e.toMemberIds.length > 0
    ? e.toMemberIds.map((id) => ({ member_id: id, name: view.names?.get(id) ?? null }))
    : null;
  return {
    cursor: e.cursor,
    type: e.type,
    from: { member_id: e.fromMemberId, label: e.fromLabel, ...(fromName !== undefined ? { name: fromName } : {}) },
    ...(to !== null ? { to } : {}),
    payload: e.type === "decision_opened" ? publicOpened(e.payload) : e.payload,
    ref_id: e.refId,
    at: new Date(e.at).toISOString(),
    // Only when true. Omission costs nothing for the twelve types that predate
    // #111, and a client that has never heard of `progress` keeps working.
    ...(isAmbient(e) || addressedAway(e, view.reader) ? { ambient: true as const } : {}),
  };
}

/**
 * Each seat's account as a peer is shown it: `a1`, `a2` and on, in the order the accounts first appear. A decision
 * snapshot keys every electorate seat to its account (ADR 0040, decision 3), which is the upstream id `publicEvent`
 * keeps from peers; the alias still shows which seats one account holds, the thing the tally dedupes by.
 */
export function accountAliases(accounts: Record<string, string>): Record<string, string> {
  const n = new Map<string, number>();
  for (const a of Object.values(accounts)) if (!n.has(a)) n.set(a, n.size + 1);
  return Object.fromEntries(Object.entries(accounts).map(([m, a]) => [m, `a${n.get(a)}`]));
}

const publicOpened = (payload: unknown) => {
  const p = payload as { accounts?: Record<string, string> } | null;
  return p?.accounts === undefined ? payload : { ...p, accounts: accountAliases(p.accounts) };
};

/**
 * An event as anyone with a public room's link is shown it (public rooms spec D4): what a member
 * is shown, less every brief. A `brief_update` is left out, null here. A `member_joined` keeps its
 * joiner's member id, label and seat, each a string or null, and nothing else: the stored payload
 * carries the brief, the org, the agent and the capabilities, and naming the three fields means a
 * field a payload gains later is not shown by default (plan ruling R4).
 */
export function publicReadEvent(e: SessionEvent, labels: ReadonlyMap<string, string> = new Map()) {
  // No room file reaches the public page (ADR 0046): not its content, which no event carries, and not its path,
  // revision or size, which for memory would name an account's notes.
  if (e.type === "brief_update" || e.type === "fs") return null;
  // No seat names on a public read (seat names spec): the page names members by number, and an addressee is named by
  // its label, which the public routes' numbering (`byNumber`) turns into "member N" as it does every label.
  const base = publicEvent(e);
  const shown = base.to !== undefined
    ? { ...base, to: base.to.map((t) => ({ member_id: t.member_id, label: labels.get(t.member_id) ?? null })) }
    : base;
  if (e.type !== "member_joined") return shown;
  const joiner = (e.payload as { member?: Record<string, unknown> | null } | null)?.member;
  const text = (key: string) => {
    const v = joiner?.[key];
    return typeof v === "string" ? v : null;
  };
  return { ...shown, payload: { member: { member_id: text("member_id"), label: text("label"), room_role: text("room_role") } } };
}

/**
 * Whether `reader` may read this member's brief (D2, D3, D5 of the read_context design): the member
 * grants read_context, or the reader is the member's own account. A null reader is a path every
 * member shares, such as the room socket, and reads a granted brief only.
 */
export function seesBrief(author: Pick<Member, "userId" | "capabilities">, reader: string | null): boolean {
  return author.capabilities.includes("read_context") || reader === author.userId;
}

// The two event types whose payload holds a brief. One place says which, so the rule and the lookup
// of the rows it needs cannot disagree about it.
const carriesBrief = (e: SessionEvent) => e.type === "brief_update" || e.type === "member_joined";

/**
 * The members whose rows `readableEvents` needs: the author of each brief_update and member_joined,
 * once each, in first-seen order. An event that holds no brief needs no row.
 */
export function briefAuthors(events: readonly SessionEvent[]): string[] {
  return [...new Set(events.filter(carriesBrief).map((e) => e.fromMemberId))];
}

/**
 * The event as `reader` may see it (read_context design, section 1), from the row of the handle that
 * wrote it (D2); a missing row reads as not granting (plan ruling R11). Never changes `e`.
 *
 * - A `brief_update` whose author keeps their brief is dropped, for every reader but the author's own account.
 * - A `member_joined` still goes out, so peers know who joined. Only `payload.brief` becomes null;
 *   the member block keeps its agent and capabilities (R10).
 * - An `fs` event about an account's memory (ADR 0046) is judged by `seesMemory` from every seat that account has
 *   held (`accountSeats`), not the one that wrote it, and dropped when it refuses or no seats are passed.
 * - Every other event comes back as it was.
 */
export function readableEvent(
  e: SessionEvent,
  author: Pick<Member, "capabilities"> | undefined,
  reader: string | null,
  accountSeats?: readonly Pick<Member, "capabilities" | "leftAt">[],
  shared = false,
): SessionEvent | null {
  // An account's room notes (ADR 0047, decision 7), judged from its sharing switch and every seat the account has held,
  // not the one that wrote it. No seats or no switch passed fails closed: the two single-event readers in rooms.ts
  // refuse every type an fs event could be.
  if (isMemoryEvent(e)) return seesMemory(accountSeats ?? [], e.fromUserId, reader, { shared }) ? e : null;
  if (!carriesBrief(e)) return e;
  if (seesBrief({ userId: e.fromUserId, capabilities: author?.capabilities ?? [] }, reader)) return e;
  if (e.type === "brief_update") return null;
  return { ...e, payload: { ...(e.payload as Record<string, unknown> | null), brief: null } };
}

/**
 * `readableEvent` over a list, each author looked up by `fromMemberId`; a dropped event is left out
 * and the order kept. A grant belongs to a handle, so one account's two handles can differ, and each
 * brief is judged by the row of the handle that wrote it. A memory event is judged by its account's sharing switch
 * (`sharers` holds the accounts that turned it on) and every seat of its account, looked up in `seatsByUser` by
 * `fromUserId` (ADR 0047).
 */
export function readableEvents(
  events: readonly SessionEvent[],
  members: readonly Pick<Member, "memberId" | "capabilities">[],
  reader: string | null,
  seatsByUser?: ReadonlyMap<string, readonly Pick<Member, "capabilities" | "leftAt">[]>,
  sharers?: ReadonlySet<string>,
): SessionEvent[] {
  const rows = new Map(members.map((m) => [m.memberId, m]));
  return events.flatMap((e) => readableEvent(e, rows.get(e.fromMemberId), reader, seatsByUser?.get(e.fromUserId), sharers?.has(e.fromUserId) ?? false) ?? []);
}

/** A room file under `/members/`: an account's memory (ADR 0046). */
export const isMemoryPath = (path: string): boolean => path.startsWith("/members/");

/** An `fs` event about an account's memory. */
export function isMemoryEvent(e: SessionEvent): boolean {
  if (e.type !== "fs") return false;
  const path = (e.payload as { path?: unknown } | null)?.path;
  // A path that cannot be read is treated as memory: a privacy filter fails closed.
  return typeof path === "string" ? isMemoryPath(path) : true;
}

/** The accounts whose seats `readableEvents` needs for these events' memory: each once, in first-seen order. */
export function memoryAuthors(events: readonly SessionEvent[]): string[] {
  return [...new Set(events.filter(isMemoryEvent).map((e) => e.fromUserId))];
}

/**
 * Whether `reader` may see an account's room notes (ADR 0047, decision 7). Its own account may, unless `ownAccount`
 * is false (app code, ADR B). A null reader, a path every member shares, may not. Anyone else may only when the
 * account has turned on notes sharing for the room (`shared`, the `ns:` row; false when not passed, so a caller that
 * has not read the switch hides the notes) and every seat the account holds grants read_context; a seat that left or
 * was evicted is not held, and with none held, every seat it held must have granted. No seats is no.
 */
export function seesMemory(
  seats: readonly Pick<Member, "capabilities" | "leftAt">[],
  ownerUserId: string,
  reader: string | null,
  opts: { ownAccount?: boolean; shared?: boolean } = {},
): boolean {
  if (reader === null) return false;
  if ((opts.ownAccount ?? true) && reader === ownerUserId) return true;
  if (opts.shared !== true) return false;
  const held = seats.filter((m) => m.leftAt === null);
  const judged = held.length > 0 ? held : seats;
  return judged.length > 0 && judged.every((m) => m.capabilities.includes("read_context"));
}
