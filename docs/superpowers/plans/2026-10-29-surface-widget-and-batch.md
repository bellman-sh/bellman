# Surface widget kind and batch write: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.
> No per-task review: one whole-branch review happens at the end.

**Goal:** Add a `widget` surface kind and an all-or-nothing batch surface write, so Colony Nerve can draw a room's
surface as its canvas.

**Architecture:** The widget is one more kind in `src/surface.ts`'s shape and rules, with an owner check in
`src/rooms.ts`. A batch is validated in order against the room's facts (`resolveSurfaceBatch`). It is placed in
order by one pure function (`placeSurfaceBatch`), so a refusal is decided before anything is written. It is then
appended by a new store method, `appendSurfaces`, as N `surface` events in one transaction.

**Tech stack:** TypeScript, zod, vitest; Durable Objects (`src/store-do.ts`) and `MemoryStore` (`src/store.ts`).

**Spec:** `docs/superpowers/specs/2026-10-29-surface-widget-and-batch-design.md`

## Global constraints

- Batch: 1 to 100 entries (`MAX_SURFACE_BATCH = 100`); each key once; no `{ key, restore }` entries.
- A batch refusal is `items[<i>]: ` followed by the single write's own words. Nothing is written and no send is spent.
- Over `bellman_send`, a batch counts as one send. `PUT /rooms/:id/surface` counts none (ADR 0022, R6), and its body
  is at most 1 MiB (`MAX_SURFACE_BATCH_BYTES = 1024 * 1024`).
- Widget localities: `shared`, `credential_bound`, `local_with_remote_input`, `proximity_collaborative`. `local_only`
  is refused with `a local-only widget stays on its Mac and is never written to a room`.
- `widget.plugin` matches `^[a-z0-9][a-z0-9._-]{0,63}$`. `owner` and `seat` are member ids, `z.string().min(4).max(64)`.
- `SurfaceItem.widget` is optional and absent on every row that is not a widget, as `locked` is.
- Every `BellmanStore` method is async. The contract suite (`tests/helpers/store-contract.ts`) runs against both stores.
- Commits go through `jj` (`jj describe` / `jj new`), on bookmark `mcfearsome/surface-widget-batch`.
- Prose rules (CLAUDE.md "Writing"): members, the room and peers, never "two sessions".
- Plans cite symbols, not lines: find each site by its symbol name.

## Review focus

1. **A batch that moves a locked frame after it created a card in that frame.** The carried card's row must keep the
   writer that the earlier entry gave it. Covered in Task 4's contract test "carries a card written earlier in the batch".
2. **A batch refused at its last entry after earlier entries needed placement.** The log, the rows, the key record
   and the minute must all be unchanged. Covered in Task 4 and Task 5.
3. **A peer rewriting a widget card it does not own.** A move keeps the owner and passes; changing the owner is
   refused. Covered in Task 2.
4. **A keyed batch retried after its room changed.** The retry replays and does not re-place. Covered in Task 4.
5. **The MCP App's card for a widget.** It must never render `body`. Covered in Task 1's render test.

---

### Task 1: The `widget` kind

**Files:**
- Modify: `src/types.ts` (`SurfaceKind`, `SurfaceItem`; add `WidgetLocality`, `Widget`)
- Modify: `src/surface.ts` (`SURFACE_KINDS`, `PLACED_KINDS`, `SurfaceItemShape`, `normalizeSurfaceWrite`, the refusal sentence that lists payload fields)
- Modify: `src/projections.ts` (`surfaceItem`)
- Modify: `ui/src/types.ts` (`SurfaceKind`, the item type), `ui/src/canvas.ts` (the card `switch`)
- Test: `tests/working-surface.test.ts`, `tests/projections.test.ts`, `ui/test/render.test.ts`

**Interfaces (produces):**
```ts
export type WidgetLocality = "shared" | "credential_bound" | "local_with_remote_input" | "proximity_collaborative";
export interface Widget { plugin: string; locality: WidgetLocality; owner: string; seat: string | null }
// SurfaceItem: widget?: Widget   (a widget's alone)
```

