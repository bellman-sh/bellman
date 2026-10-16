# Enforcing read_context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan runs with subagents and **one whole-branch review at the end**: no per-task review steps, whatever a skill says.

**Goal:** A member's brief reaches peers only when the member grants `read_context`, on every path that hands out events or briefs, briefs logged before this ships included.

**Architecture:** One runtime-free rule beside `publicEvent` (`readableEvent` in `src/public-event.ts`) decides at delivery, from the author's member row as it stands. Paths that know their reader pass the reader's user id (`bellman_sync`, `bellman_rooms` and the dash's Log route, through `eventsFor` in `src/rooms.ts`); the room socket's frames are shared and pass none. `bellman_confirm` and `bellman_connect` gate their direct brief reads with `seesBrief`. No stored shape changes and no store method is added.

**Tech Stack:** TypeScript, Cloudflare Workers and Durable Objects, the MCP SDK, vitest (root program) and `@cloudflare/vitest-pool-workers` (`worker-tests/`), and the MCP Apps page in `ui/`, built with Vite.

**Spec:** `docs/superpowers/specs/2026-10-16-read-context-design.md`

## Global Constraints

- The rule (spec §1): a `brief_update` whose author doesn't grant `read_context` is dropped, unless the reader is the author. A `member_joined` still goes out, but its `brief` is null unless the joiner grants `read_context` or the reader is the joiner. Every other event is unchanged.
- The reader is a user id, or none (`null`) for a shared path (D3, D5). The author's current grant decides: the grant on the member row of the handle that wrote the event, as it stands at delivery. A member who left keeps their last grant (D2).
- A reader's cursor still moves past a dropped event. The public page already hides every brief, and stays as it is (`publicReadEvent`).
- The tool text gains exactly one sentence, on the capabilities line of `bellman_start` and of `bellman_confirm`: `read_context lets peers read your brief; it is on by default, and without it only you see your brief.` No other tool text changes.
- No tool is added, so `extension/manifest.json` does not change. No store method is added; every `BellmanStore` method stays async.
- `src/ui/assets.ts` is generated: edit `ui/`, never that file. `plugin/bridge/*.mjs` are rebuilt only by release PRs, and this is not one.
- A non-ASCII character in TypeScript source or tests is written as a braced escape such as `\u{2019}`. None of the code below needs one.
- A room holds many members: never write "two sessions" or "the other session". Never write "load-bearing", any "worth …" phrase, or "structural".
- Edit with the Edit or Write tool, never `perl -i` or `sed -i`. Never call a `graph_*`, dual-graph or `bellman_*` tool. Never bypass commit signing.

## Review Focus

1. **A hosted room's joiner.** Expect the hosted seat's brief among `bellman_confirm`'s `briefs`, because a new seat grants `read_context` (R4). A seat started before this ships keeps its old row, and its brief stops reaching joiners. Pinned in Task 3.
2. **An org admin reading a closed room's Log** (#65). Expect a reader like any other: no private brief. Pinned in Task 4.
3. **A socket reconnecting from a cursor before a dropped update.** Expect no frame for it, and the socket's attachment at the last event read, so the next frame does not resend it. Pinned in Task 5.
4. **One account with two handles, one granting and one not.** Expect each handle's own row to decide the events it wrote. Pinned in Task 1.
5. **A creator who has left, previewed.** Expect their last grant to decide, read from their row and not from the room's record, which holds only the members in it now (ADR 0019). Pinned in Task 3.

## Rulings

Where the spec was silent or the code disagreed with it. Each is a decision this plan carries out.

- **R1. "Their own sync" is another handle of the author's account.** `bellman_sync` leaves out the caller's own events by member id, as it always has, so the handle that wrote an update never reads it back there. Task 2's test seats the author twice. A one-handle author reads it back in the dash's Log, which includes the caller's own events (D4).
- **R2. The room socket reads as no one, on both of its arms.** The Worker's `/ws` route admits one identity's handles, but `SessionDO.#wake` builds one frame and sends it to every socket in the room (spec §2, D5). The replay `SessionDO.fetch` sends on connect follows the same rule, so a reconnect is shown what a live socket was. The author's own socket does not carry their private brief; their sync on another handle does.
- **R3. The hosted seat's transcript reads no brief, so the plan adds no rule call there.** `decide` keeps message and progress replies to the open question, and `answerPrompt` holds only those, so no brief reaches the model, granted or not. Task 6 pins it. The check its test is seen to fail without is `decide`'s type filter.
- **R4. A new hosted seat grants `read_context`, the owner's choice.** `hostMember` granted `receive_messages` only, so D2 would have hidden the seat's brief from every joiner. It now grants `read_context` beside `receive_messages`, and joiners keep reading the seat's brief (Task 3, Steps 5 to 8). Seats already running keep their old row: `hostMember`'s one caller is `bellman_start`, and nothing rewrites a stored member, so in a hosted room started before this ships the seat's brief stops reaching joiners.
- **R5. `bellman_rooms` is a delivery path.** The predicate finds it (`recentEvents`): its `last_event` names a private update's type and time. It reads as the caller's account.
- **R6. D3 holds for the direct reads too.** `bellman_confirm` hands a joiner the briefs of their own account's other handles, and a creator previewing their own room reads their own brief.
- **R7. `bellman_confirm` leaves out private briefs before it takes the 25 most recently heard,** so a private brief does not take one of the 25 places. `briefs_omitted` counts it, as it counts any brief not handed; the roster already shows each member's capabilities, so the count tells a joiner nothing new.
- **R8. A private creator brief arrives as `creator_brief` with `data: null`,** the shape a creator with no brief row already gets. `bellman_connect`'s description does not change: the spec names only the capabilities lines of `bellman_start` and `bellman_confirm`.
- **R9. One path in this repo shows a brief and breaks on null:** the MCP App's join screen, `renderJoin` in `ui/src/join.ts`, reads `creator_brief.data.goal` and throws. Task 3 makes it say `The creator keeps their brief private.` The bridge shows a `member_joined`'s or a `brief_update`'s payload in the channel, and the dash's Log shows the same in its Details, but both read the paths this plan filters (sync, the socket's frames, the Log route), and the dash's `summarize` and `fieldsOf` already take a null brief. Neither changes.
- **R10. A `member_joined` loses only `payload.brief`.** `payload.member` keeps its `agent` and `capabilities`, which the roster already shows. That block has never held the brief, back to the first commit (`7496bf6`).
- **R11. An author whose row is not handed to the rule reads as not granting,** except to the author's own account (D5). `SessionDO.#wake` takes the rows its append read; its other callers (removals, ticks, housekeeping, the host's writes) pass none, and none of their events carries a brief.
- **R12. The socket's replay lists every member row before its events read,** because `events()` must stay the last await before the attach (`tests/store-do-wiring.test.ts`, "reads, then attaches, accepts and sends, without yielding in between") and the authors are not known before the events are. That is one list of `mb:` rows per upgrade, the cost `departedMembers` already pays. A `ponytail:` comment names it.
- **R13. No store method is added.** `getMembers`, `getMember` and `updateMember` already answer for a member who left and for a changed grant in both stores, with contract cases in `tests/helpers/store-contract.ts` ("reads a member who has left by id…", "reads members by id in join order…", "updateMember patches brief, capabilities and leftAt").
- **R14. The guard lists three predicates, not one:** the callers of `publicEvent`, of the store's event reads, and of `getBriefs`, each with what it serves. The spec names the first. The hosted seat and `bellman_rooms` call no `publicEvent`, and a guard on that name alone would not see a path like them.
- **R15. The sentence** is the one in Global Constraints, after the defaults' parenthesis on both lines. On `bellman_start` the existing `Grant request_actions only…` sentence follows it.
- **R16. The ADR is numbered at merge:** one more than the highest number in `docs/adr/`, which is 0023 once the abuse work's 0022 is in. Write it as `docs/adr/00NN-read-context.md` and name it at merge, as the quotes plan does (its R17).
- **R17. The docs site.** `docs-site/` sits on a branch of this repo that renders tool text into pages (`npm run docs:gen`, held to it by `tests/docs-reference.test.ts`). If that branch is on trunk when this runs, Task 7 regenerates the pages and fixes its trust page; if not, that branch does both when it lands (spec, Docs).
- **R18. bellman.sh/trust lives in bellman-sh/site,** outside this plan's one part. The copy for it is in "After this plan".
- **R19. Quotes owe a check.** The quotes plan lets a member quote a `brief_update` (its R4) and copies the quoted characters onto the quoting event. Landing after this, a quote of a private update would carry the brief to every peer. "After this plan" says what it needs.

## The delivery paths, by predicate

Every caller of `publicEvent`, of the store's event reads, and of `getBriefs`, on a line of code (a JSDoc line starts with `*`; several modules name `publicEvent(e)` in prose):

```bash
grep -rn --include='*.ts' -E '\bpublicEvent\(' src | grep -v '^src/ui/assets.ts' | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)'
grep -rn --include='*.ts' -E '\.(eventsAfter|waitForEvents|recentEvents)\(' src | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)'
grep -rn --include='*.ts' -E '\.getBriefs\(' src | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)'
```

At this plan's base (main `1aad606`) they find:

| Module, call | What it hands out | Reader | Here | Task |
|---|---|---|---|---|
| `src/tools/sync.ts`, `waitForEvents` / `eventsAfter` / `publicEvent` | `bellman_sync`'s `events` | the caller's account | `eventsFor` | 2 |
| `src/tools/sync.ts`, `eventsAfter(…, 0)` | `outstanding`: action requests' cursors and labels | none | unchanged: no brief | — |
| `src/tools/rooms.ts`, `recentEvents` | `bellman_rooms`' `last_event` | the caller's account | `eventsFor` | 2 |
| `src/tools/send.ts`, `eventsAfter` | an earlier answer's label, in a refusal | none | unchanged: no event | — |
| `src/http/rooms.ts` `readEventsRoute`, `eventsAfter` / `recentEvents` / `publicEvent` | the dash's Log | the caller's account, an org admin's included | `eventsFor` | 4 |
| `src/http/public.ts`, `recentEvents` / `eventsAfter` | the public page | anyone | unchanged: `publicReadEvent` drops every brief | — |
| `src/public-event.ts` `publicReadEvent`, `publicEvent` | the public page's shape | anyone | unchanged | — |
| `src/store-do.ts` `SessionDO.fetch`, `publicEvent` | the room socket's replay on connect | none | `readableEvents` over every member row | 5 |
| `src/store-do.ts` `SessionDO.#wake`, `publicEvent` | the pushes: each append's frame to every open socket | none | `readableEvent` with the append's rows | 5 |
| `src/store-do.ts` `DurableObjectStore`, `this.session(id).eventsAfter` and the rest | the facade, not a reader | — | — | — |
| `src/host-do.ts`, `src/host-memory.ts` (`HostDriver.read`), `eventsAfter` | the hosted seat's transcript, through `decide` and `answerPrompt` | the model | unchanged: message and progress replies only (R3) | 6 |
| `src/tools/confirm.ts`, `getBriefs` | the briefs a joiner is handed | the joiner's account | `seesBrief` | 3 |
| `src/tools/connect.ts`, `getBriefs` | the creator's brief in a preview | the previewer's account | `seesBrief` on the creator's row | 3 |
| `src/store-do.ts` `DurableObjectStore`, `getBriefs` | the facade | — | — | — |

Beside them: `src/room-socket.ts` is the bridge's half of the room socket. It parses frames and makes none, and names `publicEvent` only in comments, so the bridge changes nothing (R9). A long poll's waiter, in `SessionDO.#wake` and in `MemoryStore`, resolves with stored events that `bellman_sync` filters. `ui/src/join.ts` renders `bellman_connect`'s `creator_brief` (R9, Task 3). Task 6's guard holds these three lists from now on.

## File map

| File | Task | Change |
|---|---|---|
| `src/public-event.ts` | 1 | `seesBrief`, `briefAuthors`, `readableEvent`, `readableEvents` |
| `src/rooms.ts` | 2 | `eventsFor` |
| `src/tools/sync.ts`, `src/tools/rooms.ts` | 2 | events through `eventsFor` |
| `src/tools/confirm.ts`, `src/tools/connect.ts`, `src/tools/start.ts` | 3 | briefs through `seesBrief`; the sentence |
| `ui/src/types.ts`, `ui/src/join.ts` | 3 | a null creator brief |
| `src/host.ts` | 3 | `hostMember` grants `read_context` (R4) |
| `src/http/rooms.ts` | 4 | `readEventsRoute` through `eventsFor` |
| `src/store-do.ts` | 5 | `SessionDO.fetch`, `#wake`, `appendEvent`, `appendEventOnce` |
| `docs/adr/00NN-read-context.md`, `README.md`, `docs/ARCHITECTURE.md` | 7 | docs |

Tests: `tests/public-event.test.ts` (1), `tests/tools/read-context.test.ts` (2, 3, new), `ui/test/render.test.ts` (3), `tests/http-rooms.test.ts` (4), `tests/store-do-wiring.test.ts` and `worker-tests/ws-delivery.test.ts` (5), `tests/delivery-paths.test.ts` (6, new) and `tests/host.test.ts` (6).

---

## The server

**Workspace:** `/Users/mcfearsome/.worktrees/bellman-read-context`, a jj workspace whose working copy sits on this plan's change, on the spec's (bookmark `mcfearsome/read-context`). Git commands fail there; that is expected. Each task ends with `jj commit -m "…"`. Commits are signed: if one hangs or says "incorrect passphrase supplied", stop and tell the lead. Move the bookmark to the last change before opening the PR.

**Ordering:** this lands after the abuse-protections server work, whose bans and send limit edit `src/tools/connect.ts` and `src/tools/confirm.ts`, and before quotes, which adds `quotes` to `publicEvent` (spec, Rollout). Nothing here calls the abuse work's symbols or needs quotes.

**Commands:** `npx vitest run <file> -t "<name>"` for the root program. For workerd, install its tree once with `npm --prefix worker-tests install --legacy-peer-deps --no-audit --no-fund --silent`, then `npm run build:ui && npm --prefix worker-tests run test -- <file> -t "<name>"`. `npm run verify` ends the branch.

- [ ] **Setup 1: Rebase onto trunk.** `jj -R ~/src/github.com/bellman-sh/bellman git fetch`, then in the workspace `jj rebase -b @ -d 'trunk()'`.

- [ ] **Setup 2: Check the abuse work is in.** `grep -n 'isBannedByCreator\|via: "permanent"\|pending.via' src/tools/connect.ts src/tools/confirm.ts`. Expected: both files call `isBannedByCreator` (its Task 3, beside `BANNED` from `src/bans.ts`), `bellman_connect` puts `via: "permanent"` on the pending connect, and `bellman_confirm` copies `pending.via` onto the arriving member (its Task 7). If any is missing, stop and tell the lead which: the spec orders this after that work so the two branches' edits to these files do not meet in a merge, and changing the order is the owner's call. The edits below anchor on `creatorBrief`, the `shownBriefs` read and the capabilities lines, which that work leaves alone.

- [ ] **Setup 3: Install and verify.** `npm ci && npm run verify`. Expected: green.

- [ ] **Setup 4: Measure the tool listing before** (ARCHITECTURE §11's method). Save the two scripts under `node_modules/.cache/bellman-measure/`, which is gitignored, so jj never records them and bare imports resolve:

```ts
// list-tools.mts: the server's tools/list entries, one compact JSON object a line.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
const root = process.argv[2];
const { buildServer } = await import(`${root}/src/server.ts`);
const { MemoryStore } = await import(`${root}/src/store.ts`);
const { MemoryBlobStore } = await import(`${root}/src/blobs.ts`);
const { resolveIdentity } = await import(`${root}/src/auth.ts`);
const server = buildServer(resolveIdentity("Bearer qk_dev_jesse"), new MemoryStore(), new MemoryBlobStore(), { hostedSeat: true });
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "measure", version: "0" });
await Promise.all([server.connect(b), client.connect(a)]);
for (const t of (await client.listTools()).tools) console.log(JSON.stringify(t));
await client.close();
```

```python
# count-tools.py: cl100k over each entry's compact JSON, summed.
import json, sys, tiktoken
enc = tiktoken.get_encoding("cl100k_base")
total = 0
for line in sys.stdin:
    entry = json.loads(line)
    n = len(enc.encode(json.dumps(entry, separators=(",", ":"))))
    total += n
    print(f"{entry['name']}\t{n}")
print(f"total\t{total}")
```

Run `npm run build:ui && npx tsx node_modules/.cache/bellman-measure/list-tools.mts "$PWD" | python3 -I node_modules/.cache/bellman-measure/count-tools.py` and keep the output for Task 7. At this plan's base (main `1aad606`) it read `bellman_start 2469`, `bellman_confirm 804`, `total 8697`; the abuse work changes the total, so use what this run prints.

### Task 1: The rule

**Files:**
- Modify: `src/public-event.ts`
- Test: `tests/public-event.test.ts`

**Interfaces:**
- Produces, in `src/public-event.ts`:
  ```ts
  /** Whether `reader` may read this member's brief (D2, D3, D5): the member grants read_context, or the reader is the member's own account. A null reader reads a granted brief only. */
  export function seesBrief(author: Pick<Member, "userId" | "capabilities">, reader: string | null): boolean;
  /** The members whose rows `readableEvents` needs: the author of each brief_update and member_joined, once each, in first-seen order. */
  export function briefAuthors(events: readonly SessionEvent[]): string[];
  /** The event as `reader` may see it (spec section 1), from the row of the handle that wrote it (D2); a missing row reads as not granting (R11). Never changes `e`. */
  export function readableEvent(e: SessionEvent, author: Pick<Member, "capabilities"> | undefined, reader: string | null): SessionEvent | null;
  /** `readableEvent` over a list, each author looked up by `fromMemberId`; a dropped event is left out and the order kept. */
  export function readableEvents(events: readonly SessionEvent[], members: readonly Pick<Member, "memberId" | "capabilities">[], reader: string | null): SessionEvent[];
  ```

- [ ] **Step 1: Write the failing tests.** In `tests/public-event.test.ts`, import the four beside `publicEvent`, `Member` beside `SessionEvent`, and `brief`:

```ts
import { briefAuthors, publicEvent, readableEvent, readableEvents, seesBrief } from "../src/public-event.js";
import type { Member, SessionEvent } from "../src/types.js";
import { brief } from "./helpers/fixtures.js";
```

Append:

```ts
/**
 * The rule (read_context spec, section 1): one function over the stored event, the author's row
 * and the reader, a user id or null for a path every member shares.
 */
describe("readableEvent", () => {
  const AUTHOR = "u_quiet";
  const READER = { author: AUTHOR, peer: "u_peer", none: null } as const;
  const GRANT: Record<"on" | "off", Pick<Member, "capabilities">> = {
    on: { capabilities: ["read_context", "receive_messages"] },
    off: { capabilities: ["receive_messages"] },
  };
  const kept = brief({ goal: "kept to myself" });
  const by = { fromMemberId: "m_quiet", fromUserId: AUTHOR, fromLabel: "quiet@codenerd" };
  const update = stored({ ...by, type: "brief_update", payload: kept });
  const joined = stored({ ...by, type: "member_joined", payload: { member: { member_id: "m_quiet", label: "quiet@codenerd" }, brief: kept } });
  const message = stored({ ...by, payload: { text: "hi" } });
  const withoutBrief = { ...joined, payload: { member: { member_id: "m_quiet", label: "quiet@codenerd" }, brief: null } };

  it.each([
    ["a brief_update", "on", "peer", update, update],
    ["a brief_update", "on", "none", update, update],
    ["a brief_update", "on", "author", update, update],
    ["a brief_update", "off", "peer", update, null],
    ["a brief_update", "off", "none", update, null],
    ["a brief_update", "off", "author", update, update],
    ["a member_joined", "on", "peer", joined, joined],
    ["a member_joined", "on", "none", joined, joined],
    ["a member_joined", "on", "author", joined, joined],
    ["a member_joined", "off", "peer", joined, withoutBrief],
    ["a member_joined", "off", "none", joined, withoutBrief],
    ["a member_joined", "off", "author", joined, joined],
    ["a message", "on", "peer", message, message],
    ["a message", "off", "peer", message, message],
    ["a message", "off", "none", message, message],
    ["a message", "off", "author", message, message],
  ] as const)("shows %s, with the grant %s, to a reader who is the %s", (_what, grant, reader, e, expected) => {
    expect(readableEvent(e, GRANT[grant], READER[reader])).toEqual(expected);
  });

  it("reads an author with no row as one who does not grant read_context, except for the author", () => {
    expect(readableEvent(update, undefined, "u_peer")).toBeNull();
    expect(readableEvent(update, undefined, null)).toBeNull();
    expect(readableEvent(update, undefined, AUTHOR)).toEqual(update);
  });

  it("changes nothing in the event it is handed", () => {
    const before = structuredClone(joined);
    readableEvent(joined, GRANT.off, "u_peer");
    expect(joined).toEqual(before);
  });

  /** Review Focus 4: a grant is a handle's, so one account's two handles can differ. */
  it("over a list, looks each author up by member id, keeps the order and leaves out what it drops", () => {
    const open = stored({ type: "brief_update", fromMemberId: "m_open", fromUserId: AUTHOR, payload: brief(), cursor: 8 });
    const rows = [{ memberId: "m_quiet", ...GRANT.off }, { memberId: "m_open", ...GRANT.on }];
    expect(readableEvents([update, open, message], rows, "u_peer")).toEqual([open, message]);
    expect(readableEvents([update, open, message], rows, AUTHOR)).toEqual([update, open, message]);
  });

  it("names the authors whose rows it needs: those of a brief_update or a member_joined, once each", () => {
    expect(briefAuthors([update, joined, message, stored({ type: "brief_update", fromMemberId: "m_loud" })])).toEqual(["m_quiet", "m_loud"]);
    expect(briefAuthors([message])).toEqual([]);
  });

  it("lets a reader see a brief its author grants, or one of its own account (D3)", () => {
    expect(seesBrief({ userId: AUTHOR, ...GRANT.on }, "u_peer")).toBe(true);
    expect(seesBrief({ userId: AUTHOR, ...GRANT.off }, "u_peer")).toBe(false);
    expect(seesBrief({ userId: AUTHOR, ...GRANT.off }, null)).toBe(false);
    expect(seesBrief({ userId: AUTHOR, ...GRANT.off }, AUTHOR)).toBe(true);
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/public-event.test.ts -t "readableEvent"`. Expected: `21 failed`, with `TypeError: readableEvent is not a function` (and the same for `readableEvents`, `briefAuthors` and `seesBrief`).

- [ ] **Step 3: Implement** the four to the Interfaces. `readableEvent` matches the reader against `e.fromUserId` through `seesBrief({ userId: e.fromUserId, capabilities: author?.capabilities ?? [] }, reader)`, and a hidden join is a new object, `{ ...e, payload: { ...payload, brief: null } }`. The module stays runtime-free: `Member` is a type import (`tests/projections.test.ts` checks the module pulls in no runtime).

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/public-event.test.ts tests/projections.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "One rule says how an event reads to a reader: a brief its author keeps reaches no one but their own account"`

### Task 2: The event paths a tool serves

**Files:**
- Modify: `src/rooms.ts`, `src/tools/sync.ts`, `src/tools/rooms.ts`
- Test: `tests/tools/read-context.test.ts` (new)

**Interfaces:**
- Consumes: `briefAuthors`, `readableEvents` (Task 1).
- Produces, in `src/rooms.ts`, beside `readSurface`:
  ```ts
  /** These events as `reader` may see them (spec section 1), the rows of their briefs' authors read by id, gone from the room or not (D2): one `getMembers` call, and none when no event carries a brief. */
  export async function eventsFor(s: BellmanStore, sessionId: string, events: readonly SessionEvent[], reader: string | null): Promise<SessionEvent[]>;
  ```

- [ ] **Step 1: Write the failing tests.** Create `tests/tools/read-context.test.ts`:

```ts
/**
 * read_context, enforced (read_context spec): a member's brief reaches a peer only when the
 * member grants it. Each case seats a member who joined without the grant, through the tools.
 * The account the peer key names keeps its brief; jesse, who starts the room, and the outsider
 * grant theirs unless a case says otherwise.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brief, manifestFixture } from "../helpers/fixtures.js";
import { DEV_KEY, Harness, envelopes, type Outcome, type Peer } from "../helpers/harness.js";
import type { Capability } from "../../src/types.js";

let h: Harness;
beforeEach(() => {
  h = new Harness();
});
afterEach(async () => {
  await h.close();
});

const KEEPS: Capability[] = ["receive_messages"];
const GRANTS: Capability[] = ["read_context", "receive_messages"];

interface Shown { cursor: number; type: string; from: { member_id: string }; payload: Record<string, unknown> }
const shown = (read: Outcome): Shown[] => envelopes(read.data.events).map((e) => e.data as Shown);

/** A swarm room jesse starts, and a way to seat anyone through its code. */
async function room(opts: { creatorCapabilities?: Capability[] } = {}) {
  const creator = await h.connect(DEV_KEY.jesse);
  const started = await creator.call("bellman_start", {
    manifest: manifestFixture({ preset: "swarm" }),
    brief: brief({ goal: "the creator's" }),
    ...(opts.creatorCapabilities ? { capabilities: opts.creatorCapabilities } : {}),
  });
  expect(started.isError, started.text).toBe(false);
  const sessionId = String(started.data.session_id);
  const code = String(started.data.join_code);
  const join = async (key: string, capabilities: Capability[], goal = "kept to myself") => {
    const peer = await h.connect(key);
    const preview = await peer.call("bellman_connect", { join_code: code });
    expect(preview.isError, preview.text).toBe(false);
    const confirmed = await peer.call("bellman_confirm", {
      connect_token: String(preview.data.connect_token), brief: brief({ goal }), capabilities,
    });
    expect(confirmed.isError, confirmed.text).toBe(false);
    return { peer, memberId: String(confirmed.data.member_id), confirmed };
  };
  const sync = (peer: Peer, memberId: string) =>
    peer.call("bellman_sync", { session_id: sessionId, member_id: memberId, since_cursor: 0 });
  return { creator, creatorMemberId: String(started.data.member_id), sessionId, code, join, sync };
}

describe("the event paths a tool serves (read_context spec, section 3)", () => {
  it("shows peers a member who keeps their brief joining, without the brief", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, KEEPS);
    const read = await r.sync(r.creator, r.creatorMemberId);
    const joins = shown(read).filter((e) => e.type === "member_joined");
    expect(joins.map((e) => e.from.member_id)).toEqual([quiet.memberId]);
    expect(joins[0].payload).toMatchObject({ member: { member_id: quiet.memberId }, brief: null });
    expect(read.text).not.toContain("kept to myself");
  });

  /** The sync path. The writing handle's own sync leaves out its own events, as every sync does (R1). */
  it("sends their brief_update to no peer, and to their own account's other handle", async () => {
    const r = await room();
    const laptop = await r.join(DEV_KEY.peer, KEEPS);
    const desktop = await r.join(DEV_KEY.peer, KEEPS);
    const other = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    const sent = await laptop.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: laptop.memberId, type: "brief_update", payload: brief({ goal: "still to myself" }),
    });
    expect(sent.isError, sent.text).toBe(false);

    for (const [peer, memberId] of [[r.creator, r.creatorMemberId], [other.peer, other.memberId]] as const) {
      const read = await r.sync(peer, memberId);
      expect(shown(read).map((e) => e.type)).not.toContain("brief_update");
      expect(read.text).not.toContain("still to myself");
      expect(read.data.cursor, "the cursor moves past it").toBe(sent.data.cursor);
    }
    const mine = shown(await r.sync(desktop.peer, desktop.memberId)).find((e) => e.type === "brief_update");
    expect(mine?.payload).toMatchObject({ goal: "still to myself" });
  });

  it("follows a grant changed in the store after the brief was sent, both ways (D1, D2)", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, GRANTS);
    await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    await quiet.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: quiet.memberId, type: "brief_update", payload: brief({ goal: "shared, then not" }),
    });
    const theirs = async () => shown(await r.sync(r.creator, r.creatorMemberId)).filter((e) => e.from.member_id === quiet.memberId);
    expect((await theirs()).map((e) => e.type)).toEqual(["member_joined", "brief_update"]);

    await h.store.updateMember(r.sessionId, quiet.memberId, { capabilities: KEEPS });
    expect((await theirs()).map((e) => e.type)).toEqual(["member_joined"]);
    expect((await theirs())[0].payload.brief).toBeNull();

    await h.store.updateMember(r.sessionId, quiet.memberId, { capabilities: GRANTS });
    expect((await theirs()).map((e) => e.type)).toEqual(["member_joined", "brief_update"]);
  });

  it("keeps a member's last grant after they leave (D2)", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, KEEPS);
    const open = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    for (const m of [quiet, open]) {
      const left = await m.peer.call("bellman_leave", { session_id: r.sessionId, member_id: m.memberId });
      expect(left.isError, left.text).toBe(false);
    }
    const joins = shown(await r.sync(r.creator, r.creatorMemberId)).filter((e) => e.type === "member_joined");
    expect(joins.map((e) => [e.from.member_id, (e.payload.brief as { goal?: string } | null)?.goal ?? null])).toEqual([
      [quiet.memberId, null],
      [open.memberId, "the outsider's"],
    ]);
  });

  it("does not make a private brief_update a peer's last_event in bellman_rooms, and makes it their own account's", async () => {
    const r = await room();
    const laptop = await r.join(DEV_KEY.peer, KEEPS);
    const desktop = await r.join(DEV_KEY.peer, KEEPS);
    await laptop.peer.call("bellman_send", {
      session_id: r.sessionId, member_id: laptop.memberId, type: "brief_update", payload: brief({ goal: "still to myself" }),
    });
    const lastFor = async (peer: Peer) => {
      const listed = await peer.call("bellman_rooms", {});
      expect(listed.isError, listed.text).toBe(false);
      return (listed.data.rooms as { session_id: string; last_event: { type: string } | null }[])
        .find((x) => x.session_id === r.sessionId)?.last_event?.type;
    };
    expect(await lastFor(r.creator)).toBe("member_joined");
    expect(await lastFor(desktop.peer)).toBe("brief_update");
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/tools/read-context.test.ts`. Expected: `5 failed`, one line each:
  - `expected { member: { …(7) }, brief: { …(5) } } to match object { …(2) }`
  - `expected [ 'member_joined', …(3) ] to not include 'brief_update'`
  - `expected [ 'member_joined', 'brief_update' ] to deeply equal [ 'member_joined' ]`
  - `expected [ …(2) ] to deeply equal [ [ 'm_…', null ], …(1) ]`
  - `expected 'brief_update' to be 'member_joined'`

- [ ] **Step 3: Implement.**
  - `eventsFor` in `src/rooms.ts`, to the Interfaces. Reading by id (`getMembers`) is what keeps a departed author's grant: the record holds only the members in the room now (ADR 0019).
  - `bellman_sync`: `foreign` becomes `await eventsFor(s, session_id, <the same filter of all>, identity.userId)`. The cursor, the removal cap, `outstanding` and the surface keep reading the unfiltered `read` and `all`, so the cursor moves past a dropped event; the preamble follows the filtered `foreign`.
  - `bellman_rooms`: hand `roomSummary` the tail through `eventsFor(s, id, tail, identity.userId)`.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/tools/read-context.test.ts tests/public-event.test.ts tests/tools/sync-status.test.ts tests/tools/rooms.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "bellman_sync and bellman_rooms show a peer no brief its author keeps, as the author's grant stands now"`

### Task 3: The briefs read directly, and the words

**Files:**
- Modify: `src/tools/confirm.ts`, `src/tools/connect.ts`, `src/tools/start.ts`, `ui/src/types.ts`, `ui/src/join.ts` (`renderJoin`), `src/host.ts` (`hostMember`)
- Test: `tests/tools/read-context.test.ts`, `ui/test/render.test.ts`

**Interfaces:**
- Consumes: `seesBrief` (Task 1); `room`, `KEEPS` and `GRANTS` in the test file (Task 2).
- Produces: `ConnectResult.creator_brief: Untrusted<Brief | null>` in `ui/src/types.ts`, documented as null when the creator does not grant read_context. `hostMember(manifest, now).capabilities` is `["read_context", "receive_messages"]` (R4).

- [ ] **Step 1: Write the failing tests.** In `tests/tools/read-context.test.ts`, append:

```ts
describe("the briefs read directly (read_context spec, section 1)", () => {
  it("leaves a member's brief out of what bellman_confirm hands a later joiner, who is told one was left out", async () => {
    const r = await room();
    const quiet = await r.join(DEV_KEY.peer, KEEPS);
    const later = await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    expect(envelopes(later.confirmed.data.briefs).map((b) => b.origin.memberId)).toEqual([r.creatorMemberId]);
    expect(later.confirmed.data.briefs_omitted).toBe(1);
    expect(later.confirmed.text).not.toContain("kept to myself");

    // Their own account's next handle is handed it (D3, R6).
    const again = await r.join(DEV_KEY.peer, KEEPS);
    expect(envelopes(again.confirmed.data.briefs).map((b) => b.origin.memberId)).toContain(quiet.memberId);
  });

  it("leaves a creator's brief out of bellman_connect's preview, which their own account still reads", async () => {
    const r = await room({ creatorCapabilities: KEEPS });
    const preview = await (await h.connect(DEV_KEY.peer)).call("bellman_connect", { join_code: r.code });
    expect(preview.isError, preview.text).toBe(false);
    expect(preview.data.creator_brief).toMatchObject({ trust: "untrusted", origin: { memberId: r.creatorMemberId }, data: null });
    expect(preview.text).not.toContain("the creator's");

    const own = await (await h.connect(DEV_KEY.jesse)).call("bellman_connect", { join_code: r.code });
    expect((own.data.creator_brief as { data: { goal: string } }).data.goal).toBe("the creator's");
  });

  /** Review Focus 5: a creator who left is read by row (ADR 0019), not off the room's record. */
  it("keeps a creator's last grant after they leave, so a granted brief still shows (D2)", async () => {
    const r = await room();
    await r.join(DEV_KEY.outsider, GRANTS, "the outsider's");
    const left = await r.creator.call("bellman_leave", { session_id: r.sessionId, member_id: r.creatorMemberId });
    expect(left.isError, left.text).toBe(false);
    const preview = await (await h.connect(DEV_KEY.peer)).call("bellman_connect", { join_code: r.code });
    expect(preview.isError, preview.text).toBe(false);
    expect((preview.data.creator_brief as { data: { goal: string } | null }).data?.goal).toBe("the creator's");
  });
});

describe("the tool text (read_context spec, section 2)", () => {
  it("says on bellman_start and bellman_confirm what read_context does", async () => {
    const { tools } = await (await h.connect(DEV_KEY.jesse)).listTools();
    for (const name of ["bellman_start", "bellman_confirm"]) {
      expect(tools.find((t) => t.name === name)!.description, name)
        .toContain("read_context lets peers read your brief; it is on by default, and without it only you see your brief.");
    }
  });
});
```

In `ui/test/render.test.ts`, inside `describe("renderJoin")`, before `it("renders creator prose as text, never as markup")`:

```ts
  it("says the creator keeps their brief private when the preview carries none (read_context spec, section 1)", () => {
    const r = connectFixture();
    r.creator_brief.data = null;
    const text = renderJoin(r, () => {}, NOW).textContent!;
    expect(text).toContain("The creator keeps their brief private.");
    expect(text, "the room's own words stay").toContain("payments-migration");
    expect(text).not.toContain("Open questions");
  });
```

In that next case, change `r.creator_brief.data.goal = HOSTILE;` to `r.creator_brief.data!.goal = HOSTILE;`, which the type of Step 3 needs.

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/tools/read-context.test.ts -t "read directly|tool text"`. Expected: `3 failed | 1 passed`:
  - `expected [ 'm_…', 'm_…' ] to deeply equal [ 'm_…' ]` (confirm)
  - `expected { trust: 'untrusted', …(2) } to match object { trust: 'untrusted', …(2) }` (connect)
  - `bellman_start: expected 'Create a collaboration room and get a…' to contain 'read_context lets peers read your bri…'`
  - The creator who left passes before and after; Step 9 is its control.

  Then `npx vitest run ui/test/render.test.ts -t "keeps their brief private"`. Expected: FAIL, `TypeError: Cannot read properties of null (reading 'goal')`.

- [ ] **Step 3: Implement.**
  - `bellman_confirm`: keep the peers `seesBrief(m, identity.userId)` lets the joiner read, then take the first `BRIEFS_ON_JOIN` of them and read their briefs (R7). `briefs_omitted` keeps its formula, `peers.length - shown.length`.
  - `bellman_connect`: read the creator's row with `s.getMember(session.id, creator.memberId)`. `creatorBrief` is the brief `getBriefs` returns when the row exists and `seesBrief(row, identity.userId)`, and null otherwise. The envelope stays (R8).
  - The sentence of Global Constraints, in the `capabilities:` line of `bellman_start`'s and `bellman_confirm`'s Args (R15).
  - `ui/src/types.ts` to the Interfaces. In `renderJoin`, when `brief === null`, render `el("p", { class: "muted" }, "The creator keeps their brief private.")` where the brief's `dl` goes; the byline, the room's name and its purpose stay.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/tools/read-context.test.ts tests/tools/join-briefs.test.ts tests/tools/handshake.test.ts ui/test/render.test.ts`, then `npm run typecheck:ui`. Expected: PASS, and no type errors.

- [ ] **Step 5: Write the failing test for the hosted seat (R4).** In `tests/tools/read-context.test.ts`, add `import { HOST_MEMBER_ID } from "../../src/host.js";` and, before `describe("the tool text (read_context spec, section 2)")`:

```ts
/** Review Focus 1, and ruling R4: a new hosted seat grants read_context (the owner's choice). */
describe("a hosted room", () => {
  it("hands a joiner the hosted seat's brief, because the seat grants read_context", async () => {
    const creator = await h.connectAs({ userId: "u_max", orgId: null, plan: "max", role: "member", label: "max" });
    const started = await creator.call("bellman_start", {
      manifest: { room: "the square", purpose: "what people build", preset: "social" }, brief: brief({ goal: "the creator's" }),
    });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const joiner = await h.connect(DEV_KEY.peer);
    const preview = await joiner.call("bellman_connect", { join_code: String(started.data.join_code) });
    const joined = await joiner.call("bellman_confirm", { connect_token: String(preview.data.connect_token), brief: brief() });
    expect(joined.isError, joined.text).toBe(false);
    expect(envelopes(joined.data.briefs).map((b) => b.origin.memberId)).toContain(HOST_MEMBER_ID);
    expect((await h.store.getMember(sessionId, HOST_MEMBER_ID))?.capabilities).toEqual(["read_context", "receive_messages"]);
  });
});
```

- [ ] **Step 6: Run it to see it fail.** `npx vitest run tests/tools/read-context.test.ts -t "hosted room"`. Expected: FAIL, `expected [ 'm_…' ] to include 'm_host'`: Step 3's `bellman_confirm` now hands a brief only when its author grants `read_context`, and the seat does not yet.

- [ ] **Step 7: Make the seat grant it.** In `hostMember` (`src/host.ts`), `capabilities` becomes `["read_context", "receive_messages"]`. Nothing else changes: `hostMember`'s one caller is `bellman_start`, so only a room started from now on seats the new row. Seats already running keep their old row and grant `receive_messages` only, so their brief stops reaching joiners (R4); no step rewrites them.

- [ ] **Step 8: Run to see it pass.** `npx vitest run tests/tools/read-context.test.ts tests/host.test.ts tests/tools/host-start.test.ts tests/tools/host-switch.test.ts tests/hosted-seat-wiring.test.ts tests/host-memory.test.ts`. Expected: PASS. No existing test names the seat's capabilities.

- [ ] **Step 9: See the creator-left case fail without the row.** With Edit, make `bellman_connect` read the creator as `session.members.find((m) => m.memberId === creator.memberId)` instead of by `getMember`. Run `npx vitest run tests/tools/read-context.test.ts -t "last grant after they leave, so"`. Expected: FAIL, `expected undefined to be` the creator's goal. Put `getMember` back with Edit and run it again. Expected: PASS.

- [ ] **Step 10: Measure the tool listing after** with Setup 4's command. Expected: `bellman_start` and `bellman_confirm` each 23 over Setup 4's figures, nothing else moved, and the total 46 over. At main `1aad606` that read 2,469 to 2,492, 804 to 827, and 8,697 to 8,743. Keep the output for Task 7.

- [ ] **Step 11: Commit.** `jj commit -m "bellman_confirm and bellman_connect hand out a brief only when its author grants read_context; the tools say what the grant does, and a new hosted seat grants it"`

### Task 4: The dash's Log route

**Files:**
- Modify: `src/http/rooms.ts` (`readEventsRoute`)
- Test: `tests/http-rooms.test.ts`

**Interfaces:**
- Consumes: `eventsFor` (Task 2).

- [ ] **Step 1: Write the failing tests.** In `tests/http-rooms.test.ts`, inside `describe("GET /rooms/:id/events")`, after `it("reads a closed room's whole log for an org admin of a member, as the surface read does (#65)")`:

```ts
  /** Review Focus 2: an org admin reading a closed room (#65) is a reader like any other. */
  it("reads a closed room's log for an org admin without a brief its author keeps", async () => {
    await store.createSession(orgRoom({ closed: false, closedAt: null }));
    await store.updateMember(ORG_ROOM, "m_peer", { capabilities: ["receive_messages"] });
    await store.appendEvent(ORG_ROOM, {
      type: "brief_update", fromMemberId: "m_peer", fromUserId: "u_peer", fromLabel: "peer@codenerd", payload: { goal: "kept to myself" }, refId: null,
    });
    await say(peer(), "said in the org's room", ORG_ROOM);
    await store.closeSession(ORG_ROOM);
    const r = await read(DEV_KEY.jesse, "", ORG_ROOM);
    expect(r.events.map((e) => e.data.type)).toEqual(["message"]);
  });

  /** The dash's Log route (read_context spec, section 3): the caller's account is the reader. */
  it("leaves a brief its author keeps out of a peer's log, keeps it in the author's, and moves the cursor past it", async () => {
    await store.updateMember(ROOM, "m_peer", { capabilities: ["receive_messages"] });
    const as = { fromMemberId: "m_peer", fromUserId: "u_peer", fromLabel: "peer@codenerd", refId: null };
    await store.appendEvent(ROOM, { ...as, type: "member_joined", payload: { member: { member_id: "m_peer" }, brief: { goal: "kept to myself" } } });
    const update = (await store.appendEvent(ROOM, { ...as, type: "brief_update", payload: { goal: "still to myself" } }))!;

    const theirs = await read(DEV_KEY.jesse);
    expect(theirs.events.map((e) => e.data.type)).toEqual(["member_joined"]);
    expect(theirs.events[0].data.payload).toEqual({ member: { member_id: "m_peer" }, brief: null });
    expect(theirs.cursor).toBe(update.cursor);
    expect(JSON.stringify(theirs)).not.toContain("to myself");

    const mine = await read(DEV_KEY.peer);
    expect(mine.events.map((e) => e.data.type)).toEqual(["member_joined", "brief_update"]);
  });
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/http-rooms.test.ts -t "brief its author keeps"`. Expected: `2 failed`: `expected [ 'brief_update', 'message' ] to deeply equal [ 'message' ]` and `expected [ 'member_joined', 'brief_update' ] to deeply equal [ 'member_joined' ]`.

- [ ] **Step 3: Implement.** In `readEventsRoute`, `events` comes from `await eventsFor(deps.store, sessionId, read, who.identity.userId)`. `cursor` keeps `read.at(-1)?.cursor ?? after ?? 0`, off the unfiltered read.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/http-rooms.test.ts`. Expected: PASS.

- [ ] **Step 5: Commit.** `jj commit -m "The dash's Log shows a peer no brief its author keeps"`

### Task 5: The room socket: the replay and the pushes

**Files:**
- Modify: `src/store-do.ts` (`SessionDO.fetch`, `SessionDO.#wake`, `SessionDO.appendEvent`, `SessionDO.appendEventOnce`)
- Test: `tests/store-do-wiring.test.ts`, `worker-tests/ws-delivery.test.ts`

**Interfaces:**
- Consumes: `readableEvent`, `readableEvents` (Task 1).
- Produces: `#wake(event: SessionEvent, members: readonly Member[] = []): void`, where `members` are the room's rows as the append read them.

- [ ] **Step 1: Write the failing tests.** In `tests/store-do-wiring.test.ts`, inside `describe("fetch: websocket upgrade")`, before `it("replays nothing when the cursor is current")`:

```ts
  /** The room socket on a reconnect (read_context spec, section 2): its frames are shared, so a granted brief only. */
  it("replays no brief its author keeps, and their join without its brief", async () => {
    const quiet = member({ memberId: "m9", userId: "u9", label: "peer", roomRole: "peer_b", capabilities: ["receive_messages"] });
    const storage = fakeStorage({ session: currentRow({ members: [member(), quiet] }), cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    const by = { fromMemberId: "m9", fromUserId: "u9", fromLabel: "peer", refId: null };
    await doi.appendEvent({ ...by, type: "member_joined", payload: { member: { member_id: "m9" }, brief: { goal: "kept" } } });
    await doi.appendEvent({ ...by, type: "brief_update", payload: { goal: "kept" } });
    await doi.appendEvent({ ...by, type: "message", payload: { text: "hi" } });

    await doi.fetch(upgrade(0));
    const frames = ctx.sockets[0].sent.map((f) => JSON.parse(f));
    expect(frames.map((f) => f.type)).toEqual(["member_joined", "message"]);
    expect(frames[0].payload).toEqual({ member: { member_id: "m9" }, brief: null });
    expect(ctx.sockets[0].deserializeAttachment(), "the cursor is the last event read").toMatchObject({ cursor: 3 });
  });
```

Inside `describe("wake: socket delivery")`, before `it("sends the public event, not the stored one")`:

```ts
  /** The pushes (read_context spec, section 2): one frame goes to every socket in the room, so a granted brief only. */
  it("sends no brief its author keeps, keyed or not, and their join without its brief", async () => {
    const quiet = member({ memberId: "m9", userId: "u9", label: "peer", roomRole: "peer_b", capabilities: ["receive_messages"] });
    const storage = fakeStorage({ session: currentRow({ members: [member(), quiet] }), cursor: 0 });
    const ctx = fakeCtx(storage);
    const doi = new storeDo.SessionDO(ctx as never, {} as never);
    await doi.fetch(open(ctx, 0));
    const by = { fromMemberId: "m9", fromUserId: "u9", fromLabel: "peer", refId: null };
    await doi.appendEvent({ ...by, type: "member_joined", payload: { member: { member_id: "m9" }, brief: { goal: "kept" } } });
    await doi.appendEvent({ ...by, type: "brief_update", payload: { goal: "kept" } });
    await doi.appendEventOnce({ ...by, type: "brief_update", payload: { goal: "kept again" } }, "key-0001");
    await doi.appendEvent({ ...by, type: "message", payload: { text: "hi" } });

    const frames = ctx.sockets[0].sent.map((f) => JSON.parse(f));
    expect(frames.map((f) => f.type)).toEqual(["member_joined", "message"]);
    expect(frames[0].payload).toEqual({ member: { member_id: "m9" }, brief: null });
  });
```

At the end of `worker-tests/ws-delivery.test.ts`:

```ts
/**
 * read_context on the room socket (read_context spec, section 2), through the real route. A frame
 * is built once and sent to every socket in the room, so it carries a granted brief only, live
 * and on a reconnect's replay alike.
 */
describe("a brief its author keeps", () => {
  const quiet = member({ memberId: "m_quiet", userId: "u_quiet", label: "quiet@codenerd", roomRole: "peer_b", capabilities: ["receive_messages"] });
  const by = { fromMemberId: "m_quiet", fromUserId: "u_quiet", fromLabel: "quiet@codenerd", refId: null };

  it("reaches no socket, live or replayed, and their join arrives without it", async () => {
    const { id, store } = await room(undefined, { members: [member(), quiet] });
    const live = collect(await upgrade(id));
    await store.appendEvent(id, { ...by, type: "member_joined", payload: { member: { member_id: "m_quiet" }, brief: { goal: "kept" } } });
    await store.appendEvent(id, { ...by, type: "brief_update", payload: { goal: "kept" } });
    await store.appendEvent(id, { ...by, type: "message", payload: { text: "after" } });
    await vi.waitFor(() => expect(live).toHaveLength(2), { timeout: 3000 });

    const replayed = collect(await upgrade(id, 0));
    await vi.waitFor(() => expect(replayed).toHaveLength(2), { timeout: 3000 });
    for (const frames of [live, replayed]) {
      const shown = frames.map((f) => JSON.parse(f));
      expect(shown.map((f) => f.type)).toEqual(["member_joined", "message"]);
      expect(shown[0].payload).toEqual({ member: { member_id: "m_quiet" }, brief: null });
      expect(frames.join("")).not.toContain("kept");
    }
  });
});
```

- [ ] **Step 2: Run to see them fail.** `npx vitest run tests/store-do-wiring.test.ts -t "brief its author keeps"`. Expected: `2 failed`: `expected [ 'member_joined', …(2) ] to deeply equal [ 'member_joined', 'message' ]` (the replay) and `expected [ 'member_joined', …(3) ] to deeply equal [ 'member_joined', 'message' ]` (the pushes). Then `npm run build:ui && npm --prefix worker-tests run test -- ws-delivery.test.ts -t "a brief its author keeps"`. Expected: FAIL after its three-second wait, `expected [ …(3) ] to have a length of 2 but got 3`.

- [ ] **Step 3: Implement.**
  - `SessionDO.fetch`: after the closed and cut rechecks, so a refusal still reads nothing more, list every member row, `this.ctx.storage.list<Member>({ prefix: MEMBER_PREFIX })`; then the events read, still the last await (R12), with a `ponytail:` comment naming the per-upgrade list and its upgrade path, reading only the briefs' authors' rows. Build the frames from `readableEvents(missed, rows, null)`. The attachment's cursor stays the last of `missed`, so the cursor moves past a dropped event.
  - `SessionDO.#wake`: decide the frame once, on the first socket due the event, from `readableEvent(event, <the row in members with event.fromMemberId>, null)`. Null means no frame: no socket is sent one, and attachments do not move. The decision stays inside the per-socket `try`, where building the frame already is. Add to the docblock what a missing row means (R11).
  - `SessionDO.appendEvent` and `SessionDO.appendEventOnce`: keep the `s.members` their transaction read and pass them to `#wake`. Every other caller passes nothing.

- [ ] **Step 4: Run to see them pass.** `npx vitest run tests/store-do-wiring.test.ts`, the whole file: "reads, then attaches, accepts and sends, without yielding in between", "refuses before it reads the events" and "builds no frame for a socket that is not due the event" must pass with the new cases. Then `npm run build:ui && npm --prefix worker-tests run test -- ws-delivery.test.ts` and `npm run typecheck:worker`. Expected: PASS, and no type errors.

- [ ] **Step 5: Commit.** `jj commit -m "The room socket sends no brief its author keeps, on a reconnect's replay or on an append"`

### Task 6: The guard, and the hosted seat's transcript

**Files:**
- Create: `tests/delivery-paths.test.ts`
- Modify: `tests/host.test.ts`

**Interfaces:**
- Consumes: the paths Tasks 2 to 5 left, and `seat`, `open10`, `replyWake` and `ev` in `tests/host.test.ts`.

- [ ] **Step 1: Write the tests.** Create `tests/delivery-paths.test.ts`:

```ts
/**
 * Every module that hands a room's events or briefs to a reader (read_context spec, section 3).
 *
 * A brief reaches a peer only when its author grants `read_context`, and that holds only on
 * the paths that apply the rule (`readableEvent`, `seesBrief`). A path that reads the log or a
 * brief without it leaks every private brief again. So each module that calls `publicEvent`, a
 * store's event read or `getBriefs` is listed here with what it serves, and a module added to
 * either side fails this test until it is listed: whoever adds a path says here whether it applies the rule.
 *
 * A call is found on a line of code, not of a comment: a JSDoc line starts with `*` and a line
 * comment with `//`, and several modules name `publicEvent(e)` in prose.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sources(path);
  return path.endsWith(".ts") ? [path] : [];
});

