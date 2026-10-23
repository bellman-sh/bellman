/**
 * A topic room's proposal, the pure rules (topic rooms spec, D2 to D4): the shape of the payload an
 * `action_request` carries to propose a card, and the source a text or diagram card must link.
 *
 * Runtime-free, as surface.ts is: no store, no MCP SDK, no `cloudflare:workers`, because both stores, the
 * tools and both test programs import it. It imports action-state.ts and manifest.ts, and surface.ts for a
 * type, and nothing that imports store.ts, so store.ts can import it without a cycle. `decideApproval` is the
 * decision both stores take when a maintainer approves a proposal.
 */
import { z } from "zod";
import { PROPOSAL_KIND } from "./action-state.js";
import { describeIssue, isTopicRoom } from "./manifest.js";
import { verbsOfRole } from "./roles.js";
import type { StoredSession } from "./stored-session.js";
import type { SurfaceWrite } from "./surface.js";
import type { ApprovedBy, SessionEvent, SurfaceRow } from "./types.js";

/** The open proposals one member may hold in a topic room (spec D3). */
export const MAX_OPEN_PROPOSALS = 3;

/**
 * The payload of a proposal and nothing else: strict, so a key it does not name is refused rather than dropped.
 * `item` is checked to be an object and no more. Whether it is a card that may be written is
 * `normalizeSurfaceWrite`'s to say, when the proposal is sent and again when it is approved.
 */
const ProposalShape = z.strictObject({
  kind: z.literal(PROPOSAL_KIND),
  item: z.custom<object>((v) => typeof v === "object" && v !== null && !Array.isArray(v), "must be an object"),
  base: z.number().int().min(0),
});

/**
 * A proposal's payload read for its shape alone: `{ kind, item, base }` and nothing else. The item is handed on
 * unread, the surface's to check; `base` is the surface cursor the proposal was written against.
 */
export function readProposal(
  payload: unknown,
): { ok: true; item: unknown; base: number } | { ok: false; reason: string } {
  const parsed = ProposalShape.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      reason: `surface_proposal must be { kind: "surface_proposal", item, base }: ${describeIssue(parsed.error.issues[0])}`,
    };
  }
  return { ok: true, item: parsed.data.item, base: parsed.data.base };
}

/**
 * A run of text that starts at `http://` or `https://`, in any case. It ends at a space or at a character that
 * closes the markup around a link, `<`, `>`, a quote or a backtick, so `<https://example.com>`, a link in
 * quotes and a link inside inline code or HTML each end where the link does.
 */
