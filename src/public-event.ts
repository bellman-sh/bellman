import { isAmbient } from "./attention.js";
import type { SessionEvent } from "./types.js";

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
    payload: e.payload,
    ref_id: e.refId,
    at: new Date(e.at).toISOString(),
    // Only when true. Omission costs nothing for the twelve types that predate
    // #111, and a client that has never heard of `progress` keeps working.
    ...(isAmbient(e) ? { ambient: true as const } : {}),
  };
}

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
