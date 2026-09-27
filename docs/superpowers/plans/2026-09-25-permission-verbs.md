# Server-Enforced Permission Verbs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a room's declared permission verbs enforced by the server, so the verbs `bellman_connect` shows a joiner are a fact rather than stated intent.

**Architecture:** One new module, `src/roles.ts`, holds the only code that indexes `manifest.roles`. Each gated tool handler calls `denyVerb()` once, at the top of its branch, before touching the payload or the room's occupants. `roomPreview` reads verbs through the same accessor, so what a joiner is shown and what is enforced cannot drift apart.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), Zod 4, `@modelcontextprotocol/sdk`, Vitest. Two build programs — Node (`tsconfig.json`) and Workers (`tsconfig.worker.json`).

**Spec:** [`docs/superpowers/specs/2026-09-25-permission-verbs-design.md`](../specs/2026-09-25-permission-verbs-design.md)

## Global Constraints

- **`npm run verify` passes before every commit.** It runs `typecheck:worker`, `build`, then `test`. Baseline before this plan starts: **25 files, 517 tests, all passing.**
- **`Member.capabilities` and everything around it is untouched** — the `Capability` type, `CapabilitiesShape`, `MemberPatch.capabilities`, `src/store.ts:221`, `src/store-do.ts:138`, and both recipient-side filters in `bellman_send`. Verbs are a new check site, not a replacement (spec D1).
- **`src/types.ts`, `src/store.ts`, `src/store-do.ts` are not modified by any task in this plan.** No new state, no new store method.
- **`denyVerb` must never take an `Identity` parameter.** That signature is what makes spec D2 structural. After Task 4, `grep -n 'identity\.role' src/server.ts` must return exactly one line, inside `bellman_audit`.
- **`VERBS` stays at five.** `summarize` belongs to the room-scribe PR, per #1's rule that a verb enters the enum in the PR that adds its operation.
- **`MAX_PAYLOAD_CHARS` is 20_000** (`src/server.ts:17`).
- Commits are signed through 1Password's SSH agent. If a commit dies with `error: 1Password: failed to fill whole buffer`, the agent is locked — ask the human to unlock it and retry the same commit. **Never pass `--no-gpg-sign`.**
- This is a git worktree, not the jj checkout: use ordinary `git` here, and `.git` is a file, so `.git/COMMIT_EDITMSG` does not resolve.

## Review Focus

Five behaviors the spec implies that the tasks would not otherwise exercise. Each line's test is written into the task that owns the code — all five land in Task 2, which owns the ordering.

1. **A sender who lacks `send` in a room where nobody granted `receive_messages`** must hear about their own role, not about the recipients. The verb layer is sender-side and runs first (spec D1, "Precedence"); the capability filter's message would send them chasing someone else's setting.
2. **A sender who lacks `respond_actions` and passes a `ref_id` that is not an `action_request`** must hear the verb denial, not "no action_request with cursor id N". The second message tells a member with no authority whether a given cursor is an action request.
3. **A sender who lacks `send` and posts a payload over 20_000 chars** must hear the verb denial, not "payload too large" — which would send them off to shorten a message they were never allowed to send.
4. **A sender who lacks `send` and is alone in the room** must hear the verb denial, not "no other active members yet". The occupancy message lets a member with no authority probe who is present.
5. **A role holding `request_actions` but not `send`** may send an `action_request` and may not send a `message`. Verbs do not compose — spec D3 maps one verb per operation, and a hand-authored manifest can hold this combination even though no preset produces it.

---

### Task 1: `src/roles.ts` — the accessor and the denial message

**Files:**
- Create: `src/roles.ts`
- Create: `tests/roles.test.ts`

**Interfaces:**
- Consumes: `RoomManifest`, `Session`, `Member`, `Verb` from `src/types.js`; `resolveManifest` from `src/manifest.js` (tests only).
- Produces: `verbsOfRole(manifest: RoomManifest, role: string): readonly Verb[]` and `denyVerb(session: Session, me: Member, verb: Verb): string | null`. Tasks 2, 3 and 5 import both from `./roles.js`.

- [ ] **Step 1: Write the failing test**

Create `tests/roles.test.ts`:

```ts
/**
 * verbsOfRole and denyVerb are pure — no store, no identity, no clock. The tool
 * tests drive them through real handlers; this file pins the accessor itself,
 * including the unknown-role case that no tool path can produce (design D5).
 */
import { describe, it, expect } from "vitest";
import { denyVerb, verbsOfRole } from "../src/roles.js";
import { resolveManifest } from "../src/manifest.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";

const swarm = resolveManifest({ room: "r", preset: "swarm" });

describe("verbsOfRole", () => {
  it("returns the verbs a defined role holds", () => {
    expect(verbsOfRole(swarm, "lead")).toEqual([
      "send", "invite", "revoke", "request_actions", "respond_actions",
    ]);
  });

  it("returns an empty list for a role defined with no verbs", () => {
    expect(verbsOfRole(swarm, "observer")).toEqual([]);
  });

  // THE load-bearing assertion in this describe: an unguarded
  // `manifest.roles[role].can` throws a TypeError here.
  it("fails closed for a role the manifest does not define", () => {
    expect(verbsOfRole(swarm, "ghost")).toEqual([]);
  });

  // A regression guard, NOT proof that Object.hasOwn is load-bearing: for every
  // name reachable on Object.prototype the value has no `can`, so `?.can ?? []`
  // would return [] too. It is here so that a future rewrite reaching for a bare
  // lookup still returns a list rather than an inherited function.
  it.each(["constructor", "prototype", "toString", "__proto__", "valueOf"])(
    "fails closed for %s rather than reaching an inherited property",
    (name) => {
      expect(verbsOfRole(swarm, name)).toEqual([]);
    },
  );
});

describe("denyVerb", () => {
  const swarmSession = session({ manifest: swarm });

  it("returns null when the seat holds the verb", () => {
    const lead = member({ roomRole: "lead" });
    expect(denyVerb(swarmSession, lead, "invite")).toBeNull();
  });

  it("names the seat, the verb, and what the seat does hold", () => {
    const reviewSession = session({ manifest: resolveManifest({ room: "r", preset: "review" }) });
    const reviewer = member({ roomRole: "reviewer" });
    expect(denyVerb(reviewSession, reviewer, "request_actions")).toBe(
      'your role "reviewer" does not hold the verb "request_actions" '
      + "(it holds: send, respond_actions).",
    );
  });

  it('says "none" rather than an empty list for a verbless seat', () => {
    const observer = member({ roomRole: "observer" });
    expect(denyVerb(swarmSession, observer, "send")).toBe(
      'your role "observer" does not hold the verb "send" (it holds: none).',
    );
  });

  it("refuses every verb to a seat whose role the manifest does not define", () => {
    const ghost = member({ roomRole: "ghost" });
    for (const verb of ["send", "invite", "revoke", "request_actions", "respond_actions"] as const) {
      expect(denyVerb(swarmSession, ghost, verb), verb).toBe(
        `your role "ghost" does not hold the verb "${verb}" (it holds: none).`,
      );
    }
  });

  // D2, as a type-level fact rather than a runtime one: the signature takes a
  // Session and a Member. If someone adds an Identity parameter this stops
  // compiling, and `npm run verify` typechecks before it tests.
  it("is callable with only a session and a member", () => {
    const fn: (s: ReturnType<typeof session>, m: ReturnType<typeof member>, v: "send") => string | null = denyVerb;
    expect(fn(session({ manifest: roomManifest() }), member(), "send")).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/roles.test.ts`