/** The modules under src/ with a line of code that matches `call`; the generated UI bundle is not code. */
const callers = (call: RegExp): string[] =>
  sources(join(ROOT, "src"))
    .map((path) => relative(ROOT, path))
    .filter((path) => path !== "src/ui/assets.ts")
    .filter((path) => readFileSync(join(ROOT, path), "utf8").split("\n").some((line) => !/^\s*(\*|\/\/|\/\*)/.test(line) && call.test(line)))
    .sort();

/** Each caller of `publicEvent`, and what it hands out. */
const PUBLIC_EVENT: Record<string, string> = {
  "src/public-event.ts": "publicReadEvent, the public page's shape, which leaves out every brief",
  "src/store-do.ts": "the room socket's frames, on a reconnect's replay and on each append; shared, so a granted brief only",
  "src/tools/sync.ts": "bellman_sync, read as the caller's account",
  "src/http/rooms.ts": "the dash's Log route, read as the caller's account",
};

/** Each caller of a store's event read (`eventsAfter`, `waitForEvents`, `recentEvents`), and what it hands out. */
const EVENT_READS: Record<string, string> = {
  "src/store-do.ts": "the store facade, and the socket replay above",
  "src/tools/sync.ts": "bellman_sync, as above",
  "src/http/rooms.ts": "the dash's Log route, as above",
  "src/tools/rooms.ts": "bellman_rooms' last_event, read as the caller's account",
  "src/http/public.ts": "the public page, through publicReadEvent",
  "src/tools/send.ts": "an action_response's check for an earlier answer: hands out no event",
  "src/host-do.ts": "the hosted seat's read; its transcript holds message and progress replies only (decide)",
  "src/host-memory.ts": "the same read, on the Node server",
};

