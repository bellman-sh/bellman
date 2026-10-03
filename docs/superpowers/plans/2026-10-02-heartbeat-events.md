# Heartbeat Events Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The server appends a `heartbeat` event into a room on the room's declared cadence, carrying a snapshot of who has reported and who has gone silent; members answer with `progress` events that do not interrupt.

**Architecture:** A derived named alarm on `SessionDO` — the same mechanism as `ttl` — computes the next tick from `StoredSession.lastTickAt` and writes the event with `fromMemberId: "system"`, so no member can put a heartbeat in the room and there is no second write path. Delivery is the existing one: `#wake()` resolves held polls and sockets, the bridge pushes or queues. A new closed `ATTENTION` table, carried on the wire by `publicEvent`, makes the tick interrupt and a reply ambient.

**Tech Stack:** TypeScript, zod 4, Cloudflare Workers + Durable Objects, vitest (two programs: root, and `worker-tests/` under workerd), MCP SDK.

**Spec:** `docs/superpowers/specs/2026-10-02-heartbeat-events-design.md`

## Global Constraints

- **Every `BellmanStore` method is async**, including ones `MemoryStore` answers instantly (invariant 1).
- **`waitForEvents` must not `await` between reading events and registering a waiter** (invariant 2).
- **Peer content is untrusted everywhere** and stays wrapped to the model (invariant 3).
- **Push is never a dependency** — every surface must work by polling (invariant 6).
- **Presence is derived, never stored** — not in a field, and not in an event payload (invariant 7). Every field in a heartbeat payload is a claim about `at`, never about now. No `present`, `status`, `alive`, `healthy` or `state` key, anywhere.
- **Workers-only files are excluded from the Node build**: `src/worker.ts`, `src/store-do.ts`, `src/oauth/store.ts`. A vitest test in the root program cannot import them.
- **`src/heartbeat.ts` and `src/attention.ts` must import nothing from `cloudflare:workers`, directly or transitively**, because both test programs and `SessionDO` import them.
- **A room holds many members, not two.** In comments, docs and commit messages say *members*, *the room*, or *peers*. Never "two sessions" or "the other session".
- **Heartbeat cadence bounds: 30s minimum, 1h maximum.** `MIN_HEARTBEAT_MS = 30_000`, `MAX_HEARTBEAT_MS = 3_600_000`.
- **Thresholds:** due at `1 × heartbeatOnMs`, `silent: true` at `2 × heartbeatOnMs`.
- **No new tool ships**, so `extension/manifest.json` does not change. `tests/extension.test.ts` fails if it does.
- **Run `npm run verify` (typecheck + build + test) and `npm run typecheck:worker` before every commit.**
- **`main` moves only through merges.** Work stays on this branch.

## Review Focus

Five things the spec implies that no task's happy path exercises, most likely to bite first. Each has its test pinned to the task that owns the code.

1. **A tick written into a frozen room.** `#tickIfDue` follows `#expireIfDue`, which calls `#writeEvent` **directly and bypasses the frozen check in `appendEvent`**. A naive copy writes a tick into a frozen room and names members silent who cannot report out of it. → Task 5, Step 1.
2. **An alarm that spins.** A tick does not move `lastReportAt`, so a member-anchored due time stays in the past forever and `reArm()` re-fires immediately — the documented `due:outbox` hazard. The clock must anchor on `lastTickAt`. → Task 3, Step 1 and Task 5, Step 9.
3. **A member row with no `lastReportAt`.** Durable Object storage has no migration step. Reading `undefined` as "never reported" makes every pre-existing member instantly due and instantly silent. Must lift to `joinedAt`. → Task 3, Step 5.
4. **An ambient event dropped entirely in hook delivery.** Suppressing the channel push with an early `return` in `deliver()` also skips `enqueue()`, so hook-mode members would never see a `progress` event at all. → Task 6, Step 5.
5. **A malformed `heartbeat_on`.** `"5 minutes"`, `"0m"`, `"99h"`, `"-5m"`, `""`. The raw value is echoed into the error, which reaches tool errors and the audit log, so it must be length-bounded before it is interpolated. → Task 2, Step 5.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | `EventType` gains `heartbeat` and `progress`; `RoomManifest.heartbeatOnMs`; `RoleDef.reports`; `Member.lastReportAt?` |
| `src/attention.ts` | **new.** The closed `ATTENTION` table and `Attention` type. Nothing else. |
| `src/public-event.ts` | emits `ambient: true` for ambient types |
| `src/manifest.ts` | parses `heartbeat_on` to ms with bounds; `reports` on `RoleDefShape`; presets resolve null/false |
| `src/roles.ts` | `mustReport(manifest, role)`, fail-closed beside `verbsOfRole` |
| `src/heartbeat.ts` | **new.** Pure rules: `lastReport`, `nextTickAt`, `dueMembers`, `snapshotOf`. Runtime-free. |
| `src/stored-session.ts` | `StoredSession.lastTickAt?` |
| `src/store.ts` | `MemberPatch` gains `lastReportAt` |
| `src/store-do.ts` | `derivedDue` gains `heartbeat`; an `alarm()` branch; `#tickIfDue` |
| `src/server.ts` | `SEND_KINDS`, `SEND_VERB`, `ProgressShape`, the `progress` branch, `roomPreview` |
| `src/inbox.ts` | `PeerEvent.ambient`; `fromEnvelope` carries it |
| `src/bridge.ts` | `deliver()` suppresses the channel push for ambient events |
| `src/presence.ts` | comment correction (D13) |

---

### Task 1: The attention vocabulary

**Files:**
- Modify: `src/types.ts` (`EventType`)
- Modify: `src/presence.ts` (the "Not a heartbeat event" comment)
- Create: `src/attention.ts`
- Modify: `src/public-event.ts`
- Test: `tests/attention.test.ts`, `tests/public-event.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Attention = "interrupt" | "ambient"`; `attentionOf(type: EventType): Attention`; `isAmbient(type: EventType): boolean`. `publicEvent(e)` now returns an optional `ambient?: true`.

- [ ] **Step 1: Write the failing test**

Create `tests/attention.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ATTENTION, attentionOf, isAmbient } from "../src/attention.js";
import type { EventType } from "../src/types.js";

/**
 * The twelve types that existed before #111 all interrupt, which is what they
 * do today. This table introduces a classification, not a behaviour change.
 */
const PRE_EXISTING: EventType[] = [
  "member_joined", "member_left", "member_evicted", "member_timed_out",
  "message", "artifact", "action_request", "action_response", "brief_update",
  "invite_issued", "invite_revoked", "session_expired",
];

describe("attention", () => {
  it("leaves every pre-existing type interrupting", () => {
    for (const type of PRE_EXISTING) {
      expect(attentionOf(type)).toBe("interrupt");
    }
  });

  it("makes a reply ambient and the tick an interrupt", () => {
    expect(attentionOf("progress")).toBe("ambient");
    expect(attentionOf("heartbeat")).toBe("interrupt");
    expect(isAmbient("progress")).toBe(true);
    expect(isAmbient("heartbeat")).toBe(false);
  });

  /**
   * The table is the enforcement, not this test — `satisfies` fails the build
   * when a type has no posture. This catches the other direction: a key left
   * behind after a type is removed.
   */
  it("declares a posture for exactly the known types and no others", () => {
    expect(new Set(Object.keys(ATTENTION)))
      .toEqual(new Set([...PRE_EXISTING, "heartbeat", "progress"]));
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/attention.test.ts`
Expected: FAIL — the module does not resolve.

- [ ] **Step 3: Add the two event types**

In `src/types.ts`, extend `EventType`:

```ts
export type EventType =
  | "member_joined"
  | "member_left"
  | "member_evicted"
  | "member_timed_out"
  | "message"
  | "artifact"
  | "action_request"
  | "action_response"
  | "brief_update"
  | "invite_issued"
  | "invite_revoked"
  | "session_expired"
  /** The server's tick, on the room's cadence. Never sent by a member (#111). */
  | "heartbeat"
  /** A member's answer to a tick. */
  | "progress";
```

- [ ] **Step 4: Write `src/attention.ts`**