Expected: FAIL — `Failed to resolve import "../src/roles.js"`.

- [ ] **Step 3: Write the implementation**

Create `src/roles.ts`:

```ts
import type { Member, RoomManifest, Session, Verb } from "./types.js";

/**
 * The verbs a role holds — the only place `manifest.roles` is indexed.
 *
 * Fails closed: a role the manifest does not define holds nothing. No tool path
 * produces that today, because both seats are assigned from `creatorRole` and
 * `defaultRole`, which resolveManifest checked against `roles`. But sessions
 * round-trip through JSON in Durable Objects and #3 is about to make join codes
 * carry a role, so an unrecognised seat holds no authority rather than throwing.
 *
 * `Object.hasOwn` rather than a bare lookup. Every name reachable on
 * Object.prototype happens to have no `can`, so this is not what stops
 * `roles["constructor"]` today — RoleKeyShape's ban is. It is here so the
 * accessor stays total under a rewrite.
 */
export function verbsOfRole(manifest: RoomManifest, role: string): readonly Verb[] {
  return Object.hasOwn(manifest.roles, role) ? manifest.roles[role].can : [];
}

/**
 * Whether this member's seat may perform `verb`: null when it may, otherwise the
 * sentence the tool hands back.
 *
 * Takes a Session and a Member and NOT an Identity, deliberately. `Identity.role`
 * ("member" | "admin") is platform authority over an org and buys nothing inside
 * a room; an org admin is not automatically anything in a room, and a room's
 * creator need not be an org admin. Keeping Identity out of this signature is
 * what makes that structural rather than a convention.
 *
 * DO NOT add an Identity parameter. See the design's D2, and the grep invariant
 * in tests/tools/verbs.test.ts.
 *
 * Everything interpolated is server-controlled: `roomRole` is assigned from a
 * manifest role name (RoleKeyShape: `[a-z][a-z0-9_]{0,30}`) and verbs come from
 * the closed enum, so nothing here needs bounding or escaping.
 */
export function denyVerb(session: Session, me: Member, verb: Verb): string | null {
  const held = verbsOfRole(session.manifest, me.roomRole);
  if (held.includes(verb)) return null;
  const holds = held.length > 0 ? held.join(", ") : "none";
  return `your role "${me.roomRole}" does not hold the verb "${verb}" (it holds: ${holds}).`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/roles.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the fail-closed test is not a false green**

Temporarily change `verbsOfRole`'s body to `return manifest.roles[role].can;` and run `npx vitest run tests/roles.test.ts` again.

Expected: **7 failures.** Both unknown-role cases fail, and so do all five prototype-name cases — `roles["constructor"]` finds the inherited `Object` function, whose `.can` is `undefined`, so the assertion fails on `expected undefined to deeply equal []`; `roles["prototype"]` is `undefined` on a plain object, so that one throws a TypeError.

So the prototype cases **do** discriminate against this mutation. What they cannot distinguish is a `?.can ?? []` variant, which returns `[]` for every name on `Object.prototype` — none of which has a `can`. That narrower claim is what the test file's comment makes, and it is the accurate one.

Restore the real body and confirm the file is green before continuing.

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run verify
git add src/roles.ts tests/roles.test.ts
git commit -m "feat: add the room-role verb accessor

verbsOfRole is the only place manifest.roles is indexed, and it fails
closed: a seat naming a role the manifest does not define holds nothing.

denyVerb takes a Session and a Member and no Identity, on purpose. An org
admin holds nothing in a room, and keeping Identity out of the signature
is what makes that structural instead of a convention."
```

Expected: 26 files, ~530 tests, all passing. Nothing enforces a verb yet.

---

### Task 2: Enforce verbs in `bellman_send`

**Files:**
- Modify: `src/server.ts` — the `bellman_send` handler, immediately after the `findMember` guard (currently around `src/server.ts:614`)
- Create: `tests/tools/verbs.test.ts`
- Modify: `tests/tools/exchange.test.ts:443-491` — delete the trip-wire `describe`

**Interfaces:**
- Consumes: `denyVerb` from `./roles.js` (Task 1).
- Produces: the `needed` verb mapping, which Task 3 mirrors for `bellman_invite`. No new exports.

- [ ] **Step 1: Write the failing test**

