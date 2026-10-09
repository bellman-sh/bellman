/**
 * INVARIANT 9: the tool surface stays at 10. Every addition is deliberate: this
 *              list is where a new tool has to be noticed, so adding one means
 *              changing it here, and the number below with it, on purpose.
 * INVARIANT 4: tools first — every tool's text result stands alone; one UI
 *              resource (MCP Apps) and no other primitive; long-poll capped at 25s.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY, type Peer } from "../helpers/harness.js";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { ENTITLEMENTS } from "../../src/auth.js";
import { VERBS } from "../../src/manifest.js";
import { SURFACE_KINDS } from "../../src/surface.js";
import { APP_MIME_TYPE, APP_RESOURCE_URI } from "../../src/ui/resource.js";

const EXPECTED_TOOLS = [
  "bellman_start",
  "bellman_connect",
  "bellman_confirm",
  "bellman_send",
  "bellman_sync",
  "bellman_leave",
  "bellman_audit",
  "bellman_invite",
  "bellman_evict",
  "bellman_rooms",
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
    expect(EXPECTED_TOOLS).toHaveLength(10);
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
    expect(flat).toContain('a "swarm" room holds as many as you invite, up to 100');
  });

  // A joiner's human decides on the verbs a room declares, and since #2 the
  // server enforces them. Each tool that returns the room block says so. The
  // decision is denyVerb in src/roles.ts, the call sites are bellman_send and
  // bellman_invite, and the denial paths are tests/tools/verbs.test.ts.
  it("says on every tool that shows a room's verbs that the server enforces them, and that reading and leaving are never gated", async () => {
    const { tools } = await jesse.listTools();
    const showsVerbs = ["bellman_confirm", "bellman_connect", "bellman_start"];
    for (const name of showsVerbs) {
      const doc = tools.find((t) => t.name === name)!.description!.replace(/\s+/g, " ");
      expect(doc, name).toMatch(/verbs are enforced by the server/i);
      // The old claim must be gone, not merely joined by a new one, and not back in
      // another spelling: any case, and the plain "are not enforced", fail here. A
      // phrase pin cannot stop a paraphrase ("nothing checks them at call time"
      // passes); this closes the cheap ways back, not every one.
      expect(doc, name).not.toMatch(/\bnot (yet )?enforced\b/i);
      expect(doc, name).not.toMatch(/stated intent/i);
      // Reading the room and leaving it are the two calls no verb gates. Without
      // this clause "your_verbs is what a seat may do" reads as "and nothing else".
      // Its truth is pinned by behaviour, not here: verbs.test.ts's "sync and
      // leave are never gated". Gating either tool on purpose means changing all
      // three descriptions with it.
      expect(doc, name).toContain("never gated");
    }
  });

  // Split from the test above on purpose: that one is about the three tools that
  // DO show verbs, and its failure message says so. This one is about every OTHER
  // tool, so pluralising the one verb bellman_invite or bellman_send names — a
  // plausible editorial change — fails here, under a name that explains it,
  // instead of failing the "enforces them" test above for an unrelated reason.
  it("no other tool lists a room's verbs", async () => {
    const { tools } = await jesse.listTools();
    const showsVerbs = ["bellman_confirm", "bellman_connect", "bellman_start"];
    // bellman_invite and bellman_send do name one verb each, in the singular, as
    // what a call needs; this regex is deliberately plural, so it flags a tool
    // that starts talking about verbs rather than naming the one it requires.
    for (const t of tools.filter((t) => !showsVerbs.includes(t.name))) {
      expect(t.description, t.name).not.toMatch(/verbs/i);
    }
  });

  // The one place a caller reads which verbs it may author is this line, and it is prose beside an enum
  // it can outlive without anything noticing: it went on saying `audit, close_room` after the enum
  // dropped them, so every model was told to author verbs the server rejects while the suite stayed
  // green. Compared with the enum itself, neither can change without this failing.
  it("lists in bellman_start's description exactly the verbs a manifest may hold", async () => {
    const { tools } = await jesse.listTools();
    const doc = tools.find((t) => t.name === "bellman_start")!.description!;
    const listed = /^\s*Verbs: (.+)\.$/m.exec(doc)?.[1];
    expect(listed, "bellman_start's description has a `Verbs:` line").toBeDefined();
    expect(listed!.split(", ").sort()).toEqual([...VERBS].sort());
  });

  /** INVARIANT 4: tools first. One UI resource, and no other primitive beyond tools. */
  it("advertises tools and the one UI resource, and nothing else", () => {
    const caps = jesse.serverCapabilities();
    expect(caps?.tools).toBeDefined();
    expect(caps?.resources).toBeDefined();
    expect(caps?.prompts).toBeUndefined();
    expect(caps?.completions).toBeUndefined();
    expect(caps?.logging).toBeUndefined();
  });

  it("lists exactly one resource, the app, with the MCP Apps mimeType", async () => {
    const { resources } = await jesse.listResources();
    expect(resources.map((r) => [r.uri, r.mimeType])).toEqual([[APP_RESOURCE_URI, APP_MIME_TYPE]]);
  });

  it("reads the app as one HTML document that asks the host for a border", async () => {
    const { contents } = await jesse.readResource(APP_RESOURCE_URI);
    expect(contents).toHaveLength(1);
    const page = contents[0] as { mimeType?: string; text?: string; _meta?: { ui?: { prefersBorder?: boolean } } };
    expect(page.mimeType).toBe(APP_MIME_TYPE);
    expect(typeof page.text).toBe("string");
    expect(/^<!doctype html>/i.test(page.text!.trimStart())).toBe(true);
    expect(page._meta?.ui?.prefersBorder).toBe(true);
  });

  // The host renders a tool through the resource its _meta names. A tool that
  // named a resource this server does not serve would render nothing, so every
  // ui meta present must point at the one resource.
  it("attaches the app to bellman_connect and bellman_rooms, and to no other tool", async () => {
    const { tools } = await jesse.listTools();
    const uiOf = (t: { _meta?: Record<string, unknown> }) =>
      (t._meta as { ui?: { resourceUri?: string } } | undefined)?.ui;
    const withApp = tools.filter((t) => uiOf(t)?.resourceUri === APP_RESOURCE_URI).map((t) => t.name).sort();
    expect(withApp).toEqual(["bellman_connect", "bellman_rooms"]);
    for (const t of tools) {
      const ui = uiOf(t);
      if (ui) expect(ui.resourceUri, t.name).toBe(APP_RESOURCE_URI);
    }
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

  /**
   * Spec D1 calls a member's inability to send a `heartbeat` STRUCTURAL rather
   * than conventional. The structure is `z.enum(SEND_KINDS)` plus `SEND_VERB
   * satisfies Record<SendKind, Verb>` — and both still compile if somebody adds
   * "heartbeat" to SEND_KINDS and gives it a verb. Nothing failed in that case,
   * so the claim rested on nobody doing it.
   *
   * Pinned on the shipped schema rather than on the module's own constant: this
   * is the list a client is handed, so it closes the gap at the surface the claim
   * is about, and it needs no export from server.ts to do it.
   */
  it("offers exactly the seven send kinds, and no way to forge a heartbeat", async () => {
    const { tools } = await jesse.listTools();
    const send = tools.find((t) => t.name === "bellman_send")!;
    const kinds = (send.inputSchema.properties as Record<string, { enum?: string[] }>).type.enum;

    expect([...kinds!].sort()).toEqual([
      "action_request", "action_response", "artifact", "brief_update", "message", "progress", "surface",
    ]);
    // Said separately, because that is the claim: the tick is the server's to
    // write, and a member has no name for it to pass here.
    expect(kinds).not.toContain("heartbeat");

    // And the description is the only documentation a caller has, so every kind
    // the schema accepts has to be named somewhere in it. That is all this loop
    // asserts: `toContain` matches a substring of the whole text, so it fails only
    // for a kind named nowhere in it. It does not read the opening line, which
    // once listed five after `progress` was added — `progress` is named elsewhere
    // in the text, so that slip passes here.
    for (const kind of kinds!) {
      expect(send.description, `${kind} missing from the description`).toContain(kind);
    }
  });

  // The loop above reads the send kinds, so a kind added to SURFACE_KINDS with no clause in the `surface` line
  // would pass it (#185 is the case this closes). This one reads the Kinds sentence alone, from `Kinds:` to the
  // `placement is` after it, so a kind whose name appears elsewhere in the description (`code` is in "code/doc/data
  // payload") still has to be named in that sentence. It is still a substring of the sentence: `text` is satisfied
  // by `text/html` inside it, so this catches a kind added without a clause, not the removal of `text`'s.
  it("names every surface kind in the Kinds sentence of bellman_send's description", async () => {
    const { tools } = await jesse.listTools();
    const description = tools.find((t) => t.name === "bellman_send")!.description!;
    const from = description.indexOf("Kinds:");
    const to = description.indexOf("placement is", from);
    expect(from, "the surface line has a Kinds: sentence").toBeGreaterThanOrEqual(0);
    expect(to, "and it ends where `placement is` begins").toBeGreaterThan(from);
    const sentence = description.slice(from, to);
    for (const kind of SURFACE_KINDS) {
      expect(sentence, `${kind} missing from the Kinds sentence`).toContain(kind);
    }
  });
});