const URL_RUN = /https?:\/\/[^\s<>"'`]+/gi;

/** What prose puts after a link without it belonging to the link: the full stop, the comma, the closing bracket. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * Whether `body` holds an http or https URL with a host, read as text (topic rooms plan, R8). Nothing is parsed
 * as Markdown or Mermaid, so a link is found wherever it sits in either. A run that `new URL` refuses, such as
 * `https://` alone, is not a link.
 */
export function hasSourceLink(body: string): boolean {
  for (const [run] of body.matchAll(URL_RUN)) {
    let url: URL;
    try {
      url = new URL(run.replace(TRAILING_PUNCTUATION, ""));
    } catch {
      continue;
    }
    // ponytail: the check is that a link is there, not that it resolves or that the source is any good; any host
    // `new URL` accepts passes, `http://./` included. The maintainer's human judges the source before approving.
    if ((url.protocol === "http:" || url.protocol === "https:") && url.hostname !== "") return true;
  }
  return false;
}

/** What a text or diagram card is told when its body links no source. */
const NEEDS_A_SOURCE = "a card needs a source: put at least one http:// or https:// link in its body";

/**
 * The source rule (spec D4, plan R8): null when `write` meets it or is not asked for it, else the refusal. A
 * text or a diagram is prose, so its body links where it came from. A `link` is its own source; a removal, a
 * `file`, an `image`, an `html` page, a `shape` and a `connector` carry no prose and are asked for none.
 */
export function sourceRefusal(write: SurfaceWrite): string | null {
  const card = write.item;
  if (card === null || (card.kind !== "text" && card.kind !== "diagram")) return null;
  return hasSourceLink(card.body ?? "") ? null : NEEDS_A_SOURCE;
}

/** What the store does with an approval, decided from what it read in the transaction that writes (plan R12). */
export type ApprovalDecision =
  | { kind: "answered"; by: string }                // an earlier action_response to the request exists: its sender's label
  | { kind: "record" }                              // append the response alone (R13)
  | { kind: "stale"; cursor: number }               // the key changed after base (R16)
  | { kind: "apply"; approvedBy: ApprovedBy };      // append the response, then the card

/**
 * Whether `e` is a `surface` event for `key`. A write names it as `key` on the item and a removal as `key`
 * beside `remove: true`. The payload is read off the log and nothing is assumed of its shape.
 */
const namesKey = (e: SessionEvent, key: string): boolean =>
  e.type === "surface" && typeof e.payload === "object" && e.payload !== null && (e.payload as { key?: unknown }).key === key;

/**
 * The decision both stores take when a maintainer's `action_response` approves a proposal (topic rooms spec, D2).
 * Pure, and handed what each store read inside the transaction that writes, so the two cannot decide differently.
 * The order is part of the rule:
 *
 * 1. `answered`: an earlier response to the request is in `after`, and the first answer wins. It comes first
 *    because the card the first approval wrote is what would make a second approval of the same proposal read
 *    `stale`, and that second approval should read as answered.
 * 2. `record`: the response is stored alone (R13) when there is no write to apply (`write` is null), the room is
 *    not a topic room, the approver is not on the roster, or their role lacks `write_surface`. The proposal then
 *    reads answered, because the derivation reads the response and nothing else.
 * 3. `stale`: the key changed after `base` (R16). A row whose cursor is past `base` is stale. With no row, the key
 *    is stale when the room's surface cursor is past `base` and `after` holds a `surface` event that names it,
 *    which is how a removal shows, since it leaves no row; the latest such event's cursor is the one named.
 * 4. `apply`, with the approver the card is stamped with.
 *
 * "On the roster" means a member who has not left. The Durable Objects store reads the members present and
 * MemoryStore keeps those who left on the roster with `leftAt` set, so asking for `leftAt === null` is what makes
 * the two agree about an approver who left between the tool's read and this write.
 *
 * `after` is every event with a cursor past `base`, in cursor order. A response to the request always sits
 * there, since a proposal's `base` is behind the request it rides in.
 */
export function decideApproval(input: {
  room: Pick<StoredSession, "manifest" | "members" | "surfaceCursor">;
  approverId: string;
  requestCursor: number;
  base: number;
  write: SurfaceWrite | null;
  row: SurfaceRow | undefined;          // the stored row for write.key; undefined when there is none or write is null
  after: readonly SessionEvent[];       // every event with a cursor past base, in cursor order
}): ApprovalDecision {
  const { room, approverId, requestCursor, base, write, row, after } = input;

  const earlier = after.find((e) => e.type === "action_response" && e.refId === String(requestCursor));
  if (earlier !== undefined) return { kind: "answered", by: earlier.fromLabel };

  const approver = room.members.find((m) => m.memberId === approverId && m.leftAt === null);
  if (
    write === null || !isTopicRoom(room.manifest) || approver === undefined
    || !verbsOfRole(room.manifest, approver.roomRole).includes("write_surface")
  ) {
    return { kind: "record" };
  }

  if (row !== undefined) {
    if (row.cursor > base) return { kind: "stale", cursor: row.cursor };
  } else if ((room.surfaceCursor ?? 0) > base) {
    let latest: SessionEvent | undefined;
    for (const e of after) if (namesKey(e, write.key)) latest = e;
    if (latest !== undefined) return { kind: "stale", cursor: latest.cursor };
  }

  return { kind: "apply", approvedBy: { memberId: approver.memberId, label: approver.label } };
}