Create `tests/tools/verbs.test.ts`:

```ts
/**
 * The verb guards. #1 declared a room's verbs and enforced none of them; this is
 * the file that turns bellman_connect's preview from stated intent into a fact.
 *
 * Every denial asserts two things: the caller is told which verb their seat
 * lacks, and the room did not move. An error that still appended an event would
 * be worse than no guard at all.
 *
 * Seats are authored rather than taken from a preset because a joiner always gets
 * `default_role` until #3, so a verbless or oddly-shaped joiner seat has to be
 * declared as the default.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Harness, DEV_KEY } from "../helpers/harness.js";
import { pairUp } from "../helpers/flows.js";
import { brief } from "../helpers/fixtures.js";

let h: Harness;

beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const ALL_VERBS = ["send", "invite", "revoke", "request_actions", "respond_actions"];

/** A pair manifest whose joiner seat holds exactly `can`. */
function seat(can: string[], room = "verb-guards") {
  return {
    room,
    mode: "pair",
    roles: { lead: { can: ALL_VERBS }, guest: { can } },
    default_role: "guest",
    creator_role: "lead",
  };
}

async function eventCount(sessionId: string): Promise<number> {
  return (await h.store.getSession(sessionId))!.events.length;
}

// ---------------------------------------------------------------------------
describe("bellman_send — a seat that holds the verb", () => {
  it.each([
    ["message", "send", { text: "hello" }],
    ["artifact", "send", { name: "patch.diff", content: "--- a\n+++ b\n" }],
    ["action_request", "request_actions", { action: "run the test suite" }],
  ] as const)("allows %s to a seat holding %s", async (type, verb, payload) => {
    const p = await pairUp(h, { manifest: seat([verb]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type, payload,
    });
    expect(res.isError, res.text).toBe(false);
  });

  it("allows brief_update to a seat holding send", async () => {
    const p = await pairUp(h, { manifest: seat(["send"]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: brief({ goal: "Now porting the webhook" }),
    });
    expect(res.isError, res.text).toBe(false);

    const stored = (await h.store.getSession(p.sessionId))!
      .members.find((m) => m.memberId === p.joinerMemberId)!;
    expect(stored.brief.goal).toBe("Now porting the webhook");
  });

  it("allows action_response to a seat holding respond_actions", async () => {
    const p = await pairUp(h, { manifest: seat(["respond_actions"]) });
    // The creator holds every verb, so the request it answers is real.
    const asked = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { action: "rerun CI" },
    });
    expect(asked.isError, asked.text).toBe(false);

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: String(asked.data.cursor),
      payload: { approved: true, result: "green" },
    });
    expect(res.isError, res.text).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("bellman_send — a seat that lacks the verb", () => {
  it.each([
    ["message", "send", { text: "hello" }],
    ["artifact", "send", { name: "patch.diff", content: "x" }],
    ["brief_update", "send", { goal: "g", state: "s", constraints: [], open_questions: [], agent: { provider: "openai", model: "gpt-5", client: "chatgpt" } }],
    ["action_request", "request_actions", { action: "do a thing" }],
    ["action_response", "respond_actions", { approved: true }],
  ] as const)("refuses %s, naming the missing verb %s, and appends nothing", async (type, verb, payload) => {
    // The seat holds every verb EXCEPT the one under test, so nothing else can
    // be doing the refusing.
    const p = await pairUp(h, { manifest: seat(ALL_VERBS.filter((v) => v !== verb)) });
    const before = await eventCount(p.sessionId);

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type, payload, ...(type === "action_response" ? { ref_id: "1" } : {}),
    });

    expect(res.isError, res.text).toBe(true);
    expect(res.text).toContain(`does not hold the verb "${verb}"`);
    expect(res.text).toContain('your role "guest"');
    expect(await eventCount(p.sessionId), "a denial must not append an event").toBe(before);
  });

  it("leaves the stored brief untouched when brief_update is refused", async () => {
    const p = await pairUp(h, {
      manifest: seat([]),
      joinerBrief: brief({ goal: "The brief I joined with" }),
    });

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "brief_update", payload: brief({ goal: "Rewritten without authority" }),
    });
    expect(res.isError).toBe(true);

    const stored = (await h.store.getSession(p.sessionId))!
      .members.find((m) => m.memberId === p.joinerMemberId)!;
    expect(stored.brief.goal).toBe("The brief I joined with");
  });

  it("refuses every kind to a wholly verbless seat", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    const before = await eventCount(p.sessionId);
    for (const type of ["message", "artifact", "action_request", "action_response", "brief_update"]) {
      const res = await p.joiner.call("bellman_send", {
        session_id: p.sessionId, member_id: p.joinerMemberId,
        type, payload: { text: "x" }, ref_id: "1",
      });
      expect(res.isError, type).toBe(true);
      expect(res.text, type).toContain("(it holds: none)");
    }
    expect(await eventCount(p.sessionId)).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// A published preset, end to end. Every other test in this file authors its
// seats, which proves the guard reads a manifest but not that the presets a real
// caller cites mean anything. `review` exists to make the reviewer answer action
// requests without initiating them; this is the test that makes that true.
describe("the review preset's asymmetry is enforced", () => {
  it("lets the reviewer answer an action request but not start one", async () => {
    const p = await pairUp(h, { manifest: { room: "code-review", preset: "review" } });

    const started = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_request", payload: { action: "rebase onto main" },
    });
    expect(started.isError).toBe(true);
    expect(started.text).toContain('your role "reviewer" does not hold the verb "request_actions"');
    expect(started.text).toContain("(it holds: send, respond_actions)");

    // The author may ask, and the reviewer may answer.
    const asked = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId,
      type: "action_request", payload: { action: "rerun the failing spec" },
    });
    expect(asked.isError, asked.text).toBe(false);

    const answered = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: String(asked.data.cursor),
      payload: { approved: true, result: "passes locally" },
    });
    expect(answered.isError, answered.text).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Review Focus. The verb guard sits ahead of every other check in the handler,
// so a seat with no authority always hears about its own role. Each of these
// passes for the wrong reason if the guard is moved further down: the OTHER
// error appears instead, and the assertions here name it.
describe("bellman_send — the verb guard comes first", () => {
  it("prefers the sender's missing verb over the recipients' capabilities", async () => {
    const p = await pairUp(h, {
      manifest: seat([]),
      creatorCapabilities: ["read_context"], // nobody will accept a message
    });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "send"');
    expect(res.text).not.toContain("receive_messages");
  });

  it("prefers the missing verb over validating ref_id", async () => {
    const p = await pairUp(h, { manifest: seat(["send"]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_response", ref_id: "9999", payload: { approved: true },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "respond_actions"');
    // Whether cursor 9999 is an action_request is not this member's business.
    expect(res.text).not.toContain("9999");
  });

  it("prefers the missing verb over the payload size limit", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "x".repeat(25_000) }, // over MAX_PAYLOAD_CHARS
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "send"');
    expect(res.text).not.toContain("payload too large");
  });

  it("prefers the missing verb over reporting who is in the room", async () => {
    // A creator alone in a swarm room, seated in a role with no verbs.
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", {
      manifest: {
        room: "alone", mode: "swarm",
        roles: { watcher: { can: [] }, helper: { can: ["send"] } },
        default_role: "helper", creator_role: "watcher",
      },
      brief: brief(),
    });
    expect(started.isError, started.text).toBe(false);

    const res = await creator.call("bellman_send", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
      type: "message", payload: { text: "anyone there?" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "send"');
    expect(res.text).not.toContain("no other active members");
  });

  it("does not compose verbs: request_actions alone sends a request but not a message", async () => {
    const p = await pairUp(h, { manifest: seat(["request_actions"]) });

    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "action_request", payload: { action: "rerun CI" },
    });
    expect(asked.isError, asked.text).toBe(false);

    const said = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "and also, hello" },
    });
    expect(said.isError).toBe(true);
    expect(said.text).toContain('does not hold the verb "send"');
  });

  it("still reports a left member as left, not as unauthorized", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "x" },
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("has left the session");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/verbs.test.ts`
Expected: FAIL. Every case in the two "lacks the verb" describes and every case in "the verb guard comes first" fails, because nothing is enforced — the sends succeed. The "holds the verb" describe passes already, which is what makes the denials meaningful rather than incidental.

