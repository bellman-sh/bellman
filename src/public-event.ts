import { isAmbient } from "./attention.js";
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
export function publicEvent(e: SessionEvent) {
  return {
    cursor: e.cursor,
    type: e.type,
    from: { member_id: e.fromMemberId, label: e.fromLabel },
    payload: e.type === "decision_opened" ? publicOpened(e.payload) : e.payload,
    ref_id: e.refId,
    at: new Date(e.at).toISOString(),
    // Only when true. Omission costs nothing for the twelve types that predate
    // #111, and a client that has never heard of `progress` keeps working.
    ...(isAmbient(e) ? { ambient: true as const } : {}),
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
export function publicReadEvent(e: SessionEvent) {
  if (e.type === "brief_update") return null;
  const shown = publicEvent(e);
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
 * - Every other event comes back as it was.
 */
export function readableEvent(
  e: SessionEvent,
  author: Pick<Member, "capabilities"> | undefined,
  reader: string | null,
): SessionEvent | null {
  if (!carriesBrief(e)) return e;
  if (seesBrief({ userId: e.fromUserId, capabilities: author?.capabilities ?? [] }, reader)) return e;
  if (e.type === "brief_update") return null;
  return { ...e, payload: { ...(e.payload as Record<string, unknown> | null), brief: null } };
}

/**
 * `readableEvent` over a list, each author looked up by `fromMemberId`; a dropped event is left out
 * and the order kept. A grant belongs to a handle, so one account's two handles can differ, and each
 * event is judged by the row of the handle that wrote it.
 */
export function readableEvents(
  events: readonly SessionEvent[],
  members: readonly Pick<Member, "memberId" | "capabilities">[],
  reader: string | null,
): SessionEvent[] {
  const rows = new Map(members.map((m) => [m.memberId, m]));
  return events.flatMap((e) => readableEvent(e, rows.get(e.fromMemberId), reader) ?? []);
}
