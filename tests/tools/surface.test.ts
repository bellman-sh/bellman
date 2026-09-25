/**
 * INVARIANT 9: the tool surface stays at 8. Every addition is deliberate: this
 *              list is where a new tool has to be noticed, so adding one means
 *              changing it here, and the number below with it, on purpose.
 * INVARIANT 4: lowest-common-denominator MCP — tools only, text-first
 *              responses, long-poll capped at 25s.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { ENTITLEMENTS } from "../../src/auth.js";

const EXPECTED_TOOLS = [
  "bellman_start",
  "bellman_connect",
  "bellman_confirm",
  "bellman_send",
  "bellman_sync",
  "bellman_leave",
  "bellman_audit",
  "bellman_invite",
].sort();

describe("tool surface", () => {
  let h: Harness;
  let jesse: Peer;

  beforeEach(async () => {
    h = new Harness();
    jesse = await h.connect(DEV_KEY.jesse);
  });

  afterEach(async () => {
    await h.close();
  });

  /** INVARIANT 9 */
  it(`registers exactly the ${EXPECTED_TOOLS.length} Bellman tools`, async () => {
    const { tools } = await jesse.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
    // The invariant's number as an assertion, not prose. This file once said 7
    // over a list of 8 and nothing failed. Keep it equal to the header's.
    expect(EXPECTED_TOOLS).toHaveLength(8);
  });

  it("gives every tool a description and an input schema", async () => {
    const { tools } = await jesse.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
  });

  // A description is the only documentation a caller has, and bellman_start's went
  // stale on this branch: its Errors line omitted the likeliest error (a bad
  // manifest), and the member counts left with the `mode` argument. Each rejection
  // below is provoked, and the handler's message and the description must carry the
  // same words, so neither can change without this failing.
  it("documents bellman_start's rejections, returned fields and member counts in the handler's own words", async () => {
    const { tools } = await jesse.listTools();
    const doc = tools.find((t) => t.name === "bellman_start")!.description!;
    const flat = doc.replace(/\s+/g, " ");

    const peer = await h.connect(DEV_KEY.peer); // free plan
    const teamless = await h.connectAs({
      userId: "u_teamless", orgId: null, plan: "team", role: "admin", label: "teamless",
    });
    for (let i = 0; i < ENTITLEMENTS.free.monthlyCreates; i++) {
      await h.store.recordCreate("u_spent");
    }
    const spent = await h.connectAs({
      userId: "u_spent", orgId: null, plan: "free", role: "member", label: "spent",
    });
    const dangling = {
      room: "r", mode: "pair", roles: { lead: { can: ["send"] } },
      default_role: "ghost", creator_role: "lead",
    };

    const rejections: [string, Peer, Record<string, unknown>][] = [
      ["invalid manifest — ", jesse, { manifest: dangling }],
      ["swarm mode requires", peer, { manifest: manifestFixture({ preset: "swarm" }) }],
      ["org_only sessions require", peer, { manifest: manifestFixture(), org_only: true }],
      ["org_only was set but", teamless, { manifest: manifestFixture(), org_only: true }],
      ["monthly session limit", spent, { manifest: manifestFixture() }],
    ];
    for (const [words, who, args] of rejections) {
      const res = await who.call("bellman_start", { brief: brief(), ...args });
      expect(res.isError, words).toBe(true);
      expect(res.text, `handler says: ${words}`).toContain(words);
      expect(flat, `description says: ${words}`).toContain(words);
    }

    // Everything the handler returns is named on the Returns line. The one
    // exception is share_instructions, which no tool lists: it is guidance for a
    // human, not data.
    const started = await jesse.call("bellman_start", { brief: brief(), manifest: manifestFixture() });
    const from = flat.indexOf("Returns:");
    const to = flat.indexOf("Keep member_id");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    for (const key of Object.keys(started.data).filter((k) => k !== "share_instructions")) {
      expect(flat.slice(from, to), `Returns line names ${key}`).toContain(key);
    }

    // What each mode holds is what a caller chooses a preset by.
    expect(flat).toContain('"pair" room holds exactly 2 members');
    expect(flat).toContain("up to your plan's member limit");
  });

  /** INVARIANT 4: tools only — no resources, prompts, sampling or elicitation. */
  it("advertises tools and nothing else", () => {
    const caps = jesse.serverCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeUndefined();
    expect(caps?.prompts).toBeUndefined();
    expect(caps?.completions).toBeUndefined();
    expect(caps?.logging).toBeUndefined();
  });

  /** INVARIANT 4: text-first, structuredContent as enhancement. */
  it("answers with a text block on both success and failure", async () => {
    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.text).not.toBe("");
    expect(started.data.session_id).toBeTruthy();

    const failed = await jesse.call("bellman_sync", {
      session_id: "qs_missing", member_id: "m_missing",
    });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain("Error:");
  });

  /** INVARIANT 4: long-poll capped at 25s so strict clients do not time out. */
  it("rejects a wait longer than 25 seconds", async () => {
    const { tools } = await jesse.listTools();
    const sync = tools.find((t) => t.name === "bellman_sync")!;
    const waitSchema = (sync.inputSchema.properties as Record<string, { maximum?: number; minimum?: number }>)
      .wait_seconds;
    expect(waitSchema.maximum).toBe(25);
    expect(waitSchema.minimum).toBe(0);

    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    const over = await jesse.call("bellman_sync", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
      wait_seconds: 26,
    });
    expect(over.isError).toBe(true);
  });

  it("caps payload size rather than relaying unbounded context", async () => {
    const { tools } = await jesse.listTools();
    const send = tools.find((t) => t.name === "bellman_send")!;
    expect(JSON.stringify(send.description)).toContain("20000");
  });
});