- [ ] **Step 3: Add the guard**

In `src/server.ts`, add the import:

```ts
import { denyVerb } from "./roles.js";
```

In the `bellman_send` handler, immediately after the existing member check and **before** `const serialized = JSON.stringify(payload);`:

```ts
      const me = findMember(session, member_id, identity);
      if (!me || me.leftAt !== null) return fail("member_id is not yours or has left the session.");

      // Authority first: before the payload, before who is listening. A seat that
      // may not act hears why, rather than being sent off to shorten a message it
      // was never allowed to send or learning who is present by probing.
      //
      // brief_update needs `send` because it appends an event that puts this
      // member's prose into every peer's context. A seat that may not speak may
      // not restate itself either — which is exactly what `observer` promises its
      // readers. Verbs do not compose: each kind maps to one verb and no other.
      const needed: Verb =
        type === "action_request" ? "request_actions" :
        type === "action_response" ? "respond_actions" :
        "send";
      const denial = denyVerb(session, me, needed);
      if (denial) return fail(denial);
```

`Verb` is already imported in `src/server.ts` (`roomPreview` uses it). If it is not, add it to the existing `import type { ... } from "./types.js"` line.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools/verbs.test.ts`
Expected: PASS.

- [ ] **Step 5: Prove the guard is what made them pass**

Temporarily change the guard to `const denial = null;` and run `npx vitest run tests/tools/verbs.test.ts`.

Must fail: every case in both "lacks the verb" describes, every case in "the verb guard comes first", and the reviewer half of "the review preset's asymmetry is enforced". The "holds the verb" describe must stay **green** — it passed before the guard existed and must keep passing after, or the guard is refusing calls it should allow.

Restore the real guard.

- [ ] **Step 6: Retire the trip-wire**

Run: `npx vitest run tests/tools/exchange.test.ts`
Expected: FAIL in `"a room's verbs are declared, not yet enforced"` — its first assertion is that a seat omitting `send` still sends. #1 wrote that test to fail on this exact day.

Delete the whole `describe` block at `tests/tools/exchange.test.ts:443-491`, including its `// TRIP-WIRE` comment. Its comment says "invert it … Do not just delete it" — the inversion is `tests/tools/verbs.test.ts`, which Step 1 created. Its second half (a role listing `invite` still cannot invite) becomes Task 3's business.

Replace the deleted block with a pointer, so the next reader knows where it went:

```ts
// The trip-wire that lived here — "a room's verbs are declared, not yet
// enforced" — fired as designed when #2 landed. Its replacement is
// tests/tools/verbs.test.ts, which asserts the guards rather than their absence.
```

- [ ] **Step 7: Run the full suite and commit**

```bash
npm run verify
```

Expected: **green.** 27 files, ~549 tests.

`tests/tools/surface.test.ts` does **not** fail, and it is worth knowing why, because the first draft of this plan said it would. Its pin is `expect(doc).toContain("not yet enforced at call time")` — an assertion that the string is *present*. This task does not touch the three descriptions, so the string is still there and the pin passes. The sentence is now **false but still present**, and `toContain` cannot tell the difference.

Nothing in the suite flags that staleness between here and Task 5. That is the real cost of splitting the work this way, and Task 5's Step 1 closes it by writing the inverted pin first and watching it fail.

