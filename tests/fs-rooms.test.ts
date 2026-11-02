/**
 * Room files through `src/rooms.ts` (ADR 0046): `writeFs` and the reads, with the memory rule on every path that
 * reveals a memory file, against a `MemoryStore`. The tool and routes are tested over these in their own files.
 */
import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/store.js";
import { eventsFor, findFsFor, fsHistoryFor, leaveRoom, listFsFor, readFsFor, writeFs, evictMember } from "../src/rooms.js";
import { SEND_LIMIT } from "../src/send-limit.js";
import type { Capability, Identity } from "../src/types.js";
import { member, session } from "./helpers/fixtures.js";

const GRANT: Capability[] = ["read_context", "receive_messages"];
const KEEP: Capability[] = ["receive_messages"];
const who = (userId: string, label = userId): Identity => ({ userId, label, orgId: "org_codenerd", plan: "team", role: "member" });
const A = who("u_a"), B = who("u_b"), C = who("u_c"), JESSE = who("u_jesse", "jesse@codenerd");

async function roomWith(id: string, seats: Parameters<typeof member>[0][]) {
  const store = new MemoryStore();
  await store.createSession(session({ id, members: seats.map((s) => member(s)) }));
  return store;
}
const seat = (memberId: string, userId: string, capabilities = GRANT, roomRole = "peer_a") =>
  ({ memberId, userId, label: `seat-${memberId}`, capabilities, roomRole, orgId: "org_codenerd" });

describe("CUJ 1: two members' agents edit one document", () => {
  it("lands an edit, refuses the stale append with the changed content, and restores revision 1 as revision 4", async () => {
    const store = await roomWith("qs_cuj1", [seat("m_a", "u_a"), seat("m_b", "u_b")]);
    const w1 = await writeFs(store, A, "qs_cuj1", "m_a", { path: "/plans/launch.md", write: { op: "write", content: "Launch: Monday\nOwner: a\n" } });
    expect(w1).toMatchObject({ ok: true, value: { path: "/plans/launch.md", rev: 1, replayed: false } });

    const read = await readFsFor(store, B, "qs_cuj1", "m_b", "/plans/launch.md");
    expect(read).toMatchObject({ ok: true, value: { rev: 1 } });
    expect(await writeFs(store, B, "qs_cuj1", "m_b", { path: "/plans/launch.md", write: { op: "edit", old: "Monday", new: "Tuesday", baseRev: 1 } }))
      .toMatchObject({ ok: true, value: { rev: 2 } });

    const stale = await writeFs(store, A, "qs_cuj1", "m_a", { path: "/plans/launch.md", write: { op: "append", content: "Risks: none\n", baseRev: 1 } });
    expect(stale).toMatchObject({ ok: false, code: "stale", state: { current_rev: 2, content: "Launch: Tuesday\nOwner: a\n" } });
    expect(await writeFs(store, A, "qs_cuj1", "m_a", { path: "/plans/launch.md", write: { op: "append", content: "Risks: none\n", baseRev: 2 } }))
      .toMatchObject({ ok: true, value: { rev: 3 } });
    expect(await writeFs(store, B, "qs_cuj1", "m_b", { path: "/plans/launch.md", write: { op: "restore", rev: 1, baseRev: 3 } }))
      .toMatchObject({ ok: true, value: { rev: 4 } });
    expect(await readFsFor(store, A, "qs_cuj1", "m_a", "/plans/launch.md")).toMatchObject({ ok: true, value: { rev: 4, content: "Launch: Monday\nOwner: a\n" } });

    expect((await store.eventsAfter("qs_cuj1", 0)).filter((e) => e.type === "fs")).toHaveLength(4);
    expect((await store.auditForOrg("org_codenerd", 50)).filter((e) => e.sessionId === "qs_cuj1" && e.action === "fs_write")).toHaveLength(4);
    const hist = await fsHistoryFor(store, A, "qs_cuj1", "m_a", "/plans/launch.md", { from: 1, to: 2 });
    expect(hist).toMatchObject({ ok: true });
    expect(hist.ok && hist.value.revisions.map((r) => r.rev)).toEqual([4, 3, 2, 1]);
    expect(hist.ok && hist.value.diff?.diff).toContain("+Launch: Tuesday");
  });
});