```ts
import type { EventType } from "./types.js";

/**
 * Whether an event should reach a member mid-turn, or wait until it looks.
 *
 * In neither server.ts nor bridge.ts, and with no import beyond a type, for the
 * reason public-event.ts gives: both the server's projection and the client's
 * delivery read it, and a table in either one would make that one the owner of a
 * type list the other has to keep up with.
 */
export type Attention = "interrupt" | "ambient";

/**
 * The posture of every event type. Closed over EventType by `satisfies`, so a
 * new type must declare one here or this stops compiling — the SEND_VERB
 * pattern. A default arm would hand it `interrupt` silently, and the point is
 * that every posture is one somebody chose.
 *
 * The twelve types that predate #111 are all `interrupt`, which is what they
 * already do: this table classifies, it does not change behaviour.
 * `invite_issued` and `member_joined` have a case for being ambient, and
 * re-classifying either is a separate change with its own argument to make.
 */
export const ATTENTION = {
  member_joined: "interrupt",
  member_left: "interrupt",
  member_evicted: "interrupt",
  member_timed_out: "interrupt",
  message: "interrupt",
  artifact: "interrupt",
  action_request: "interrupt",
  action_response: "interrupt",
  brief_update: "interrupt",
  invite_issued: "interrupt",
  invite_revoked: "interrupt",
  session_expired: "interrupt",
  /**
   * The tick interrupts, because interrupting a working member to ask where it
   * is IS the feature — the room asked for it, and a tick nobody reads produces
   * no report. It also carries the one thing a peer cannot discover by waiting:
   * which members have gone silent.
   */
  heartbeat: "interrupt",
  /**
   * A reply does not, because a peer that cares is already looking, and progress
   * notes landing in a peer's context every few minutes are worse than silence.
   */
  progress: "ambient",
} as const satisfies Record<EventType, Attention>;

export const attentionOf = (type: EventType): Attention => ATTENTION[type];
export const isAmbient = (type: EventType): boolean => ATTENTION[type] === "ambient";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/attention.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing `publicEvent` test**

Add to `tests/public-event.test.ts` (create the file if it does not exist, importing `publicEvent` from `../src/public-event.js` and `SessionEvent` from `../src/types.js`):

```ts
const base = {
  cursor: 7,
  fromMemberId: "m_a",
  fromUserId: "u_jesse",
  fromLabel: "jesse@codenerd",
  payload: { note: "ran migration 0042" },
  refId: null,
  at: 1_773_000_000_000,
};

it("omits ambient for an interrupting event", () => {
  const out = publicEvent({ ...base, type: "message" });
  expect("ambient" in out).toBe(false);
});

it("marks an ambient event, so a client need not know the type list", () => {
  expect(publicEvent({ ...base, type: "progress" })).toMatchObject({ ambient: true });
});

it("never leaks fromUserId", () => {
  expect("fromUserId" in publicEvent({ ...base, type: "progress" })).toBe(false);
});
```

- [ ] **Step 7: Run it to make sure it fails**

Run: `npx vitest run tests/public-event.test.ts`
Expected: FAIL — `ambient` is not in the projection.

- [ ] **Step 8: Emit `ambient` from `publicEvent`**

In `src/public-event.ts`, import `isAmbient` and spread the key conditionally:

```ts
import { isAmbient } from "./attention.js";

