import { describe, expect, it } from "vitest";
import { cleanBlock, cleanText, eventLine } from "../src/door-protocol.js";

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
});

describe("eventLine", () => {
  it("reads a string payload, a payload's text, or the payload as JSON, cleaned", () => {
    expect(eventLine({ type: "message", payload: "hi" })).toBe("hi");
    expect(eventLine({ type: "message", payload: { text: "a\nb" } })).toBe("a b");
    expect(eventLine({ type: "artifact", payload: { name: "x" } })).toBe('{"name":"x"}');
    expect(eventLine({ type: "message", payload: null })).toBe("");
  });
});