- [ ] **Step 1: Write failing tests** in `tests/working-surface.test.ts`, in a `describe("widget kind")`:
  - `{ key: "n-1", kind: "widget", title: "Stripe", widget: { plugin: "stripe", locality: "credential_bound", owner: "m_abcd" } }`
    normalises to an item with `widget: { plugin: "stripe", locality: "credential_bound", owner: "m_abcd", seat: null }`
    and `body: null`.
  - Each of the four localities passes.
  - `locality: "local_only"` is refused, and the reason contains `a local-only widget stays on its Mac and is never written to a room`.
  - A widget without `widget` is refused with `a widget needs widget { plugin, locality, owner, seat? }`.
  - `widget` on a `text` item is refused with `only a widget has widget`.
  - `body: "{not json"` is refused with `a widget's body is its config, as JSON text`; `body: "{\"range\":\"7d\"}"` passes.
  - `plugin: "Stripe"` (uppercase) is refused.
  - A `text` item normalises with no `widget` key at all (`"widget" in item === false`).
  - `PLACED_KINDS` includes `"widget"`, and a widget with `frame: 2` normalises with `frame: 2`.
- [ ] **Step 2:** `npx vitest run tests/working-surface.test.ts -t "widget kind"`. Expected: FAIL.
- [ ] **Step 3: Implement.** Add the types. In `SurfaceItemShape`, add
  `widget: z.strictObject({ plugin, locality: z.enum([...4 localities, "local_only"]), owner, seat: ….nullish() }).nullish()`.
  `local_only` is in the enum so the rule can refuse it in its own words. The rules go in `normalizeSurfaceWrite`'s
  kind chain, beside `shape`. Spread `...(v.kind === "widget" ? { widget: { …, seat: v.widget!.seat ?? null } } : {})`
  into the item, as `locked` is spread. Add `widget?` to the field list in the shape refusal's sentence.
- [ ] **Step 4:** Rerun Step 2. Expected: PASS.
- [ ] **Step 5: Projection.** In `tests/projections.test.ts`: `surfaceItem` of a widget row carries `widget` as
  stored, and of a text row carries `widget: null`. Implement `widget: r.widget ?? null` in `surfaceItem`.
- [ ] **Step 6: MCP App card.** In `ui/test/render.test.ts`: a widget item with `body: "<b>x</b>"` renders a card that
  shows the plugin id, the title and the owner's label (when the roster has it; otherwise the owner id). The card's
  `innerHTML` does not contain `<b>x</b>` or `x`. Implement `case "widget":` in `ui/src/canvas.ts`'s card switch
  using `el(...)`/`text(...)`, as the other cases do. Add `"widget"` to `ui/src/types.ts`'s `SurfaceKind`, and
  `"frame"` too, which is already missing there.
- [ ] **Step 7:** `npm test`. Expected: PASS.
- [ ] **Step 8: Commit.** `jj describe -m "A widget is a surface kind: plugin, locality, owner and seat, its config as JSON in body, drawn as a card"` then `jj new`.

### Task 2: A widget names only its writer's own seat as owner

**Files:**
- Modify: `src/rooms.ts` (`resolveSurfaceWrite` also returns the stored row; add `widgetOwnerRefusal`; call it in `writeSurface`)
- Test: `tests/tools/surface.test.ts`

**Interfaces:**
- Produces: `resolveSurfaceWrite(...)` returns `RoomResult<{ write: SurfaceWrite; stored: SurfaceRow | undefined }>`,
  where `stored` is the row `facts.rows` holds for `write.key`. The approval call site in `src/tools/send.ts` keeps
  reading only `.write`.
- Produces: `export function widgetOwnerRefusal(session: StoredSession, actor: Identity, write: SurfaceWrite, stored: SurfaceRow | undefined): string | null`.
  It returns null for anything that is not a widget item, and for a widget whose `owner` equals `stored?.widget?.owner`.
  Otherwise it returns null when `session.members` holds a member with `memberId === owner && userId === actor.userId`,
  and else the refusal:
  `surface widget "<key>": owner <owner> is not a seat of yours in this room; only the owner's account sets a widget's owner`.