```bash
git add src/server.ts tests/tools/verbs.test.ts tests/tools/exchange.test.ts
git commit -m "feat: enforce room verbs in bellman_send

message, artifact and brief_update need send; action_request needs
request_actions; action_response needs respond_actions. Each kind maps to
one verb and verbs do not compose.

The guard sits ahead of the payload-size check and the occupancy check, so
a seat with no authority hears about its own role instead of being sent to
shorten a message it could not send, or learning who is in the room by
probing. Every denial is asserted to append no event.

Retires #1's trip-wire, which existed to fail on this commit.

The three tool descriptions and the README still say verbs are not
enforced. That is now false, and nothing in the suite flags it - the pin
asserts the sentence is present, not that it is true. Task 5 rewrites
them and inverts the pin."
```

---

### Task 3: Enforce `invite` and `revoke` in `bellman_invite`

**Files:**
- Modify: `src/server.ts:533-537` — delete the creator-only check, add the guard
- Modify: `tests/tools/verbs.test.ts` — append the invite describe
- Modify: `tests/tools/invite.test.ts:98-107` — the creator-only test becomes role-based

**Interfaces:**
- Consumes: `denyVerb` from `./roles.js`, already imported by Task 2.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `tests/tools/verbs.test.ts`:

```ts
// ---------------------------------------------------------------------------
// bellman_invite gated on two separate verbs. #1's enum made `invite` and
// `revoke` distinct, so a seat may hold one without the other and the guard
// respects that rather than treating revoke as a weaker invite.
describe("bellman_invite — invite and revoke are separate verbs", () => {
  it("lets a joiner who holds invite reopen the room", async () => {
    // A swarm room, so there is capacity for a third member and the code is usable.
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", {
      manifest: {
        room: "guest-can-invite", mode: "swarm",
        roles: { lead: { can: ALL_VERBS }, guest: { can: ["send", "invite"] } },
        default_role: "guest", creator_role: "lead",
      },
      brief: brief(),
    });
    expect(started.isError, started.text).toBe(false);

    const joiner = await h.connect(DEV_KEY.peer);
    const preview = await joiner.call("bellman_connect", { join_code: started.data.join_code });
    const confirmed = await joiner.call("bellman_confirm", {
      connect_token: preview.data.connect_token, brief: brief(),
    });
    expect(confirmed.isError, confirmed.text).toBe(false);

    const reissued = await joiner.call("bellman_invite", {
      session_id: String(started.data.session_id),
      member_id: String(confirmed.data.member_id),
    });
    expect(reissued.isError, reissued.text).toBe(false);
    expect(String(reissued.data.join_code)).toMatch(/^BELL-/);
  });

  it("refuses invite to a seat that lacks it, naming the verb", async () => {
    const p = await pairUp(h, { manifest: seat(["send", "revoke"]) });
    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "invite"');
    expect(res.text).toContain("(it holds: send, revoke)");
  });

  it("refuses revoke to a seat that holds invite but not revoke", async () => {
    const p = await pairUp(h, { manifest: seat(["send", "invite"]) });
    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId, revoke: true,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "revoke"');
  });

  it("a denied invite neither mints a code nor appends an event", async () => {
    const p = await pairUp(h, { manifest: seat([]) });
    const before = (await h.store.getSession(p.sessionId))!;

    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(res.isError).toBe(true);

    const after = (await h.store.getSession(p.sessionId))!;
    expect(after.joinCode).toBe(before.joinCode);
    expect(after.events.length).toBe(before.events.length);
  });

  it("refuses a creator whose own role holds neither verb — a sealed room stays sealed", async () => {
    // tests/manifest.test.ts already declares this manifest legal. It means the
    // room cannot be reopened by anyone, creator included. That is the declared
    // behaviour arriving, not a regression.
    const creator = await h.connect(DEV_KEY.jesse);
    const started = await creator.call("bellman_start", {
      manifest: {
        room: "sealed", mode: "pair",
        roles: { lead: { can: ["send"] }, guest: { can: ["send"] } },
        default_role: "guest", creator_role: "lead",
      },
      brief: brief(),
    });
    expect(started.isError, started.text).toBe(false);

    const res = await creator.call("bellman_invite", {
      session_id: String(started.data.session_id),
      member_id: String(started.data.member_id),
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "invite"');
    // And specifically NOT the old rule, which would have let the creator through.
    expect(res.text).not.toContain("only the session creator");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/verbs.test.ts -t "invite and revoke are separate verbs"`
Expected: FAIL. The two "refuses" cases and the sealed-room case fail with `"only the session creator can issue join codes."`, and the joiner-holds-invite case fails for the same reason.

- [ ] **Step 3: Replace the creator check with the guard**

In `src/server.ts`, delete these four lines from the `bellman_invite` handler:

```ts
      // Roles land in M0; until then the creator is the only one who can reopen the door.
      if (session.createdBy !== identity.userId) {
        return fail("only the session creator can issue join codes.");
      }
```

and put the guard in their place:

```ts
      // Roles landed. `invite` and `revoke` are separate verbs, so a seat may hold
      // one without the other. A room whose manifest gives nobody `invite` cannot
      // be reopened by anyone, its creator included — tests/manifest.test.ts calls
      // that a legal manifest, so it is the declared behaviour, not a hole.
      const denial = denyVerb(session, me, revoke ? "revoke" : "invite");
      if (denial) return fail(denial);
```

`Session.createdBy` stays on the type and keeps being set — it is provenance. After this edit nothing reads it to decide authority.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/tools/verbs.test.ts -t "invite and revoke are separate verbs"`
Expected: PASS.

- [ ] **Step 5: Update the test that asserted the old rule**

Run: `npx vitest run tests/tools/invite.test.ts`
Expected: FAIL in `"is the creator's to give — a joined member cannot reopen the room"` — the refusal still happens, but the message changed.

Replace that test (`tests/tools/invite.test.ts:98-107`) with:

```ts
  it("is the lead's to give — a joiner seated without `invite` cannot reopen the room", async () => {
    // The default `pair` preset seats the joiner as peer_b, which holds send,
    // request_actions and respond_actions — and neither invite nor revoke.
    const s = await pairUp(h);

    const attempt = await s.joiner.call("bellman_invite", {
      session_id: s.sessionId, member_id: s.joinerMemberId,
    });

    expect(attempt.isError).toBe(true);
    expect(attempt.text).toContain('your role "peer_b" does not hold the verb "invite"');
  });
