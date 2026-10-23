/**
 * Outside callers (A2A): the types and constants Task 1 lays down. Behaviour arrives in later tasks.
 */
import { afterEach, describe, it, expect } from "vitest";
import { VERBS, builtinPresets, resolveManifest, PRESET_NAMES } from "../src/manifest.js";
import { verbsOfRole } from "../src/roles.js";
import { pairUp } from "./helpers/flows.js";
import { Harness } from "./helpers/harness.js";

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe("the answer verb", () => {
  it('"answer" is a verb no built-in preset grants', () => {
    expect(VERBS).toContain("answer");
    for (const { name } of builtinPresets()) {
      const m = resolveManifest({ room: "r", preset: name });
      for (const role of Object.keys(m.roles)) {
        expect(verbsOfRole(m, role), `${name}/${role}`).not.toContain("answer");
      }
    }
    expect(builtinPresets()).toHaveLength(PRESET_NAMES.length);
  });

  it("a manifest role can be granted answer", () => {
    const m = resolveManifest({
      room: "r", mode: "pair",
      roles: { lead: { can: ["send", "answer"] }, helper: { can: ["send"] } },
      default_role: "helper", creator_role: "lead",
    });
    expect(verbsOfRole(m, "lead")).toContain("answer");
  });
});

describe("outside_answer before the A2A door exists", () => {
  it("is refused by bellman_send, whatever the sender's role", async () => {
    const harness = (h = new Harness());
    const s = await pairUp(harness);
    const out = await s.creator.call("bellman_send", {
      session_id: s.sessionId, member_id: s.creatorMemberId, type: "outside_answer", payload: { text: "hi" },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not supported yet");
  });
});