/** Each caller of `getBriefs`, and whose briefs it hands out. */
const BRIEF_READS: Record<string, string> = {
  "src/store-do.ts": "the store facade",
  "src/tools/connect.ts": "the creator's brief in a preview, when the creator grants read_context",
  "src/tools/confirm.ts": "the briefs a joiner is handed, of peers who grant read_context",
};

describe("the paths a brief can leave by (read_context spec, section 3)", () => {
  it("lists every module that calls publicEvent", () => {
    expect(callers(/\bpublicEvent\(/)).toEqual(Object.keys(PUBLIC_EVENT).sort());
  });

  it("lists every module that reads a room's events from the store", () => {
    expect(callers(/\.(eventsAfter|waitForEvents|recentEvents)\(/)).toEqual(Object.keys(EVENT_READS).sort());
  });

  it("lists every module that reads a member's brief", () => {
    expect(callers(/\.getBriefs\(/)).toEqual(Object.keys(BRIEF_READS).sort());
  });
});
```

In `tests/host.test.ts`, add `brief` to the fixtures import, and before `describe("handleWake checks before it reads (I4, M7)")`:

```ts
/**
 * The hosted seat is a peer (read_context spec, section 2), and its transcript is the replies to
 * its open question: message and progress events (`decide`). A brief never reaches the model,
 * granted or not, so the read_context rule has nothing to remove here, and this pins that it
 * stays so. A change that lets a brief into the prompt fails here, and owes the rule first.
 */
describe("the transcript and briefs", () => {
  it("sends the model no brief, even a brief_update that names the open question as its ref", async () => {
    const { driver } = seat({ record: open10 });
    const read = driver.read;
    driver.read = async (id) => ({
      ...(await read(id)),
      events: async () => [
        ev({ cursor: 11, type: "brief_update", refId: "10", payload: brief({ goal: "KEPT-TO-MYSELF" }) }),
        ev({ cursor: 12, refId: "10", payload: { text: "a reply" } }),
      ],
    });
    const bodies: string[] = [];
    driver.callModel = async (body) => {
      bodies.push(JSON.stringify(body));
      return { status: 200, json: { content: [{ type: "text", text: "Fine." }], stop_reason: "end_turn" } };
    };
    await handleWake(driver, replyWake(12), NOW);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("a reply");
    expect(bodies[0]).not.toContain("KEPT-TO-MYSELF");
  });
});
```

- [ ] **Step 2: Run them.** `npx vitest run tests/delivery-paths.test.ts tests/host.test.ts`. Expected: PASS. The guard lists what Tasks 2 to 5 left, and the hosted seat already reads no brief (R3), so Step 3 is where each is seen to fail.

- [ ] **Step 3: See each fail without its check.**
  - Create `src/probe-leak.ts` with Write, and run no jj command while it exists:
    ```ts
    import { publicEvent } from "./public-event.js";
    import type { SessionEvent } from "./types.js";
    /** publicEvent(e) in prose is not a call. */
    export const leak = (e: SessionEvent, s: { eventsAfter(id: string, c: number): unknown }) => [publicEvent(e), s.eventsAfter("qs", 0)];
    ```
    `npx vitest run tests/delivery-paths.test.ts`. Expected: `2 failed | 1 passed`, each diff showing `+   "src/probe-leak.ts",`. Delete it (`rm src/probe-leak.ts`) and run again. Expected: PASS.
  - With Edit, take `(e.type === "message" || e.type === "progress") && ` out of `decide`'s reply filter in `src/host.ts`. `npx vitest run tests/host.test.ts -t "sends the model no brief"`. Expected: FAIL, `expected '{"model":"claude-haiku-4-5-20251001",…' not to contain 'KEPT-TO-MYSELF'`. Put it back with Edit and run again. Expected: PASS.
  - `jj diff --stat`. Expected: the two test files, and nothing under `src/`.

- [ ] **Step 4: Commit.** `jj commit -m "A test lists every module that reads a room's events or briefs, and pins that the hosted seat's transcript holds none"`

### Task 7: The docs, and the branch verified

**Files:**
- Create: `docs/adr/00NN-read-context.md` (R16)
- Modify: `README.md`, `docs/ARCHITECTURE.md`; and, only when `scripts/docs-gen.ts` is on trunk, `docs-site/src/content/docs/concepts/trust.md` and the pages `npm run docs:gen` writes (R17)

No test of its own: its checks are the grep in Step 5 and `npm run verify`.

- [ ] **Step 1: Write the ADR** in the shape of ADR 0021: Date, Status accepted, Spec, Plan, Context, Decision, Consequences. Context is the spec's Goal. Decision, one line each, with where it lives: D1 to D5; the rule (`readableEvent`, `seesBrief`) and who reads as whom (this plan's delivery-path table); R2, R3, R4, R9, R12 and R14. Consequences:
  - A room where every member grants `read_context`, as the default does, sees no change.
  - A hosted seat started after this grants `read_context`, so joiners read its brief; a seat already running keeps its old row, and its brief stops reaching joiners (R4).
  - A member reads their own private update back on another handle or in the dash's Log, never on the handle that wrote it, and never on their own room socket (R1, R2).
  - A socket upgrade lists every member row of its room (R12).
  - A new path that reads events or briefs is listed in `tests/delivery-paths.test.ts` before it ships.
  - Nothing stored changed shape, so a rollback is a revert.
  - The quotes work resolves a quote against events as the quoter may see them (R19).

- [ ] **Step 2: README.md.** Replace the `Capability grants` bullet with:

```markdown
- **Capability grants**: members declare what may be done *to* them (`read_context`, `receive_messages`, `request_actions`). `read_context` is enforced: a member's brief reaches peers only when they grant it, and without it only their own account reads it. Action requests are approved by the receiving **human**, not the receiving agent.
```

- [ ] **Step 3: ARCHITECTURE.md.**
  - §5: the paragraph that begins "Briefs are rows too" ends with this sentence, rewrapped to the paragraph:

```markdown
Each hands a brief only to a reader its author's `read_context` allows (§7).
```

  - §7: after the bullet that begins "An `action_request` is approved by the receiving human":

```markdown
- **A brief reaches a peer only when its author grants `read_context`** (ADR 00NN).
  `readableEvent` (`src/public-event.ts`) decides at delivery from the author's member
  row as it stands, so a grant changed later covers earlier briefs: a `brief_update` is
  dropped, and a `member_joined` loses its brief, for any reader but the author's own
  account. `bellman_sync`, `bellman_rooms` and the dash's Log read as the caller's
  account (`eventsFor`); the room socket's frames are shared and read as no one;
  `bellman_confirm` and `bellman_connect` hand a brief through `seesBrief`.
  `tests/delivery-paths.test.ts` lists every module that reads events or briefs.
```

  - §11: the `Tool definitions` row takes Task 3 Step 10's total, and above the newest "Re-measured" paragraph, with Setup 4's and Task 3 Step 10's numbers filled in:

```markdown
Re-measured on <date> for read_context, by the method below: 46 tokens over the <before>
that main (`<sha>`) measures. `bellman_start` is up 23, to <start>, and `bellman_confirm`
up 23, to <confirm>, for the sentence their capabilities line gains on what `read_context`
does. No tool was added. That is <after>.
```

- [ ] **Step 4: The docs site, when it is on trunk (R17).** `test -f scripts/docs-gen.ts && echo landed`. If it prints `landed`, run `npm run docs:gen`, and in `docs-site/src/content/docs/concepts/trust.md` replace this sentence:

```markdown
No call is refused on `read_context`; it is recorded with your seat on the room's roster.
```

with:

```markdown
`read_context` is enforced: a peer reads your brief only when you grant it, and without it only your own account does.
```

If it prints nothing, skip this step.

- [ ] **Step 5: Check the words, then verify.**
  - `grep -nE -i 'load-bearing|load bearing|worth (saying|stating|noting|knowing|recording)|structural|two sessions|the other session' docs/adr/00NN-read-context.md README.md docs/ARCHITECTURE.md`. Expected: nothing; main has no hit in these files.
  - `npm run verify`. Expected: green.
  - `jj diff -r 'trunk()..@' --stat`. Expected: the spec, this plan, and the files of this plan's file map and tests; nothing in `plugin/`, `extension/`, `src/ui/assets.ts` or `node_modules/`.

- [ ] **Step 6: Commit.** `jj commit -m "ADR 00NN, and the docs, for read_context enforced"`

---

## After this plan

- **The site's trust page** (R18), a PR in bellman-sh/site after this merges, in `public/trust.html`:
  - In the "Two-phase connect" tile, the sentence `A joiner runs <code>bellman_connect</code> and sees your brief, the seat the code admits them to and the verbs it carries.` becomes `A joiner runs <code>bellman_connect</code> and sees the seat the code admits them to, the verbs it carries and, if you grant <code>read_context</code>, your brief.`
  - In the "Grants, not trust" tile, after the three grants: `<code>read_context</code> is enforced: a peer reads your brief only when you grant it.`
- **The quotes plan** (R19): its `resolveQuote` should resolve against events as the quoter may see them, with `readableEvent` and the quoter's account as the reader, so a member cannot quote a brief they were never shown. A quote copies characters when it is written, so a quote of a granted brief stays readable after its author stops granting `read_context`; that plan says whether that is acceptable, or refuses quotes of a `brief_update`.