```

- [ ] **Step 6: Run the full suite and commit**

```bash
npm run verify
```

Expected: **green.** `tests/tools/surface.test.ts` does not fail here either — its pin asserts the stale sentence is *present*, and this task does not touch the descriptions. See Task 2 Step 7.

```bash
git add src/server.ts tests/tools/verbs.test.ts tests/tools/invite.test.ts
git commit -m "feat: gate bellman_invite on the invite and revoke verbs

Deletes the createdBy placeholder the issue names. A manifest may now give
a joiner invite, and a sealed room - one where no role holds invite - can
be reopened by nobody, its creator included. manifest.test.ts already
declares that manifest legal, so this is the declared behaviour arriving.

createdBy stays as provenance; nothing reads it for authority now."
```

---

### Task 4: The collision, fail-closed at the tool layer, and what stays ungated

**Files:**
- Modify: `tests/tools/verbs.test.ts` — append three describes

**Interfaces:**
- Consumes: `h.store.createSession` (from `BellmanStore`); `member`, `roomManifest`, `session` from `../helpers/fixtures.js`.
- Produces: nothing. This task adds only tests — it is the reviewer gate that asks whether platform authority leaks into rooms.

- [ ] **Step 1: Write the test**

Widen the fixtures import at the top of `tests/tools/verbs.test.ts`:

```ts
import { brief, member, roomManifest, session } from "../helpers/fixtures.js";
```

Append:

```ts
// ---------------------------------------------------------------------------
// D2. There are two things called "role" and they are not the same thing.
// Identity.role ("member" | "admin") is platform authority over an org. A room
// role says what you may do inside one session. An org admin is not
// automatically anything in a room.
describe("platform role and room role are different things", () => {
  it("refuses an org admin seated in a verbless role", async () => {
    // DEV_KEY.jesse is a team-plan ADMIN in org_codenerd. DEV_KEY.peer is a
    // free-plan member, and free plans allow only `pair`, so peer creates.
    const p = await pairUp(h, {
      creatorKey: DEV_KEY.peer,
      joinerKey: DEV_KEY.jesse,
      manifest: seat([], "admin-holds-nothing"),
    });
    expect(p.joiner.identity.role).toBe("admin");

    const res = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
      type: "message", payload: { text: "I administer this org" },
    });

    expect(res.isError).toBe(true);
    expect(res.text).toContain('your role "guest" does not hold the verb "send"');
  });

  it("refuses an org admin's invite in a room whose seat lacks it", async () => {
    const p = await pairUp(h, {
      creatorKey: DEV_KEY.peer,
      joinerKey: DEV_KEY.jesse,
      manifest: seat(["send"], "admin-cannot-invite"),
    });
    const res = await p.joiner.call("bellman_invite", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('does not hold the verb "invite"');
  });

  // The invariant behind both: no room guard consults identity.role. This is a
  // grep, because that is the property — not any one call's outcome.
  it("leaves identity.role used only by bellman_audit", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/server.ts", import.meta.url), "utf8");
    const hits = src.split("\n")
      .map((line, i) => [i + 1, line] as const)
      .filter(([, line]) => line.includes("identity.role"));
    expect(hits.length, `identity.role at lines ${hits.map(([n]) => n).join(", ")}`).toBe(1);
    expect(hits[0][1]).toContain("the audit log requires the admin role");
  });

  it("never names Identity in src/roles.ts's code", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/roles.ts", import.meta.url), "utf8");
    // Comments are stripped first, and must be: the docblock deliberately says
    // "takes a Session and a Member and NOT an Identity" and "DO NOT add an
    // Identity parameter". That warning belongs where an editor sees it, so the
    // assertion is about the code — no import of Identity, no annotation using
    // it — not about the prose explaining why.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(code).not.toContain("Identity");
    // A positive control: stripping must not have eaten the whole file, or this
    // assertion would pass against an empty string.
    expect(code).toContain("export function denyVerb");
  });
});

// ---------------------------------------------------------------------------
// D5 at the tool layer. No tool path produces a seat whose roomRole names no
// role, so this session is written straight into the store.
describe("a seat naming no role holds nothing", () => {
  it("refuses every gated operation", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    await h.store.createSession(session({
      id: "qs_ghost_seat",
      createdBy: jesse.identity.userId,
      orgId: jesse.identity.orgId,
      manifest: roomManifest(),
      members: [
        member({
          memberId: "m_ghost",
          userId: jesse.identity.userId,
          label: jesse.identity.label,
          orgId: jesse.identity.orgId,
          roomRole: "no_such_role",
        }),
      ],
    }));

    for (const [tool, args] of [
      ["bellman_send", { type: "message", payload: { text: "x" } }],
      ["bellman_invite", {}],
      ["bellman_invite", { revoke: true }],
    ] as const) {
      const res = await jesse.call(tool, {
        session_id: "qs_ghost_seat", member_id: "m_ghost", ...args,
      });
      expect(res.isError, tool).toBe(true);
      expect(res.text, tool).toContain('your role "no_such_role" does not hold the verb');
      expect(res.text, tool).toContain("(it holds: none)");
    }
  });
});

