/**
 * One page, two screens (spec D10): the page decides which from the result it is
 * handed. Pure, so Review Focus 5 is pinned here: an error result and a result
 * with no structuredContent both become text, never a blank frame.
 */
import { describe, it, expect } from "vitest";
import { pickScreen } from "../src/screen.js";
import { connectFixture, roomsFixture } from "./fixtures.js";

describe("pickScreen", () => {
  it("renders the join screen for a connect result and the monitor for a rooms result", () => {
    expect(pickScreen({ structuredContent: connectFixture() })).toMatchObject({ kind: "join" });
    expect(pickScreen({ structuredContent: roomsFixture() })).toMatchObject({ kind: "monitor" });
  });

  it("shows an error's text, and the text of a result with no structured content", () => {
    expect(pickScreen({ isError: true, content: [{ type: "text", text: "Error: session is full." }] }))
      .toEqual({ kind: "error", text: "Error: session is full." });
    expect(pickScreen({ content: [{ type: "text", text: "plain" }] })).toEqual({ kind: "none", text: "plain" });
    expect(pickScreen({})).toEqual({ kind: "none", text: "Nothing to show." });
  });
});
