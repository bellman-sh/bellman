import { describe, expect, it } from "vitest";
import { cleanBlock, cleanText, eventLine } from "../src/door-protocol.js";

/** The characters that draw nothing or turn the direction a line reads in: each one the cleaners drop. */
const INVISIBLE = [
  "\u{61c}", "\u{200b}", "\u{200e}", "\u{200f}", "\u{202a}", "\u{202b}", "\u{202c}", "\u{202d}", "\u{202e}",
  "\u{2060}", "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}", "\u{feff}",
];
/** A family emoji: three people held together by zero-width joiners. */
const FAMILY = "\u{1f468}\u{200d}\u{1f469}\u{200d}\u{1f467}";

describe("cleanText", () => {
  it("drops escape sequences and control characters", () => {
    expect(cleanText("\u{1b}[31mred\u{1b}[0m\u{7}bell\u{1b}]0;title\u{7}!")).toBe("redbell!");
  });
  it("folds newlines and runs of whitespace into one space, trimmed", () => {
    expect(cleanText("  a\n\n b\tc \r\n")).toBe("a b c");
  });
  it("cuts at max characters, the last one an ellipsis", () => {
    expect(cleanText("x".repeat(10_000), 10)).toBe("x".repeat(9) + "…");
  });
  it("leaves nothing of a string of control characters alone", () => {
    expect(cleanText("\u{0}\u{1b}\u{7f}\u{9b}")).toBe("");
  });
  it("drops every character that draws nothing or turns a line's direction", () => {
    for (const c of INVISIBLE) expect(cleanText(`a${c}b`), `U+${c.codePointAt(0)!.toString(16)}`).toBe("ab");
    // An override that would draw "live" as "evil", and an isolate that would reorder what follows it.
    expect(cleanText("\u{202e}live\u{202c}")).toBe("live");
    expect(cleanText("ada \u{2067}nimda\u{2069} 1")).toBe("ada nimda 1");
  });
  it("leaves nothing of a label made of them alone", () => {
    expect(cleanText(INVISIBLE.join(""))).toBe("");
    expect(cleanText(` ${INVISIBLE.join(" ")} `)).toBe("");
  });
  it("keeps the zero-width joiner and non-joiner, which emoji and some scripts need", () => {
    expect(cleanText(FAMILY)).toBe(FAMILY);
    expect(cleanText("a\u{200c}b")).toBe("a\u{200c}b");
  });
  it("ends an OSC sequence at its string terminator as well as at BEL", () => {
    expect(cleanText("a\u{1b}]0;title\u{1b}\\b")).toBe("ab");
  });
  it("leaves a string that fits in max alone", () => {
    expect(cleanText("x".repeat(10), 10)).toBe("x".repeat(10));
  });
  it("returns no more than max, even for a max below one", () => {
    expect(cleanText("x".repeat(100), 1)).toBe("…");
    expect(cleanText("x".repeat(100), 0)).toBe("");
    expect(cleanText("x".repeat(100), -5)).toBe("");
  });
});

describe("cleanBlock", () => {
  it("keeps line breaks and drops every other control", () => {
    expect(cleanBlock("# Plan\r\n\u{1b}[1m- a\u{1b}[0m\n- b\u{7}")).toBe("# Plan\n- a\n- b");
  });
  it("drops a carriage return that is not half of a line break, and a tab", () => {
    // A bare CR sends a terminal's cursor back over the line it just drew.
    expect(cleanBlock("a\rb\tc")).toBe("abc");
  });
  it("cuts at max characters, the last one an ellipsis", () => {
    expect(cleanBlock("x".repeat(20), 5)).toBe("xxxx…");
  });
  it("drops every character that draws nothing or turns a line's direction, and keeps the joiners", () => {
    expect(cleanBlock(`# Plan\n${INVISIBLE.join("")}- a\u{200c}b ${FAMILY}\n`)).toBe(`# Plan\n- a\u{200c}b ${FAMILY}\n`);
    for (const c of INVISIBLE) expect(cleanBlock(`a${c}\nb`), `U+${c.codePointAt(0)!.toString(16)}`).toBe("a\nb");
  });
});