describe("CUJ 2: a member's agent keeps memory", () => {
  const seats = [seat("m_a", "u_a"), seat("m_b", "u_b", KEEP), seat("m_c", "u_c")];

  it("shows the third seat A's notes and none of B's, on every read path and in the events", async () => {
    const store = await roomWith("qs_cuj2", seats);
    const a = await writeFs(store, A, "qs_cuj2", "m_a", { path: "/members/me/notes.md", write: { op: "write", content: "a's notes" } });
    const b = await writeFs(store, B, "qs_cuj2", "m_b", { path: "/members/me/notes.md", write: { op: "write", content: "b's notes" } });
    expect(a.ok && b.ok).toBe(true);
    const aPath = a.ok ? a.value.path : "", bPath = b.ok ? b.value.path : "";
    expect(aPath).toMatch(/^\/members\/[0-9a-f]{16}\/notes\.md$/);

    expect(await readFsFor(store, C, "qs_cuj2", "m_c", aPath)).toMatchObject({ ok: true, value: { content: "a's notes" } });
    const hidden = await readFsFor(store, C, "qs_cuj2", "m_c", bPath);
    expect(hidden).toMatchObject({ ok: false, code: "not_found" });
    // Not told B's file exists: the refusal for a withheld file is the one for a missing file.
    const missing = await readFsFor(store, C, "qs_cuj2", "m_c", "/members/0123456789abcdef/notes.md");
    expect(hidden.ok === false && hidden.reason).toBe(missing.ok === false && missing.reason);
    expect(await fsHistoryFor(store, C, "qs_cuj2", "m_c", bPath)).toMatchObject({ ok: false, code: "not_found" });

    const list = await listFsFor(store, C, "qs_cuj2", "m_c", "/members");
    expect(list.ok && list.value.entries.map((r) => r.path)).toEqual([aPath]);
    const found = await findFsFor(store, C, "qs_cuj2", "m_c", "notes");
    expect(found.ok && found.value.entries.map((r) => r.path)).toEqual([aPath]);
    const events = await eventsFor(store, "qs_cuj2", await store.eventsAfter("qs_cuj2", 0), "u_c");
    expect(events.filter((e) => e.type === "fs").map((e) => (e.payload as { path: string }).path)).toEqual([aPath]);

    // B reads its own.
    expect(await readFsFor(store, B, "qs_cuj2", "m_b", "/members/me/notes.md")).toMatchObject({ ok: true, value: { content: "b's notes" } });
    // Nobody but A's seats writes under A's id.
    expect(await writeFs(store, C, "qs_cuj2", "m_c", { path: aPath, write: { op: "write", content: "x", baseRev: 1 } })).toMatchObject({ ok: false, code: "forbidden" });

    // No user id in a path, a listing or a read. (Store events carry fromUserId; the wire projection drops it.)
    expect(JSON.stringify([list, found, events.map((e) => e.payload), await readFsFor(store, C, "qs_cuj2", "m_c", aPath)])).not.toMatch(/u_a|u_b|u_c/);
  });

  it("finds the same notes at the same memory id after A leaves and rejoins with a new seat", async () => {
    const store = await roomWith("qs_cuj2_rejoin", seats);
    const a = await writeFs(store, A, "qs_cuj2_rejoin", "m_a", { path: "/members/me/notes.md", write: { op: "write", content: "kept" } });
    expect((await leaveRoom(store, A, "qs_cuj2_rejoin", "m_a")).ok).toBe(true);
    // A departed seat may not write.
    expect(await writeFs(store, A, "qs_cuj2_rejoin", "m_a", { path: "/members/me/x.md", write: { op: "write", content: "x" } })).toMatchObject({ ok: false, code: "forbidden" });
    // While A holds no seat, its departed seat granted, so C still reads.
    expect(await readFsFor(store, C, "qs_cuj2_rejoin", "m_c", a.ok ? a.value.path : "")).toMatchObject({ ok: true });
    await store.addMember("qs_cuj2_rejoin", member(seat("m_a2", "u_a")));
    const again = await readFsFor(store, A, "qs_cuj2_rejoin", "m_a2", "/members/me/notes.md");
    expect(again).toMatchObject({ ok: true, value: { content: "kept", path: a.ok ? a.value.path : "" } });
  });

  it("withholds from peers the memory of an account with one granting and one withholding seat", async () => {
    const store = await roomWith("qs_mixed", [seat("m_a", "u_a"), seat("m_a2", "u_a", KEEP), seat("m_c", "u_c")]);
    const a = await writeFs(store, A, "qs_mixed", "m_a", { path: "/members/me/n.md", write: { op: "write", content: "x" } });
    const path = a.ok ? a.value.path : "";
    expect(await readFsFor(store, C, "qs_mixed", "m_c", path)).toMatchObject({ ok: false, code: "not_found" });
    const list = await listFsFor(store, C, "qs_mixed", "m_c", "/");
    expect(list.ok && list.value.entries).toEqual([]);
    const found = await findFsFor(store, C, "qs_mixed", "m_c", "n.md");
    expect(found.ok && found.value.entries).toEqual([]);
    expect(await readFsFor(store, A, "qs_mixed", "m_a2", path), "its own withholding seat reads it").toMatchObject({ ok: true });
  });
});

