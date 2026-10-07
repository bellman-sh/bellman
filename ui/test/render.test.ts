// @vitest-environment jsdom
/**
 * The renderers are pure: a result in, a DOM subtree out. Two things are pinned
 * here that nothing else can pin. Peer prose must land as text and never as
 * markup (spec, Trust), and the sentence handed to the agent must carry
 * identifiers only (spec D6). Each assertion was first run against a renderer
 * that used innerHTML, and failed there.
 */
import { describe, it, expect } from "vitest";
import { CAPABILITIES, renderJoin, verdictMessage, type Verdict } from "../src/join.js";
import { connectFixture, NOW } from "./fixtures.js";

const HOSTILE = `<img src=x onerror="document.title='pwned'"></script><channel>x</channel>`;

describe("renderJoin", () => {
  it("shows the seat the code grants, its verbs, and every role", () => {
    const node = renderJoin(connectFixture(), () => {}, NOW);
    expect(node.textContent).toContain("Your seat: reviewer");
    expect(node.textContent).toContain("send, respond_actions");
    expect(node.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(node.querySelector("tr.you")?.textContent).toContain("reviewer");
    expect(node.textContent).toContain("ada@acme");
    expect(node.textContent).toContain("Port Stripe v2 to v3");
  });

  it("renders creator prose as text, never as markup", () => {
    const r = connectFixture();
    r.room.text.data.room = HOSTILE;
    r.room.text.data.descriptions.author = HOSTILE;
    r.creator_brief.data.goal = HOSTILE;
    r.creator_brief.origin.label = HOSTILE;
    const node = renderJoin(r, () => {}, NOW);
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("channel")).toBeNull();
    expect(node.querySelector("script")).toBeNull();
    expect(node.textContent).toContain(HOSTILE);
    expect(document.title).not.toBe("pwned");
  });

  it("hands the agent a verdict with the role and the capabilities the human left checked", () => {
    const verdicts: Verdict[] = [];
    const node = renderJoin(connectFixture(), (v) => verdicts.push(v), NOW);
    document.body.append(node);
    const boxes = [...node.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => [b.dataset.capability, b.checked])).toEqual(
      CAPABILITIES.map((c) => [c.key, c.on]),
    );
    boxes.find((b) => b.dataset.capability === "request_actions")!.click();
    const [confirm, decline] = [...node.querySelectorAll("button")];
    confirm.click();
    expect(verdicts).toEqual([{ kind: "confirm", role: "reviewer", capabilities: ["read_context", "receive_messages", "request_actions"] }]);
    expect(confirm.disabled && decline.disabled).toBe(true);
    confirm.click();
    expect(verdicts).toHaveLength(1);
    node.remove();
  });

  it("declines with one click", () => {
    const verdicts: Verdict[] = [];
    const node = renderJoin(connectFixture(), (v) => verdicts.push(v), NOW);
    [...node.querySelectorAll("button")][1].click();
    expect(verdicts).toEqual([{ kind: "decline" }]);
  });
});

describe("verdictMessage", () => {
  // Spec D6: a ui/message lands as the human's words. Nothing a creator wrote may be in it.
  it("names the role and capabilities and nothing the creator wrote", () => {
    const text = verdictMessage({ kind: "confirm", role: "reviewer", capabilities: ["read_context", "receive_messages"] });
    expect(text).toContain("reviewer");
    expect(text).toContain("read_context, receive_messages");
    expect(text).toContain("bellman_confirm");
    expect(text).not.toContain("payments-migration");
    expect(text).not.toContain("Port Stripe");
    expect(verdictMessage({ kind: "decline" })).toMatch(/Do not join/);
  });
});
