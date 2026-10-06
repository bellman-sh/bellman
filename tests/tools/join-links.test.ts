/**
 * A join code is shared as a link, and the link must carry the code
 * unchanged: the page it opens is rendered from the URL alone, so a code the
 * server mints and the code a person reads on the page are the same string.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { pairUp } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";
import { joinUrl } from "../../src/codes.js";

let h: Harness;

beforeEach(() => {
  h = new Harness();
});

afterEach(async () => {
  await h.close();
});

describe("bellman_start", () => {
  it("returns the link the code is shared as", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const started = await jesse.call("bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    expect(started.data.join_url).toBe(joinUrl(String(started.data.join_code)));
    expect(String(started.data.join_url)).toMatch(/^https:\/\/bellman\.sh\/j\/BELL-/);
  });
});
