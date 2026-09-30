import type { SessionEvent } from "./types.js";

// Deliberately in neither server.ts nor store-do.ts. store-do.ts imports
// `cloudflare:workers`, so the Node program cannot import it (tsconfig.json
// excludes it), and importing server.ts from the Durable Object would pull the
// whole tool layer into it. What both must agree on lives here, with no import
// beyond a type, as stored-session.ts does for the shape store-do.ts and the
// tests share.

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
  };
}
