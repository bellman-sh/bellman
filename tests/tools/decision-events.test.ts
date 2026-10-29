/**
 * Decision events (ADR 0040, #402) reach a member through `bellman_sync` as any other event does: projected by
 * `publicEvent`, wrapped as untrusted, and with no effect on `outstanding`, which lists action requests alone until
 * #405. No tool opens or votes on a decision yet, so the room's store writes them directly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MemoryStore } from "../../src/store.js";
import { Harness, envelopes } from "../helpers/harness.js";
import { pairUp, type PairedSession } from "../helpers/flows.js";
import { decisionHash, type DecisionDraft } from "../../src/decision.js";

let store: MemoryStore;
let h: Harness;
let p: PairedSession;

beforeEach(async () => {
  store = new MemoryStore();
  h = new Harness(store);
  p = await pairUp(h);
});
afterEach(async () => { await h.close(); });

const draft: DecisionDraft = { key: "tools", effect: { kind: "surface_proposal", base: 0 }, rule: "majority" };

describe("decision events over bellman_sync", () => {
  it("arrive projected and wrapped, interrupting except the vote, and leave outstanding alone", async () => {
    const opened = await store.openDecision(p.sessionId, {
      type: "decision_opened", fromMemberId: p.creatorMemberId, fromUserId: "u_jesse", fromLabel: "creator",
      payload: draft, refId: null,
    }, null);
    if (opened.outcome !== "appended") throw new Error(opened.outcome);
    await store.castVote(p.sessionId, {
      type: "decision_vote", fromMemberId: p.creatorMemberId, fromUserId: "u_jesse", fromLabel: "creator", refId: null,
      payload: { decision: opened.event.cursor, hash: decisionHash(draft), choice: "approve", via: "action_response", human_approved: true },
    }, null);
    await store.closeDecision(p.sessionId, opened.event.cursor, { state: "failed", reason: "rejected" }, Date.now());

    const out = await p.joiner.call("bellman_sync", { session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: p.joinerCursor });
    expect(out.isError, out.text).toBe(false);
    const events = envelopes(out.data.events);
    expect(events.every((e) => e.trust === "untrusted")).toBe(true);
    const shown = events.map((e) => e.data as { type: string; ambient?: boolean; payload: Record<string, unknown> });
    expect(shown.map((e) => [e.type, e.ambient ?? false])).toEqual([
      ["decision_opened", false], ["decision_vote", true], ["decision_closed", false],
    ]);
    expect(shown[1].payload).toMatchObject({ capacity: "binding", hash: decisionHash(draft) });
    expect(shown[2].payload).toMatchObject({ decision: opened.event.cursor, state: "failed", reason: "rejected" });
    expect(out.data.outstanding).toBeUndefined();
  });
});