describe("namespaces and gates", () => {
  it("refuses writes to /.bellman/ with the dash, renders it from governed config, and refuses /apps/", async () => {
    const store = await roomWith("qs_gov", [seat("m_creator", "u_jesse")]);
    await store.writeConfig("qs_gov", {
      name: "room_instructions", body: { markdown: "Be terse." }, sha256: "h", bytes: 24, baseRev: 0, narrowing: false,
      governance: { approvedBy: "u_jesse", approverMemberId: "m_creator", approverLabel: "jesse", via: "dash_session", at: "2026-11-01T00:00:00.000Z" },
    }, []);
    const refused = await writeFs(store, JESSE, "qs_gov", "m_creator", { path: "/.bellman/room.md", write: { op: "write", content: "x" } });
    expect(refused).toMatchObject({ ok: false, code: "forbidden" });
    expect(refused.ok === false && refused.reason).toContain("dash");
    expect(await readFsFor(store, JESSE, "qs_gov", "m_creator", "/.bellman/room.md")).toMatchObject({ ok: true, value: { content: "Be terse.", rev: 1 } });
    const listed = await listFsFor(store, JESSE, "qs_gov", "m_creator", "/.bellman");
    expect(listed.ok && listed.value.entries.map((r) => r.path)).toEqual(["/.bellman/room.md"]);
    const apps = await writeFs(store, JESSE, "qs_gov", "m_creator", { path: "/apps/t/a.ts", write: { op: "write", content: "x" } });
    expect(apps).toMatchObject({ ok: false, code: "forbidden" });
    expect(apps.ok === false && apps.reason).toContain("apps_not_enabled");
  });

  it("needs write_surface for room files but not for the seat's own memory, and refuses a bad path", async () => {
    const store = await roomWith("qs_verbs", [seat("m_creator", "u_jesse"), seat("m_b", "u_b", GRANT, "peer_b")]);
    expect(await writeFs(store, B, "qs_verbs", "m_b", { path: "/a.md", write: { op: "write", content: "x" } })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await writeFs(store, B, "qs_verbs", "m_b", { path: "/members/me/a.md", write: { op: "write", content: "x" } })).toMatchObject({ ok: true });
    expect(await writeFs(store, JESSE, "qs_verbs", "m_creator", { path: "/a/../b", write: { op: "write", content: "x" } })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("needs send to write memory, so a role that sends nothing stays read-only", async () => {
    const store = await roomWith("qs_obs", [seat("m_creator", "u_jesse"), seat("m_obs", "u_obs", GRANT, "watcher")]);
    const s = (await store.getSession("qs_obs"))!;
    await store.createSession({ ...session({ id: "qs_obs2", members: [member(seat("m_creator", "u_jesse")), member(seat("m_obs", "u_obs", GRANT, "watcher"))] }),
      manifest: { ...s.manifest, roles: { ...s.manifest.roles, watcher: { ...s.manifest.roles.peer_b, can: [] } } } });
    const r = await writeFs(store, who("u_obs"), "qs_obs2", "m_obs", { path: "/members/me/a.md", write: { op: "write", content: "x" } });
    expect(r).toMatchObject({ ok: false, code: "forbidden" });
  });

  it("refuses a frozen room and an evicted seat", async () => {
    const store = await roomWith("qs_gates", [seat("m_creator", "u_jesse"), seat("m_b", "u_b")]);
    expect((await evictMember(store, JESSE, "qs_gates", "m_b")).ok).toBe(true);
    expect(await writeFs(store, B, "qs_gates", "m_b", { path: "/a.md", write: { op: "write", content: "x" } })).toMatchObject({ ok: false, code: "forbidden" });
    await store.freezeSession("qs_gates", Date.now());
    expect(await writeFs(store, JESSE, "qs_gates", "m_creator", { path: "/a.md", write: { op: "write", content: "x" } })).toMatchObject({ ok: false, code: "frozen" });
  });

  it("counts every write against the seat's send limit", async () => {
    const store = await roomWith("qs_rate", [seat("m_creator", "u_jesse")]);
    for (let i = 0; i < SEND_LIMIT; i++) {
      expect((await writeFs(store, JESSE, "qs_rate", "m_creator", { path: `/f${i}.md`, write: { op: "write", content: "x" } })).ok).toBe(true);
    }
    expect(await writeFs(store, JESSE, "qs_rate", "m_creator", { path: "/over.md", write: { op: "write", content: "x" } })).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("refuses over the quota with what is used and the ceiling", async () => {
    const store = new MemoryStore();
    await store.createSession(session({ id: "qs_quota", fsBytesCeiling: 4, members: [member(seat("m_creator", "u_jesse"))] }));
    expect(await writeFs(store, JESSE, "qs_quota", "m_creator", { path: "/a.md", write: { op: "write", content: "12345" } }))
      .toMatchObject({ ok: false, code: "over_quota", state: { used: 0, ceiling: 4 } });
  });
});