// ---------------------------------------------------------------------------
// Reading is implied by membership and a member must always be able to leave, so
// no verb gates either. A verbless seat is the case that proves it.
describe("sync and leave are never gated", () => {
  it("lets a wholly verbless seat read the room and leave it", async () => {
    const p = await pairUp(h, { manifest: seat([]) });

    const synced = await p.joiner.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.joinerMemberId, since_cursor: 0,
    });
    expect(synced.isError, synced.text).toBe(false);

    const left = await p.joiner.call("bellman_leave", {
      session_id: p.sessionId, member_id: p.joinerMemberId,
    });
    expect(left.isError, left.text).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run tests/tools/verbs.test.ts`
Expected: PASS. These document decisions Tasks 2 and 3 already implemented rather than driving new code — which is why there is no red step here, and why Step 3 exists instead.

- [ ] **Step 3: Prove each new assertion can fail**

Three deliberate breakages, one at a time, each reverted before the next.

Each expectation below names the test that **must** fail — the one that proves the assertion discriminates. Expect collateral failures too: these mutations are coarse, and other tests in this file legitimately depend on the same behavior. Collateral red is fine; the named test staying **green** is the failure signal, because it would mean that assertion proves nothing.

1. In `src/roles.ts`, make `denyVerb` allow an unknown seat: insert `if (held.length === 0) return null;` before the `holds` line. Must fail: `"a seat naming no role holds nothing"`. Also expect every `seat([])` case in this file to fail, since a verbless seat now passes the guard.
2. In `src/server.ts`'s `bellman_send` guard, change the last line to `if (denial && identity.role !== "admin") return fail(denial);`. Must fail: `"refuses an org admin seated in a verbless role"` **and** `"leaves identity.role used only by bellman_audit"` (the grep now finds two occurrences).
3. In `src/server.ts`'s `bellman_sync` handler, add a `denyVerb(session, me, "send")` guard after its member check. Must fail: `"sync and leave are never gated"`. Also expect wide collateral breakage across other test files, since most of them sync from a seat that was never given `send`.

Revert all three. Confirm `npx vitest run tests/tools/verbs.test.ts` is back to green.

- [ ] **Step 4: Run the full suite and commit**

```bash
npm run verify
git add tests/tools/verbs.test.ts
git commit -m "test: pin that platform authority buys nothing in a room

An org admin seated in a verbless role is refused, and no room guard reads
identity.role - asserted as a grep over src/server.ts, because the single
remaining call site is not the property; the absence everywhere else is.

Also pins the fail-closed path (a seat naming no role holds nothing, built
by writing the session straight into the store) and that sync and leave
stay ungated for a seat with no verbs at all."
```

---

### Task 5: Make the words true

**Files:**
- Modify: `src/server.ts:253` (`bellman_start`), `:364` (`bellman_connect`), `:428` (`bellman_confirm`) — the three descriptions
- Modify: `src/server.ts:100-133` — the `roomPreview` docblock
- Modify: `src/server.ts:139-141` — `your_verbs` reads through `verbsOfRole`
- Modify: `src/server.ts:599` — `bellman_send`'s `Errors:` line
- Modify: `src/server.ts:518` — `bellman_invite`'s `Errors:` line
- Modify: `src/server.ts:510` — `bellman_invite`'s **opening sentence**, which still says the code is for "a session you created"
- Modify: `tests/tools/surface.test.ts:112-127` — invert the pin
- Modify: `README.md:21`, `:26` ("Creator only."), `:31`, `:183-185`

**The full set of statements this PR makes false.** Tasks 2 and 3 each found one the earlier drafts had missed, so this list is the authority — do not trust a grep alone to find them:

| Location | Stale claim |
|---|---|
| `src/server.ts:253` | `bellman_start`: "not yet enforced at call time" |
| `src/server.ts:364` | `bellman_connect`: "declared rules … stated intent" |
| `src/server.ts:428` | `bellman_confirm`: "declared rules, not yet enforced" |
| `src/server.ts:510` | `bellman_invite`: "a session you created" — now any seat holding `invite` |
| `src/server.ts:518` | `bellman_invite` `Errors:`: "only the creator can issue" |
| `src/server.ts:599` | `bellman_send` `Errors:`: capability errors only, no mention of verbs |
| `src/server.ts:131-134` | `roomPreview` docblock: "Nothing enforces them at call time until #2" |
| `tests/tools/surface.test.ts:112-115` | comment cites "the trip-wire in exchange.test.ts", deleted in Task 2 |
| `README.md:21` | "verbs are declared, not yet enforced" |
| `README.md:26` | "Creator only." on `bellman_invite` |
| `README.md:31` | "verbs are declared, not yet enforced" |
| `README.md:183-185` | "the server records them and shows them as the creator's stated intent" |

Nothing in the suite pins `server.ts:510` or `README.md:26`, so only this table catches them.

**Interfaces:**
- Consumes: `verbsOfRole` from `./roles.js` (Task 1).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Replace `tests/tools/surface.test.ts:112-127` — the comment and the `it` — with:

```ts
  // A joiner's human decides on the verbs a room declares, and since #2 the
  // server enforces them. Each tool that returns the room block says so. The
  // guards are in src/roles.ts; the denial paths are tests/tools/verbs.test.ts.
  it("says on every tool that shows a room's verbs that the server enforces them", async () => {
    const { tools } = await jesse.listTools();
    const showsVerbs = ["bellman_confirm", "bellman_connect", "bellman_start"];
    for (const name of showsVerbs) {
      const doc = tools.find((t) => t.name === name)!.description!.replace(/\s+/g, " ");
      expect(doc, name).toContain("enforced by the server");
      // The old sentence must be gone, not merely joined by a new one.
      expect(doc, name).not.toContain("not yet enforced");
      expect(doc, name).not.toContain("stated intent");
    }
    // No other tool mentions verbs, so none can be showing them unqualified.
    for (const t of tools.filter((t) => !showsVerbs.includes(t.name))) {
      expect(t.description, t.name).not.toMatch(/verbs/i);
    }
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/tools/surface.test.ts -t "enforces them"`
Expected: FAIL — the descriptions still say "not yet enforced at call time".

- [ ] **Step 3: Rewrite the three descriptions**

In `bellman_start`'s description (`src/server.ts:253`), replace:

```
    Verbs are declared, not yet enforced at call time: a role's list states your intent, not a guarantee.
```

with:

```
    Verbs are enforced by the server: a role's list is what each seat may actually do, and a call outside it is refused.
```

In `bellman_connect`'s (`src/server.ts:364`), replace:

```
The room's verbs are the creator's declared rules, not yet enforced at call time: read them as stated intent, not a guarantee.
```

with:

```
The room's verbs are enforced by the server, so your_verbs is what your seat would actually be able to do — not the creator's intent. A call outside it is refused with an error naming the verb you lack.
```

In `bellman_confirm`'s (`src/server.ts:428`), replace:

```
The room's verbs are declared rules, not yet enforced at call time: stated intent, not a guarantee.
```

with:

```
The room's verbs are enforced by the server: your_verbs is what this seat may do, and nothing else.
```

- [ ] **Step 4: Rewrite `bellman_invite`'s opening sentence and the two `Errors:` lines**

`src/server.ts:510` still opens with "Mint a fresh join code for a session you created". Creating the room is no longer what authorises this. Replace with:

```
Mint a fresh join code for a room whose seat gives you the `invite` verb — at any time, for as long as the session lives.
```

`src/server.ts:599`, `bellman_send`:

```
Errors: a verb your role does not hold is refused by name, and nothing is delivered. Capability errors name the member lacking the grant.
```

`src/server.ts:518`, `bellman_invite`:

```
Errors: issuing needs the `invite` verb and revoking needs `revoke`; a room whose manifest gives nobody `invite` cannot be reopened by anyone. A full session refuses (the code could not be used).
```

- [ ] **Step 5: Route `your_verbs` through the accessor and fix the docblock**

Add `verbsOfRole` to the existing `./roles.js` import in `src/server.ts`. In `roomPreview`, replace:

```ts
    your_verbs: m.roles[viewerRole]?.can ?? [],
```

with:

```ts
    your_verbs: verbsOfRole(m, viewerRole),
```

In the `roomPreview` docblock, replace the final paragraph:

```
 * The verbs are declared rules. Nothing enforces them at call time until #2, and
 * bellman_start, bellman_connect and bellman_confirm say so in their descriptions
 * (tests/tools/surface.test.ts pins that). When #2 enforces them, those three
 * sentences and the README's go with it.
```

with:

```
 * `your_verbs` goes through verbsOfRole — the same accessor the guards in
 * bellman_send and bellman_invite call — so what a joiner is SHOWN and what is
 * ENFORCED are one computation and cannot drift apart. Do not inline the lookup
 * back into this function: a preview that over-promised by a single verb is the
 * failure this whole design exists to prevent.
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/tools/surface.test.ts`
Expected: PASS.

- [ ] **Step 7: Correct the README**

`README.md:21`, the `bellman_connect` table row — replace `verbs are declared, not yet enforced` with `verbs are enforced by the server`.

`README.md:26`, the `bellman_invite` table row — replace `Creator only.` with `Needs the `invite` verb (`revoke` to close the door).` The creator-only rule is gone; a manifest may seat a joiner with `invite`, and a room whose manifest gives nobody `invite` cannot be reopened by anyone.

`README.md:31`, the two-phase connect bullet — the same replacement as `:21`.

`README.md:183-185`, replace:

```
Verbs are declared, not yet enforced: the server records them and shows
them as the creator's stated intent, not a guarantee.
```

with:

```
Verbs are enforced by the server. A call a seat's role does not permit is
refused with an error naming the verb it lacks, and nothing is delivered or
recorded. The verbs shown in a connect preview and the verbs enforced come
from one accessor (`src/roles.ts`), so a preview cannot over-promise.

A room role is not `Identity.role`. The latter is `member` | `admin` over an
*org* and buys nothing inside a room: an org admin holds exactly what their
seat holds.
```

- [ ] **Step 8: Verify no stale promise survives**

```bash
grep -rn "not yet enforced\|stated intent\|declared rules\|until #2" src/ tests/ README.md
```

Expected: no output.

- [ ] **Step 9: Run the full suite and commit**

```bash
npm run verify
```

Expected: **green — 27 files, ~560 tests, zero failures.** Every commit in this plan is green; what changes here is that the words finally match the behavior.

```bash
git add src/server.ts tests/tools/surface.test.ts README.md
git commit -m "docs: say that verbs are enforced, because now they are

#1 wrote in six places that a room's verbs were declared and not enforced.
All six change here, and surface.test.ts flips from pinning the old
sentence to pinning the new one.

roomPreview's your_verbs now reads through verbsOfRole, the same accessor
the guards call, so the verbs a joiner is shown and the verbs enforced are
one computation. A preview that over-promised by one verb is the failure
this design exists to prevent.

The README also now states that a room role is not Identity.role."
```

---

## Done when

- `npm run verify` is green, with `tests/roles.test.ts` and `tests/tools/verbs.test.ts` added.
- `grep -rn "not yet enforced" src/ tests/ README.md` is empty.
- `grep -n 'identity\.role' src/server.ts` returns one line, in `bellman_audit`.
- `git diff main --stat` shows `src/types.ts`, `src/store.ts` and `src/store-do.ts` untouched.
- The PR body states that peer content's trust model is unchanged, and that a sealed room can no longer be reopened by its creator.

## Notes for the PR

Two things reviewers will look for, from the spec:

- **`capabilities` did not move.** Issue #2's opening proposes folding it into roles; spec D1 keeps both layers because they answer different questions, and the issue's own author approved that. Say so explicitly, or the PR reads as an incomplete implementation of its issue.
- **The room-scribe design overlaps.** Its D5 plans a `summarize` verb and justifies an interim ownership check by citing `bellman_invite`'s creator check — which this PR deletes. `summarize` stays out of `VERBS` here. If the scribe lands after this, its guard should be written as `denyVerb(session, me, "summarize")` directly and that sentence of its D5 is stale.
