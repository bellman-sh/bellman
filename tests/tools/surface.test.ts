/**
 * INVARIANT 9: the tool surface stays at 7.
 * INVARIANT 4: lowest-common-denominator MCP — tools only, text-first
 *              responses, long-poll capped at 25s.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";

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
  it("registers exactly the 7 Bellman tools", async () => {
    const { tools } = await jesse.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
  });

  it("gives every tool a description and an input schema", async () => {
    const { tools } = await jesse.listTools();
    for (const tool of tools) {
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.inputSchema, tool.name).toBeTruthy();
      expect(tool.inputSchema.type, tool.name).toBe("object");
    }
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