- [ ] **Step 1: Write failing tests** with the harness, using two accounts in one swarm room, A and B, both holding `write_surface`:
  - A writes a widget with `owner` set to A's member id. It lands.
  - B writes a new key with `owner` set to A's member id. It is refused with the sentence above, and no event is appended.
  - B rewrites A's widget with a new placement and the same owner. It lands, and the row's `byMemberId` is B.
  - B rewrites A's widget with `owner` set to B's member id. It is refused.
  - B restores (`{ key, restore }`) a version of A's widget after A removed it. It is refused: the key is new again, and its owner is A's.
- [ ] **Step 2:** `npx vitest run tests/tools/surface.test.ts -t "widget owner"`. Expected: FAIL.
- [ ] **Step 3: Implement.** In `writeSurface`, call `widgetOwnerRefusal(session, actor, write, stored)` right after
  `resolveSurfaceWrite`. Refuse with code `"forbidden"`. The approval path does not call it: there, a human approves
  the card.
- [ ] **Step 4:** Rerun Step 2. Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit.** `jj describe -m "A widget names its writer's own seat as owner, and a peer may move it but not change whose it is"` then `jj new`.

### Task 3: Batch payload, and checks over facts updated in order

**Files:**
- Modify: `src/surface.ts` (add `MAX_SURFACE_BATCH`, `isBatchPayload`, `normalizeSurfaceBatch`)
- Modify: `src/rooms.ts` (extract `checkAgainstFacts` from `resolveSurfaceWrite`; add `resolveSurfaceBatch`)
- Test: `tests/working-surface.test.ts`, `tests/tools/surface.test.ts`

**Interfaces (produces):**
```ts
// src/surface.ts
export const MAX_SURFACE_BATCH = 100;
export const isBatchPayload = (payload: unknown): boolean; // an object with an `items` key
export function normalizeSurfaceBatch(payload: unknown):
  | { ok: true; entries: { write: SurfaceWrite; blobId: string | null }[] }
  | { ok: false; reason: string };
// src/rooms.ts
export interface SurfaceView { count: number; frames: number; kindOf(key: string): SurfaceKind | undefined }
function checkAgainstFacts(write: SurfaceWrite, view: SurfaceView): RoomResult<null>; // the item cap, the frame cap and connector ends, moved verbatim out of resolveSurfaceWrite
export async function resolveSurfaceBatch(store: BellmanStore, blobs: BlobStore, sessionId: string, payload: unknown):
  Promise<RoomResult<{ writes: SurfaceWrite[]; stored: Map<string, SurfaceRow> }>>;
```

- [ ] **Step 1: Write failing `normalizeSurfaceBatch` tests** in `tests/working-surface.test.ts`:
  - `{ items: [] }` is refused, and `{ items: <101 text items> }` is refused.
  - `{ items: [a, b], extra: 1 }` is refused: the shape is `z.strictObject({ items: z.array(z.unknown()).min(1).max(100) })`.
  - A restore entry at index 1 is refused with `items[1]: a batch does not restore; send { key, restore } on its own`.
  - A duplicate key at index 2 that was first used at index 0 is refused with `items[2]: key "k" is already written by items[0]`.
  - A bad entry at index 3 is refused with `items[3]: ` followed by `normalizeSurfaceWrite`'s own reason for that entry.
  - Two good entries come back in order.
- [ ] **Step 2:** Run them. Expected: FAIL. Implement. Run again. Expected: PASS.
- [ ] **Step 3: Write failing `resolveSurfaceBatch` tests** in `tests/tools/surface.test.ts`, driven through the store directly:
  - A connector at index 1 whose ends are a card made at index 0 and a card already on the surface: resolves.
  - A connector naming a key removed at index 0 is refused with `items[1]: connector "c" names "a", which is not on the surface.`
  - A surface holding 999 items and a batch adding 2 new keys: `items[1]` is refused with the item-cap sentence.
  - A blob-backed image in a batch settles to the object's bytes, type and name, as a single write does.