describe("eventLine", () => {
  it("reads a string payload or a payload's text, cleaned, and anything else by its type", () => {
    expect(eventLine({ type: "message", payload: "hi" })).toBe("hi");
    expect(eventLine({ type: "message", payload: { text: "a\nb" } })).toBe("a b");
    expect(eventLine({ type: "artifact", payload: { name: "x" } })).toBe("artifact");
    expect(eventLine({ type: "message", payload: null })).toBe("message");
  });
});

describe("eventLine, a line for each of the room's own events (L10)", () => {
  const line = (type: string, payload: unknown, ref_id: string | null = null) => eventLine({ type, payload, ref_id });

  it.each([
    ["a member joining, by their role", "member_joined", { member: { member_id: "m-ada", label: "ada", room_role: "builder" }, brief: { goal: "g" } }, "joined as builder"],
    ["a member leaving", "member_left", { label: "ada" }, "left"],
    // The event is the remover's, its label theirs: the member removed is the payload's.
    ["a member removed, by who was removed", "member_evicted", { member_id: "m-ada", label: "ada", room_role: "builder" }, "removed ada"],
    ["a code issued", "invite_issued", { role: "helper", expires_at: null, permanent: true }, "invited a helper"],
    ["a code issued for a role said with an", "invite_issued", { role: "observer", expires_at: null, permanent: false }, "invited an observer"],
    ["a code retired", "invite_revoked", { roles: ["helper"] }, "retired the helper code"],
    ["several codes retired", "invite_revoked", { roles: ["helper", "builder"] }, "retired the helper, builder codes"],
    ["a canvas item, by its title", "surface", { key: "plan", kind: "text", title: "The plan", body: "# Plan" }, "✎ canvas: The plan"],
    ["a canvas item with no title, by its key", "surface", { key: "plan", kind: "text", title: null, body: "# Plan" }, "✎ canvas: plan"],
    ["a canvas item removed", "surface", { key: "plan", remove: true }, "✎ canvas: plan"],
    ["a brief replaced", "brief_update", { goal: "g", state: "s", constraints: [], open_questions: [], agent: { name: "claude" } }, "updated their brief"],
    ["a progress report, by its note", "progress", { note: "on step 2", step: "2", eta_seconds: 60 }, "on step 2"],
  ])("reads %s", (_, type, payload, expected) => {
    expect(line(type, payload)).toBe(expected);
  });

  it("reads an answer by what it answered and the request it names, whatever text it carries", () => {
    expect(line("action_response", { approved: true, result: "done" }, "5")).toBe("approved request 5");
    expect(line("action_response", { approved: false }, "5")).toBe("declined request 5");
    // A peer's text cannot make a refusal read as an approval.
    expect(line("action_response", { approved: false, text: "approved" }, "5")).toBe("declined request 5");
  });

  it("reads an event it has no line for as its type, never as its JSON", () => {
    for (const [type, payload] of [
      ["artifact", { name: "x", content: "y" }],
      ["heartbeat", { members: [] }],
      ["housekeeping", { finding: "room_idle" }],
      ["member_timed_out", { label: "ada" }],
      ["a_type_from_a_later_server", { a: 1 }],
    ] as const) {
      expect(line(type, payload)).toBe(type);
    }
  });

  it("keeps a request with no text whole, as JSON: it is what the person is asked to approve", () => {
    expect(line("action_request", { command: "deploy", target: "prod" })).toBe('{"command":"deploy","target":"prod"}');
  });

  it("cleans and cuts every string a peer put in a line", () => {
    const hostile = "\u{1b}[2Jevil\n\u{7}";
    for (const [type, payload, ref] of [
      ["member_joined", { member: { room_role: hostile } }, null],
      ["member_evicted", { label: hostile }, null],
      ["invite_issued", { role: hostile }, null],
      ["invite_revoked", { roles: [hostile] }, null],
      ["surface", { key: "k", title: hostile }, null],
      ["progress", { note: hostile }, null],
      ["action_response", { approved: true }, hostile],
    ] as const) {
      const read = line(type, payload, ref);
      expect(read).toContain("evil");
      expect(read).not.toMatch(/[\u{0}-\u{1f}\u{7f}-\u{9f}]/u);
    }
    expect(line("progress", { note: "n".repeat(10_000) }).length).toBeLessThanOrEqual(200);
  });
});