export function publicEvent(e: SessionEvent) {
  return {
    cursor: e.cursor,
    type: e.type,
    from: { member_id: e.fromMemberId, label: e.fromLabel },
    payload: e.payload,
    ref_id: e.refId,
    at: new Date(e.at).toISOString(),
    // Only when true. Omission costs nothing for the twelve types that predate
    // #111, and a client that has never heard of `progress` keeps working.
    ...(isAmbient(e.type) ? { ambient: true as const } : {}),
  };
}
```

- [ ] **Step 9: Run both tests**

Run: `npx vitest run tests/attention.test.ts tests/public-event.test.ts`
Expected: PASS

- [ ] **Step 10: Correct the `presence.ts` comment (D13)**

In `src/presence.ts`, the module comment currently reads "Not a heartbeat event." Replace that paragraph with:

```
 * Not a heartbeat. Liveness carries nothing and arrives on a timer, so a row
 * per beat in the durable, replayable event log is the worst possible home for
 * it — that is the cost curve #99 and #25 exist to flatten. It is a field on
 * the member, written as a side effect of calls the member already makes.
 *
 * A `heartbeat` EVENT is a different thing and does exist (#111): the server
 * appends one on the room's declared cadence, carrying a snapshot of who has
 * reported, and members answer it with `progress`. That is content with a
 * recipient. This is liveness with neither. The two never share a field.
```

- [ ] **Step 11: Verify and commit**

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

```bash
git add src/types.ts src/attention.ts src/public-event.ts src/presence.ts tests/attention.test.ts tests/public-event.test.ts
git commit -m "Give every event type an attention posture

The table is closed over EventType, so a new type must declare whether it
interrupts or waits until a member looks. publicEvent carries it, because
both the poll and the socket read that one projection and a table inside
either would make it the owner of a list the other has to track.

Every type that predates this interrupts, which is what it already does.
#82 and #81 reuse this rather than inventing a second notion of loudness."
```

---

### Task 2: `heartbeat_on` and `reports` in the manifest

**Files:**
- Modify: `src/types.ts` (`RoomManifest`, `RoleDef`)
- Modify: `src/manifest.ts`
- Modify: `src/roles.ts`
- Test: `tests/manifest.test.ts`, `tests/roles.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `RoomManifest.heartbeatOnMs: number | null`; `RoleDef.reports: boolean`; `MIN_HEARTBEAT_MS`, `MAX_HEARTBEAT_MS` exported from `src/manifest.ts`; `mustReport(manifest: RoomManifest, role: string): boolean` from `src/roles.ts`.

- [ ] **Step 1: Write the failing manifest tests**

Add to `tests/manifest.test.ts`:

```ts
import { resolveManifest, ManifestError, MIN_HEARTBEAT_MS, MAX_HEARTBEAT_MS } from "../src/manifest.js";

describe("heartbeat_on", () => {
  const authored = (over: Record<string, unknown> = {}) => ({
    room: "migration-swarm",
    mode: "swarm",
    roles: {
      lead: { can: ["send", "invite"], reports: true },
      observer: { can: [] },
    },
    default_role: "observer",
    creator_role: "lead",
    ...over,
  });

  it("parses s, m and h to milliseconds", () => {
    expect(resolveManifest(authored({ heartbeat_on: "30s" })).heartbeatOnMs).toBe(30_000);
    expect(resolveManifest(authored({ heartbeat_on: "5m" })).heartbeatOnMs).toBe(300_000);
    expect(resolveManifest(authored({ heartbeat_on: "1h" })).heartbeatOnMs).toBe(3_600_000);
  });

  it("defaults to no cadence, and to a role that is not asked", () => {
    const m = resolveManifest(authored());
    expect(m.heartbeatOnMs).toBe(null);
    expect(m.roles.observer.reports).toBe(false);
    expect(m.roles.lead.reports).toBe(true);
  });

  it("expects nothing of any preset role", () => {
    for (const preset of ["pair", "swarm", "review"] as const) {
      const m = resolveManifest({ room: "r", preset });
      expect(m.heartbeatOnMs).toBe(null);
      for (const def of Object.values(m.roles)) expect(def.reports).toBe(false);
    }
  });

  // Review Focus 5 — the raw value reaches a tool error and the audit log.
  it.each(["5 minutes", "0m", "99h", "-5m", "", "5", "m", "5M", "1d"])(
    "refuses %o with a message naming the shape",
    (bad) => {
      expect(() => resolveManifest(authored({ heartbeat_on: bad }))).toThrow(ManifestError);
    },
  );

  it("refuses a duration outside the bounds, naming them", () => {
    expect(() => resolveManifest(authored({ heartbeat_on: "10s" })))
      .toThrow(/between 30s and 1h/);
    expect(() => resolveManifest(authored({ heartbeat_on: "2h" })))
      .toThrow(/between 30s and 1h/);
    expect(MIN_HEARTBEAT_MS).toBe(30_000);
    expect(MAX_HEARTBEAT_MS).toBe(3_600_000);
  });

  it("bounds the echoed value so a long string cannot reach the audit log", () => {
    expect(() => resolveManifest(authored({ heartbeat_on: "9".repeat(500) + "m" })))
      .toThrow(ManifestError);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/manifest.test.ts`
Expected: FAIL — `heartbeatOnMs` is undefined, and `heartbeat_on` is an unrecognised key on a `strictObject`.

- [ ] **Step 3: Extend the types**

In `src/types.ts`:

```ts
export interface RoleDef {
  can: Verb[];
  description: string | null;
  /**
   * Whether a member in this seat must answer the room's heartbeat tick (#111).
   *
   * Separate from the cadence, which is one number for the whole room: the tick
   * is a single event, so per-role intervals would mean several schedules and a
   * partial snapshot. This is the per-role half, and it is what keeps the signal
   * clean — a seat that does no work, like `swarm`'s observer, must not be named
   * silent for behaving exactly as its role describes.
   */
  reports: boolean;
}

export interface RoomManifest {
  room: string;
  purpose: string | null;
  mode: SessionMode;
  roles: Record<string, RoleDef>;
  defaultRole: string;
  creatorRole: string;
  preset: PresetName | null;
  /**
   * How often the server appends a `heartbeat` tick, or null for a room that
   * expects no reports. Immutable with the rest of the manifest, so a peer
   * reading silence reads it against the same number every member was given.
   */
  heartbeatOnMs: number | null;
}
```

- [ ] **Step 4: Add the bounds and the parser to `src/manifest.ts`**

```ts
/**
 * The cadence bounds. Below the floor it is a liveness timer, which is #103's
 * job and what #111 explicitly is not. Above the ceiling the cadence says
 * nothing a peer could act on inside a working session.
 */
export const MIN_HEARTBEAT_MS = 30_000;
export const MAX_HEARTBEAT_MS = 3_600_000;

const DURATION = /^(\d{1,4})(s|m|h)$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * `"30s"`, `"5m"`, `"1h"` to milliseconds.
 *
 * The raw value is echoed by both errors, and those reach tool errors and the
 * audit log, so HeartbeatOnShape bounds it to 8 characters before it can get
 * here. The regex caps the digits too, so neither message can be grown by its
 * input.
 */
function parseHeartbeatOn(raw: string): number {
  const m = DURATION.exec(raw);
  if (!m) {
    throw new ManifestError(
      `heartbeat_on must be a duration like "30s", "5m" or "1h" (got "${raw}")`,
    );
  }
  const ms = Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS];
  if (ms < MIN_HEARTBEAT_MS || ms > MAX_HEARTBEAT_MS) {
    throw new ManifestError(`heartbeat_on must be between 30s and 1h (got "${raw}")`);
  }
  return ms;
}

/** Bounded before interpolation. See parseHeartbeatOn. */
const HeartbeatOnShape = z.string().max(8);
```

- [ ] **Step 5: Accept the two keys in the shapes**

In `src/manifest.ts`, add `reports` to `RoleDefShape` and `heartbeat_on` to `AuthorShape`:

```ts
const RoleDefShape = z.strictObject({
  can: z.array(z.enum(VERBS)).max(VERBS.length),
  description: z.string().max(300).nullish(),
  // Absent means not asked. A role has to opt in to being expected to report,
  // for the same reason no preset does (D3): a tick that names members silent
  // who were never asked for anything is how the signal gets ignored.
  reports: z.boolean().nullish(),
});
```

and inside `AuthorShape`, beside `mode`:

```ts
  heartbeat_on: HeartbeatOnShape.nullish(),
```

`CiteShape` gains nothing: a preset carries no cadence (D3).

- [ ] **Step 6: Resolve both arms**

In `resolveManifest`, the preset arm returns `heartbeatOnMs: null`, and the authored arm parses. In the preset arm's return object add:

```ts
      heartbeatOnMs: null,
```

In the authored arm, inside the `for (const [key, def] of Object.entries(v.roles))` loop, carry `reports` through:

```ts
    roles[key] = {
      can: [...def.can],
      description: def.description ?? null,
      reports: def.reports ?? false,
    };
```

and in that arm's return object add:

```ts
      heartbeatOnMs: v.heartbeat_on ? parseHeartbeatOn(v.heartbeat_on) : null,
```

- [ ] **Step 7: Give every preset role `reports: false`**

In `src/manifest.ts`, `role()` is the only constructor of a preset `RoleDef`, so one change covers all nine:

```ts
function role(can: Verb[], description: string): RoleDef {
  // No preset expects a report (D3). Turning this on for shipped presets would
  // tick every room anyone already runs and name members silent who were never
  // asked for anything.
  return { can, description, reports: false };
}
```

- [ ] **Step 8: Run the manifest tests**

Run: `npx vitest run tests/manifest.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing `mustReport` test**

Add to `tests/roles.test.ts`:

```ts
import { mustReport } from "../src/roles.js";
import { roomManifest } from "./helpers/fixtures.js";

describe("mustReport", () => {
  const m = roomManifest({
    roles: {
      lead: { can: ["send"], description: null, reports: true },
      observer: { can: [], description: null, reports: false },
    },
    defaultRole: "observer",
    creatorRole: "lead",
  });

  it("answers from the role definition", () => {
    expect(mustReport(m, "lead")).toBe(true);
    expect(mustReport(m, "observer")).toBe(false);
  });

  /**
   * Fails closed, like verbsOfRole. Sessions round-trip through JSON in Durable
   * Objects, so an unrecognised seat must be asked for nothing rather than throw.
   */
  it("expects nothing of a role the manifest does not define", () => {
    expect(mustReport(m, "ghost")).toBe(false);
  });

  it("expects nothing of a name reachable on Object.prototype", () => {
    expect(mustReport(m, "constructor")).toBe(false);
    expect(mustReport(m, "__proto__")).toBe(false);
  });
});
```

- [ ] **Step 10: Run it to make sure it fails**

Run: `npx vitest run tests/roles.test.ts`
Expected: FAIL — `mustReport` is not exported.

- [ ] **Step 11: Add `mustReport` to `src/roles.ts`**

```ts
/**
 * Whether this seat must answer the room's heartbeat tick — the other place
 * `manifest.roles` is indexed, and it fails closed for the same reason
 * `verbsOfRole` does: a role the manifest does not define is asked for nothing.
 *
 * `Object.hasOwn` rather than a bare lookup, so the accessor stays total under a
 * rewrite. `roles["constructor"]` on a plain object is the inherited Object
 * function, which has no `reports`, but relying on that is relying on the shape
 * of something else.
 */
export function mustReport(manifest: RoomManifest, role: string): boolean {
  return Object.hasOwn(manifest.roles, role) ? manifest.roles[role].reports : false;
}
```

- [ ] **Step 12: Fix every construction site the new required fields broke**

`RoleDef.reports` and `RoomManifest.heartbeatOnMs` are required, so `npm run verify` names each literal that lacks them. Add `reports: false` and `heartbeatOnMs: null` to each. Expect hits in `tests/helpers/fixtures.ts` (`roomManifest` passes through `resolveManifest`, so it may need none) and in any test that builds a `RoleDef` or `RoomManifest` by hand.

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

- [ ] **Step 13: Commit**

```bash
git add src/types.ts src/manifest.ts src/roles.ts tests/manifest.test.ts tests/roles.test.ts tests/helpers/fixtures.ts
git commit -m "Let a room declare a heartbeat cadence, and a role declare who answers

One cadence for the room, because the tick is a single event and per-role
intervals would mean several schedules and a partial snapshot. The per-role
half is a boolean: a seat that does no work must not be named silent for
behaving exactly as its role describes.

No preset declares either. Turning it on for shipped presets would tick every
room anyone already runs, for members never asked for anything.

mustReport fails closed beside verbsOfRole: an unrecognised seat is asked for
nothing rather than throwing, because sessions round-trip through JSON."
```

---

### Task 3: The pure heartbeat rules

**Files:**
- Modify: `src/stored-session.ts` (`lastTickAt?`)
- Modify: `src/types.ts` (`Member.lastReportAt?`)
- Create: `src/heartbeat.ts`
- Test: `tests/heartbeat.test.ts`

**Interfaces:**
- Consumes: `mustReport` (Task 2), `RoomManifest.heartbeatOnMs` (Task 2).
- Produces: `lastReport(m: Member): number`; `nextTickAt(s: StoredSession, now: number): number | null`; `dueMembers(s: StoredSession, now: number): Member[]`; `snapshotOf(s: StoredSession, now: number): HeartbeatPayload`; `interface HeartbeatPayload { cadence_seconds: number; ask: string; members: ReportRow[] }`; `interface ReportRow { member_id: string; label: string; last_report_at: string | null; silent_for_seconds: number; silent: boolean }`.

- [ ] **Step 1: Write the failing tests, spin case first**

Create `tests/heartbeat.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { lastReport, nextTickAt, dueMembers, snapshotOf } from "../src/heartbeat.js";
import { member, roomManifest, session } from "./helpers/fixtures.js";
import type { StoredSession } from "../src/stored-session.js";

const T0 = Date.parse("2026-03-15T12:00:00Z");
const FIVE_MIN = 300_000;

const manifest = roomManifest({
  roles: {
    lead: { can: ["send"], description: null, reports: true },
    observer: { can: [], description: null, reports: false },
  },
  defaultRole: "observer",
  creatorRole: "lead",
  heartbeatOnMs: FIVE_MIN,
});

/** A StoredSession is a Session without its events. */
function stored(over: Partial<StoredSession> = {}): StoredSession {
  const { events, ...rest } = session({ manifest });
  return { ...rest, ...over } as StoredSession;
}

const lead = (over = {}) =>
  member({ memberId: "m_lead", label: "lead@a", roomRole: "lead", joinedAt: T0, ...over });
const watcher = (over = {}) =>
  member({ memberId: "m_obs", label: "obs@b", roomRole: "observer", joinedAt: T0, ...over });

describe("nextTickAt", () => {
  /**
   * Review Focus 2. A tick does not move lastReportAt — only a reply does — so a
   * due time computed from member reports stays in the past for a member that
   * never answers, and reArm() would fire the alarm back to back for good. The
   * clock anchors on lastTickAt, which strictly advances.
   */
  it("advances with lastTickAt, so a silent member cannot spin the alarm", () => {
    const s = stored({ members: [lead()], lastTickAt: T0 });
    expect(nextTickAt(s, T0)).toBe(T0 + FIVE_MIN);

    // One firing later, the member still having reported nothing.
    const after = stored({ members: [lead()], lastTickAt: T0 + FIVE_MIN });
    expect(nextTickAt(after, T0 + FIVE_MIN)).toBe(T0 + 2 * FIVE_MIN);
  });

  it("anchors on the earliest reporting member before any tick has fired", () => {
    const s = stored({ members: [lead({ joinedAt: T0 + 1_000 })], lastTickAt: undefined });
    expect(nextTickAt(s, T0)).toBe(T0 + 1_000 + FIVE_MIN);
  });

  it("returns a past time at most once, and converges after one firing", () => {
    const asleep = stored({ members: [lead()], lastTickAt: T0 - 10 * FIVE_MIN });
    expect(nextTickAt(asleep, T0)).toBeLessThan(T0);
    const woken = stored({ members: [lead()], lastTickAt: T0 });
    expect(nextTickAt(woken, T0)).toBe(T0 + FIVE_MIN);
  });

  it("arms nothing when the room declares no cadence", () => {
    const s = { ...stored({ members: [lead()] }), manifest: roomManifest() } as StoredSession;
    expect(nextTickAt(s, T0)).toBe(null);
  });

  // Review Focus 3's sibling: an empty roster must not arm, or the alarm fires
  // for as long as the object lives with nobody to ask.
  it("arms nothing when no member must report", () => {
    expect(nextTickAt(stored({ members: [watcher()] }), T0)).toBe(null);
    expect(nextTickAt(stored({ members: [] }), T0)).toBe(null);
    expect(nextTickAt(stored({ members: [lead({ leftAt: T0 })] }), T0)).toBe(null);
  });

  it("arms nothing for a frozen or closed room", () => {
    expect(nextTickAt(stored({ members: [lead()], frozenAt: T0 }), T0)).toBe(null);
    expect(nextTickAt(stored({ members: [lead()], closed: true }), T0)).toBe(null);
  });
});

describe("lastReport", () => {
  /**
   * Review Focus 3. Durable Object storage has no migration step, so a member
   * stored before the field existed has none. Reading undefined as "never
   * reported" makes every one of them instantly due and instantly silent.
   */
  it("lifts a member stored before the field existed to joinedAt", () => {
    expect(lastReport(member({ joinedAt: T0, lastReportAt: undefined }))).toBe(T0);
  });

  it("uses the stamp when there is one", () => {
    expect(lastReport(member({ joinedAt: T0, lastReportAt: T0 + 60_000 }))).toBe(T0 + 60_000);
  });
});

describe("dueMembers", () => {
  it("is due at one cadence and not before", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 })] });
    expect(dueMembers(s, T0 + FIVE_MIN - 1)).toEqual([]);
    expect(dueMembers(s, T0 + FIVE_MIN).map((m) => m.memberId)).toEqual(["m_lead"]);
  });

  it("never includes a seat that is not asked", () => {
    const s = stored({ members: [watcher({ lastReportAt: T0 })] });
    expect(dueMembers(s, T0 + 100 * FIVE_MIN)).toEqual([]);
  });
});