- [ ] **Step 4: Implement.** `resolveSurfaceWrite` builds its `SurfaceView` from `surfaceFacts` and calls
  `checkAgainstFacts`. Its refusals keep their exact words, and the existing tests in
  `tests/tools/surface.test.ts` guard that. `resolveSurfaceBatch` makes one `surfaceFacts` read over every entry's key
  and every connector end. It settles each blob. It walks the entries in order, checking each one and then updating
  the view: a new key counts +1, a removal of a present key −1, and kinds change to and from `frame` adjust `frames`.
  Each refusal gets the `items[i]: ` prefix. `stored` is the facts' rows by key.
- [ ] **Step 5:** Run them. Expected: PASS. Then `npm test`.
- [ ] **Step 6: Commit.** `jj describe -m "A batch of surface writes is checked entry by entry against the room as the earlier entries leave it"` then `jj new`.

### Task 4: `appendSurfaces` in both stores

**Files:**
- Modify: `src/store.ts` (add `SurfaceBatchAppend`, `surfaceBatchPrint`, `placeSurfaceBatch`; add `appendSurfaces` to `BellmanStore` and `MemoryStore`)
- Modify: `src/store-do.ts` (add `SessionDO.appendSurfaces` and the forwarding store method beside `appendSurface`)
- Test: `tests/helpers/store-contract.ts` (new `describe("appendSurfaces")` beside `describe("appendSurface (surface frames spec, D2)")`), `tests/frames.test.ts` for the pure function

**Interfaces (produces):**
```ts
export type SurfaceAuthor = Pick<EventBody, "fromMemberId" | "fromUserId" | "fromLabel">;
export type SurfaceBatchAppend =
  | { outcome: "appended"; events: SessionEvent[] }   // cursor order: each write's event, then the cards it carried
  | { outcome: "replayed"; event: SessionEvent }      // the last event the original call appended
  | { outcome: "conflict" } | { outcome: "frozen" }
  | { outcome: "refused"; index: number; kind: "conflict" | "invalid"; reason: string };
export const surfaceBatchPrint = (author: SurfaceAuthor, writes: readonly SurfaceWrite[]): string;
//   fingerprint of { type: "surface", ...author, refId: null, payload: { items: writes.map(item-or-removal, with `frame` folded in as surfacePrint does) } }
export function placeSurfaceBatch(
  rows: readonly SurfaceRow[], writes: readonly SurfaceWrite[], author: SurfaceAuthor, cursor: number, at: number,
): { ok: true; entries: { placed: Extract<Placed, { ok: true }>; moved: SurfaceRow[] }[] }
 | { ok: false; index: number; kind: "conflict" | "invalid"; reason: string };
// BellmanStore
appendSurfaces(sessionId: string, author: SurfaceAuthor, writes: readonly SurfaceWrite[], key: string | null): Promise<SurfaceBatchAppend>;
```

`placeSurfaceBatch` runs entirely in memory, so a refusal is decided before either store writes anything. It works
over a `Map` of the rows. For entry i, `placed` is `placeSurfaceWrite([...map.values()], w)` when
`placesAmongRows(w)` holds, and otherwise `{ ok: true, write: w, carried: [] }`. A refusal returns `index: i`.
`moved` is the map's row for each `placed.carried` key, read before the entry is applied. Applying the entry runs
`applySurfaceWrite` on the map: the entry's own event first, at the next provisional cursor, authored by `author`;
then each carried card, at the following cursors, through `asRowWriter` with the row's own `approvedBy`. The
cursors start at `cursor`, which is the room's next cursor.

- [ ] **Step 1: Pure tests** in `tests/frames.test.ts`:
  - Two unplaced text cards in one batch take slots 0 and 1.
  - A frame at index 0 and a card with `frame: 1` at index 1: the card lands inside the new frame.
  - Two frames at indexes 0 and 2 that overlap: refused with `index: 2` and the overlap refusal's kind and words.
  - A card made at index 0 inside a locked frame, then that frame moved at index 1: entry 1's `moved` holds the card's
    row with `byMemberId` equal to the author.
