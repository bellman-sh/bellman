/**
 * A topic room's proposal, the pure rules (topic rooms spec, D2 to D4): the shape of the payload an
 * `action_request` carries to propose a card, and the source a text or diagram card must link.
 *
 * Runtime-free, as surface.ts is: no store, no MCP SDK, no `cloudflare:workers`, because both stores, the
 * tools and both test programs import it. It imports action-state.ts and manifest.ts, and surface.ts for a
 * type, and nothing that imports store.ts, so store.ts can import it without a cycle. `decideApproval`, the
 * decision both stores take when a maintainer approves a proposal, is added here with the approval itself.
 */
import { z } from "zod";
import { PROPOSAL_KIND } from "./action-state.js";
import { describeIssue } from "./manifest.js";
import type { SurfaceWrite } from "./surface.js";

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
