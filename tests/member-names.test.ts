/**
 * `publicNames` (src/member-names.ts): the one map from a room's labels to the names a reader outside
 * the room is shown. The public routes swap it into each page, and the hosted seat's prompt names the
 * senders of the replies it answers by it, so what both rely on is pinned here, once.
 */
import { describe, expect, it } from "vitest";
import { HOST_LABEL, hostMember } from "../src/host.js";
import { publicNames } from "../src/member-names.js";
import { MemoryStore } from "../src/store.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

/** A store that numbers the labels it is given a table for, and records each ask. */
function numbering(table: Record<string, number>) {
  const asked: [string, string[]][] = [];
  const store = {
    publicNumbers: async (sessionId: string, labels: readonly string[]) => {
      asked.push([sessionId, [...labels]]);
      return Object.fromEntries(labels.filter((l) => l in table).map((l) => [l, table[l]]));
    },
  };
  return { store, asked };
}

describe("publicNames", () => {
  it("calls a label the room numbered 'member N', and leaves out one it has not numbered", async () => {
    const { store } = numbering({ "a@x": 1, "b@x": 2 });
    const names = await publicNames(store, "qs_1", ["a@x", "b@x", "nobody@x"]);
    expect(names.get("a@x")).toBe("member 1");
    expect(names.get("b@x")).toBe("member 2");
    expect(names.has("nobody@x")).toBe(false);
  });

  it("asks the store once, in the room it was given, for each label once", async () => {
    const { store, asked } = numbering({ "a@x": 1 });
    await publicNames(store, "qs_1", new Set(["a@x", "b@x"]));
    await publicNames(store, "qs_2", ["a@x", "b@x", "a@x"]);
    expect(asked).toEqual([["qs_1", ["a@x", "b@x"]], ["qs_2", ["a@x", "b@x"]]]);
  });

  // The seat's stored label stays `host@bellman` (member rows, events, the audit trail); only what a
  // reader outside the room is shown calls it `host`.
  it("calls the hosted seat 'host', whether the store has a number for its label or none", async () => {
    expect((await publicNames(numbering({}).store, "qs_1", [HOST_LABEL])).get(HOST_LABEL)).toBe("host");
    // The store never numbers the seat, but a label is only a string: the seat's is its own.
    expect((await publicNames(numbering({ [HOST_LABEL]: 3 }).store, "qs_1", [HOST_LABEL])).get(HOST_LABEL)).toBe("host");
  });

  it("names a real room's creator by number and its hosted seat 'host'", async () => {
    const m = roomManifest({
      mode: "swarm", preset: null, heartbeatOnMs: 3_600_000,
      roles: { lead: { can: ["send", "invite"], description: null, reports: false }, host: { can: ["send"], description: null, reports: false } },
      defaultRole: "lead", creatorRole: "lead", host: { role: "host", model: "haiku", instructions: null },
    });
    const store = new MemoryStore();
    await store.createSession(session({ manifest: m, members: [member({ label: "jesse@mcfearsome.dev" }), hostMember(m, Date.now())] }));
    const names = await publicNames(store, "qs_test", ["jesse@mcfearsome.dev", HOST_LABEL, "nobody@x"]);
    expect(names).toEqual(new Map([["jesse@mcfearsome.dev", "member 1"], [HOST_LABEL, "host"]]));
  });
});