- [ ] **Step 2:** Run them. Expected: FAIL. Implement `placeSurfaceBatch`. Run again. Expected: PASS.
- [ ] **Step 3: Contract tests** under `describe("appendSurfaces")`:
  - Three writes land as three `surface` events at consecutive cursors with three rows, and `surfaceCursor` is the last.
  - "refuses at the last entry and writes nothing": an overlap at index 2 leaves the event count, the rows and
    `idempotencyRecord` unchanged, and answers `{ outcome: "refused", index: 2 }`.
  - "carries a card written earlier in the batch": the case from Step 1. The events come in this order: the card,
    the frame, then the carried card. The carried row's `byMemberId` is the author's.
  - A keyed batch retried returns `replayed` with the original last event, even after another write has changed the
    room in between. The same key used with different writes answers `conflict`.
  - A frozen room answers `frozen`.
  - A long poll that is waiting is woken once and handed every event of the batch.
- [ ] **Step 4:** `npx vitest run tests/store.test.ts -t appendSurfaces` (the memory run of the contract). Expected: FAIL.
- [ ] **Step 5: MemoryStore.** Keep one synchronous stretch, as `appendSurface` does. The order is: key record; frozen;
  `rows` (listed only when `writes.some(placesAmongRows)`); `placeSurfaceBatch` with `cursor = s.events.length + 1`;
  a refusal returns. Then, for each entry, call `this.surfaceNow(s, placedEvent(draftOf(author, w), w, placed), placed, undefined, at)`.
  Record the key against the last event's cursor.
- [ ] **Step 6: SessionDO.** Use one `ctx.storage.transaction`. Inside it: key record; frozen; list the rows when
  needed; `placeSurfaceBatch` with `cursor = await this.nextCursor(txn)`; a refusal returns before any write. For each
  entry, call `placedSurfaceRows(txn, session, [], …, new Map(moved.map((r) => [r.key, r])), cursorᵢ, at)`. Thread
  the returned `session` into the next entry. Put each entry's events, puts and deletes before the next entry runs,
  so `extraRows`' reads within the transaction see them. Finally, one `putRows` holds `cursor`, the key record and
  the session (via `asRows`). After commit, call `#wake(events, members)` once, then `reArm` when the books brought a
  due time forward, as `appendSurface` does. Add the forwarding method on the store class beside its `appendSurface`.
- [ ] **Step 7:** `npm test`, then `npm run test:worker` (the DO run of the contract). Expected: PASS for both.
- [ ] **Step 8: Commit.** `jj describe -m "A store appends a batch of surface writes in one operation: every event and row, or none"` then `jj new`.

### Task 5: `bellman_send` takes a batch

**Files:**
- Modify: `src/rooms.ts` (add `writeSurfaceBatch`)
- Modify: `src/tools/send.ts` (route `{ items }`; one sentence in the description; `count` in the result)
- Test: `tests/tools/surface.test.ts`, `tests/tools/send-limit.test.ts`

**Interfaces (produces):**
```ts
export async function writeSurfaceBatch(
  store: BellmanStore, blobs: BlobStore, actor: Identity, sessionId: string, memberId: string,
  payload: unknown, idempotencyKey?: string, countSend = false,
): Promise<RoomResult<{ cursor: number; count: number; replayed: boolean; roomMembers: string[] }>>;
```
The order is `writeSurface`'s: `gateSeat` → `resolveSurfaceBatch` → `widgetOwnerRefusal` per entry (with
`stored.get(key)`, refusal prefixed `items[i]: `) → `findMember` → `admitSend` once when `countSend` →
`appendSurfaces` → map its outcomes the way `writeSurface` maps them (`refused` becomes
`refuse(kind, \`items[${index}]: ${reason}\`)`) → when not replayed, one audit row `sent_surface_batch` with
`{ count, keys }` → `cursor` is the last event's.