describe("snapshotOf", () => {
  it("marks silent only at two cadences, so a member is asked before peers are alarmed", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 })] });
    expect(snapshotOf(s, T0 + FIVE_MIN).members[0].silent).toBe(false);
    expect(snapshotOf(s, T0 + 2 * FIVE_MIN).members[0].silent).toBe(true);
  });

  it("reports a measurement taken at the tick, never a claim about now", () => {
    const s = stored({ members: [lead({ lastReportAt: T0 })] });
    const row = snapshotOf(s, T0 + 11 * 60_000).members[0];
    expect(row).toMatchObject({
      member_id: "m_lead",
      label: "lead@a",
      last_report_at: new Date(T0).toISOString(),
      silent_for_seconds: 660,
      silent: true,
    });
  });

  it("says so when a member has never reported", () => {
    const s = stored({ members: [lead({ lastReportAt: undefined })] });
    const row = snapshotOf(s, T0 + FIVE_MIN).members[0];
    expect(row.last_report_at).toBe(null);
    expect(row.silent_for_seconds).toBe(300);
  });

  it("lists only members that must report", () => {
    const s = stored({ members: [lead(), watcher()] });
    expect(snapshotOf(s, T0).members.map((r) => r.member_id)).toEqual(["m_lead"]);
  });

  /** Invariant 7: no field may be a claim about now. */
  it("carries no presence key", () => {
    const s = stored({ members: [lead()] });
    const keys = Object.keys(snapshotOf(s, T0).members[0]);
    for (const banned of ["present", "status", "alive", "healthy", "state"]) {
      expect(keys).not.toContain(banned);
    }
  });

  it("carries the cadence and the ask", () => {
    const snap = snapshotOf(stored({ members: [lead()] }), T0);
    expect(snap.cadence_seconds).toBe(300);
    expect(snap.ask).toMatch(/bellman_send/);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `npx vitest run tests/heartbeat.test.ts`
Expected: FAIL — the module does not resolve.

- [ ] **Step 3: Add the two stored fields**

In `src/types.ts`, on `Member`, after `lastSeenAt`:

```ts
  /**
   * When this member last answered a heartbeat tick with `progress` (#111).
   *
   * Distinct from `lastSeenAt`, which any call moves: this moves only on a
   * deliberate report, because the question it answers is "has this member said
   * where it is", not "is it there". Absent on rows stored before the field
   * existed; read it through `lastReport`, which lifts those to `joinedAt`.
   */
  lastReportAt?: number;
```

In `src/stored-session.ts`, on `StoredSession`:

```ts
  /**
   * When the heartbeat alarm last fired for this room (#111).
   *
   * The tick's clock, and the reason the alarm cannot spin: a tick does not move
   * any member's `lastReportAt`, so a due time computed from member reports
   * alone stays in the past for a member that never answers, and `reArm()` would
   * point the alarm back at it indefinitely — the hazard `alarm()`'s comment
   * records for `due:outbox`. This strictly advances on every firing.
   *
   * Absent until the first firing; `nextTickAt` anchors on the earliest
   * reporting member's `joinedAt` until then.
   */
  lastTickAt?: number;
```

- [ ] **Step 4: Write `src/heartbeat.ts`**

```ts
/**
 * When the server asks a room's members where they are, and what it tells them
 * about each other (#111).
 *
 * Not presence. `presence.ts` answers whether a member is *there*, derived from
 * calls it already makes; this answers whether it has *said where it is*, which
 * only a deliberate report can establish. The two never share a field: a member
 * can be present and silent, which is exactly the state this exists to surface.
 *
 * Every rule here is pure and takes `now`, so the store holds no heartbeat
 * policy — the same split `seatVictims` has from `STALE_AFTER_MS`.
 *
 * This module must stay importable by both builds: no `cloudflare:workers`,
 * directly or transitively. `SessionDO` imports it, and so do both test
 * programs.
 */
import type { Member } from "./types.js";
import type { StoredSession } from "./stored-session.js";
import { isActiveMember } from "./store.js";
import { mustReport } from "./roles.js";

/**
 * When this member last reported, falling back to when it joined.
 *
 * The fallback is the legacy lift: members stored before `lastReportAt` existed
 * have none, and reading `undefined` as "never reported" would make every one of
 * them due and silent the moment this ships. Joining is not a report, but it IS
 * the moment the clock should start from, so `joinedAt` is the honest answer —
 * the same read-time lift `lastSeen` applies.
 *
 * Unlike `lastSeen`, this lives here rather than in store.ts: no store method
 * reads it, because seating a member does not depend on whether it has reported.
 */
export const lastReport = (m: Member): number => m.lastReportAt ?? m.joinedAt;

/** Members holding a seat the room expects reports from. */
const reporting = (s: StoredSession): Member[] =>
  s.members.filter((m) => isActiveMember(m) && mustReport(s.manifest, m.roomRole));

/**
 * When the heartbeat alarm should next fire, or null for a room that needs none.
 *
 * Anchored on `lastTickAt` and NOT on member report times, which is what keeps
 * the alarm from spinning: see the field's comment in stored-session.ts.
 *
 * Null for a room with no cadence, no member to ask, or that cannot be answered
 * — a frozen or closed room. Deriving a time for a closed session would re-arm
 * the alarm to a moment already past and fire for as long as the object lived,
 * which is the reason `derivedDue` already gives about the TTL.
 *
 * It may return a time in the past, once, for an object that slept through a
 * tick. That is correct: the alarm fires immediately, the firing moves
 * `lastTickAt` to now, and the next answer is in the future.
 */
export function nextTickAt(s: StoredSession, now: number): number | null {
  const every = s.manifest.heartbeatOnMs;
  if (every === null || s.closed || s.frozenAt !== null) return null;
  const asked = reporting(s);
  if (asked.length === 0) return null;
  const anchor = s.lastTickAt ?? Math.min(...asked.map((m) => m.joinedAt));
  return anchor + every;
}

/** Members that have gone a full cadence without reporting. The tick asks these. */
export function dueMembers(s: StoredSession, now: number): Member[] {
  const every = s.manifest.heartbeatOnMs;
  if (every === null) return [];
  return reporting(s).filter((m) => now - lastReport(m) >= every);
}

export interface ReportRow {
  member_id: string;
  label: string;
  /** ISO 8601, or null for a member that has never reported. */
  last_report_at: string | null;
  /** Measured at the tick. A fact about `at`, not a claim about now. */
  silent_for_seconds: number;
  /** Past two cadences. */
  silent: boolean;
}

export interface HeartbeatPayload {
  cadence_seconds: number;
  ask: string;
  members: ReportRow[];
}

/**
 * What the tick carries: the thing only the server can see.
 *
 * **Invariant 7 holds here and the payload is where it would break.** Every
 * field is a claim about the tick's own `at` — "had reported nothing for 660
 * seconds at 14:05" was true then and stays true on replay. There is no
 * `present`, `status`, `alive` or `healthy` key, and there must never be: those
 * are claims about now, which replay re-asserts hours after the member went.
 * Presence stays derived, in presence.ts.
 *
 * Two thresholds. `silent` is two cadences and the ask is one, so a member is
 * asked for a full interval before any peer is told it has gone quiet. A false
 * silent costs every peer's trust in the signal; a late one costs a few minutes.
 */
export function snapshotOf(s: StoredSession, now: number): HeartbeatPayload {
  const every = s.manifest.heartbeatOnMs ?? 0;
  return {
    cadence_seconds: Math.round(every / 1000),
    ask: "Reply with bellman_send type=\"progress\", payload { note } — one line on where you are.",
    members: reporting(s).map((m) => ({
      member_id: m.memberId,
      label: m.label,
      last_report_at: m.lastReportAt ? new Date(m.lastReportAt).toISOString() : null,
      silent_for_seconds: Math.max(0, Math.round((now - lastReport(m)) / 1000)),
      silent: now - lastReport(m) >= 2 * every,
    })),
  };
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/heartbeat.test.ts`
Expected: PASS

- [ ] **Step 6: Prove the spin test can fail**

Temporarily change `nextTickAt`'s anchor to `Math.min(...asked.map(lastReport))` — the member-anchored rule the spec described — and re-run. The "advances with lastTickAt" case must go red. Revert the change.

Run: `npx vitest run tests/heartbeat.test.ts -t "spin"`
Expected: FAIL while reverted-to-broken, PASS after reverting back. A positive control: this assertion has now been seen to fail.

- [ ] **Step 7: Verify and commit**

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

```bash
git add src/types.ts src/stored-session.ts src/heartbeat.ts tests/heartbeat.test.ts
git commit -m "Derive when to tick, and what the tick says about the room

The clock anchors on lastTickAt rather than on member report times. A tick
moves nobody's lastReportAt — only a reply does — so a member-anchored due
time stays in the past for a member that never answers, and reArm() would
fire the alarm back to back for good. lastTickAt strictly advances.

The snapshot is where invariant 7 would break, so every field is a
measurement taken at the tick rather than a claim about now: there is no
present, status or alive key and there must never be. Presence stays derived.

silent is two cadences and the ask is one, so a member is asked for a full
interval before any peer is told it has gone quiet."
```

---

### Task 4: The `progress` reply

**Files:**
- Modify: `src/store.ts` (`MemberPatch`)
- Modify: `src/server.ts` (`SEND_KINDS`, `SEND_VERB`, `ProgressShape`, the `progress` branch)
- Test: `tests/tools/progress.test.ts`, `tests/helpers/store-contract.ts`

**Interfaces:**
- Consumes: `EventType` (Task 1), `lastReport` (Task 3).
- Produces: a `progress` value in `bellman_send`'s `type` enum; `Member.lastReportAt` written by the handler.

- [ ] **Step 1: Write the failing tool test**

Create `tests/tools/progress.test.ts`, following the in-memory MCP client style of the existing tool tests in `tests/tools/`:

```ts
import { describe, it, expect } from "vitest";
// Use the same harness import the sibling files in tests/tools/ use.
import { withRoom } from "../helpers/harness.js";

describe("bellman_send type=progress", () => {
  it("appends an event and stamps lastReportAt", async () => {
    await withRoom(async ({ callAs, creator, joiner, store, sessionId }) => {
      const out = await callAs(creator, "bellman_send", {
        session_id: sessionId,
        member_id: creator.memberId,
        type: "progress",
        payload: { note: "ran migration 0042", step: "3 of 7" },
      });
      expect(out.isError).toBeFalsy();

      const events = await store.eventsAfter(sessionId, 0);
      expect(events.at(-1)).toMatchObject({
        type: "progress",
        fromMemberId: creator.memberId,
        payload: { note: "ran migration 0042", step: "3 of 7" },
      });

      const s = await store.getSession(sessionId);
      const me = s!.members.find((m) => m.memberId === creator.memberId)!;
      expect(me.lastReportAt).toBe(events.at(-1)!.at);
    });
  });

  it("refuses a payload with any key the shape does not name", async () => {
    await withRoom(async ({ callAs, creator, sessionId }) => {
      for (const bad of [
        { note: "x", status: "working" },
        { note: "x", alive: true },
        { note: "x", present: true },
        { note: "x", healthy: true },
        { note: "x", state: "busy" },
      ]) {
        const out = await callAs(creator, "bellman_send", {
          session_id: sessionId, member_id: creator.memberId, type: "progress", payload: bad,
        });
        expect(out.isError).toBe(true);
      }
    });
  });

  it("requires a note, and bounds it", async () => {
    await withRoom(async ({ callAs, creator, sessionId }) => {
      for (const bad of [{}, { note: "" }, { note: "x".repeat(501) }, { note: 7 }]) {
        const out = await callAs(creator, "bellman_send", {
          session_id: sessionId, member_id: creator.memberId, type: "progress", payload: bad,
        });
        expect(out.isError).toBe(true);
      }
    });
  });

  /** A seat that may not speak may not report either — brief_update's reasoning. */
  it("needs the send verb", async () => {
    await withRoom({ joinerRole: "observer" }, async ({ callAs, joiner, sessionId }) => {
      const out = await callAs(joiner, "bellman_send", {
        session_id: sessionId, member_id: joiner.memberId, type: "progress",
        payload: { note: "watching" },
      });
      expect(out.isError).toBe(true);
      expect(JSON.stringify(out)).toMatch(/does not hold the verb "send"/);
    });
  });
});
```

If `withRoom` does not take an options object in this repo, set the joiner's role the way the sibling tests in `tests/tools/verbs.test.ts` do and keep the assertions identical.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/tools/progress.test.ts`
Expected: FAIL — `progress` is not a member of the `type` enum, so the SDK rejects the call before any handler runs.

- [ ] **Step 3: Widen `MemberPatch`**

In `src/store.ts`:

```ts
export type MemberPatch = Partial<
  Pick<Member, "brief" | "capabilities" | "leftAt" | "lastSeenAt" | "lastReportAt">
>;
```

- [ ] **Step 4: Add the kind, its verb and its payload shape**

In `src/server.ts`:

```ts
const SEND_KINDS = [
  "message", "artifact", "action_request", "action_response", "brief_update", "progress",
] as const;
```

In `SEND_VERB`, beside `brief_update`:

```ts
  /**
   * A reply to the room's heartbeat tick. `send` and not a new verb: manifest.ts
   * is explicit that a verb lands only in the PR that adds its operation, and a
   * seat that may not speak may not report either — brief_update's reasoning.
   * `RoleDef.reports` already answers who is asked.
   */
  progress: "send",
```

With the other zod shapes:

```ts
/**
 * A heartbeat reply. `strictObject`, so every key the shape does not name is
 * refused — which is how `status`, `alive`, `present` and `healthy` are kept out
 * without a denylist that falls behind the first name somebody forgets. The
 * payload is a claim about when it was sent, never about now (invariant 7).
 */
const ProgressShape = z.strictObject({
  note: z.string().min(1).max(500),
  step: z.string().max(40).optional(),
  eta_seconds: z.number().int().nonnegative().max(86_400).optional(),
});
```

- [ ] **Step 5: Validate and stamp in the handler**

In `bellman_send`, beside the `brief_update` validation block:

```ts
      if (type === "progress") {
        const parsed = ProgressShape.safeParse(payload);
        if (!parsed.success) {
          return fail(`progress payload must be { note, step?, eta_seconds? }: ${parsed.error.issues[0]?.message}`);
        }
      }
```

and in the `if (!replayed)` block, beside the `updatedBrief` write:

```ts
        // Patched here rather than inside appendEvent, so the store stays
        // type-agnostic — nothing in it branches on an event's kind. A failed
        // patch after a committed event leaves the member looking like it
        // reported later than it did, and the next tick asks again; a store that
        // inspected payloads to find out would be the worse trade.
        if (type === "progress") {
          await s.updateMember(session_id, member_id, { lastReportAt: event.at });
        }
```

- [ ] **Step 6: Document the kind in the tool description**

In `bellman_send`'s description, after the `brief_update` line:

```
      "progress"       — answer the room's heartbeat: where you are now ({ note, step?, eta_seconds? }). Peers are not interrupted by it; it reaches them when they next look.
```

- [ ] **Step 7: Run the tool test**

Run: `npx vitest run tests/tools/progress.test.ts`
Expected: PASS

- [ ] **Step 8: Add the store-contract case**

In `tests/helpers/store-contract.ts`, inside `describeStoreContract`:

```ts
    it("patches lastReportAt, and reads a member stored without it as joinedAt", async () => {
      const joinedAt = Date.now();
      await store.createSession(session({ members: [member({ lastReportAt: undefined, joinedAt })] }));
      const before = await store.getSession("qs_test");
      expect(before!.members[0].lastReportAt).toBeUndefined();
      expect(lastReport(before!.members[0])).toBe(joinedAt);

      await store.updateMember("qs_test", "m_creator", { lastReportAt: joinedAt + 60_000 });
      const after = await store.getSession("qs_test");
      expect(after!.members[0].lastReportAt).toBe(joinedAt + 60_000);
      expect(lastReport(after!.members[0])).toBe(joinedAt + 60_000);
    });
```

Add `import { lastReport } from "../../src/heartbeat.js";` to that file's imports.

- [ ] **Step 9: Run both store programs**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS

Run: `cd worker-tests && npx vitest run store-contract.test.ts`
Expected: PASS — the same assertion against real Durable Objects.

- [ ] **Step 10: Verify and commit**

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

```bash
git add src/store.ts src/server.ts tests/tools/progress.test.ts tests/helpers/store-contract.ts
git commit -m "Let a member answer a tick with progress

A sixth send kind, mapped to send rather than a new verb: a seat that may not
speak may not report either, and RoleDef.reports already answers who is asked.

The payload is a strictObject, so status, alive, present and healthy are
refused because every unnamed key is — no denylist to fall behind.

lastReportAt is patched by the handler, not inside appendEvent, so the store
stays type-agnostic. A failed patch leaves the member looking like it reported
late and the next tick asks again; a store that read payloads to find out
would be the worse trade."
```

---

### Task 5: The tick

**Files:**
- Modify: `src/store-do.ts` (`derivedDue`, `alarm`, `#tickIfDue`)
- Test: `worker-tests/heartbeat-tick.test.ts`

**Interfaces:**
- Consumes: `nextTickAt`, `dueMembers`, `snapshotOf` (Task 3); `StoredSession.lastTickAt` (Task 3).
- Produces: a `heartbeat` event appended with `fromMemberId: "system"`; `lastTickAt` advanced on every firing.

- [ ] **Step 1: Write the failing tests, frozen case first**

Create `worker-tests/heartbeat-tick.test.ts`:

```ts
/**
 * The heartbeat tick, which only a real Durable Object can fire. The pure rules
 * it runs are unit-tested in tests/heartbeat.test.ts; this file is about the
 * alarm: that it fires, that it advances its own clock, and that it writes
 * nothing into a room that cannot answer.
 */
import { it, expect, afterEach } from "vitest";
import { env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { DurableObjectStore, type SessionDO } from "../src/store-do.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

const FIVE_MIN = 300_000;

const manifest = roomManifest({
  roles: {
    lead: { can: ["send"], description: null, reports: true },
    observer: { can: [], description: null, reports: false },
  },
  defaultRole: "observer",
  creatorRole: "lead",
  heartbeatOnMs: FIVE_MIN,
});

const room = (id: string, over = {}) =>
  session({
    id,
    manifest,
    joinCodes: {},
    members: [member({ memberId: "m_lead", roomRole: "lead", label: "lead@a" })],
    ...over,
  });

const rows = (stub: DurableObjectStub) =>
  runInDurableObject(stub, async (_i: SessionDO, ctx) => ({
    session: await ctx.storage.get<{ lastTickAt?: number; frozenAt: number | null }>("session"),
    events: [...(await ctx.storage.list<{ type: string; payload: unknown; fromMemberId: string }>(
      { prefix: "e:" },
    )).values()],
  }));

/**
 * Review Focus 1. #tickIfDue mirrors #expireIfDue, which calls #writeEvent
 * DIRECTLY and so bypasses appendEvent's frozen guard. A naive copy writes a
 * tick into a frozen room and names members silent who cannot report out of it.
 * A freeze must cost nobody their standing.
 */
it("writes no tick into a frozen room", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_frozen"));
  await store.freezeSession("qs_frozen", Date.now());

  const stub = env.SESSION.get(env.SESSION.idFromName("qs_frozen"));
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
});

it("appends a tick from the server, never from a member", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_tick"));

  const stub = env.SESSION.get(env.SESSION.idFromName("qs_tick"));
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    // A member that joined a full cadence ago and has reported nothing.
    await ctx.storage.put("session", { ...s, lastTickAt: Date.now() - FIVE_MIN });
  });
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  const tick = after.events.find((e) => e.type === "heartbeat")!;
  expect(tick.fromMemberId).toBe("system");
  expect(tick.payload).toMatchObject({
    cadence_seconds: 300,
    members: [{ member_id: "m_lead", silent: false }],
  });
});

it("advances lastTickAt on every firing, so the alarm cannot spin", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_spin"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_spin"));

  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const s = await ctx.storage.get<Record<string, unknown>>("session");
    await ctx.storage.put("session", { ...s, lastTickAt: Date.now() - 10 * FIVE_MIN });
  });
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.session!.lastTickAt).toBeGreaterThan(Date.now() - 1_000);
  // The next armed time is in the future, so no second firing is owed.
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});

it("writes no tick when nobody is due, but still re-arms", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_quiet", {
    members: [member({ memberId: "m_lead", roomRole: "lead", lastReportAt: Date.now() })],
  }));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_quiet"));
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  const after = await rows(stub);
  expect(after.events.filter((e) => e.type === "heartbeat")).toEqual([]);
  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    expect(await ctx.storage.getAlarm()).toBeGreaterThan(Date.now());
  });
});

it("arms nothing for a room whose roles ask for no reports", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(session({ id: "qs_none", joinCodes: {} }));
  await runInDurableObject(
    env.SESSION.get(env.SESSION.idFromName("qs_none")),
    async (_i: SessionDO, ctx) => {
      // Only the TTL, which is the session's expiry and not a tick.
      const s = await ctx.storage.get<{ expiresAt: number }>("session");
      expect(await ctx.storage.getAlarm()).toBe(s!.expiresAt);
    },
  );
});

/**
 * The rollback property. The due time is DERIVED, so a build that does not know
 * the name does not compute it either — unlike a stored `due:` row, which an
 * older build never consumes and whose closing reArm() fires the alarm back to
 * back for good.
 */
it("stores no due row for the tick, so a rollback strands nothing", async () => {
  const store = new DurableObjectStore(env as never);
  await store.createSession(room("qs_rollback"));
  const stub = env.SESSION.get(env.SESSION.idFromName("qs_rollback"));
  await runInDurableObject(stub, (i: SessionDO) => i.alarm());

  await runInDurableObject(stub, async (_i: SessionDO, ctx) => {
    const due = [...(await ctx.storage.list({ prefix: "due:" })).keys()];
    expect(due).not.toContain("due:heartbeat");
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `cd worker-tests && npx vitest run heartbeat-tick.test.ts`
Expected: FAIL — no tick is ever written, so the "appends a tick" and "advances lastTickAt" cases go red. The frozen case passes vacuously, which is why Step 8 proves it can fail.

- [ ] **Step 3: Derive the tick's due time**

In `src/store-do.ts`, import the rules:

```ts
import { dueMembers, nextTickAt, snapshotOf } from "./heartbeat.js";
```

and extend `derivedDue`:

```ts
  private async derivedDue(): Promise<Map<string, number>> {
    const s = await this.stored();
    if (!s || s.closed) return new Map();
    const due = new Map([["ttl", s.expiresAt]]);
    // Derived rather than a stored `due:` row, deliberately. A name the driver
    // can report with no branch below is never consumed, and the closing reArm()
    // fires the alarm back to back for good — the rollback hazard this object's
    // alarm() comment records for `due:outbox`. A build that does not know this
    // name does not compute it either, so rolling back strands nothing.
    const tick = nextTickAt(s, Date.now());
    if (tick !== null) due.set(HEARTBEAT_HANDLER, tick);
    return due;
  }
```

with the constant beside the other key helpers at the top of the file:

```ts
const HEARTBEAT_HANDLER = "heartbeat";
```

- [ ] **Step 4: Dispatch it**

In `SessionDO.alarm()`, beside the `ttl` branch:

```ts
      if (name === HEARTBEAT_HANDLER) {
        const s = await this.stored();
        if (s) await this.#tickIfDue(s, now);
      }
```

- [ ] **Step 5: Write `#tickIfDue`**

```ts
  /**
   * Ask the room's members where they are, if any of them owes an answer.
   *
   * `#private` for the reason every writing method on this class is: a Durable
   * Object answers RPC for every method on it and TypeScript's `private` is
   * erased, so a plain stub could otherwise forge a tick into any room.
   *
   * **The frozen and closed guards are the point of this method, not a
   * formality.** It writes through `#writeEvent`, as `#expireIfDue` does, which
   * means it does NOT inherit `appendEvent`'s frozen check. Without them a
   * frozen room gets ticks naming members silent who cannot report out of it,
   * and a freeze must cost nobody their standing — the same rule that keeps
   * `reclaimStaleSeats` out of a frozen room.
   *
   * `lastTickAt` advances whether or not an event is written, which is what
   * stops the alarm spinning: the clock has to move even on a firing that found
   * nobody due, or `derivedDue` returns the same past time and `reArm()` points
   * the alarm straight back at it.
   */
  async #tickIfDue(s: StoredSession, now: number): Promise<void> {
    if (s.closed || s.frozenAt !== null) return;
    if (s.manifest.heartbeatOnMs === null) return;

    const due = dueMembers(s, now);
    if (due.length === 0) {
      // Nothing to ask, but the clock still moves. See the comment above.
      await this.ctx.storage.put<unknown>({ session: { ...s, lastTickAt: now } });
      return;
    }

    const event: SessionEvent = {
      cursor: await this.nextCursor(),
      type: "heartbeat" as EventType,
      // The server is not a member and holds no role, so it needs no verb.
      fromMemberId: "system",
      fromUserId: "system",
      fromLabel: "bellman",
      payload: snapshotOf(s, now),
      refId: null,
      at: now,
    };
    // The event, its cursor and the advanced clock in one put. Committed
    // separately, an interruption between them leaves a tick stored with the
    // clock unmoved, and the next firing writes the same tick again.
    await this.#writeEvent(event, { session: { ...s, lastTickAt: now } });
    this.#wake(event);
  }
```

- [ ] **Step 6: Run the worker tests**

Run: `cd worker-tests && npx vitest run heartbeat-tick.test.ts`
Expected: PASS

- [ ] **Step 7: Run the whole worker program, for the alarm it shares**

Run: `cd worker-tests && npx vitest run`
Expected: PASS — `alarms.test.ts` especially, since the TTL now shares `derivedDue` with a second name.

- [ ] **Step 8: Prove the frozen assertion can fail**

Temporarily delete `if (s.closed || s.frozenAt !== null) return;` from `#tickIfDue` and re-run. "writes no tick into a frozen room" must go red. Restore the line.

Run: `cd worker-tests && npx vitest run heartbeat-tick.test.ts -t "frozen"`
Expected: FAIL while the guard is removed, PASS once restored. A positive control for Review Focus 1.

- [ ] **Step 9: Prove the spin assertion can fail**

Temporarily change the no-one-due branch to `return;` without writing `lastTickAt`, and re-run. "writes no tick when nobody is due, but still re-arms" must go red on its alarm assertion. Restore.

Run: `cd worker-tests && npx vitest run heartbeat-tick.test.ts -t "re-arms"`
Expected: FAIL while broken, PASS once restored.

- [ ] **Step 10: Verify and commit**

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

```bash
git add src/store-do.ts worker-tests/heartbeat-tick.test.ts
git commit -m "Tick the room from a derived named alarm

SessionDO appends the heartbeat itself, fromMemberId system, so no member can
put one in the room and bellman_send stays the only write path. Delivery is
the existing one: #wake resolves held polls and sockets and the bridge does
the rest, so a heads-down member is reached without polling for it.

Derived rather than a stored due row. A name the driver reports with no branch
is never consumed and reArm fires the alarm back to back for good; a build
that does not know this name does not compute it either, so a rollback
strands nothing.

The frozen guard is the method's point, not a formality: this writes through
#writeEvent like #expireIfDue does, so it does not inherit appendEvent's
frozen check, and a freeze must cost nobody their standing.

lastTickAt advances on every firing including one that found nobody due,
which is what keeps the alarm from spinning."
```

---

### Task 6: Ambient events do not interrupt

**Files:**
- Modify: `src/inbox.ts` (`PeerEvent`, `WireEnvelope`, `fromEnvelope`)
- Modify: `src/bridge.ts` (`deliver`)
- Test: `tests/bridge-delivery.test.ts`

**Interfaces:**
- Consumes: `publicEvent`'s `ambient` key (Task 1).
- Produces: `PeerEvent.ambient?: boolean`.

- [ ] **Step 1: Write the failing test**

Create `tests/bridge-delivery.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { fromEnvelope, type WireEnvelope } from "../src/inbox.js";

const envelope = (over: Record<string, unknown> = {}): WireEnvelope => ({
  trust: "untrusted",
  origin: { memberId: "m_a", label: "lead@a" },
  data: {
    cursor: 7,
    type: "progress",
    from: { member_id: "m_a", label: "lead@a" },
    payload: { note: "ran migration 0042" },
    ref_id: null,
    at: "2026-03-15T12:00:00.000Z",
    ambient: true,
    ...over,
  },
} as WireEnvelope);

describe("fromEnvelope", () => {
  it("carries ambient through to the delivered event", () => {
    const e = fromEnvelope({ session_id: "qs_1", member_id: "m_me" }, envelope());
    expect(e.ambient).toBe(true);
  });

  it("leaves it falsy for an event the server did not mark", () => {
    const e = fromEnvelope(
      { session_id: "qs_1", member_id: "m_me" },
      envelope({ type: "message", ambient: undefined }),
    );
    expect(e.ambient).toBeFalsy();
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/bridge-delivery.test.ts`
Expected: FAIL — `ambient` is not a property of `PeerEvent`.

- [ ] **Step 3: Carry `ambient` on the wire type**

In `src/inbox.ts`, add to `PeerEvent`:

```ts
  /**
   * The server said this event should not interrupt (#111). Read it rather than
   * naming types: attention is declared once, in src/attention.ts, and carried
   * by publicEvent so that every client reads one answer.
   */
  ambient?: boolean;
```

Add `ambient?: boolean` to `WireEnvelope`'s `data`, and carry it in `fromEnvelope`:

```ts
    ambient: env.data.ambient,
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/bridge-delivery.test.ts`
Expected: PASS

- [ ] **Step 5: Suppress only the channel push**

In `src/bridge.ts`, `deliver()`:

```ts
  async function deliver(event: PeerEvent): Promise<void> {
    if (delivery === "hook") {
      // Ambient events are queued like any other. Hook delivery drains at the
      // END of a turn, so it does not interrupt by construction — and skipping
      // the enqueue here would mean a hook-mode member never saw a progress
      // report at all, rather than seeing it a little later.
      enqueue(inboxDir!, event);
      return;
    }
    /**
     * A channel push lands mid-turn, which is the interruption. A heartbeat tick
     * earns one: being asked where you are IS the feature, and a tick nobody
     * reads produces no report. A reply does not: a member that cares is already
     * looking, and progress notes arriving every few minutes are worse than
     * silence. It reaches the agent through a solicited bellman_sync or
     * bellman_wait instead.
     */
    if (event.ambient) return;
    const meta: Record<string, string> = {
```

- [ ] **Step 6: Assert the delivery split, not just the flag**

Add to `tests/bridge-delivery.test.ts`, using the bridge harness the sibling bridge tests use (`tests/bridge.test.ts`) to build a bridge in each mode and capture `server.notification` calls and inbox writes:

```ts
describe("deliver", () => {
  it("pushes a tick and withholds a reply, in channel mode", async () => {
    const { pushes, deliver } = await channelBridge();
    await deliver({ ...peer, type: "heartbeat", ambient: undefined });
    await deliver({ ...peer, type: "progress", ambient: true });
    expect(pushes.map((p) => p.params.meta.type)).toEqual(["heartbeat"]);
  });

  // Review Focus 4 — the early return must not skip the queue.
  it("queues both in hook mode, because end of turn is not an interruption", async () => {
    const { queued, deliver } = await hookBridge();
    await deliver({ ...peer, type: "heartbeat", ambient: undefined });
    await deliver({ ...peer, type: "progress", ambient: true });
    expect(queued.map((e) => e.type)).toEqual(["heartbeat", "progress"]);
  });
});
```

Match `channelBridge`, `hookBridge` and `peer` to the fixtures already in `tests/bridge.test.ts`; if that file builds its bridge inline, do the same here rather than adding a shared helper for two cases.

- [ ] **Step 7: Run it, then prove it can fail**

Run: `npx vitest run tests/bridge-delivery.test.ts`
Expected: PASS

Temporarily move `if (event.ambient) return;` above the `delivery === "hook"` block and re-run: "queues both in hook mode" must go red. Restore it below.

- [ ] **Step 8: Verify and commit**

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

```bash
git add src/inbox.ts src/bridge.ts tests/bridge-delivery.test.ts
git commit -m "Withhold the channel push for an ambient event

deliver() reads the server's ambient flag rather than naming types, so
attention is declared once and every client reads one answer.

Only the mid-turn push is withheld. Hook delivery queues an ambient event
like any other, because draining at the end of a turn is not an interruption
— and returning before the enqueue would mean a hook-mode member never saw a
progress report at all."
```

---

### Task 7: What a joiner is shown

**Files:**
- Modify: `src/server.ts` (`roomPreview`)
- Test: `tests/tools/connect.test.ts`

**Interfaces:**
- Consumes: `mustReport` (Task 2), `RoomManifest.heartbeatOnMs` (Task 2).
- Produces: `heartbeat_on_seconds` and `you_report` in the room preview.

- [ ] **Step 1: Write the failing test**

Add to `tests/tools/connect.test.ts`:

```ts
it("shows the cadence and whether this seat must answer it", async () => {
  // A room whose default_role reports, with a 5m cadence.
  await withAuthoredRoom({ heartbeat_on: "5m", reports: true }, async ({ preview }) => {
    expect(preview).toMatchObject({ heartbeat_on_seconds: 300, you_report: true });
  });
});

it("says so when the room expects no reports", async () => {
  await withRoom(async ({ preview }) => {
    expect(preview).toMatchObject({ heartbeat_on_seconds: null, you_report: false });
  });
});
```

Build the authored room the way the sibling cases in that file build theirs; the assertion is on `bellman_connect`'s result body.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/tools/connect.test.ts`
Expected: FAIL — neither key is in the preview.

- [ ] **Step 3: Add both to `roomPreview`**

In `src/server.ts`, inside `roomPreview`'s returned object:

```ts
    /**
     * The obligation, shown before a joiner's human accepts the seat. This is
     * the consent point: a member that will be named silent in a tick has to be
     * able to see that before joining, the same reason `your_verbs` is here.
     *
     * Through mustReport, which is what the tick itself calls, so what a joiner
     * is SHOWN and what is ASKED are one computation and cannot drift apart.
     */
    heartbeat_on_seconds: m.heartbeatOnMs === null ? null : Math.round(m.heartbeatOnMs / 1000),
    you_report: mustReport(m, viewerRole),
```

Add `mustReport` to the import from `./roles.js`.

- [ ] **Step 4: Run the test**

Run: `npx vitest run tests/tools/connect.test.ts`
Expected: PASS

- [ ] **Step 5: Verify and commit**

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

```bash
git add src/server.ts tests/tools/connect.test.ts
git commit -m "Show a joiner the cadence and whether its seat must answer

The consent point. A member that will be named silent in a tick has to see
that before taking the seat, for the same reason your_verbs is in the preview.

Through mustReport, which is what the tick calls, so what a joiner is shown
and what is asked of it are one computation."
```

---

### Task 8: Architecture doc and the token measurement

**Files:**
- Modify: `docs/ARCHITECTURE.md` (§5, §9, §10, §11)
- Test: whatever script `docs/ARCHITECTURE.md` §11's numbers came from

**Interfaces:**
- Consumes: everything above. Runs last because §11 measures the finished tool definitions.

- [ ] **Step 1: Re-measure the tool definitions**

§11 records ~4,820 tokens for all tool definitions and 1,462 for `bellman_start`, tokenized with cl100k. Re-run that measurement against this branch. If no script is committed, serialize the `tools/list` result and count with the same tokenizer, then record the method beside the number so the next person can repeat it.

Record both the new totals and the delta.

- [ ] **Step 2: Update §11**

Replace the tool-definition row's number with the measured one, and add:

```
#111 added `heartbeat_on` and `reports` to the manifest schema inside
`bellman_start`, and `progress` to `bellman_send`. It added nothing to
`bellman_sync`: the ask travels in the tick's payload, paid by rooms that use
the feature, rather than in a tool description paid by every request.
```

- [ ] **Step 3: Update §5**

The paragraph beginning "It is a field and not a `heartbeat` event on purpose" now contradicts a shipped `heartbeat` event. Replace it with the distinction as built: liveness is a field because it carries nothing and arrives on a timer; a `heartbeat` event is the server's tick on the room's declared cadence, carrying a snapshot of who has reported, and members answer with `progress`. Say that `lastSeenAt` and `lastReportAt` are separate on purpose — any call moves the first, only a deliberate report moves the second — because a member can be present and silent, which is the state the feature exists to surface.

- [ ] **Step 4: Update §9**

Add the tick to the named-alarm material: `SessionDO` now has three handlers, `outbox`, `ttl` and `heartbeat`, and the third is **derived** rather than stored. Record why that is the safer half of the rollback rule the section already states — a stored `due:` row an older build never consumes spins the alarm, and a derived due time a build does not know is never computed.

- [ ] **Step 5: Update §10**

Invariant 7 reads "not in a field, and not in an event payload". Add the sentence that keeps a heartbeat payload from looking like a counterexample: a tick's snapshot carries measurements taken at the event's own `at`, which stay true on replay, and never a claim about now — no `present`, `status`, `alive` or `healthy` key. Presence itself is still derived and still lives in `presence.ts`.

- [ ] **Step 6: Update the front matter**

Set `last-verified-against-source` to this branch's HEAD short SHA, `last-updated` to today, and add the heartbeat spec to `siblings`.

- [ ] **Step 7: Verify and commit**

Run: `npm run verify && npm run typecheck:worker`
Expected: PASS

```bash
git add docs/ARCHITECTURE.md
git commit -m "Record the tick in the architecture

§5 said liveness is a field and not a heartbeat event, which now reads as a
contradiction: both exist and they are different things. lastSeenAt moves on
any call, lastReportAt only on a deliberate report, because a member can be
present and silent and that is the state the feature surfaces.

§9 gains the third named alarm and why it is derived rather than stored. §10
says why a tick's snapshot is not a counterexample to invariant 7. §11 carries
the re-measured tool definitions."
```

---

## Self-Review

**Spec coverage.** D1 → Task 5. D2 → Task 2. D3 → Task 2 Step 7. D4 → Task 3 (`snapshotOf`) and Task 5. D5 → Task 5. D6 → Tasks 1 and 6. D7 → Task 4. D8 → Task 4 Step 4. D9 → Task 1. D10 → Task 3, **refined**: the spec computes the due time from member reports, which spins the alarm, so the clock anchors on `lastTickAt` and the alarm wakes on the cadence while the event is written only when a member is due. The volume argument D10 makes is about log rows and is preserved; the extra wake is the part D5 established is nearly free. D11 → nothing to build. D12 → Task 8. D13 → Task 1 Step 10 and Task 8 Step 3.

**Placeholders.** None. Every code step carries the code; the three places that defer to an existing fixture style (Task 4 Step 1, Task 6 Step 6, Task 7 Step 1) name the sibling file to match and keep the assertions fixed.

**Type consistency.** `lastReport` (not `lastReportOf`) throughout; `mustReport(manifest, role)` in Tasks 2, 3 and 7; `nextTickAt(s, now)`, `dueMembers(s, now)`, `snapshotOf(s, now)` in Tasks 3 and 5; `HEARTBEAT_HANDLER` is the `"heartbeat"` handler name and `"heartbeat"` is also the `EventType` — same string, two uses, deliberate. `heartbeatOnMs` on the manifest, `heartbeat_on` on the wire, `heartbeat_on_seconds` in the preview, `cadence_seconds` in the payload.

**Review Focus coverage.** 1 → Task 5 Steps 1 and 8, with a positive control. 2 → Task 3 Steps 1 and 6 and Task 5 Step 9, both with positive controls. 3 → Task 3 Step 1 (`lastReport`) and Task 4 Step 8 (store contract). 4 → Task 6 Steps 6 and 7, with a positive control. 5 → Task 2 Step 1.