- [ ] **Step 1: Failing tests** in `tests/tools/surface.test.ts` (harness, `bellman_send type: "surface"`):
  - A 3-item batch returns `count: 3`, and its `cursor` equals the `surface_cursor` of a following `bellman_surface` read.
  - A batch whose second item is invalid is refused with text starting `items[1]: `, and the surface is unchanged.
  - A keyed batch sent twice: the second returns `replayed: true` and the same cursor.
  - The audit holds one `sent_surface_batch` row with `count: 3`.
  - In `tests/tools/send-limit.test.ts`: send 29 single surface writes, then a 40-item batch is admitted (one send).
    The next single write is refused as `rate_limited`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3: Implement.** In `send.ts`'s `type === "surface"` branch, call `isBatchPayload(payload) ? writeSurfaceBatch(…, true) : writeSurface(…, true)`
  and return `count` when present. Append this to the `"surface"` line of the description, verbatim:
  `{ items: [...] } writes up to 100 items or removals in one call: all land or none, as one send; each key once, no restores; a refusal names items[i].`
- [ ] **Step 4:** Rerun. Expected: PASS. Then `npm run docs:gen` and `npm test`.
- [ ] **Step 5: Commit.** `jj describe -m "bellman_send writes a batch of surface items as one send, all or none"` then `jj new`.

### Task 6: `PUT /rooms/:id/surface`

**Files:**
- Modify: `src/http/rooms.ts` (`MAX_SURFACE_BATCH_BYTES`; the `SURFACE` match accepts PUT; add `writeSurfaceBatchRoute`)
- Test: `tests/http-rooms.test.ts`

- [ ] **Step 1: Failing tests:**
  - A bearer-authorised PUT with `{ items: [a, b] }` and `?member_id=` returns 200 `{ cursor, count: 2 }`. Run a
    second time with the panel cookie and the CSRF header the existing PUT tests use.
  - A body over 1 MiB is refused with 413.
  - A non-object body, or a body without `items`, returns 400.
  - A stranger's member id returns 404, and a seat without `write_surface` returns 403.
  - An invalid entry returns 400 with `items[i]: ` in the detail.
  - `POST` returns 405, with `allow: GET, PUT`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3: Implement** `writeSurfaceBatchRoute(request, url, sessionId, origin, deps)` as a copy of
  `writeSurfaceRoute`'s sequence (caller, CSRF, `member_id`, `lengthRefusal(request, MAX_SURFACE_BATCH_BYTES, "a surface batch", origin)`,
  JSON object, the stranger 404 via `adminWriteRefusal`), with no key in the path. It calls
  `writeSurfaceBatch(deps.store, deps.blobs, who.identity, sessionId, memberId, body)` with no send count, and maps
  the result through the same `STATUS` table.
- [ ] **Step 4:** Rerun. Expected: PASS. Then `npm test`.
- [ ] **Step 5: Commit.** `jj describe -m "PUT /rooms/:id/surface writes a batch, as bellman_send does"` then `jj new`.

### Task 7: ADR, docs, budget

**Files:**
- Create: `docs/adr/00NN-surface-widget-and-batch.md`. Number it against origin/main, every open PR and every local
  bookmark when the PR opens.
- Modify: the docs site's surface page under `docs-site/src/content/docs/`, `docs/ARCHITECTURE.md` §11
- [ ] **Step 1:** Write the ADR in the house format of `docs/adr/0038-surface-frames.md`. Cover D1 to D3 of the spec,
  and why the batch is N events and not one.
- [ ] **Step 2:** Add the widget kind and the batch to the docs site's surface page.
- [ ] **Step 3:** Re-measure §11's tool-definition row (the `~/.worktrees/bellman-measure` scripts; first run them
  against main as the control) and record the delta of Task 5's sentence.
- [ ] **Step 4:** `npm run verify; echo rc=$?` gives rc=0, `npm --prefix docs-site run build` passes, and
  `npx wrangler deploy --dry-run` passes.
- [ ] **Step 5: Commit.** `jj describe -m "ADR NN: the surface takes widgets and batches; docs and the tool budget follow"`.

## Not in this plan

- The dash's widget card (bellman-sh/dash, its own PR).
- The bridge door's batch route (#465 follow-up).
- `bellman_send`'s description also changes on `mcfearsome/concise-tool-descriptions`. Whichever branch lands second
  merges the sentence from Task 5 into the rewritten text and re-measures §11.
