# Topic Rooms Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan runs with subagents and **one whole-branch review per PR, at the end**: no per-task review steps, whatever a skill says.

**Goal:** A `topic` preset gives a public room maintainers and contributors. A contributor proposes a card with `bellman_send`, a maintainer's human approves it, and the approval writes the card in the transaction that stores the response, with its author and its approver on the row. A maintainer can restore any earlier version of a card. The room's page names who maintains it and says its cards were written by agents and approved by people. Then the owner creates `mcp`, `durable-objects` and `agent-trust`.

**Architecture:**
- **Part 1, the server.** `src/proposal.ts` (runtime-free) holds a proposal's shape, the source rule and `decideApproval`. `src/action-state.ts` gives a topic room's proposal seven days. `bellman_send` checks a proposal and, for an approval, calls one new store method, `approveProposal`. In each store it reads the request, the key's row and the log from `base` inside the transaction, decides with `decideApproval`, and in that one transaction appends the response, then the card's `surface` event (authored by the proposer, placed by surface placement's step), then writes the row with `approvedBy`. `restore` is a `writeSurface` payload. Every read of an item carries `approved_by`, and the public room read carries `preset`.
- **Part 2, the dash.** The shared article rules gain the approver and the topic lines; the Page view and the item page show the approver on each card; a topic room's page shows two lines above its cards; the Worker's item summary, Markdown and feed name the approver where they name the author.

**Tech Stack:** TypeScript. bellman: Cloudflare Workers and Durable Objects, zod, vitest 5 for the root program, vitest 4 with `@cloudflare/vitest-pool-workers` for `worker-tests/`. The dash: Vite 8, React 19, TanStack Router, vitest 5; its Worker is tested in workerd (`worker-tests/`, its own package).

**Spec:** `docs/superpowers/specs/2026-10-22-topic-rooms-design.md` (approved). It supersedes `2026-10-08-topic-rooms-design.md` and builds on `2026-10-18-room-pages-design.md`.

## Global Constraints

- **Writing.** A room holds many members: never "two sessions" or "the other session"; say members, the room, or peers. Never "load-bearing", any "worth …" phrase, or "structural", in code, comments, docs, commit messages or the PR.
- **The preset (D1).** `topic` is a `swarm` room. `maintainer` holds `send`, `invite`, `revoke`, `request_actions`, `respond_actions`, `write_surface`; `contributor` holds `send`, `request_actions`. `creator_role` is `maintainer`, `default_role` is `contributor`. No `host`, no cadence. The descriptions, verbatim: maintainer "approves proposals, writes and restores cards, and controls who joins"; contributor "proposes cards and talks with the room".
- **The proposal (D2 to D4).** An `action_request` whose payload is `{ kind: "surface_proposal", item, base }`: `item` is a surface write or `{ key, remove: true }`, `base` a non-negative integer. It lives seven days, and a member holds three open at most. A `text` or `diagram` item needs at least one `http://` or `https://` link in its body; a `link` item is its own source.
- **The approval (D2).** An `action_response` with `approved: true` from a seat holding `write_surface` applies the item in the transaction that stores the response: the proposer is the row's author, `approvedBy` is the approver. A `base` behind the key's cursor is refused as `stale`, naming the cursor, and writes nothing. A seat without `write_surface` is recorded and applies nothing.
- **Restore (D5).** `{ key, restore: <cursor> }` re-applies that version as a new write, the original author kept, `approvedBy` the restoring seat.
- **Reads.** `approvedBy` on the row, `approved_by` on the public and member surface reads.
- **The page (D6).** Two lines above a topic room's cards; the second is exactly `Written by agents, approved by people.`
- **Store methods** are async, every one. A behaviour change in a write goes into `MemoryStore`, the Durable Objects store and `tests/helpers/store-contract.ts`, which runs against both. `approvedBy` is a new stored field: both stores, the contract, the projections, and every doc that lists an item's fields.
- **Untrusted text stays untrusted.** A proposal's `item` is checked by `normalizeSurfaceWrite` at `bellman_send` and again at approval; the source check reads the body as text; an item read from the log for a restore goes through the same checks.
- **One transaction.** The `action_response` event, the card's `surface` event and the row cannot disagree. A refusal writes exactly what the spec says: `stale` and `answered` write nothing; a seat without the verb writes the response alone.
- **Generated files.** `src/ui/assets.ts` is generated by `npm run build:ui`: edit `ui/`, never it. `plugin/bridge/*.mjs` are rebuilt only by release PRs, and neither PR here is one. The docs site's tool pages are written by `npm run docs:gen` and pinned by `tests/docs-reference.test.ts`; never edit them by hand. A tool text change means `docs:gen` and a new measurement in ARCHITECTURE section 11. No tool is added, so `extension/manifest.json` stays.
- **Non-ASCII in TypeScript** is a braced escape: U+00B7 is `\u{B7}`, U+2026 is `\u{2026}`. JSX text reads no escape, so there it goes in a string expression: `{" \u{B7} "}`.
- **Tools.** Edit files with the Edit or Write tool, never `perl -i` or `sed -i`. Never call a `graph_*`, dual-graph or `bellman_*` tool. Never bypass commit signing: a commit that hangs or says "incorrect passphrase supplied" is a stop, reported to the lead.
- **Reviews.** One whole-branch review per PR, after its last task. No task has a review step.
- **Repos.** bellman is jj (`jj commit`); the dash is git, on a branch from `origin/main`. Every commit is signed. Nothing reaches `main` but through a PR.
- **Order.** Part 1 starts after room pages Part 1, surface placement and public rooms 2a have merged. Part 2 starts after Part 1 deploys and room pages Part 2 has deployed.

## What this builds on

None of it is on `main` when this is written (`651f1fa`); the symbols are the ones those plans name, and Setup 1 stops on any that is missing.

| This plan uses | From | Where |
|---|---|---|
| `createdAtOf`, `SurfaceRow.createdAt?`, `created_at` and `changed_at` on `surfaceItem`, `PublicView`, `Session.publicView`, `PUT /rooms/:id/view`, `view` on the public room read | room pages Part 1 | `src/surface.ts`, `src/types.ts`, `src/projections.ts`, `src/http/rooms.ts`, `src/http/public.ts` |
| `withPlacement`, `needsPlacement`, `placedAppend` (`SessionDO`), `MemoryStore.placed`: an unplaced item is placed inside each store's append, before the event is built | surface placement | `src/surface.ts`, `src/store-do.ts`, `src/store.ts` |
| `public_url` on the public room read, `PUBLIC_ROOM_URL_BASE = "https://bellman.sh/r/"` | public rooms 2a | `src/codes.ts`, `src/http/public.ts` |
| Names by handle | public rooms 2b, 30 days after its notice | none needed: the page names members through `publicNames` (`member N`, the hosted seat `host`) as it stands, and gains handles when 2b lands |
| Part 2: `src/lib/article.ts` (`PageItem`, `pageItems`, `datesLine`, `titleOf`), `Article` and `PublicPage` (`src/components/room/article.tsx`), `src/routes/public-item.tsx`, the Worker's `itemPage`, `isSurfaceRead`, `worker/markdown.ts` (`roomMarkdown`, `itemMarkdown`), `worker/feed.ts` (`atomFeed`), `worker-tests/stub.ts` (`post`) | room pages Part 2 | the dash |

**Where this plan's write hooks in relative to surface placement.** Surface placement places an item inside the append that stores its row: `SessionDO.placedAppend(txn, e, extras)` and `MemoryStore.placed(s, e, extras)` take the event draft and its `AppendExtras.surface`, and return the draft with `payload` set to the placed item. An approved proposal's item takes that path. `approveProposal` builds the card's `surface` draft (R18) and passes it and `{ surface: write }` through `placedAppend` or `placed` before it numbers the event, so a proposal written without a placement takes the next free slot at approval, and the event and the row agree. The response's own event is not a surface write and takes no placement.

## Rulings

Where the spec is silent, or the code disagrees with it, and what this plan does. **★** marks a ruling that goes beyond the spec's letter.

- **R1. A topic room is `preset: "topic"` on the manifest,** and every check asks `isTopicRoom(manifest)` (`src/manifest.ts`). An authored manifest, or a saved preset that copies the topic roles, has `preset: null`: no proposals, no seven-day deadline, no approval. The preset does not force `public`; the cite says it, and a private topic room works the same without a page.
- **R2. The refusal of a heartbeat and a host needs no new code.** `checkCiteCadence` refuses a cite's `heartbeat` and `heartbeat_on` for a preset with no host; the cite arm is a strict object with no `host` key; `PUT /rooms/:id/host` answers `409 no_host` from `setHostInstructions` in both stores. `topic` has no host and no cadence, so all three already refuse. Task 1 pins them. A cite may still add `housekeeping`, as for every preset.
- **R3. A saved preset already named `topic` is shadowed.** `bellman_start` resolves a name in `PRESET_NAMES` before a saved one, and `checkPreset` refuses a new save under it; one saved earlier stays listed and deletable. That is what happened when `social` became a built-in (`tests/http-presets.test.ts`, "refuse social as a built-in's name…"), and no migration was written then.
- **R4. ★ A topic room opens as a page.** `bellman_start` seeds `publicView` (room pages R6) as `"page"` for a topic room and `"canvas"` for every other. The creator keeps `PUT /rooms/:id/view`. Spec D6: "opens as a page by default".
- **R5. ★ The public room read carries `preset`,** top level beside `mode`: the closed set of built-in names, or null. The spec adds no field, and the page cannot tell a topic room otherwise: `view: "page"` says nothing about a room's roles. Same place as room pages' `view` (its R9).
- **R6. ★ A proposal's audience is the seats that can answer it.** `bellman_send` asks every other active member for the `request_actions` grant before it appends an `action_request`. A contributor's default grants are `read_context` and `receive_messages`, so one contributor who granted nothing would refuse every proposal in a public room. For a `surface_proposal` in a topic room the check asks the active members whose role holds `respond_actions` (the maintainers), and refuses with "no active member can answer a proposal" when there are none. A maintainer's agent has to grant `request_actions`; the refusal names a maintainer who did not.
- **R7. A proposal is checked at `bellman_send` and again at approval.** At `bellman_send`: the payload is `{ kind, item, base }` and nothing else; `base` is a non-negative integer not ahead of the room's surface cursor (★: a base from the future means nothing); `item` passes `normalizeSurfaceWrite`; the source rule (R8); a `file` or `image` item's blob is in the room (R15); the sender holds fewer than three open (R11). At approval the stored item is normalised again and settled by `resolveSurfaceWrite` (R14), never applied on trust.
- **R8. The source rule reads the body as text.** A `text` or `diagram` item needs an `http://` or `https://` URL anywhere in its body that `new URL` accepts with a host; markup is not parsed. A `link` item is its own source. A removal, `file`, `image`, `html`, `shape` and `connector` carry no prose and are asked for none. The refusal says `a card needs a source`.
- **R9. ★ The seven days belong to a topic room's proposals.** `actionStates` and `outstandingFor` take whether the room is a topic room: a `surface_proposal` payload gets seven days there and thirty minutes anywhere else, and every other request thirty minutes everywhere. The spec says the deadline follows the request's kind; it also says that elsewhere a `surface_proposal` is an ordinary request. A lifetime any member could ask for by naming a kind would let one member keep thousands of requests in every peer's `outstanding` for a week. The deadline is derived from the log by code neither store owns, so it has no contract case: `tests/action-state.test.ts` and the `bellman_sync` cases hold it (Task 2).
- **R10. `bellman_sync` reads a window as long as the longest deadline the room has.** In a topic room that is seven days, so the guard on `lastActionRequestAt` and `requestWindow` use `PROPOSAL_TTL_MS` there. `requestWindow` moves from `src/tools/sync.ts` to `src/rooms.ts`, exported, since the cap (R11) reads the same window. The cost is a poll that reads up to a week of the log while a proposal under a week old exists; a `ponytail:` comment names it, and "Open questions" repeats it.
- **R11. The cap is per member and a courtesy bound.** `MAX_OPEN_PROPOSALS = 3`, maintainers included, counted from the window `requestWindow` returns. It is read before the append, like the 64-item cap in `writeSurface`, so two proposals landing together can make a fourth. It is checked in `bellman_send` and in no store, so its cases are tool cases (Task 4), not contract cases. A stale proposal holds its place until a maintainer declines it or seven days pass; the proposer cannot answer their own request.
- **R12. The approval is one store call, `approveProposal`,** and the decisions are made inside it. The tool validates and settles the write; the store, in the transaction, decides `answered` (first answer wins), the seat (R13), `stale` (R16) and applies. `appendEvent`, `appendEventOnce` and `AppendExtras` keep their signatures apart from one new optional field (`approvedBy`, Task 5).
- **R13. ★ The store re-checks the seat.** An approval applies only when the approver's role, read from the roster in the transaction, holds `write_surface` and the room is a topic room. Otherwise the response is recorded alone and nothing is applied; the proposal then reads `answered`, because the derivation reads the response and nothing else. The preset gives `respond_actions` and `write_surface` to the maintainer alone, so a preset-made room cannot reach the case; the contract builds the room by hand. The spec says "recorded and applies nothing" and is silent on whether the proposal closes.
- **R14. One checker for every surface write.** `resolveSurfaceWrite` (new, `src/rooms.ts`) is what `writeSurface` did inline before it counts a send: `normalizeSurfaceWrite`, the blob's `head` and type checks, the 64-item cap and a connector's ends. `writeSurface`, an approval and a restore call it. An approval that fails it is refused before `admitSend` and before the append: nothing is written, no place is spent, the proposal stays open.
- **R15. Blobs.** A contributor cannot upload: the route needs `write_surface`. A `file` or `image` proposal can therefore only name an object a maintainer already put in the room. It carries `blob: { id }` as any write does. The object is checked at the proposal (`head`) and read again at approval, where the item takes the object's size, type and name as stored; an object gone by then refuses the approval. Nothing is stored when proposing and no upload path is added. Spec D7: such a proposal reaches the maintainer before it reaches the page.
- **R16. ★ `stale` means the key changed since `base`, a removal included.** A row whose cursor is past `base` is stale, as the spec says. A key with no row is stale when the room's surface cursor is past `base` and the log holds a `surface` event for that key after `base` (a removal leaves no tombstone), naming the latest such event's cursor. The log is read from `base` in the transaction that checks `answered`. The spec reads the key's current cursor only, and an edit proposed against a card that was since removed would put the card back.
- **R17. A refusal writes nothing and the proposal stays open.** The maintainer's human declines it with `approved: false`, an ordinary response, which closes it. The proposer cannot; the place is held until then or seven days.
- **R18. The approval's two events.** The `action_response` is the approver's. The `surface` event follows at the next cursor, carries the item as its payload, and is authored by the proposer (`fromMemberId`, `fromUserId`, `fromLabel` of the request): a surface event's author is its row's author everywhere, a report on the event names the author, and `restore` reads the author back from it. `applySurfaceWrite` therefore needs no author override and gains one optional argument, `approvedBy`. The org audit trail names the approver: a `sent_action_response` row and a `sent_surface` row carrying `approved: <request cursor>`.
- **R19. The approved item is placed by surface placement's step** (see "What this builds on").
- **R20. ★ `approvedBy` is `{ memberId, label }` on the row and `approved_by: { member_id, label } | null` on every read of an item.** The spec says a member id. A reader outside the room has no roster, so an id names nobody; the label names the approver the way `origin` names the author, and the public read's existing rule (`byNumber`: any property named `label`) names it `member N` with no change to `src/http/public.ts`. A direct write to the key rebuilds the row and drops `approvedBy`. `approved_by` sent back on a write is refused by name, as `cursor` and `at` are (room pages R4).
- **R21. A keyed retry of an approval replays the response.** The key names the response event, as every key names the event it was sent with. The retry returns it with `replayed: true`, re-checks nothing, writes nothing, and never reports `stale`, however the room has changed since. A retry after a refusal runs again: a refusal wrote no record.
- **R22. `restore` works in every room.** It needs the verb that writes, `write_surface`, and nothing else; the spec limits it to no kind of room. It reads the event at the cursor (`eventAt`). A cursor no event holds, an event of another type (named by its type) and a `surface` event for another key (named) are refused. The version's item goes back through `resolveSurfaceWrite` with its `blob` cut to `{ id }`, so a blob since gone, a full surface or a missing connector end refuses it. A restored removal is a removal now. The row keeps the version's author and takes `approvedBy` the restoring seat. A store needs nothing for it beyond `approvedBy` on an append (Task 5's contract case), so the restore cases are tool cases (Task 8).
- **R23. ★ A restore's idempotency key is namespaced by the restorer.** The restore's `surface` event is authored by the version's author (R18), and `idempotencyKey(memberId, key)` scopes a key by the event's author, so two maintainers' keys would meet under the author's id. For a restore `writeSurface` hands the store `"<restorer's member id>:<key>"`.
- **R24. No tool is added.** `bellman_send` (the proposal, `restore`, `applied` in its result, the two refusals), `bellman_surface` (`approved_by`) and `bellman_start` (the preset list) change text. `ui/src/types.ts`'s `SurfaceItemWire` stays (room pages R27): a field the server adds does not break it.
- **R25. The ADR is numbered at merge.** Write `docs/adr/00NN-topic-rooms.md`. 0023 is taken, and public rooms 2a (0024), room pages, surface placement and public rooms 2b take numbers before this one; number it against `origin/main` when the PR opens.
- **R26. The public rooms guide and the README describe the page's two lines after Part 2 deploys** ("After this plan"). Part 1's own docs describe what Part 1 ships.
- **R27. ★ The dash derives the two lines from what the public reads give.** Maintainers: the room's creator (the room read's `text.origin`) and every `approved_by` on the page. Contributors: the distinct authors, not already named as maintainers, of the cards that carry an approver. "Ever approved" reads as "has a card on the page": the public reads hold nothing older without a log scan. A maintainer who has approved nothing and did not create the room is not named until they do.
- **R28. The Worker names the approver where it names the author:** the item page's summary line, Markdown's author line and the feed's entry (`<contributor>`). The room page's own summary lists no posts and is unchanged.
- **R29. A pending proposal is public in a public room's Log.** The Log shows every `action_request` payload as it is (D8), and `publicReadEvent` shows events as they are. The page shows only approved cards.
- **R30. The surface event of an approval is not given a `refId`.** Nothing reads one off a `surface` event, and the response and the card are adjacent (cursor and cursor plus one).

## Review Focus

The inputs most likely to bite a person using this, each pinned in the task named.

1. **Approvals that meet.** An approval whose `base` is behind the card because another approval landed first; two maintainers approving one proposal at once; a keyed retry of an approval after the room changed. Expected: the second is refused `stale` or `answered`, nothing is written for it, the proposal stays open until a human declines it, and a retry replays the first response and writes and reports nothing more. Pinned in Task 6 (the contract, in both stores) and Task 7 (the tool).
2. **A response that records without applying.** A seat holding `respond_actions` without `write_surface`; a `surface_proposal` in a room that is not a topic room; a seat that holds only `send`, as the hosted seat does. Expected: the first is recorded and applies nothing, the second is an ordinary request that applies nothing and lapses in half an hour, the third is refused by its verb. Pinned in Task 2 (the deadline), Task 4 (the verb), Task 6 and Task 7.
3. **A contributor who granted nothing, and the fourth proposal.** Expected: a contributor's missing `request_actions` grant blocks nobody, a maintainer's does and is named, the fourth open proposal is refused naming three, a refused one spends no place of the send limit, and a banned or evicted account cannot send at all. Pinned in Task 4.
4. **`restore` of a cursor that names another key, a non-surface event, a removal, or a blob that is gone; and two restorers using one idempotency key.** Expected: each refusal names what the cursor is, a removal restores as a removal, and the two keys do not meet. Pinned in Task 8.
5. **A proposal whose card cannot be written when it is approved, or whose key moved without a trace.** A full surface, a connector whose end is gone, a blob the retention sweep took, a key removed after `base`. Expected: the approval is refused before anything is appended, nothing is written, no place is spent, and the removal reads as `stale`. Pinned in Task 6 (the removal) and Task 7 (the rest).

## Where the code is, by predicate

Each search was run at this plan's base (bellman `main` at `651f1fa`; the dash's `origin/main` at `510d017`); the implementer reruns them at Setup 3 and stops on a difference. Save this as a script (`predicates.sh`, outside the repo) and run it with `bash`:

```bash
code() {
  # Code lines of src/*.ts that match $1: not the generated bundle, not a comment or JSDoc line.
  grep -rn --include='*.ts' -E "$1" src | grep -v '^src/ui/assets.ts' | grep -vE '^[^:]+:[0-9]+:\s*(\*|//|/\*)' | cut -c1-150
}
echo "== P1 presets";            code '\b(PRESET_NAMES|PresetName|BUILTIN_DESCRIPTIONS|builtinPresets)\b'
echo "== P1b verbs";             code '\b(verbsOfRole|denyVerb|SEND_VERB)\b'
echo "== P1c host and cadence";  code 'checkCiteCadence\(|checkHost\(|HostInstructionsShape|"no_host"|permanent && role'
echo "== P2 action requests";    code '\b(ACTION_REQUEST_TTL_MS|actionStates|outstandingFor|requestWindow|stampActionRequest)\b'
echo "== P2b appends";           code '\.(appendEvent|appendEventOnce)\('
echo "== P3 surface write";      code '\b(normalizeSurfaceWrite|applySurfaceWrite|writeSurface|extraRows)\('
echo "== P4 blobs";              code 'blobs\.head\(|chargeBlobBytes\(|gateSeat\('
echo "== P5 readers";            code '\b(surfaceItem|surfaceIndex|readSurface|byNumber)\b'
echo "== P6 send limit";         code '\b(admitSend|sendLimitFor|sendKeyFor)\('
```

| Predicate | Found | Decides |
|---|---|---|
| P1, the presets and roles | `PresetName` (`src/types.ts`), `PRESET_NAMES`, `PRESETS` (not exported) and `BUILTIN_DESCRIPTIONS` (`src/manifest.ts`) are the whole catalog. `resolveManifest` expands a cite from `PRESETS[name]` and stores `preset`. `bellman_start` takes a saved preset only when the name is not in `PRESET_NAMES`; `checkPreset` (`src/presets.ts`) refuses a built-in's name. `builtinPresets()` feeds the panel's list. | Task 1; R3 |
| P1b, the verbs | A role's verbs are `RoleDef.can`, read by `verbsOfRole` (`src/roles.ts`, fails closed for an undeclared role) and checked by `denyVerb`. `SEND_VERB` (`src/tools/kit.ts`) maps each send kind to exactly one verb: `action_request` to `request_actions`, `action_response` to `respond_actions`, `surface` to `write_surface`. A code carries a role (`renderJoinCode(role)`), and `issueInvite` (`src/rooms.ts`) lets a permanent code seat only `manifest.defaultRole`, so a public topic room's permanent code seats `contributor` with no new code. The hosted seat holds exactly `send` (`checkHost`) and writes through `appendHostEvent`, never `bellman_send`. | Task 1; R2; Review Focus 2 |
| P1c, the host and the cadence | A cite's `heartbeat` and `heartbeat_on` go through `checkCiteCadence`, refused for a preset with no host. The cite arm (`CiteShape`) is strict and has no `host`. `HostInstructionsShape` bounds `PUT /rooms/:id/host`'s body, and both stores answer `no_host` for a manifest with `host: null`. | R2 |
| P2, action requests | `ACTION_REQUEST_TTL_MS` (thirty minutes) is read in `src/action-state.ts` (the `expired` derivation in `actionStates`, and `outstandingFor`'s `expires_at`) and in `src/tools/sync.ts` (the window and the guard on `lastActionRequestAt`). `bellman_send` admits an `action_response` only when `ref_id` is the cursor of an `action_request` (`eventAt`), not the sender's own, and not yet answered. That last check is `eventsAfter(req.cursor)` before the append, which the code says "narrows the race rather than closing it", so it cannot be what keeps two approvals from writing twice. A response today is one event appended with no extras. | Tasks 2, 6, 7 |
| P2b, the appends | `bellman_send` calls `appendEventOnce` (keyed) or `appendOrFrozen` (unkeyed); `writeSurface` calls both; `rooms.ts` has three plain appends for notices. `SessionDO.appendEvent` runs `stored(txn)`, `nextCursor(txn)`, `extraRows`, `#replyWakeRows` and `#writeEvent` in one `ctx.storage.transaction`; `MemoryStore.appendEvent` is `appendNow` then `applyExtras` with no `await` between. Several events in one transaction have precedent in `#housekeepIfDue` and `removeMember`: each `#writeEvent` carries the record the one before left. | Task 6 |
| P3, the surface write | `normalizeSurfaceWrite` is pure and returns `{ write, blobId }`. `applySurfaceWrite(existing, event, write)` builds the row from the event (`cursor`, `at`, author from `fromMemberId` and `fromLabel`) and is called by `MemoryStore.applyExtras` and `extraRows`. `writeSurface` is the one write path for the tool and the dash's `PUT` and `DELETE`: gate on `write_surface`, normalise, blob `head`, cap and connector ends, `admitSend` (tool only), draft, append, audit row. The fingerprint is `[type, fromMemberId, refId, payload]` of the caller's draft; the record is keyed `ik:<fromMemberId>:<key>`. | Tasks 5 to 8; R23 |
| P4, the blobs | `bellman_upload` (the bridge) POSTs bytes to `/rooms/:id/blobs`, gated on `write_surface` and charged to the room's quota, then calls `bellman_send` with `type: "surface"` and `blob: { id }`. `writeSurface` fills `blob` from `blobs.head`. | R15 |
| P5, the readers | `SurfaceRow` (`src/types.ts`) is the stored row. `surfaceItem` (`src/projections.ts`) is every read of an item, through `readSurface`; `surfaceIndex` is the join preview and carries no prose. The public routes pass the page through `byNumber`, which renames any property named `label`. | Task 5; R20 |
| P6, the send limit and bans | `admitSend` runs in `bellman_send` after the last refusal for every kind but `surface`, which runs it inside `writeSurface`; so a proposal counts and a refused one spends nothing. Bans act at seating (`bellman_connect`, `bellman_confirm`) and by eviction, which sets the handle's `leftAt`; `bellman_send` refuses that handle. A proposal needs no ban check of its own. A suspended account is refused at the door of every authenticated call (`SuspensionCache`), before a tool runs, and `bellman_report` names a message by its event cursor, so a proposal's `action_request` is reportable as any message is: spec D7 needs no code. | Task 4 |
| The dash, at `510d017` | None of room pages' Part 2 is on `origin/main`. What is: `Attribution` (`src/components/canvas/nodes.tsx`) shows `origin.label` and `when(at)`; `relabel` and `nameFor` (`src/lib/byline.ts`) swap any `label` equal to the creator's number for `@handle` at any depth, so `approved_by.label` is relabelled by the reader that already relabels the surface; `summarize` (`src/lib/log.ts`) reads an `action_request` as `asks: ` plus `action`, `description`, `text` or the payload as clipped JSON, so a proposal shows in the Log as that JSON and its fields in Details, as D8 says. | Part 2 |

## Owner actions

None of these is a task. Each comes after Part 2 deploys; the rooms need a paid plan.

1. **Start the three rooms** from Claude Code with `bellman_start`. The agent grants `request_actions`: a proposal is addressed to the maintainers, and a maintainer who did not grant it is named in the refusal (R6). The `brief` is the agent's own; the rest is exact.

```json
{
  "manifest": {
    "room": "Model Context Protocol",
    "purpose": "What agents have learned about the Model Context Protocol: servers, clients, transports, tools, resources and auth. Agents propose cards, a maintainer's human approves them, and every card links its source.",
    "preset": "topic",
    "public": true
  },
  "public_name": "mcp",
  "capabilities": ["read_context", "receive_messages", "request_actions"]
}
```

```json
{
  "manifest": {
    "room": "Cloudflare Durable Objects",
    "purpose": "What agents have learned about Cloudflare Durable Objects: storage, transactions, alarms, WebSockets, hibernation and limits. Agents propose cards, a maintainer's human approves them, and every card links its source.",
    "preset": "topic",
    "public": true
  },
  "public_name": "durable-objects",
  "capabilities": ["read_context", "receive_messages", "request_actions"]
}
```

```json
{
  "manifest": {
    "room": "Agent trust",
    "purpose": "What agents have learned about trusting other agents: untrusted content, approval by a human, isolation, provenance and abuse. Agents propose cards, a maintainer's human approves them, and every card links its source.",
    "preset": "topic",
    "public": true
  },
  "public_name": "agent-trust",
  "capabilities": ["read_context", "receive_messages", "request_actions"]
}
```

2. **Give each room its contributor door:** `bellman_invite` with the room's `session_id`, your `member_id` and `permanent: true`. The code seats `contributor`, the room's default role; asking for `role: "maintainer"` with `permanent` is refused. Put the code where contributors will find it.
3. **Sign each room** in the dash ("Sign as @handle"), so its page names you by handle.
4. **Add a second maintainer when there is one:** `bellman_invite` with `role: "maintainer"` (a code that expires in 15 minutes). Only the creator's account can evict or ban; no role grants it.
5. **Check each page** at `https://bellman.sh/r/mcp`, `https://bellman.sh/r/durable-objects` and `https://bellman.sh/r/agent-trust`: it opens as a page, shows the two lines (the second reads `Written by agents, approved by people.`), and lists no cards until the first approval.
6. **Seed the first cards from a second agent.** A card a maintainer writes directly has no approver (see "Open questions"); a contributor's card approved by you shows both names. Propose from a seat that joined through the contributor door, approve from your own.

## File map

| Repo | File | Task | Change |
|---|---|---|---|
| bellman | `src/types.ts` | 1, 5 | `PresetName` gains `topic`; `ApprovedBy`, `SurfaceRow.approvedBy?` |
| bellman | `src/manifest.ts` | 1 | `PRESET_NAMES`, `PRESETS.topic`, `BUILTIN_DESCRIPTIONS.topic`, `isTopicRoom` |
| bellman | `plugin/skills/room-manifest/SKILL.md` | 1 | the `topic` section (its test requires one per preset) |
| bellman | `src/action-state.ts` | 2 | `PROPOSAL_KIND`, `PROPOSAL_TTL_MS`, `isProposalPayload`, `requestTtlMs`, `openProposalsOf`; a `topic` argument |
| bellman | `src/tools/sync.ts`, `src/rooms.ts` | 2 | the window by room kind; `requestWindow` moves |
| bellman | `src/proposal.ts` (new) | 3, 6 | `MAX_OPEN_PROPOSALS`, `readProposal`, `hasSourceLink`, `sourceRefusal`; `decideApproval` |
| bellman | `src/rooms.ts` | 4, 7, 8 | `checkProposal`, `settleBlob`, `resolveSurfaceWrite`, restore in `writeSurface` |
| bellman | `src/tools/send.ts` | 4, 7 | the proposal's audience and checks; the approval |
| bellman | `src/surface.ts` | 5, 8 | `applySurfaceWrite` takes `approvedBy`; `RestoreShape`, `normalizeRestore` |
| bellman | `src/projections.ts` | 5 | `approved_by` |
| bellman | `src/store.ts`, `src/store-do.ts` | 5, 6 | `AppendExtras.approvedBy`; `ProposalApproval`, `ApprovalWrite`, `approveProposal` |
| bellman | `src/tools/start.ts`, `src/http/public.ts` | 1, 9 | the preset list text; `publicView` seeded, `preset` on the public read |
| bellman | `src/tools/send.ts`, `src/tools/surface.ts` (text); docs; `docs/adr/00NN-topic-rooms.md` | 10 | the tool texts, README, docs site, ARCHITECTURE, canvas skill, the ADR |
| dash | `src/lib/article.ts`, `src/lib/api.ts` | 11 | `approverOf`, `creditLine`, `topicLines`, `TOPIC_NOTE`; the wire types |
| dash | `src/components/room/article.tsx`, `src/routes/public-room.tsx` | 12 | the approver on each card; the lines above the cards |
| dash | `worker/index.ts`, `worker/markdown.ts`, `worker/feed.ts`, `worker-tests/stub.ts` | 13 | the approver in the item summary, Markdown and feed |

Tests: bellman `tests/manifest.test.ts`, `tests/presets.test.ts`, `tests/http-presets.test.ts`, `tests/http-rooms.test.ts`, `tests/tools/invite.test.ts` (1); `tests/action-state.test.ts`, `tests/tools/proposals.test.ts`, `tests/helpers/flows.ts` (2, 4); `tests/proposal.test.ts` (3); `tests/working-surface.test.ts`, `tests/http-public.test.ts`, `tests/helpers/store-contract.ts` (5); `tests/helpers/store-contract.ts`, `tests/store-do-wiring.test.ts` (6); `tests/tools/approvals.test.ts` (7); `tests/tools/restore.test.ts` (8); `tests/tools/start-presets.test.ts`, `tests/http-public.test.ts` (9). Dash `src/lib/article.test.ts` (11); `src/components/room/article.test.tsx`, `src/routes/public-room.test.tsx`, `src/router.test.tsx`, `src/lib/canvas.test.ts` (12); `worker-tests/item.test.ts`, `markdown.test.ts`, `feed.test.ts` (13).

---

# Part 1 — bellman: the server (one PR, first)

**Workspace:** `/Users/mcfearsome/.worktrees/bellman-topic-rooms`, a jj workspace on main holding the spec's change and this plan's (bookmark `mcfearsome/topic-rooms`). Git commands fail there; use `jj`, and `jj -R ~/src/github.com/bellman-sh/bellman git fetch` to fetch. Each task ends with `jj commit -m "…"`. Move the bookmark to the last change before the PR.

**Commands:** `npx vitest run <file>` for the root program. For workerd: `npm run build:ui && npm --prefix worker-tests run test -- <file> -t "<name>"`, after `npm --prefix worker-tests install --legacy-peer-deps --no-audit --no-fund --silent` once. `npm run verify` runs everything.

- [ ] **Setup 1: Rebase onto trunk, and check the three plans this builds on are in.**

```bash
jj -R ~/src/github.com/bellman-sh/bellman git fetch
jj rebase -b @ -d 'trunk()'
grep -n 'export const createdAtOf' src/surface.ts && grep -n 'publicView' src/types.ts \
  && grep -n 'placedAppend' src/store-do.ts && grep -n 'export function withPlacement' src/surface.ts \
  && grep -n 'PUBLIC_ROOM_URL_BASE = "https://bellman.sh/r/"' src/codes.ts
```

Expected: each prints a line. A missing one is a stop: tell the lead which of room pages Part 1, surface placement or public rooms 2a has not merged. All three edit `src/store-do.ts`, and this plan's `approveProposal` sits beside the methods they change.

- [ ] **Setup 2: Install and verify.** `npm ci && npm run verify`. Expected: green.
- [ ] **Setup 3: Rerun the predicates** above and compare with the table. Stop and tell the lead on a difference.
- [ ] **Setup 4: Measure the tool listing before** (ARCHITECTURE section 11's method), for Task 10. Use `list-tools.mts` and `count-tools.py` from room pages' Setup 3 (`docs/superpowers/plans/2026-10-18-room-pages.md`, on trunk by now) under `node_modules/.cache/bellman-measure/`, then run `npm run build:ui && npx tsx node_modules/.cache/bellman-measure/list-tools.mts "$PWD" | python3.13 -I node_modules/.cache/bellman-measure/count-tools.py` and keep the output.

### Task 1: The `topic` preset

**Files:**
- Modify: `src/types.ts` (`PresetName`), `src/manifest.ts` (`PRESET_NAMES`, `PRESETS`, `BUILTIN_DESCRIPTIONS`, `isTopicRoom`), `src/tools/start.ts` (the description), `plugin/skills/room-manifest/SKILL.md`; regenerated: `docs-site/src/content/docs/reference/tools/bellman_start.md`
- Test: `tests/manifest.test.ts`, `tests/presets.test.ts`, `tests/http-presets.test.ts`, `tests/http-rooms.test.ts`, `tests/tools/invite.test.ts`

**Interfaces:**
- Produces: `"topic"` in `PresetName` and `PRESET_NAMES` (after `social`); `resolveManifest({ room, preset: "topic", public? })` expands per D1; `builtinPresets()` lists it fifth; in `src/manifest.ts`, `export const isTopicRoom = (m: Pick<RoomManifest, "preset">): boolean => m.preset === "topic";`, which every later task asks (R1).

- [ ] **Step 1: Write the failing tests**

`tests/manifest.test.ts`: the unknown-preset case's pattern becomes `/pair, swarm, review, social, topic/`; the `catalog: Record<PresetName, …>` gains

```ts
    topic: {
      maintainer: ["send", "invite", "revoke", "request_actions", "respond_actions", "write_surface"],
      contributor: ["send", "request_actions"],
    },
```

and, after the social host cases, a new block (`isTopicRoom` joins the import from `../src/manifest.js`):

```ts
describe("the topic preset (topic rooms spec, D1)", () => {
  const topic = () => resolveManifest({ room: "mcp", purpose: "What agents learned about MCP", preset: "topic", public: true });

  it("expands to a swarm room: maintainers hold all six verbs, contributors hold send and request_actions", () => {
    const m = topic();
    expect(m).toMatchObject({ mode: "swarm", preset: "topic", public: true, host: null, heartbeatOnMs: null, housekeeping: null });
    expect(Object.keys(m.roles).sort()).toEqual(["contributor", "maintainer"]);
    expect([...m.roles.maintainer.can].sort()).toEqual([...VERBS].sort());
    expect(m.roles.contributor.can).toEqual(["send", "request_actions"]);
    expect(isTopicRoom(m)).toBe(true);
    expect(isTopicRoom(resolveManifest({ room: "r", preset: "swarm" }))).toBe(false);
  });

  it("seats its creator as a maintainer and a newcomer as a contributor, and describes both for the panel", () => {
    const m = topic();
    expect([m.creatorRole, m.defaultRole]).toEqual(["maintainer", "contributor"]);
    expect(m.roles.maintainer.description).toBe("approves proposals, writes and restores cards, and controls who joins");
    expect(m.roles.contributor.description).toBe("proposes cards and talks with the room");
  });

  it("is public only when the cite says so", () => {
    expect(resolveManifest({ room: "r", preset: "topic" }).public).toBe(false);
  });

  // R2: a page does not tick. Three rules that already exist refuse it, and this pins them for topic.
  it("refuses a cite that sets a heartbeat in either spelling, or a host, because a page does not tick", () => {
    expect(() => resolveManifest({ room: "r", preset: "topic", heartbeat: "1h" }))
      .toThrow('heartbeat: the "topic" preset has no host, so a cite of it cannot set a cadence');
    expect(() => resolveManifest({ room: "r", preset: "topic", heartbeat_on: "1h" })).toThrow(/no host/);
    expect(() => resolveManifest({ room: "r", preset: "topic", host: { role: "host" } } as never)).toThrow('Unrecognized key: "host"');
  });

  it("hands each room its own roles, not the catalog's", () => {
    topic().roles.contributor.can.push("write_surface");
    expect(topic().roles.contributor.can).toEqual(["send", "request_actions"]);
  });
});
```

`tests/presets.test.ts`: the `it.each(["pair", "swarm", "review", "social"])` over built-in names gains `"topic"`; "lists the four built-ins in a saved preset's form…" becomes "lists the five built-ins…" and its list gains `"topic"` (the clone loop saves a `my_topic` under a new name, which pins that the topic roles validate as an authored preset); add:

```ts
  it("shows topic as a swarm of maintainers and contributors with no host and no beat", () => {
    const topic = builtinPresets().find((p) => p.name === "topic")!;
    expect(topic).toMatchObject({ mode: "swarm", heartbeat: null, host: null, default_role: "contributor", creator_role: "maintainer" });
    expect(Object.keys(topic.roles).sort()).toEqual(["contributor", "maintainer"]);
  });
```

`tests/http-presets.test.ts`: "list the four built-ins expanded…" becomes "…five…" with `"topic"` last in its list, and beside the `social` precedent (R3) a twin:

```ts
  /** `topic` became a built-in after saved presets shipped, as `social` did (R3). */
  it("refuse topic as a built-in's name, and still list and delete one saved under it before", async () => {
    const refused = (await put(DEV_KEY.jesse, "topic"))!;
    expect(refused.status).toBe(409);
    expect(await bodyOf(refused)).toMatchObject({ error: "builtin" });
    await store.putPreset("u_jesse", {
      name: "topic", description: null, mode: "pair", heartbeat_on: null, housekeeping: null,
      roles: { solo: { can: ["send"], description: null, reports: false } },
      default_role: "solo", creator_role: "solo", updated_at: "2026-10-09T12:00:00.000Z",
    } as never, MAX_PRESETS);
    expect(((await bodyOf(await call(DEV_KEY.jesse, "/presets"))).mine as { name: string }[]).map((p) => p.name)).toEqual(["topic"]);
    expect((await call(DEV_KEY.jesse, "/presets/topic", { method: "DELETE" }))!.status).toBe(204);
    expect(await store.getPreset("u_jesse", "topic")).toBeUndefined();
  });
```

`tests/http-rooms.test.ts`, in `describe("PUT /rooms/:id/host (a live room's host instructions)")` after "answers 409 for a room with no host and for a closed room…" (`resolveManifest` joins the imports):

```ts
  it("answers 409 no_host for a topic room, which has none", async () => {
    await store.createSession(session({
      id: "qs_topic", manifest: resolveManifest({ room: "mcp", preset: "topic", public: true }),
      members: [member({ roomRole: "maintainer" })],
    }));
    const res = (await set(DEV_KEY.jesse, { instructions: "Ask a question." }, {}, "qs_topic"))!;
    expect([res.status, (await bodyOf(res)).error]).toEqual([409, "no_host"]);
  });
```

`tests/tools/invite.test.ts`, beside the permanent-code cases (`startRoom` from `../helpers/flows.js` and `manifestFixture` from `../helpers/fixtures.js`, if the file does not import them):

```ts
  it("seats a topic room's contributors through the permanent code, and refuses it for a maintainer", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    const { sessionId, memberId } = await startRoom(jesse, manifestFixture({ preset: "topic", public: true }));
    const door = await jesse.call("bellman_invite", { session_id: sessionId, member_id: memberId, permanent: true });
    expect(door.isError, door.text).toBe(false);
    expect(door.data).toMatchObject({ role: "contributor", permanent: true, join_code_expires_at: null });
    const asked = await jesse.call("bellman_invite", { session_id: sessionId, member_id: memberId, permanent: true, role: "maintainer" });
    expect(asked.isError).toBe(true);
    expect(asked.text).toContain(`a permanent code seats only the room's default role, "contributor"`);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/manifest.test.ts tests/presets.test.ts tests/http-presets.test.ts tests/http-rooms.test.ts tests/tools/invite.test.ts tests/room-manifest-skill.test.ts`
Expected: FAIL. `topic` is an unknown preset (`unknown preset "topic" (valid: pair, swarm, review, social)`), `isTopicRoom` is not exported, and the typecheck of `catalog: Record<PresetName, …>` names the missing key.

- [ ] **Step 3: Implement**

- `src/types.ts`: `PresetName` gains `"topic"`.
- `src/manifest.ts`: `PRESET_NAMES` gains `"topic"`; `isTopicRoom` as in Interfaces, with a comment saying R1; `PRESETS.topic` is `mode: "swarm"`, `roles: { maintainer, contributor }` built with `role(can, description)` and the verbs and the two description strings of Global Constraints, `defaultRole: "contributor"`, `creatorRole: "maintainer"`, `host: null`. `BUILTIN_DESCRIPTIONS.topic`: `"Maintainers who approve what contributors propose and write and restore the cards, and contributors who propose cards and talk with the room."`
- `src/tools/start.ts`: in the description, `preset: "pair" | "swarm" | "review" | "social"` gains `| "topic"`, and "the swarm and social presets make swarm rooms" reads "the swarm, social and topic presets make swarm rooms". Nothing else in the tool changes.
- `plugin/skills/room-manifest/SKILL.md` (its test requires a section for every preset): the frontmatter description's "pair/swarm/review/social presets" gains `/topic`; Step 1's table gains the row `| A public room kept by maintainers and proposed to by contributors | preset: topic |`; Step 2a's comment reads `# pair | swarm | review | social | topic`; and after the `social` table, before `## Step 2b`:

```markdown
**`topic`** — mode `swarm`. A room that holds what agents learned about one subject, kept
by people. A contributor proposes a card with `bellman_send` (an `action_request` whose
payload is `{ kind: "surface_proposal", item, base }`); a maintainer's human approves it,
and the approval writes the card. A text or diagram card needs an http or https link in its
body, a member holds three open proposals, and a proposal lives seven days. A maintainer can
restore any earlier version of a card with `{ key, restore: <cursor> }`. The preset has no
host and no `heartbeat`: a cite that sets either is refused. Cite it with `public: true` for a
room anyone can read; its permanent code seats contributors.

| Role | Can | |
|---|---|---|
| `maintainer` | send, invite, revoke, request_actions, respond_actions, write_surface | creator |
| `contributor` | send, request_actions | default |
```

- [ ] **Step 4: Run them, then the drift test, then regenerate**

Run: `npx vitest run tests/manifest.test.ts tests/presets.test.ts tests/http-presets.test.ts tests/http-rooms.test.ts tests/tools/invite.test.ts tests/room-manifest-skill.test.ts && npm run typecheck`
Expected: PASS.

Run: `npx vitest run tests/docs-reference.test.ts`
Expected: FAIL, "run npm run docs:gen", for `bellman_start`.

Run: `npm run docs:gen && npx vitest run tests/docs-reference.test.ts && jj diff --stat`
Expected: PASS; the diff names `docs-site/src/content/docs/reference/tools/bellman_start.md` and no other generated page.

- [ ] **Step 5: Commit**

```bash
jj commit -m "The topic preset: maintainers who approve and restore, contributors who propose, no host and no heartbeat"
```

### Task 2: A proposal lives seven days in a topic room

**Files:**
- Modify: `src/action-state.ts`, `src/tools/sync.ts`, `src/rooms.ts` (`requestWindow` moves here)
- Test: `tests/action-state.test.ts`, `tests/tools/proposals.test.ts` (new), `tests/helpers/flows.ts` (`topicRoom`)

**Interfaces:**
- Consumes: `isTopicRoom` (Task 1).
- Produces, in `src/action-state.ts`:

```ts
/** A topic room's contribution: the `kind` of an action request's payload that proposes a card (topic rooms spec, D2). */
export const PROPOSAL_KIND = "surface_proposal";
/** Seven days: how long a topic room's proposal stays open before it reads `expired` (D3). */
export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60_000;
export const isProposalPayload = (payload: unknown): boolean;
/** How long `e` stays answerable: `PROPOSAL_TTL_MS` for a proposal in a topic room, `ACTION_REQUEST_TTL_MS` for everything else (R9). */
export function requestTtlMs(e: Pick<SessionEvent, "payload">, topic: boolean): number;
export function actionStates(events: readonly SessionEvent[], now: number, topic?: boolean): Map<number, ActionState>;
export function outstandingFor(events: readonly SessionEvent[], memberId: string, now: number, topic?: boolean): OutstandingRequest[];
/** How many proposals `memberId` holds open at `now`, read from the log in a topic room. */
export function openProposalsOf(events: readonly SessionEvent[], memberId: string, now: number): number;
```

  `topic` defaults to false, so every existing caller reads as before. In `src/rooms.ts`: `export async function requestWindow(store: BellmanStore, sessionId: string, since: number): Promise<SessionEvent[]>`, moved from `src/tools/sync.ts` unchanged.
- Produces, in `tests/helpers/flows.ts`:

```ts
/** A public topic room: jesse is its maintainer, who allows action requests, and a stranger joined through the permanent code as a contributor who allows none. */
export interface TopicRoom {
  maintainer: Peer; maintainerId: string; contributor: Peer; contributorId: string; sessionId: string; code: string;
}
export async function topicRoom(h: Harness, over?: { maintainerCapabilities?: string[] }): Promise<TopicRoom>;
```

  `topicRoom` starts `manifestFixture({ preset: "topic", public: true })` as `DEV_KEY.jesse` with `capabilities` `over.maintainerCapabilities ?? ["read_context", "receive_messages", "request_actions"]`, issues the permanent code with `bellman_invite`, and joins `DEV_KEY.outsider` through it with `joinWith(contributor, code)` (its default capabilities grant `read_context` and `receive_messages` only). Each call is checked with `expect(…isError, ….text).toBe(false)`.

- [ ] **Step 1: Write the failing tests**

`tests/action-state.test.ts` (`PROPOSAL_TTL_MS` and `openProposalsOf` join the import from `../src/action-state.js`):

```ts
describe("a topic room's proposals (topic rooms spec, D3)", () => {
  const proposal = (cursor: number, over: Partial<SessionEvent> = {}) =>
    request(cursor, { payload: { kind: "surface_proposal", item: { key: "k", remove: true }, base: 0 }, ...over });

  it("keeps a proposal outstanding for seven days and expires it after, where the room is a topic room", () => {
    expect(actionStates([proposal(1)], T0 + PROPOSAL_TTL_MS, true).get(1)).toBe("outstanding");
    expect(actionStates([proposal(1)], T0 + PROPOSAL_TTL_MS + 1, true).get(1)).toBe("expired");
  });

  // R9: elsewhere a surface_proposal is an ordinary request, and any other request is thirty minutes everywhere.
  it("keeps thirty minutes for any other request in a topic room, and for a proposal's payload in any other room", () => {
    expect(actionStates([request(1)], T0 + ACTION_REQUEST_TTL_MS + 1, true).get(1)).toBe("expired");
    expect(actionStates([proposal(1)], T0 + ACTION_REQUEST_TTL_MS + 1).get(1)).toBe("expired");
    expect(actionStates([proposal(1)], T0 + ACTION_REQUEST_TTL_MS + 1, false).get(1)).toBe("expired");
  });

  it("lets an answer that comes after the seven days still answer it", () => {
    expect(actionStates([proposal(1), response(2, 1, true)], T0 + PROPOSAL_TTL_MS + 60_000, true).get(1)).toBe("answered");
  });

  it("lists a proposal while it is open, with an expires_at a week on", () => {
    const at = T0 + 2 * 60 * 60_000;
    expect(outstandingFor([proposal(1)], "m_b", at, true)).toEqual([
      expect.objectContaining({ cursor: 1, mine: false, expires_at: new Date(T0 + PROPOSAL_TTL_MS).toISOString() }),
    ]);
    expect(outstandingFor([proposal(1)], "m_b", at)).toEqual([]);
  });

  it("counts a member's open proposals: an answered, a declined and an expired one are not open, nor is anyone else's", () => {
    const events = [
      proposal(1), proposal(2), proposal(3), proposal(4, { fromMemberId: "m_c" }),
      response(5, 2, true), response(6, 3, false),
    ];
    expect(openProposalsOf(events, "m_a", T0)).toBe(1);
    expect(openProposalsOf(events, "m_a", T0 + PROPOSAL_TTL_MS + 1)).toBe(0);
    expect(openProposalsOf(events, "m_c", T0)).toBe(1);
  });
});
```

`tests/tools/proposals.test.ts` (new):

```ts
/**
 * Proposals in a topic room (topic rooms spec, D2 to D4): a contributor's action_request whose payload is
 * { kind: "surface_proposal", item, base }. This file holds how long one lives (Task 2) and what bellman_send
 * checks before one is sent (Task 4).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pairUp, topicRoom, type TopicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness, type Peer } from "../helpers/harness.js";
import { manifestFixture } from "../helpers/fixtures.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { vi.useRealTimers(); await h.close(); });

/** A text card with the source D4 asks for. */
const card = (over: Record<string, unknown> = {}) => ({
  key: "tools", kind: "text", title: "Tools",
  body: "A server exposes tools by name. See https://modelcontextprotocol.io/specification/server/tools", ...over,
});
const propose = (r: TopicRoom, over: Record<string, unknown> = {}) =>
  r.contributor.call("bellman_send", {
    session_id: r.sessionId, member_id: r.contributorId, type: "action_request",
    payload: { kind: "surface_proposal", item: card(), base: 0, ...over },
  });
const sync = (peer: Peer, sessionId: string, memberId: string) =>
  peer.call("bellman_sync", { session_id: sessionId, member_id: memberId, since_cursor: 0 });
type Outstanding = { cursor: number; mine: boolean }[];

describe("how long a proposal stays open (D3)", () => {
  it("keeps one outstanding in bellman_sync for a week in a topic room, in both directions, while a plain request lapses in half an hour", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 2 * 60 * 60_000);
    const asked = await propose(r);
    const plain = await r.contributor.call("bellman_send", {
      session_id: r.sessionId, member_id: r.contributorId, type: "action_request", payload: { ask: "run it" },
    });
    vi.useRealTimers();
    expect(asked.isError, asked.text).toBe(false);
    expect(plain.isError, plain.text).toBe(false);

    const theirs = await sync(r.maintainer, r.sessionId, r.maintainerId);
    const mine = await sync(r.contributor, r.sessionId, r.contributorId);
    expect(theirs.data.outstanding as Outstanding).toEqual([expect.objectContaining({ cursor: asked.data.cursor, mine: false })]);
    expect(mine.data.outstanding as Outstanding).toEqual([expect.objectContaining({ cursor: asked.data.cursor, mine: true })]);
  });

  it("expires it after seven days", async () => {
    const r = await topicRoom(h);
    vi.setSystemTime(Date.now() - 8 * 24 * 60 * 60_000);
    expect((await propose(r)).isError).toBe(false);
    vi.useRealTimers();
    expect((await sync(r.maintainer, r.sessionId, r.maintainerId)).data.outstanding).toBeUndefined();
  });

  // R9: a payload that only says surface_proposal is an ordinary request anywhere else.
  it("keeps thirty minutes for the same payload in a room that is not a topic room", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    vi.setSystemTime(Date.now() - 2 * 60 * 60_000);
    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request",
      payload: { kind: "surface_proposal", item: card(), base: 0 },
    });
    vi.useRealTimers();
    expect(asked.isError, asked.text).toBe(false);
    expect((await sync(p.creator, p.sessionId, p.creatorMemberId)).data.outstanding).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/action-state.test.ts tests/tools/proposals.test.ts`
Expected: FAIL. `PROPOSAL_TTL_MS` and `openProposalsOf` are not exported, `topicRoom` does not exist (add it to `tests/helpers/flows.ts` first, from its Interfaces, so the file runs), and with it in place the week-long case finds no `outstanding`: the room reads half an hour.

- [ ] **Step 3: Implement**

- `src/action-state.ts`: the exports in Interfaces. `actionStates` takes the deadline from `requestTtlMs(e, topic)`; `outstandingFor` passes `topic` through and takes `expires_at` from the same function; `openProposalsOf` counts the member's own `action_request`s that are proposals and read `outstanding` at `now` with `topic` true. The module's doc says the deadline is a function of the request and the room's kind, still derived and never stored.
- `src/rooms.ts`: `requestWindow` moves here, exported, with its `ponytail:` comment.
- `src/tools/sync.ts`: `const topic = isTopicRoom(answering.manifest)` where the outstanding block starts; `ttl` is `PROPOSAL_TTL_MS` when `topic`, else `ACTION_REQUEST_TTL_MS`. `askedInSlice` asks `Date.now() <= e.at + requestTtlMs(e, topic)`; `mayHaveOutstanding` and the `requestWindow(s, session_id, Date.now() - ttl)` use `ttl`; `outstandingFor(visible, member_id, Date.now(), topic)`. The comment above them, which says a request's whole life is half an hour, says so for a room that is not a topic room and gives the topic room's seven days (R10). Add `// ponytail: a topic room reads up to seven days of its log per poll while a proposal under a week old exists; the upgrade is the oldest open proposal's cursor kept on the record.`

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/action-state.test.ts tests/tools/proposals.test.ts tests/tools/exchange.test.ts tests/delivery-paths.test.ts && npm run typecheck`
Expected: PASS. The exchange file's half-hour cases are the control: a room that is not a topic room reads as before.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A proposal in a topic room stays open for seven days, and bellman_sync reads a window as long as that"
```

### Task 3: A proposal's shape and its source rule

**Files:**
- Create: `src/proposal.ts`
- Test: `tests/proposal.test.ts`

**Interfaces:**
- Consumes: `PROPOSAL_KIND` (Task 2), `describeIssue` (`src/manifest.ts`), `SurfaceWrite` (`src/surface.ts`).
- Produces, in `src/proposal.ts` (runtime-free, like `src/surface.ts`):

```ts
/** The open proposals one member may hold in a topic room (spec D3). */
export const MAX_OPEN_PROPOSALS = 3;
/** A proposal's payload read for its shape alone: `{ kind, item, base }` and nothing else. The item is the surface's to check. */
export function readProposal(payload: unknown): { ok: true; item: unknown; base: number } | { ok: false; reason: string };
/** Whether `body` holds an http or https URL with a host, read as text (R8). */
export function hasSourceLink(body: string): boolean;
/** The source rule (D4, R8): null when `write` meets it or is not asked for it, else the refusal. */
export function sourceRefusal(write: SurfaceWrite): string | null;
```

- [ ] **Step 1: Write the failing tests**

`tests/proposal.test.ts`:

```ts
/**
 * A topic room's proposal (topic rooms spec, D2 and D4): the payload's shape, and the source a text or diagram
 * card must link. Pure; the room-level rules are tests/tools/proposals.test.ts.
 */
import { describe, expect, it } from "vitest";
import { hasSourceLink, readProposal, sourceRefusal } from "../src/proposal.js";
import type { SurfaceWrite } from "../src/surface.js";
import type { SurfaceItem } from "../src/types.js";

const item = { key: "tools", kind: "text", title: "Tools", body: "See https://modelcontextprotocol.io/specification" };

describe("readProposal", () => {
  it("reads { kind, item, base } and hands the item on unread", () => {
    expect(readProposal({ kind: "surface_proposal", item, base: 12 })).toEqual({ ok: true, item, base: 12 });
    expect(readProposal({ kind: "surface_proposal", item: { key: "tools", remove: true }, base: 0 })).toMatchObject({ ok: true, base: 0 });
  });

  it.each([
    ["another kind", { kind: "surface_write", item, base: 0 }, "kind"],
    ["no item", { kind: "surface_proposal", base: 0 }, "item"],
    ["an item that is not an object", { kind: "surface_proposal", item: "tools", base: 0 }, "item"],
    ["no base", { kind: "surface_proposal", item }, "base"],
    ["a negative base", { kind: "surface_proposal", item, base: -1 }, "base"],
    ["a fractional base", { kind: "surface_proposal", item, base: 1.5 }, "base"],
    ["a base that is text", { kind: "surface_proposal", item, base: "0" }, "base"],
    ["a key it does not name", { kind: "surface_proposal", item, base: 0, note: "why" }, "note"],
  ])("refuses %s, naming the field", (_why, payload, field) => {
    const out = readProposal(payload);
    expect(out.ok).toBe(false);
    const reason = out.ok ? "" : out.reason;
    expect(reason).toContain("surface_proposal");
    expect(reason).toContain(field);
  });
});

describe("the source rule (D4, R8)", () => {
  const write = (body: string, kind: SurfaceItem["kind"] = "text"): SurfaceWrite => ({
    key: "k", item: { key: "k", kind, title: null, body, ends: null, placement: null, blob: null, shape: null },
  });

  it.each([
    "See https://modelcontextprotocol.io/specification/server/tools for the shape.",
    "[the spec](https://modelcontextprotocol.io/specification)",
    "Source: http://localhost:3900/docs.",
    "no markup at all, just https://example.com/a?b=c#d",
    'flowchart LR\n  A --> B\n  click A "https://example.com/a"',
  ])("accepts a card whose body carries a link, wherever it sits: %j", (body) => {
    expect(hasSourceLink(body)).toBe(true);
    expect(sourceRefusal(write(body))).toBeNull();
    expect(sourceRefusal(write(body, "diagram"))).toBeNull();
  });

  it.each(["", "no link here", "example.com/spec", "ftp://example.com/file", "https://", "see https:// and http://.", "mailto:a@b.c"])(
    "refuses a text or diagram card with no http or https link: %j",
    (body) => {
      expect(hasSourceLink(body)).toBe(false);
      for (const kind of ["text", "diagram"] as const) expect(sourceRefusal(write(body, kind)), kind).toContain("a card needs a source");
    },
  );

  it("asks nothing of a link, which is its own source, of a removal, or of a kind with no prose", () => {
    expect(sourceRefusal({ key: "k", item: null })).toBeNull();
    expect(sourceRefusal(write("not read", "link"))).toBeNull();
    for (const kind of ["file", "image", "html", "shape", "connector"] as const) expect(sourceRefusal(write("", kind)), kind).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/proposal.test.ts`
Expected: FAIL: `../src/proposal.js` does not exist.

- [ ] **Step 3: Implement `src/proposal.ts`**

`readProposal` is a strict zod object (`kind` the literal `PROPOSAL_KIND`, `item` a non-null non-array object, `base` an integer of 0 or more) whose refusal reads `surface_proposal must be { kind: "surface_proposal", item, base }: <describeIssue>`. `hasSourceLink` takes every run of non-space characters that follows an `http://` or `https://` (stopping at `<`, `>`, a quote or a backtick), drops trailing `.,;:!?)]}` from each, and accepts the body when one parses with `new URL` as `http:` or `https:` with a non-empty `hostname`. `sourceRefusal` returns null for a removal or for any kind but `text` and `diagram`; otherwise `a card needs a source: put at least one http:// or https:// link in its body` when `hasSourceLink(item.body ?? "")` is false. The file's header comment says it is runtime-free and what Task 6 adds to it (`decideApproval`).

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/proposal.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A proposal's payload has a shape, and a text or diagram card must link a source"
```

### Task 4: A proposal at `bellman_send`

**Files:**
- Modify: `src/rooms.ts` (`NO_ANSWERER`, `settleBlob`, `checkProposal`, and `writeSurface` calls `settleBlob`), `src/tools/send.ts`
- Test: `tests/tools/proposals.test.ts`

**Interfaces:**
- Consumes: `readProposal`, `sourceRefusal`, `MAX_OPEN_PROPOSALS` (Task 3); `isProposalPayload`, `openProposalsOf`, `PROPOSAL_TTL_MS`, `requestWindow` (Task 2); `isTopicRoom` (Task 1); `normalizeSurfaceWrite`, `surfaceCursor`.
- Produces, in `src/rooms.ts`:

```ts
export const NO_ANSWERER: string; // "no active member can answer a proposal: every seat that holds respond_actions has left. Ask the room's creator to seat a maintainer."
/** The blob a write names, settled against the room's object and the kind's type rule: the write with its blob's metadata filled, or the refusal. `writeSurface`'s inline step, shared (R14). */
export async function settleBlob(blobs: BlobStore, sessionId: string, write: SurfaceWrite, blobId: string): Promise<RoomResult<SurfaceWrite>>;
/** Whether `me` may send this proposal now (R7): its shape, its item, its source, its base, its blob and the cap of three. */
export async function checkProposal(
  store: BellmanStore, blobs: BlobStore, session: StoredSession, me: Member, payload: unknown, now?: number,
): Promise<RoomResult<null>>;
```

- [ ] **Step 1: Write the failing tests**

`tests/tools/proposals.test.ts`, after the first block (`joinWith` joins the import from `../helpers/flows.js`):

```ts
const eventCount = async (r: TopicRoom) => (await h.store.eventsAfter(r.sessionId, 0)).length;
const say = (r: TopicRoom, text: string) =>
  r.contributor.call("bellman_send", { session_id: r.sessionId, member_id: r.contributorId, type: "message", payload: { text } });
const decline = (r: TopicRoom, cursor: unknown) =>
  r.maintainer.call("bellman_send", {
    session_id: r.sessionId, member_id: r.maintainerId, type: "action_response", ref_id: String(cursor), payload: { approved: false },
  });

describe("sending a proposal (D2 to D4)", () => {
  it("reaches the maintainers from a contributor who granted nothing, and writes nothing to the surface", async () => {
    const r = await topicRoom(h);
    const out = await propose(r);
    expect(out.isError, out.text).toBe(false);
    expect(String(out.data.note)).toContain("HUMAN must approve");
    expect(await h.store.surfaceOf(r.sessionId)).toEqual([]);
    expect((await h.store.eventsAfter(r.sessionId, 0)).at(-1)).toMatchObject({
      type: "action_request", fromMemberId: r.contributorId, payload: { kind: "surface_proposal", base: 0, item: card() },
    });
  });

  // R6: the grant is asked of the seats that can answer, and a contributor who granted nothing blocks nobody.
  it("is refused naming a maintainer who did not grant request_actions", async () => {
    const r = await topicRoom(h, { maintainerCapabilities: ["read_context", "receive_messages"] });
    const before = await eventCount(r);
    const out = await propose(r);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("did not grant request_actions");
    expect(out.text).toContain("jesse@codenerd");
    expect(await eventCount(r)).toBe(before);
  });

  it("is refused when no active seat can answer it", async () => {
    const r = await topicRoom(h);
    const second = await h.connect(DEV_KEY.peer);
    expect((await joinWith(second, r.code)).isError).toBe(false);
    expect((await r.maintainer.call("bellman_leave", { session_id: r.sessionId, member_id: r.maintainerId })).isError).toBe(false);
    const out = await propose(r);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("no active member can answer a proposal");
  });

  it.each([
    ["no base", { base: undefined }, "base"],
    ["a negative base", { base: -1 }, "base"],
    ["a key the payload does not name", { note: "why" }, "note"],
    ["a base ahead of the room's surface cursor", { base: 5 }, "ahead of the room's surface cursor"],
    ["an item the surface refuses", { item: card({ kind: "link", body: "not a url" }) }, "http or https URL"],
    ["a text card with no source", { item: card({ body: "no link here" }) }, "a card needs a source"],
    ["a diagram with no source", { item: card({ kind: "diagram", body: "flowchart LR\n  A --> B" }) }, "a card needs a source"],
  ])("refuses %s, and appends nothing", async (_why, over, words) => {
    const r = await topicRoom(h);
    const before = await eventCount(r);
    const out = await propose(r, over);
    expect(out.isError, out.text).toBe(true);
    expect(out.text).toContain(words);
    expect(await eventCount(r)).toBe(before);
  });

  it("takes a link card, which is its own source, and a removal", async () => {
    const r = await topicRoom(h);
    expect((await propose(r, { item: { key: "spec", kind: "link", title: "The spec", body: "https://modelcontextprotocol.io/specification" } })).isError).toBe(false);
    expect((await propose(r, { item: { key: "old", remove: true } })).isError).toBe(false);
  });

  it("refuses a file card whose blob is not in the room (R15), naming it", async () => {
    const r = await topicRoom(h);
    const out = await propose(r, { item: { key: "pic", kind: "file", blob: { id: "a".repeat(32) } } });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`no blob ${"a".repeat(32)} has been uploaded to this room`);
  });
});

describe("the limit on open proposals (D3)", () => {
  it("holds a member to three: the fourth is refused naming three, another member's places are their own, and an answer frees one", async () => {
    const r = await topicRoom(h);
    const second = await h.connect(DEV_KEY.peer);
    const joined = await joinWith(second, r.code);
    const asked: number[] = [];
    for (const key of ["a", "b", "c"]) asked.push(Number((await propose(r, { item: card({ key }) })).data.cursor));

    const fourth = await propose(r, { item: card({ key: "d" }) });
    expect(fourth.isError).toBe(true);
    expect(fourth.text).toContain("3 open proposals");

    const theirs = await second.call("bellman_send", {
      session_id: r.sessionId, member_id: String(joined.data.member_id), type: "action_request",
      payload: { kind: "surface_proposal", item: card({ key: "e" }), base: 0 },
    });
    expect(theirs.isError, theirs.text).toBe(false);

    expect((await decline(r, asked[0])).isError).toBe(false);
    expect((await propose(r, { item: card({ key: "d" }) })).isError).toBe(false);
  });

  // The contributor came through the permanent code: a stranger, six sends a minute (abuse protections D5).
  it("counts a proposal under the send limit, and a refused one spends no place", async () => {
    const r = await topicRoom(h);
    for (const key of ["a", "b", "c"]) expect((await propose(r, { item: card({ key }) })).isError, key).toBe(false);
    expect((await propose(r, { item: card({ key: "d" }) })).text).toContain("3 open proposals");
    for (const i of [1, 2, 3]) expect((await say(r, `m${i}`)).isError, `message ${i}`).toBe(false);
    const over = await say(r, "one too many");
    expect(over.isError).toBe(true);
    expect(over.data).toMatchObject({ error: "rate_limited" });
  });

  it("cannot be sent by an account the creator evicted: the handle has left, which needs no check of its own", async () => {
    const r = await topicRoom(h);
    const gone = await r.maintainer.call("bellman_evict", { session_id: r.sessionId, member_id: r.contributorId, ban: "room" });
    expect(gone.isError, gone.text).toBe(false);
    const out = await propose(r);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("has left the session");
  });
});

describe("outside a topic room, and a seat that holds only send", () => {
  // Spec section 1: elsewhere a surface_proposal is an ordinary action request. Nothing is checked or applied.
  it("is an ordinary action request in a swarm room: not checked, nothing written to the surface", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const odd = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request",
      payload: { kind: "surface_proposal", item: 5, base: "x" },
    });
    expect(odd.isError, odd.text).toBe(false);
    expect(await h.store.surfaceOf(p.sessionId)).toEqual([]);
  });

  // The hosted seat holds exactly send (checkHost) and never calls bellman_send; a seat with that role is refused by its verb.
  it("is refused to a seat that holds only send, as the hosted seat does: the verb check names request_actions", async () => {
    const manifest = {
      room: "quiet-room", mode: "swarm", default_role: "quiet", creator_role: "lead",
      roles: { lead: { can: ["send", "invite", "request_actions", "respond_actions", "write_surface"] }, quiet: { can: ["send"] } },
    };
    const p = await pairUp(h, { manifest });
    const out = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request",
      payload: { kind: "surface_proposal", item: card(), base: 0 },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('does not hold the verb "request_actions"');
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/tools/proposals.test.ts`
Expected: FAIL. The proposals are accepted unchecked (the refusal table finds `isError` false), a contributor who granted nothing blocks the proposal in the cases that need two contributors, the fourth is accepted, and the send-limit case has no cap to spend a place on.

- [ ] **Step 3: Implement**

- `src/rooms.ts`: `settleBlob` is the blob step of `writeSurface` moved out whole (`blobs.head`, the image and html type refusals, the filled `blob`), and `writeSurface` calls it. `checkProposal`, in this order: `readProposal` (refusal `invalid`); `normalizeSurfaceWrite(read.item)`, its refusal prefixed `surface_proposal item: `; `sourceRefusal`, prefixed `surface_proposal "<key>": `; `read.base > surfaceCursor(session)` refuses `surface_proposal base <n> is ahead of the room's surface cursor <m>: base is the surface_cursor you read`; `settleBlob` when the item names a blob (a refusal passes through); then `openProposalsOf(await requestWindow(store, session.id, now - PROPOSAL_TTL_MS), me.memberId, now) >= MAX_OPEN_PROPOSALS` refuses `conflict` with `you already hold ${MAX_OPEN_PROPOSALS} open proposals, the most a member may hold in a topic room. A maintainer answering one, or its seven days passing, makes room for another.` Success is `succeed(null)`.
- `src/tools/send.ts`: in the `action_request` branch, `proposing` is `isTopicRoom(session.manifest) && isProposalPayload(payload)`. The audience is `others` filtered to the roles holding `respond_actions` (`verbsOfRole`) when `proposing`, else `others`; an empty audience when `proposing` is `fail(NO_ANSWERER)`; the capability refusal reads that audience and keeps its words. After it, `if (proposing)` runs `checkProposal(s, blobs, session, me, payload)` and returns `refusal(checked)` on a failure. All of it is before `admitSend`, so a refused proposal spends no place.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/tools/proposals.test.ts tests/tools/working-surface.test.ts tests/tools/exchange.test.ts tests/tools/send-limit.test.ts && npm run typecheck`
Expected: PASS. `working-surface.test.ts` is the control for `settleBlob`'s move.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A proposal reaches the maintainers who can answer it: its shape, item, source, base and blob are checked, a member holds three open, and each counts as a send"
```

### Task 5: A card remembers who approved it, and every read names the approver

**Files:**
- Modify: `src/types.ts` (`ApprovedBy`, `SurfaceRow.approvedBy?`), `src/surface.ts` (`applySurfaceWrite`, the comments on `BlobShape` and `SurfaceItemShape`), `src/projections.ts` (`surfaceItem`), `src/store.ts` (`AppendExtras.approvedBy`, `MemoryStore.applyExtras`), `src/store-do.ts` (`extraRows`), `src/tools/surface.ts` (the description), `docs-site/src/content/docs/guides/surface.md`, `plugin/skills/canvas/SKILL.md`; regenerated: `docs-site/src/content/docs/reference/tools/bellman_surface.md`
- Test: `tests/working-surface.test.ts`, `tests/helpers/store-contract.ts`, `tests/http-public.test.ts`, `tests/http-rooms.test.ts`

**Interfaces:**
- Produces: `export interface ApprovedBy { memberId: string; label: string }` in `src/types.ts`; `SurfaceRow.approvedBy?: ApprovedBy`; `applySurfaceWrite(existing, event, write, approvedBy?: ApprovedBy)`; `AppendExtras.approvedBy?: ApprovedBy`, stamped on the row of this append's `surface` write; `surfaceItem(r).data.approved_by: { member_id: string; label: string } | null`, after `changed_at`. Tasks 6 and 8 pass `approvedBy`; Part 2 reads `approved_by`.

- [ ] **Step 1: Write the failing tests**

`tests/working-surface.test.ts`, in `describe("applySurfaceWrite")`:

```ts
  // Topic rooms spec, D2: the row names who approved it beside who wrote it, and a write with no approver drops the old one (R20).
  it("stamps approvedBy when it is given, and a later write without one drops it", () => {
    const approver = { memberId: "m_maint", label: "jesse@codenerd" };
    const approved = applySurfaceWrite(undefined, event(5), { key: "plan", item: item() }, approver) as SurfaceRow;
    expect(approved).toMatchObject({ byMemberId: "m_creator", approvedBy: approver });
    const rewritten = applySurfaceWrite(approved, event(9), { key: "plan", item: item({ body: "revised" }) }) as SurfaceRow;
    expect("approvedBy" in rewritten).toBe(false);
  });
```

and in `describe("the trust split (D9)")`:

```ts
  it("names who approved the item, as the author is named, and reads null for a row nobody approved", () => {
    const approved = { ...row, approvedBy: { memberId: "m_maint", label: "jesse@codenerd" } };
    expect(surfaceItem(approved).data).toMatchObject({ approved_by: { member_id: "m_maint", label: "jesse@codenerd" } });
    expect(surfaceItem(row).data.approved_by).toBeNull();
  });
```

`tests/helpers/store-contract.ts`, in `describe("the surface rows")`, after "replaces the row on a later write to the same key":

```ts
      // Topic rooms spec, D2, in both stores: the approver rides the append beside the write.
      it("keeps who approved a row beside who wrote it, and a later write without an approver drops it", async () => {
        const s = session({});
        await store.createSession(s);
        const approver = { memberId: "m_maint", label: "maint@codenerd" };

        const approved = (await store.appendEvent(s.id, wrote(), { surface: { key: "plan", item: plan() }, approvedBy: approver }))!;
        expect((await store.surfaceOf(s.id))[0]).toMatchObject({ cursor: approved.cursor, byMemberId: "m_creator", approvedBy: approver });

        await store.appendEvent(s.id, wrote(plan("revised")), { surface: { key: "plan", item: plan("revised") } });
        expect("approvedBy" in (await store.surfaceOf(s.id))[0]).toBe(false);
      });
```

`tests/http-public.test.ts`, in `describe("GET /public/rooms/:id/surface")`:

```ts
  // Topic rooms spec, section 2 and R20: the approver is named as the author is, by the public name rule.
  it("names a card's approver by number, as it names its author", async () => {
    const item = { key: "plan", kind: "text" as const, title: "The plan", body: "hello", ends: null, placement: null, blob: null, shape: null };
    await store.appendEvent(
      PUB,
      { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null },
      { surface: { key: "plan", item }, approvedBy: { memberId: "m_peer", label: "peer@codenerd" } },
    );
    const { items } = (await bodyOf(await read(`/public/rooms/${PUB}/surface`))) as unknown as {
      items: { origin: { label: string }; data: { approved_by: { member_id: string; label: string } | null } }[];
    };
    expect(items[0].origin.label).toBe("member 1");
    expect(items[0].data.approved_by).toEqual({ member_id: "m_peer", label: "member 2" });
  });
```

`tests/http-rooms.test.ts`, in `describe("GET /rooms/:id/surface")` and `describe("PUT and DELETE /rooms/:id/surface/:key")`:

```ts
  it("reads a card's approver by label for a member", async () => {
    const item = { key: "plan", kind: "text" as const, title: null, body: "hello", ends: null, placement: null, blob: null, shape: null };
    await store.appendEvent(
      ROOM,
      { type: "surface", fromMemberId: "m_creator", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null },
      { surface: { key: "plan", item }, approvedBy: { memberId: "m_peer", label: "peer@codenerd" } },
    );
    const { items } = (await bodyOf(await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface`))) as unknown as { items: { data: Record<string, unknown> }[] };
    expect(items[0].data.approved_by).toEqual({ member_id: "m_peer", label: "peer@codenerd" });
  });

  // R20: read, edit, send back. The server's approver is refused by name, as cursor and at are.
  it("refuses an item sent back with approved_by, naming the field", async () => {
    const res = (await call(DEV_KEY.jesse, `/rooms/${ROOM}/surface/plan?member_id=m_creator`, {
      method: "PUT", body: { kind: "text", body: "hello", approved_by: { member_id: "m_peer", label: "peer@codenerd" } },
    }))!;
    expect(res.status).toBe(400);
    expect(String((await bodyOf(res)).error_description)).toContain("approved_by");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/working-surface.test.ts tests/store.test.ts tests/http-public.test.ts tests/http-rooms.test.ts`
Expected: FAIL: `applySurfaceWrite` ignores a fourth argument, no row holds `approvedBy`, no read carries `approved_by`. The refusal case PASSES before and after: it pins what the strict shape already does.

Run: `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts -t "who approved a row"`
Expected: the contract case FAILS in workerd.

- [ ] **Step 3: Implement**

- `src/types.ts`: `ApprovedBy` and `SurfaceRow.approvedBy?`, its JSDoc: the member whose approval put this version on the surface, or who restored it (topic rooms spec, D2 and D5); absent on a row written without one, and a later write to the key drops it (R20).
- `applySurfaceWrite` adds `...(approvedBy === undefined ? {} : { approvedBy })` to the row it returns; its JSDoc says so.
- `AppendExtras.approvedBy?: ApprovedBy`, documented beside `surface`: stamped on the row this append's `surface` write stores; not applied on a replay, as `surface` is not.
- `MemoryStore.applyExtras` and `extraRows` pass `extras.approvedBy` as the fourth argument.
- `surfaceItem`: `approved_by: r.approvedBy === undefined ? null : { member_id: r.approvedBy.memberId, label: r.approvedBy.label }` after `changed_at`, with a comment naming D2 and R20.
- `src/tools/surface.ts`: the item list in `bellman_surface`'s description ends `…, changed_at (its last change, as at), approved_by (the maintainer whose approval put this version on the surface, { member_id, label }, or null) }`.
- `src/surface.ts`: the comments on `BlobShape` and `SurfaceItemShape` say an item sent back as read is refused for `cursor`, `at`, `created_at`, `changed_at` and `approved_by`.
- `docs-site/src/content/docs/guides/surface.md`, the paragraph that begins "The payload is checked strictly", and the paragraph after the field table in `plugin/skills/canvas/SKILL.md`: the server-set fields an item carries when read are `cursor`, `at`, `created_at`, `changed_at` and `approved_by`, and an item sent back goes without those five. The guide gains one sentence: `approved_by` names the maintainer whose approval put the version there, `null` when none did.

- [ ] **Step 4: Run them, then the drift test, then regenerate**

Run: `npx vitest run tests/working-surface.test.ts tests/store.test.ts tests/http-public.test.ts tests/http-rooms.test.ts tests/projections.test.ts && npm run typecheck && npm run typecheck:worker && npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts -t "surface rows"`
Expected: PASS, the contract case in both stores.

Run: `npx vitest run tests/docs-reference.test.ts`
Expected: FAIL, "run npm run docs:gen", for `bellman_surface`.

Run: `npm run docs:gen && npx vitest run tests/docs-reference.test.ts && jj diff --stat`
Expected: PASS; the diff names `docs-site/src/content/docs/reference/tools/bellman_surface.md` and no other generated page.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A card remembers who approved it, and every read of an item names the approver"
```

### Task 6: The approval writes the card in the response's transaction, in both stores

This is the task the spec turns on. Write the contract cases first and watch each fail.

**Files:**
- Modify: `src/proposal.ts` (`decideApproval`), `src/store.ts` (`ProposalApproval`, `ApprovalWrite`, `BellmanStore.approveProposal`, `MemoryStore.approveProposal`), `src/store-do.ts` (`SessionDO.approveProposal`, `DurableObjectStore.approveProposal`)
- Test: `tests/helpers/store-contract.ts`, `tests/store-do-wiring.test.ts`

**Interfaces:**
- Consumes: `applySurfaceWrite` and `AppendExtras.approvedBy` (Task 5), `verbsOfRole`, `isTopicRoom` (Task 1), surface placement's `placedAppend` and `MemoryStore.placed`, `noteAppend`, `idempotencyKey`, `fingerprint`.
- Produces, in `src/store.ts`:

```ts
/** What `bellman_send` hands the store to approve a proposal in the response's own transaction (topic rooms spec, D2, R12). */
export interface ProposalApproval {
  /** The cursor of the `action_request` being approved. */
  requestCursor: number;
  /** The surface cursor the proposer read: the proposal's `base`. */
  base: number;
  /** The proposal's write after `resolveSurfaceWrite` settled it (blob metadata filled), or null when the tool found none to apply. */
  write: SurfaceWrite | null;
}
export type ApprovalWrite =
  | { outcome: "appended"; event: SessionEvent; written: SessionEvent | null } // `written` is the card's surface event, null when the seat applied none (R13)
  | { outcome: "replayed"; event: SessionEvent }
  | { outcome: "stale"; cursor: number }
  | { outcome: "answered"; by: string }
  | { outcome: "conflict" }
  | { outcome: "frozen" };
// BellmanStore:
approveProposal(sessionId: string, e: EventBody, key: string | null, approval: ProposalApproval): Promise<ApprovalWrite>;
```

  `e` is the `action_response` draft, exactly as `bellman_send` would hand `appendEvent`. A `key` makes it keyed as `appendEventOnce` does, and `null` unkeyed.
- Produces, in `src/proposal.ts`:

```ts
export type ApprovalDecision =
  | { kind: "answered"; by: string }                // an earlier action_response to the request exists: its sender's label
  | { kind: "record" }                              // append the response alone (R13)
  | { kind: "stale"; cursor: number }               // the key changed after base (R16)
  | { kind: "apply"; approvedBy: ApprovedBy };      // append the response, then the card
/** Pure: both stores call it with what they read in the transaction, so they cannot decide differently. Order: answered, record, stale, apply. */
export function decideApproval(input: {
  room: Pick<StoredSession, "manifest" | "members" | "surfaceCursor">;
  approverId: string;
  requestCursor: number;
  base: number;
  write: SurfaceWrite | null;
  row: SurfaceRow | undefined;          // the stored row for write.key; undefined when there is none or write is null
  after: readonly SessionEvent[];       // every event with a cursor past base, in cursor order
}): ApprovalDecision;
```

  `record` when `write` is null, the room is not a topic room, the approver is not on the roster, or the approver's role lacks `write_surface`. `stale` when `row.cursor > base`; or, with no row, when `room.surfaceCursor > base` and `after` holds a `surface` event whose payload names `write.key` (the removal), naming the latest such cursor (R16).

- [ ] **Step 1: Write the failing contract cases**

`tests/helpers/store-contract.ts` (`resolveManifest` joins the imports from `../../src/manifest.js`, `actionStates` from `../../src/action-state.js`, and `ProposalApproval` from `../../src/store.js`). After `describe("the surface rows")`:

```ts
    /**
     * Approving a proposal (topic rooms spec, D2): the response and the card are one transaction.
     * `decideApproval` in proposal.ts is the rule; these hold both stores to applying it inside the response's
     * append, where a second approval and a retry are decided.
     */
    describe("approving a proposal (topic rooms spec, D2)", () => {
      const MAINT = member({ memberId: "m_maint", userId: "u_jesse", label: "jesse@codenerd", roomRole: "maintainer" });
      const MAINT2 = member({ memberId: "m_maint2", userId: "u_second", label: "second@codenerd", roomRole: "maintainer" });
      const ADA = member({ memberId: "m_ada", userId: "u_ada", label: "ada@lovelace", roomRole: "contributor" });
      const topic = () => resolveManifest({ room: "mcp", preset: "topic", public: true });
      const room = async (over: NonNullable<Parameters<typeof session>[0]> = {}) => {
        const s = session({ manifest: topic(), members: [MAINT, MAINT2, ADA], ...over });
        await store.createSession(s);
        return s.id;
      };
      const card = (body = "See https://modelcontextprotocol.io/specification"): SurfaceItem => ({
        key: "tools", kind: "text", title: "Tools", body, ends: null, placement: { x: 0, y: 0 }, blob: null, shape: null,
      });
      const writeOf = (item: SurfaceItem | null = card()) => ({ key: "tools", item });
      const proposed = (id: string, item: SurfaceItem | { key: string; remove: true } = card(), base = 0) =>
        store.appendEvent(id, {
          type: "action_request", fromMemberId: "m_ada", fromUserId: "u_ada", fromLabel: "ada@lovelace",
          payload: { kind: "surface_proposal", item, base }, refId: null,
        }, { stampActionRequest: true });
      const answer = (cursor: number, by = MAINT): EventBody => ({
        type: "action_response", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label,
        payload: { approved: true }, refId: String(cursor),
      });
      const approve = (id: string, request: SessionEvent, over: Partial<ProposalApproval> = {}, key: string | null = null, by = MAINT) =>
        store.approveProposal(id, answer(request.cursor, by), key, { requestCursor: request.cursor, base: 0, write: writeOf(), ...over });
      const direct = (id: string, item: SurfaceItem | null, by = MAINT) =>
        store.appendEvent(id, {
          type: "surface", fromMemberId: by.memberId, fromUserId: by.userId, fromLabel: by.label,
          payload: item ?? { key: "tools", remove: true }, refId: null,
        }, { surface: { key: "tools", item } });
      const events = (id: string) => store.eventsAfter(id, 0);
      const landed = (out: Awaited<ReturnType<typeof approve>>) => {
        if (out.outcome !== "appended") throw new Error(`the approval said ${out.outcome}`);
        return out;
      };

      it("writes the response and the card together: the card authored by the proposer and approved by the approver, at the next cursor", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const out = landed(await approve(id, request));
        expect(out.event.cursor).toBe(request.cursor + 1);
        expect(out.written).toMatchObject({ type: "surface", cursor: request.cursor + 2, fromMemberId: "m_ada", fromLabel: "ada@lovelace", payload: card() });
        expect(await store.surfaceOf(id)).toEqual([expect.objectContaining({
          ...card(), cursor: out.written!.cursor, at: out.written!.at,
          byMemberId: "m_ada", byLabel: "ada@lovelace", approvedBy: { memberId: "m_maint", label: "jesse@codenerd" },
        })]);
        expect(surfaceCursor((await store.getSession(id))!)).toBe(out.written!.cursor);
        const next = (await direct(id, card("later")))!;
        expect(next.cursor, "the next append takes the cursor after the card's").toBe(out.written!.cursor + 1);
      });

      it("removes a card when a removal is approved, and the card's event says so", async () => {
        const id = await room();
        const added = (await direct(id, card()))!;
        const request = (await proposed(id, { key: "tools", remove: true }, added.cursor))!;
        const out = landed(await approve(id, request, { base: added.cursor, write: writeOf(null) }));
        expect(out.written!.payload).toEqual({ key: "tools", remove: true });
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      // Review Focus 1: another approval landed first, so the key's cursor is past base.
      it("refuses an approval whose base is behind the card, naming the card's cursor, and writes nothing", async () => {
        const id = await room();
        const first = (await proposed(id, card("First. https://example.com/1")))!;
        const second = (await proposed(id, card("Second. https://example.com/2")))!;
        const done = landed(await approve(id, first, { write: writeOf(card("First. https://example.com/1")) }));
        const before = await events(id);

        const out = await approve(id, second, { write: writeOf(card("Second. https://example.com/2")) });

        expect(out).toEqual({ outcome: "stale", cursor: done.written!.cursor });
        expect(await events(id)).toEqual(before);
        expect((await store.surfaceOf(id))[0].body).toBe("First. https://example.com/1");
        expect(actionStates(await events(id), Date.now(), true).get(second.cursor), "the proposal is still open").toBe("outstanding");
      });

      // Review Focus 5 (R16): a removal leaves no tombstone, so the log is what says the key moved.
      it("refuses an approval for a key that was removed after base, naming the removal", async () => {
        const id = await room();
        const added = (await direct(id, card()))!;
        const request = (await proposed(id, card("An edit. https://example.com/e"), added.cursor))!;
        const gone = (await direct(id, null))!;

        const out = await approve(id, request, { base: added.cursor, write: writeOf(card("An edit. https://example.com/e")) });

        expect(out).toEqual({ outcome: "stale", cursor: gone.cursor });
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      it("does not call a new card stale because another key moved", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const other: SurfaceItem = { ...card(), key: "other" };
        await store.appendEvent(id, {
          type: "surface", fromMemberId: "m_maint", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: other, refId: null,
        }, { surface: { key: "other", item: other } });
        expect((await approve(id, request)).outcome).toBe("appended");
      });

      // Review Focus 1: two approvals that meet. The tool's own check for an earlier answer reads before it appends and cannot stop this.
      it("applies one of two approvals that meet, and refuses the other as answered, with one card and one response", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const outs = await Promise.all([approve(id, request), approve(id, request, {}, null, MAINT2)]);
        expect(outs.map((o) => o.outcome).sort()).toEqual(["answered", "appended"]);
        const won = landed(outs.find((o) => o.outcome === "appended")!);
        expect(outs.find((o) => o.outcome === "answered")).toEqual({ outcome: "answered", by: won.event.fromLabel });
        const log = await events(id);
        expect(log.filter((e) => e.type === "action_response")).toHaveLength(1);
        expect(log.filter((e) => e.type === "surface")).toHaveLength(1);
        expect(await store.surfaceOf(id)).toHaveLength(1);
      });

      // Review Focus 2 (R13): the preset gives both verbs to the maintainer, so the room is built with one taken away.
      it("records the response of a seat that holds respond_actions without write_surface, and applies nothing", async () => {
        const base = topic();
        const manifest = {
          ...base,
          roles: { ...base.roles, maintainer: { ...base.roles.maintainer, can: base.roles.maintainer.can.filter((v) => v !== "write_surface") } },
        };
        const id = await room({ manifest });
        const request = (await proposed(id))!;
        const out = landed(await approve(id, request));
        expect(out.written).toBeNull();
        expect((await events(id)).map((e) => e.type)).toEqual(["action_request", "action_response"]);
        expect(await store.surfaceOf(id)).toEqual([]);
        expect(surfaceCursor((await store.getSession(id))!)).toBe(0);
        expect(actionStates(await events(id), Date.now(), true).get(request.cursor), "the derivation reads the response alone").toBe("answered");
      });

      it("records the response alone in a room that is not a topic room, though the approver holds write_surface", async () => {
        const lead = { ...MAINT, roomRole: "lead" };
        const id = await room({ manifest: resolveManifest({ room: "s", preset: "swarm" }), members: [lead, { ...ADA, roomRole: "helper" }] });
        const request = (await proposed(id))!;
        const out = landed(await approve(id, request, {}, null, lead));
        expect(out.written).toBeNull();
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      // Review Focus 1, R21: the key names the response, so a retry replays it however the room has changed.
      it("replays a keyed approval after the room changed: the same response, no second write, and no stale", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        const first = landed(await approve(id, request, {}, "ap-0001"));
        await direct(id, card("changed after"));
        const log = await events(id);

        const retry = await approve(id, request, {}, "ap-0001");

        expect(retry).toEqual({ outcome: "replayed", event: first.event });
        expect(await events(id)).toEqual(log);
        expect((await store.surfaceOf(id))[0].body).toBe("changed after");
      });

      it("reports a conflict for a key reused with a different response, and writes nothing", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        landed(await approve(id, request, {}, "ap-0001"));
        const log = await events(id);
        const other = { ...answer(request.cursor), payload: { approved: true, result: "a different note" } };
        const out = await store.approveProposal(id, other, "ap-0001", { requestCursor: request.cursor, base: 0, write: writeOf() });
        expect(out).toEqual({ outcome: "conflict" });
        expect(await events(id)).toEqual(log);
      });

      it("writes neither response nor card into a room that froze after the proposal", async () => {
        const id = await room();
        const request = (await proposed(id))!;
        await store.freezeSession(id, 1);
        expect(await approve(id, request)).toEqual({ outcome: "frozen" });
        expect(await events(id)).toHaveLength(1);
        expect(await store.surfaceOf(id)).toEqual([]);
      });

      // Surface placement: the approved item goes through the same step as any write, so an unplaced one takes a slot.
      it("places an item the proposer left unplaced, in the row and in the card's event", async () => {
        const id = await room();
        const unplaced = { ...card(), placement: null };
        const request = (await proposed(id, unplaced))!;
        const out = landed(await approve(id, request, { write: writeOf(unplaced) }));
        expect((await store.surfaceOf(id))[0].placement).toEqual({ x: 0, y: 0 });
        expect(out.written!.payload).toMatchObject({ key: "tools", placement: { x: 0, y: 0 } });
      });
    });
```

`tests/store-do-wiring.test.ts`, at the end of the file (`resolveManifest` joins the imports):

```ts
/**
 * An approval is one transaction (topic rooms spec, D2, R12): the response, the card's event, the row, the cursor and the
 * record are written inside a single `transaction` call, and nothing is put outside one. The fake has no rollback;
 * that the real one aborts a whole transaction is proven in workerd (worker-tests/join-code-outbox.test.ts).
 */
describe("SessionDO approveProposal", () => {
  it("writes everything an approval owes inside one transaction", async () => {
    const item = { key: "tools", kind: "text", title: null, body: "See https://example.com", ends: null, placement: { x: 0, y: 0 }, blob: null, shape: null };
    const request = {
      cursor: 1, type: "action_request", fromMemberId: "m_ada", fromUserId: "u_ada", fromLabel: "ada@lovelace",
      payload: { kind: "surface_proposal", item, base: 0 }, refId: null, at: 1_700_000_000_000,
    };
    const storage = fakeStorage({
      session: currentRow({
        manifest: resolveManifest({ room: "mcp", preset: "topic", public: true }),
        members: [member({ memberId: "m_maint", roomRole: "maintainer" }), member({ memberId: "m_ada", userId: "u_ada", label: "ada@lovelace", roomRole: "contributor" })],
      }),
      cursor: 1,
      "e:000000000001": request,
    });
    let open = 0;
    let outside = 0;
    const transaction = storage.transaction;
    const put = storage.put;
    (storage as { transaction: unknown }).transaction = async (closure: never) => {
      open++;
      try { return await transaction(closure); } finally { open--; }
    };
    (storage as { put: unknown }).put = async (...args: Parameters<typeof put>) => {
      if (open === 0) outside++;
      return put(...args);
    };
    const doi = new storeDo.SessionDO(fakeCtx(storage) as never, {} as never);

    const out = await doi.approveProposal(
      { type: "action_response", fromMemberId: "m_maint", fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: { approved: true }, refId: "1" },
      null,
      { requestCursor: 1, base: 0, write: { key: "tools", item } },
    );

    expect(out.outcome).toBe("appended");
    expect(outside, "puts made outside the transaction").toBe(0);
    expect((await doi.eventsAfter(0)).map((e) => e.type)).toEqual(["action_request", "action_response", "surface"]);
    expect(await doi.surfaceOf()).toMatchObject([{ key: "tools", byMemberId: "m_ada", approvedBy: { memberId: "m_maint" } }]);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/store.test.ts -t "approving a proposal"`
Expected: FAIL in every case: `store.approveProposal is not a function`.

Run: `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts -t "approving a proposal"`
Expected: the same cases FAIL in workerd.

- [ ] **Step 3: Implement**

- `src/proposal.ts`: `ApprovalDecision` and `decideApproval` to Interfaces. The first answer is the first event in `after` with `type === "action_response"` and `refId === String(requestCursor)`; its label is `by`. The approver's verbs are `verbsOfRole(room.manifest, member.roomRole)` for the roster member with `approverId`.
- `src/store.ts`: the types, the interface method with a doc that says what `appendEventOnce` says about keys (a key names the response; a replay appends and applies nothing) and that a refusal writes nothing, not even a record. `MemoryStore.approveProposal`, with no `await` from its first read to its last write, as `appendEvent` has none: the key check as `appendEventOnce` makes it (`conflict`, `replayed`); frozen; the request event, the row for `write.key` when there is a write, and the events past `base`; `decideApproval`; a refusal returns its outcome and writes nothing; otherwise `appendNow` the response and record the key, and for `apply` build the card's draft (`type: "surface"`, `fromMemberId`, `fromUserId` and `fromLabel` of the request, `payload: write.item ?? { key: write.key, remove: true }`, `refId: null`), pass it and `{ surface: write }` through `this.placed`, `appendNow` the result and `applyExtras(s, card, { surface: placed.extras.surface, approvedBy })`. A request cursor that holds no `action_request` throws, as an idempotency record naming a missing cursor does: the tool read it a moment before.
- `src/store-do.ts`: `SessionDO.approveProposal(e, key, approval)` in one `ctx.storage.transaction`, with the same reads (`stored(txn)`, `txn.get` of the request and of `sf:<key>`, and one `txn.list({ prefix: "e:", start: eventKey(base + 1) })` for `after`), the same decision, and, for `apply`, one put for both events. That put follows `removeMember`'s, which also writes several events at once, and not two `#writeEvent` calls, whose second would run the books on a record that does not hold the first's:

```ts
// `request` is the event read at approval.requestCursor; `approval.write` is not null here, and `decided` is the "apply" decision.
const cardDraft: EventBody = {
  type: "surface", fromMemberId: request.fromMemberId, fromUserId: request.fromUserId, fromLabel: request.fromLabel,
  payload: approval.write.item ?? { key: approval.write.key, remove: true }, refId: null,
};
const at = Date.now();
const response: SessionEvent = { ...e, cursor: await this.nextCursor(txn), at };
const placed = await placedAppend(txn, cardDraft, { surface: approval.write });     // surface placement's step
const card: SessionEvent = { ...placed.e, cursor: response.cursor + 1, at };
// The books (#66) for each event, folded over the record, as removeMember folds them.
const kept = [response, card].reduce<StoredSession>((draft, ev) => ({ ...draft, ...noteAppend(draft, ev) }), s);
const owed = await extraRows(txn, kept, card, { surface: placed.extras.surface, approvedBy: decided.approvedBy });
await putRows(txn, {
  [eventKey(response.cursor)]: response, [eventKey(card.cursor)]: card, cursor: card.cursor,
  ...(key === null ? {} : { [idempotencyKey(e.fromMemberId, key)]: { cursor: response.cursor, print: fingerprint(e) } }),
  ...asRows(s, { ...owed.puts, session: owed.puts.session ?? kept }),
});
for (const row of owed.deletes) await txn.delete(row);
```

  For `record` the response alone goes through the same put (one event, `kept` from it). After the commit: `#wake` each event written, in cursor order; `reArm()` when `bringsForward(s, kept, at)` or `tickBroughtForward(s, kept)` says so. `DurableObjectStore.approveProposal(sessionId, e, key, approval)` is `this.session(sessionId).approveProposal(e, key, approval)`. `// ponytail:` one list of the log from `base` per approval, which bounds the cost at the events since the proposer read; the upgrade is an `answered` marker beside the request.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/store.test.ts tests/store-do-wiring.test.ts tests/working-surface.test.ts tests/housekeeping.test.ts && npm run typecheck && npm run typecheck:worker`
Expected: PASS.

Run: `npm run build:ui && npm --prefix worker-tests run test -- store-contract.test.ts`
Expected: PASS, "approving a proposal" among the cases run against the real `SessionDO`.

- [ ] **Step 5: See each rule fail without its code**

`jj st` first, then break with Edit, run, and put back with Edit.

| # | Break | Run | Expect these to fail |
|---|---|---|---|
| 1 | In `decideApproval`, drop the removal branch: treat a key with no row as never stale | `npx vitest run tests/store.test.ts -t "approving a proposal"` | "refuses an approval for a key that was removed after base, naming the removal" |
| 2 | In `decideApproval`, swap the first two steps (check the seat and `stale` before `answered`) | the same | "applies one of two approvals that meet…" (the loser is `stale`, not `answered`) |
| 3 | In `MemoryStore.approveProposal`, append the response and the card with `await` between them | the same | "applies one of two approvals that meet…" (both pass the decision) |
| 4 | In `MemoryStore.approveProposal`, run the key check after the decision | the same | "replays a keyed approval after the room changed…" (the retry reads `stale`) |
| 5 | In `SessionDO.approveProposal`, put the card's event in a second `putRows` after the transaction closure returns | `npx vitest run tests/store-do-wiring.test.ts -t "approveProposal"` | "writes everything an approval owes inside one transaction" |

Then `jj diff --stat`. Expected: the files of this task and nothing else.

- [ ] **Step 6: Commit**

```bash
jj commit -m "approveProposal: a maintainer's approval appends the response and the proposer's card in one transaction, refuses a stale or answered one with nothing written, and stamps the approver"
```

### Task 7: `bellman_send` approves

**Files:**
- Modify: `src/rooms.ts` (`resolveSurfaceWrite`, and `writeSurface` calls it), `src/tools/send.ts`
- Test: `tests/tools/approvals.test.ts` (new), `tests/tools/proposals.test.ts` and `tests/helpers/flows.ts` (the shared helpers move)

**Interfaces:**
- Consumes: `approveProposal`, `ProposalApproval` (Task 6); `readProposal` (Task 3); `settleBlob` (Task 4).
- Produces, in `src/rooms.ts`:

```ts
/** `writeSurface`'s checks before it counts a send, for any surface payload (R14): `normalizeSurfaceWrite`, the blob, the item cap, a connector's ends. An approval and a restore call it. */
export async function resolveSurfaceWrite(
  store: BellmanStore, blobs: BlobStore, sessionId: string, payload: unknown,
): Promise<RoomResult<{ write: SurfaceWrite }>>;
```

  `bellman_send`'s result gains `applied: { key: string; cursor: number }` when an approval wrote a card; a stale approval's result is an error with `structuredContent` `{ error: "stale", cursor }`.

- [ ] **Step 1: Write the failing tests**

Move `card`, `propose` and `sync` from `tests/tools/proposals.test.ts` into `tests/helpers/flows.ts` as exports (`propose(r, over)` keeps its shape), and import them in both files. Then `tests/tools/approvals.test.ts`:

```ts
/**
 * Approving a proposal through bellman_send (topic rooms spec, D2): a maintainer's human answers with approved: true,
 * and the card is written in the response's transaction. The store's cases are tests/helpers/store-contract.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { card, pairUp, propose, sync, topicRoom, joinWith, type TopicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness } from "../helpers/harness.js";
import { manifestFixture, member, session } from "../helpers/fixtures.js";
import { newBlobId } from "../../src/blobs.js";
import { resolveManifest } from "../../src/manifest.js";
import { MAX_SURFACE_ITEMS } from "../../src/surface.js";
import { text } from "../helpers/blob-bytes.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

const answer = (r: TopicRoom, cursor: unknown, payload: Record<string, unknown> = { approved: true }, extra: Record<string, unknown> = {}) =>
  r.maintainer.call("bellman_send", {
    session_id: r.sessionId, member_id: r.maintainerId, type: "action_response", ref_id: String(cursor), payload, ...extra,
  });
const rowsOf = (r: TopicRoom) => h.store.surfaceOf(r.sessionId);
const eventsOf = (r: TopicRoom) => h.store.eventsAfter(r.sessionId, 0);
type Outstanding = { cursor: number }[];

describe("approving a proposal", () => {
  it("writes the card: authored by the contributor, approved by the maintainer, after the response in the log, and every read names both", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    const out = await answer(r, asked.data.cursor);
    expect(out.isError, out.text).toBe(false);

    const log = await eventsOf(r);
    expect(log.slice(-3).map((e) => [e.type, e.fromMemberId])).toEqual([
      ["action_request", r.contributorId], ["action_response", r.maintainerId], ["surface", r.contributorId],
    ]);
    expect(out.data).toMatchObject({ cursor: log.at(-2)!.cursor, applied: { key: "tools", cursor: log.at(-1)!.cursor } });
    expect(await rowsOf(r)).toEqual([expect.objectContaining({
      key: "tools", byMemberId: r.contributorId, byLabel: r.contributor.identity.label,
      approvedBy: { memberId: r.maintainerId, label: r.maintainer.identity.label },
    })]);
    const read = await r.maintainer.call("bellman_surface", { session_id: r.sessionId });
    const items = (read.data.surface as { items: { origin: { label: string }; data: { approved_by: unknown } }[] }).items;
    expect(items[0].origin.label).toBe(r.contributor.identity.label);
    expect(items[0].data.approved_by).toEqual({ member_id: r.maintainerId, label: r.maintainer.identity.label });
  });

  it("files an audit row for the response and one for the card, the card's naming the proposal it came from", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    await answer(r, asked.data.cursor);
    const rows = await h.store.auditForOrg(r.maintainer.identity.orgId!, 50);
    expect(rows.slice(-2).map((a) => a.action)).toEqual(["sent_action_response", "sent_surface"]);
    expect(rows.at(-1)!.detail).toMatchObject({ key: "tools", kind: "text", approved: Number(asked.data.cursor) });
  });

  it("writes nothing when the human declines, and the proposal reads declined", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    expect((await answer(r, asked.data.cursor, { approved: false })).isError).toBe(false);
    expect(await rowsOf(r)).toEqual([]);
    expect((await eventsOf(r)).map((e) => e.type).filter((t) => t === "surface")).toEqual([]);
  });

  it("removes a card when a removal is approved", async () => {
    const r = await topicRoom(h);
    const first = await propose(r);
    await answer(r, first.data.cursor);
    const sf = await r.maintainer.call("bellman_sync", { session_id: r.sessionId, member_id: r.maintainerId, since_cursor: 0, surface: true });
    const base = (sf.data.surface as { cursor: number }).cursor;
    const removal = await propose(r, { item: { key: "tools", remove: true }, base });
    expect((await answer(r, removal.data.cursor)).isError).toBe(false);
    expect(await rowsOf(r)).toEqual([]);
  });

  // Review Focus 1.
  it("refuses a stale approval, naming the card's cursor, writes nothing, leaves the proposal open, and a decline then closes it", async () => {
    const r = await topicRoom(h);
    const first = await propose(r, { item: card({ body: "First. https://example.com/1" }) });
    const second = await propose(r, { item: card({ body: "Second. https://example.com/2" }) });
    const landed = await answer(r, first.data.cursor);
    expect(landed.isError, landed.text).toBe(false);
    const before = (await eventsOf(r)).length;

    const late = await answer(r, second.data.cursor);
    expect(late.isError).toBe(true);
    expect(late.data).toEqual({ error: "stale", cursor: (landed.data.applied as { cursor: number }).cursor });
    expect(late.text).toContain("stale");
    expect((await eventsOf(r)).length).toBe(before);
    expect((await rowsOf(r))[0].body).toBe("First. https://example.com/1");

    const open = await sync(r.contributor, r.sessionId, r.contributorId);
    expect((open.data.outstanding as Outstanding).map((o) => o.cursor)).toEqual([second.data.cursor]);
    expect((await answer(r, second.data.cursor, { approved: false })).isError).toBe(false);
    expect((await sync(r.contributor, r.sessionId, r.contributorId)).data.outstanding).toBeUndefined();
  });

  it("refuses a second approval of the same proposal: the first answer is the one that counts", async () => {
    const r = await topicRoom(h);
    const second = await h.connect(DEV_KEY.peer);
    const door = await r.maintainer.call("bellman_invite", { session_id: r.sessionId, member_id: r.maintainerId, role: "maintainer" });
    const joined = await joinWith(second, String(door.data.join_code), ["read_context", "receive_messages", "request_actions"]);
    expect(joined.isError, joined.text).toBe(false);
    const asked = await propose(r);
    expect((await answer(r, asked.data.cursor)).isError).toBe(false);
    const before = (await eventsOf(r)).length;

    const again = await second.call("bellman_send", {
      session_id: r.sessionId, member_id: String(joined.data.member_id), type: "action_response",
      ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("was already answered");
    expect((await eventsOf(r)).length).toBe(before);
  });

  // Review Focus 2: recorded, not applied.
  it("records an approval from a seat that holds respond_actions without write_surface, and applies nothing", async () => {
    const base = resolveManifest({ room: "mcp", preset: "topic", public: true });
    const manifest = {
      ...base,
      roles: { ...base.roles, maintainer: { ...base.roles.maintainer, can: base.roles.maintainer.can.filter((v) => v !== "write_surface") } },
    };
    const caps = ["read_context", "receive_messages", "request_actions"] as const;
    await h.store.createSession(session({
      id: "qs_nowrite", manifest,
      members: [
        member({ memberId: "m_maint", userId: "u_jesse", label: "jesse@codenerd", roomRole: "maintainer", capabilities: [...caps] }),
        member({ memberId: "m_ada", userId: "u_peer", label: "peer@codenerd", roomRole: "contributor" }),
      ],
    }));
    const maintainer = await h.connect(DEV_KEY.jesse);
    const contributor = await h.connect(DEV_KEY.peer);
    const asked = await contributor.call("bellman_send", {
      session_id: "qs_nowrite", member_id: "m_ada", type: "action_request", payload: { kind: "surface_proposal", item: card(), base: 0 },
    });
    expect(asked.isError, asked.text).toBe(false);
    const out = await maintainer.call("bellman_send", {
      session_id: "qs_nowrite", member_id: "m_maint", type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.applied).toBeUndefined();
    expect(await h.store.surfaceOf("qs_nowrite")).toEqual([]);
  });

  it("applies nothing outside a topic room: an approval of a surface_proposal there is an ordinary answer", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const asked = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_request", payload: { kind: "surface_proposal", item: card(), base: 0 },
    });
    expect(asked.isError, asked.text).toBe(false);
    const out = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.applied).toBeUndefined();
    expect(await h.store.surfaceOf(p.sessionId)).toEqual([]);
  });

  // The hosted seat holds exactly send; a seat with that role is refused by its verb, as it would be for any answer.
  it("cannot be done by a seat that holds only send, as the hosted seat does", async () => {
    const manifest = {
      room: "quiet-room", mode: "swarm", default_role: "quiet", creator_role: "lead",
      roles: { lead: { can: ["send", "invite", "request_actions", "respond_actions", "write_surface"] }, quiet: { can: ["send"] } },
    };
    const p = await pairUp(h, { manifest });
    const asked = await p.creator.call("bellman_send", {
      session_id: p.sessionId, member_id: p.creatorMemberId, type: "action_request", payload: { ask: "run it" },
    });
    const out = await p.joiner.call("bellman_send", {
      session_id: p.sessionId, member_id: p.joinerMemberId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    expect(out.isError).toBe(true);
    expect(out.text).toContain('does not hold the verb "respond_actions"');
  });
});

// Review Focus 5 and R14: the item is settled again at approval, and a refusal there appends nothing.
describe("a proposal whose card cannot be written when it is approved", () => {
  it("is refused when the surface is full, appends nothing, and stays open", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    for (let i = 0; i < MAX_SURFACE_ITEMS; i++) {
      const item = { ...card({ key: `k${i}` }), ends: null, placement: null, blob: null, shape: null };
      await h.store.appendEvent(r.sessionId, {
        type: "surface", fromMemberId: r.maintainerId, fromUserId: "u_jesse", fromLabel: "jesse@codenerd", payload: item, refId: null,
      }, { surface: { key: `k${i}`, item } });
    }
    const before = (await eventsOf(r)).length;
    const out = await answer(r, asked.data.cursor);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`already holds ${MAX_SURFACE_ITEMS} items`);
    expect((await eventsOf(r)).length).toBe(before);
    expect(((await sync(r.contributor, r.sessionId, r.contributorId)).data.outstanding as Outstanding).map((o) => o.cursor)).toEqual([asked.data.cursor]);
  });

  it("is refused when a connector's end is not on the surface", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r, { item: { key: "link", kind: "connector", ends: { from: "a", to: "b" } } });
    expect(asked.isError, asked.text).toBe(false);
    const out = await answer(r, asked.data.cursor);
    expect(out.isError).toBe(true);
    expect(out.text).toContain('connector "link" names "a", which is not on the surface');
  });

  const stored = async (r: TopicRoom) => {
    const id = newBlobId();
    const bytes = text("notes");
    await h.blobs.put(r.sessionId, id, bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, {
      bytes: bytes.byteLength, type: "text/markdown", name: "notes.md", by: r.maintainerId, at: 1_700_000_000_000,
    });
    return id;
  };

  it("takes a file card's size, type and name from the object at approval, and is refused when the object has gone", async () => {
    const r = await topicRoom(h);
    const id = await stored(r);
    const asked = await propose(r, { item: { key: "notes", kind: "file", blob: { id } } });
    expect(asked.isError, asked.text).toBe(false);
    expect((await answer(r, asked.data.cursor)).isError).toBe(false);
    expect((await rowsOf(r))[0].blob).toEqual({ id, bytes: 5, type: "text/markdown", name: "notes.md" });

    const gone = await stored(r);
    const next = await propose(r, { item: { key: "more", kind: "file", blob: { id: gone } } });
    await h.blobs.delete(r.sessionId, gone);
    const out = await answer(r, next.data.cursor);
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`no blob ${gone} has been uploaded to this room`);
  });
});

describe("an idempotent retry of an approval", () => {
  it("replays the response after the room changed: no second write, and no stale", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r);
    const first = await answer(r, asked.data.cursor, { approved: true }, { idempotency_key: "approve-0001" });
    expect(first.isError, first.text).toBe(false);
    const changed = await r.maintainer.call("bellman_send", {
      session_id: r.sessionId, member_id: r.maintainerId, type: "surface", payload: card({ body: "Edited. https://example.com/e" }),
    });
    expect(changed.isError, changed.text).toBe(false);
    const before = (await eventsOf(r)).length;

    const retry = await answer(r, asked.data.cursor, { approved: true }, { idempotency_key: "approve-0001" });

    expect(retry.isError, retry.text).toBe(false);
    expect(retry.data).toMatchObject({ cursor: first.data.cursor, replayed: true });
    expect(retry.data.applied).toBeUndefined();
    expect((await eventsOf(r)).length).toBe(before);
    expect((await rowsOf(r))[0].body).toBe("Edited. https://example.com/e");
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/tools/approvals.test.ts tests/tools/proposals.test.ts`
Expected: FAIL. An approval appends the response and writes no card (`rowsOf` is empty), `applied` is absent, nothing is refused as stale, and the full-surface case approves without a card. The cases for a seat without the verb, outside a topic room, the send-only seat, the decline and the replay PASS before the change, as they pin what an ordinary answer already does.

- [ ] **Step 3: Implement**

- `src/rooms.ts`: `resolveSurfaceWrite` is the part of `writeSurface` between its gate and its `countSend` block, moved out whole: `normalizeSurfaceWrite`, `settleBlob` for a named blob, the rows read for the 64-item cap and a connector's ends, the same refusals in the same words. `writeSurface` calls it.
- `src/tools/send.ts`: hoist `req` out of the `action_response` block as `request`. After `ActionResponseShape` has passed, when the answer is `approved: true`, the room is a topic room and `readProposal(request.payload)` is ok: `write` is null unless the seat holds `write_surface` (`denyVerb(session, me, "write_surface") === null`), and then `resolveSurfaceWrite(s, blobs, session_id, read.item)`, whose refusal is returned as `refusal(...)`; `approval` is `{ requestCursor: request.cursor, base: read.base, write }`. This is before `admitSend`, so a refused approval spends no place. When there is an `approval`, the append is `s.approveProposal(session_id, draft, idempotency_key ?? null, approval)` in place of `appendEventOnce` or `appendOrFrozen`, and its outcomes read: `stale` is the error `stale: "<key>" changed at cursor <cursor>, after cursor <base>, which this proposal was written against. Nothing was written and the proposal is still open. Decline it (approved: false); its proposer can read the surface again and propose again.` with `structuredContent` `{ error: "stale", cursor }`; `answered` is the existing "already answered by …" refusal; `conflict` and `frozen` are the existing ones; `appended` and `replayed` carry `event` as before. After the existing audit row, a `written` card files `sent_surface` with `{ key, kind, chars, approved: request.cursor }` (a removal `{ key, removed: true, approved: … }`). The result gains `applied: { key, cursor: written.cursor }` when `written` is not null. Everything else is the existing path, and a decline or a non-proposal never reaches the new call.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/tools tests/store.test.ts tests/http-rooms.test.ts && npm run typecheck`
Expected: PASS. `tests/tools/working-surface.test.ts` and `tests/http-rooms.test.ts` are the control for `resolveSurfaceWrite`'s move: their refusals read in the same words.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A maintainer's approval through bellman_send writes the proposed card, settles the item again first, and answers a stale one with the card's cursor"
```

### Task 8: `restore`

**Files:**
- Modify: `src/surface.ts` (`RestoreShape`, `isRestorePayload`, `normalizeRestore`), `src/rooms.ts` (`writeSurface`)
- Test: `tests/tools/restore.test.ts` (new)

**Interfaces:**
- Consumes: `resolveSurfaceWrite` (Task 7), `approvedBy` extras (Task 5).
- Produces, in `src/surface.ts`:

```ts
/** `{ key, restore: <cursor> }` (topic rooms spec, D5). Strict, so a stray field is refused by name. */
export const RestoreShape: z.ZodType<{ key: string; restore: number }>;
export const isRestorePayload = (payload: unknown): boolean; // an object with a `restore` key
export function normalizeRestore(payload: unknown): { ok: true; key: string; cursor: number } | { ok: false; reason: string };
```

  `writeSurface` takes a restore payload through the same gate, send count and audit as any write.

- [ ] **Step 1: Write the failing tests**

`tests/tools/restore.test.ts`:

```ts
/**
 * Restore (topic rooms spec, D5, R22, R23): { key, restore: <cursor> } re-applies the version of a key written at that
 * cursor, as a new write, with the version's author kept and the restoring seat as its approver.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { card, joinWith, pairUp, propose, topicRoom, type TopicRoom } from "../helpers/flows.js";
import { DEV_KEY, Harness, type Peer } from "../helpers/harness.js";
import { manifestFixture } from "../helpers/fixtures.js";
import { newBlobId } from "../../src/blobs.js";
import { text } from "../helpers/blob-bytes.js";

let h: Harness;
beforeEach(() => { h = new Harness(); });
afterEach(async () => { await h.close(); });

interface Seat { peer: Peer; memberId: string }
const write = (s: Seat, r: { sessionId: string }, payload: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  s.peer.call("bellman_send", { session_id: r.sessionId, member_id: s.memberId, type: "surface", payload, ...extra });
const maintainer = (r: TopicRoom): Seat => ({ peer: r.maintainer, memberId: r.maintainerId });
const rows = (r: { sessionId: string }) => h.store.surfaceOf(r.sessionId);
const events = (r: { sessionId: string }) => h.store.eventsAfter(r.sessionId, 0);

/** A second maintainer, seated through a code for the role. */
async function secondMaintainer(r: TopicRoom): Promise<Seat> {
  const peer = await h.connect(DEV_KEY.peer);
  const door = await r.maintainer.call("bellman_invite", { session_id: r.sessionId, member_id: r.maintainerId, role: "maintainer" });
  const joined = await joinWith(peer, String(door.data.join_code), ["read_context", "receive_messages", "request_actions"]);
  expect(joined.isError, joined.text).toBe(false);
  return { peer, memberId: String(joined.data.member_id) };
}

describe("restoring a version", () => {
  it("re-applies it as a new write: the version's author kept, the restoring seat as approver, the older versions still in the log", async () => {
    const r = await topicRoom(h);
    const m2 = await secondMaintainer(r);
    const v1 = await write(maintainer(r), r, card({ body: "First. https://example.com/1" }));
    const v2 = await write(m2, r, card({ body: "Second. https://example.com/2" }));
    expect(v2.isError, v2.text).toBe(false);

    const back = await write(m2, r, { key: "tools", restore: v1.data.cursor });
    expect(back.isError, back.text).toBe(false);

    const [row] = await rows(r);
    expect(row).toMatchObject({
      body: "First. https://example.com/1", byMemberId: r.maintainerId,
      approvedBy: { memberId: m2.memberId, label: m2.peer.identity.label },
    });
    expect(row.cursor).toBeGreaterThan(Number(v2.data.cursor));
    expect((await events(r)).at(-1)).toMatchObject({ type: "surface", fromMemberId: r.maintainerId, payload: { body: "First. https://example.com/1" } });
    expect((await events(r)).filter((e) => e.type === "surface")).toHaveLength(3);
  });

  it("keeps a contributor as the author of a version an approval put there, across a restore", async () => {
    const r = await topicRoom(h);
    const asked = await propose(r, { item: card({ body: "Contributed. https://example.com/c" }) });
    const approved = await r.maintainer.call("bellman_send", {
      session_id: r.sessionId, member_id: r.maintainerId, type: "action_response", ref_id: String(asked.data.cursor), payload: { approved: true },
    });
    const version = (approved.data.applied as { cursor: number }).cursor;
    await write(maintainer(r), r, card({ body: "Edited by the maintainer. https://example.com/e" }));

    const back = await write(maintainer(r), r, { key: "tools", restore: version });

    expect(back.isError, back.text).toBe(false);
    expect((await rows(r))[0]).toMatchObject({
      body: "Contributed. https://example.com/c", byMemberId: r.contributorId, approvedBy: { memberId: r.maintainerId },
    });
  });

  // R22: a removal is restored as a removal, and it is the restorer's act.
  it("restores a removal as a removal now", async () => {
    const r = await topicRoom(h);
    await write(maintainer(r), r, card());
    const removed = await write(maintainer(r), r, { key: "tools", remove: true });
    await write(maintainer(r), r, card({ body: "Back again. https://example.com/b" }));
    expect((await rows(r))).toHaveLength(1);

    const back = await write(maintainer(r), r, { key: "tools", restore: removed.data.cursor });

    expect(back.isError, back.text).toBe(false);
    expect(await rows(r)).toEqual([]);
    expect((await events(r)).at(-1)).toMatchObject({ type: "surface", fromMemberId: r.maintainerId, payload: { key: "tools", remove: true } });
  });

  // Review Focus 4.
  it("refuses a cursor that names no event, another key's write or another kind of event, naming what it is", async () => {
    const r = await topicRoom(h);
    await write(maintainer(r), r, card());
    const other = await write(maintainer(r), r, card({ key: "other" }));
    const said = await r.contributor.call("bellman_send", {
      session_id: r.sessionId, member_id: r.contributorId, type: "message", payload: { text: "hello" },
    });
    const before = (await events(r)).length;

    const cases: [unknown, string][] = [
      [other.data.cursor, 'wrote "other", not "tools"'],
      [said.data.cursor, "is a message event, not a surface write"],
      [9999, "no event at cursor 9999"],
    ];
    for (const [cursor, words] of cases) {
      const out = await write(maintainer(r), r, { key: "tools", restore: cursor });
      expect(out.isError, String(cursor)).toBe(true);
      expect(out.text, String(cursor)).toContain(words);
    }
    expect((await events(r)).length).toBe(before);
  });

  it.each([
    ["a cursor of zero", { key: "tools", restore: 0 }],
    ["a cursor that is text", { key: "tools", restore: "3" }],
    ["a field beside the cursor", { key: "tools", restore: 3, kind: "text" }],
  ])("refuses %s", async (_why, payload) => {
    const r = await topicRoom(h);
    const out = await write(maintainer(r), r, payload);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("surface restore must be { key, restore: <cursor> }");
  });

  it("is refused when the version's blob has gone, and when the seat does not hold write_surface", async () => {
    const r = await topicRoom(h);
    const id = newBlobId();
    const bytes = text("notes");
    await h.blobs.put(r.sessionId, id, bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, {
      bytes: bytes.byteLength, type: "text/markdown", name: "notes.md", by: r.maintainerId, at: 1_700_000_000_000,
    });
    const v1 = await write(maintainer(r), r, { key: "notes", kind: "file", blob: { id } });
    expect(v1.isError, v1.text).toBe(false);
    await write(maintainer(r), r, { key: "notes", kind: "text", title: "Notes", body: "Now prose. https://example.com/n" });
    await h.blobs.delete(r.sessionId, id);
    const gone = await write(maintainer(r), r, { key: "notes", restore: v1.data.cursor });
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain(`no blob ${id} has been uploaded to this room`);

    const contributor: Seat = { peer: r.contributor, memberId: r.contributorId };
    const denied = await write(contributor, r, { key: "notes", restore: v1.data.cursor });
    expect(denied.isError).toBe(true);
    expect(denied.text).toContain('does not hold the verb "write_surface"');
  });

  it("works in a room that is not a topic room", async () => {
    const p = await pairUp(h, { manifest: manifestFixture({ preset: "swarm" }) });
    const lead: Seat = { peer: p.creator, memberId: p.creatorMemberId };
    const v1 = await write(lead, p, { key: "plan", kind: "text", body: "first" });
    await write(lead, p, { key: "plan", kind: "text", body: "second" });
    const back = await write(lead, p, { key: "plan", restore: v1.data.cursor });
    expect(back.isError, back.text).toBe(false);
    expect((await rows(p))[0]).toMatchObject({ body: "first", approvedBy: { memberId: p.creatorMemberId } });
  });

  it("files an audit row naming the cursor restored", async () => {
    const r = await topicRoom(h);
    const v1 = await write(maintainer(r), r, card());
    await write(maintainer(r), r, { key: "tools", restore: v1.data.cursor });
    const last = (await h.store.auditForOrg(r.maintainer.identity.orgId!, 50)).at(-1)!;
    expect(last).toMatchObject({ action: "sent_surface", detail: { key: "tools", restored: Number(v1.data.cursor) } });
  });
});

// R23: the restore's event is authored by the version's author, and a key is scoped by the event's author.
describe("a restore's idempotency key", () => {
  it("replays for the seat that used it, and is not shared with another maintainer using the same words", async () => {
    const r = await topicRoom(h);
    const m2 = await secondMaintainer(r);
    const v1 = await write(maintainer(r), r, card({ body: "First. https://example.com/1" }));
    await write(m2, r, card({ body: "Second. https://example.com/2" }));
    const restore = { key: "tools", restore: v1.data.cursor };

    const a = await write(maintainer(r), r, restore, { idempotency_key: "restore-0001" });
    const b = await write(m2, r, restore, { idempotency_key: "restore-0001" });
    expect(a.isError, a.text).toBe(false);
    expect(b.isError, b.text).toBe(false);
    expect(b.data.replayed, "the second seat's write is its own").toBeUndefined();
    expect(b.data.cursor).not.toBe(a.data.cursor);

    const again = await write(maintainer(r), r, restore, { idempotency_key: "restore-0001" });
    expect(again.data).toMatchObject({ replayed: true, cursor: a.data.cursor });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/tools/restore.test.ts`
Expected: FAIL. A restore payload reads as an item and is refused by the surface (`surface payload must be { key, kind, … }`), in every case.

- [ ] **Step 3: Implement**

- `src/surface.ts`: `RestoreShape` is a strict object `{ key: SurfaceKeyShape, restore: z.number().int().positive() }`; `normalizeRestore` reads it and refuses `surface restore must be { key, restore: <cursor> }: <issue>`; `isRestorePayload` is an object with a `restore` key. `normalizeSurfaceWrite` is untouched.
- `src/rooms.ts`: in `writeSurface`, after the gate, a restore payload goes through a helper `restoreVersion(store, sessionId, payload)` that returns the payload to settle and the author: `normalizeRestore`; `store.eventAt`; the three refusals of R22 in these words, `restore: no event at cursor <n>`, `restore: cursor <n> is a <type> event, not a surface write` and `restore: cursor <n> wrote "<key>", not "<key>"`; a removal version gives `{ key, remove: true }` and no author; any other gives the version's payload with its `blob` cut to `{ id }` (or null) and the event's `fromMemberId`, `fromUserId` and `fromLabel`. `resolveSurfaceWrite` settles that payload as for any write. The draft's `from*` is the version's author when there is one and the actor otherwise; `extras` is `{ surface: write, approvedBy: { memberId: me.memberId, label: me.label } }` with `me` from `findMember`; the audit row's detail gains `restored: <cursor>`; and a keyed restore hands the store `"<memberId>:<key>"` (R23), with a comment saying why. The gate, `resolveSurfaceWrite`, the send count and the append are the code a plain write runs.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/tools tests/http-rooms.test.ts tests/working-surface.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A maintainer restores an earlier version of a card with { key, restore: cursor }: its author kept, the restorer as approver, a removal restored as a removal"
```

### Task 9: A topic room opens as a page, and the public read names its preset

**Files:**
- Modify: `src/tools/start.ts` (`publicView`), `src/http/public.ts` (the room read)
- Test: `tests/tools/start-presets.test.ts`, `tests/http-public.test.ts`

**Interfaces:**
- Consumes: `Session.publicView` (room pages Part 1), `isTopicRoom` (Task 1).
- Produces: `bellman_start` seeds `publicView` as `isTopicRoom(manifest) ? "page" : "canvas"` (R4); `GET /public/rooms/:id` carries `preset: session.manifest.preset` (a built-in's name or null), top level beside `mode` (R5). Part 2 reads it.

- [ ] **Step 1: Write the failing tests**

`tests/tools/start-presets.test.ts` (`startRoom` joins the imports from `../helpers/flows.js`):

```ts
  // Topic rooms spec, D6 and R4: a topic room opens as a page; every other preset as its canvas.
  it("starts a topic room opening as a page, and every other preset opening as its canvas", async () => {
    const jesse = await h.connect(DEV_KEY.jesse);
    for (const [preset, view] of [["topic", "page"], ["swarm", "canvas"], ["pair", "canvas"]] as const) {
      const { sessionId } = await startRoom(jesse, manifestFixture({ preset, public: true }));
      expect((await h.store.getSession(sessionId))!.publicView, preset).toBe(view);
    }
  });
```

`tests/http-public.test.ts`: the key list in "answers a public room to anyone with no credential, every origin and no credentials grant" gains `"preset"` (sorted: `["by", "closed_at", "id", "mode", "preset", "public_url", "status", "text", "view"]` once 2a and room pages are in), and in `describe("GET /public/rooms/:id")` (`resolveManifest` joins the imports):

```ts
  // Topic rooms spec, R4 and R5.
  it("names the room's preset, null for a room that cites none, and a topic room opens as a page", async () => {
    expect((await bodyOf(await read(`/public/rooms/${PUB}`))).preset).toBe("pair");
    await store.createSession(publicRoom({
      id: "qs_topic", manifest: roomManifest({ ...resolveManifest({ room: "mcp", preset: "topic", public: true }) }), publicView: "page",
    }));
    expect(await bodyOf(await read("/public/rooms/qs_topic"))).toMatchObject({ preset: "topic", view: "page", mode: "swarm" });
    await store.createSession(publicRoom({ id: "qs_authored", manifest: roomManifest({ public: true, preset: null }) }));
    expect((await bodyOf(await read("/public/rooms/qs_authored"))).preset).toBeNull();
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run tests/tools/start-presets.test.ts tests/http-public.test.ts`
Expected: FAIL: a topic room starts as `canvas`, and the read has no `preset`.

- [ ] **Step 3: Implement**

`src/tools/start.ts`: `publicView: isTopicRoom(manifest) ? "page" : "canvas"` where room pages wrote `"canvas"`, with a comment naming D6 and R4. `src/http/public.ts`: the room object gains `preset: session.manifest.preset` after `mode`, with a comment naming R5.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run tests/tools tests/http-public.test.ts tests/public-rooms.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
jj commit -m "A topic room opens as a page, and the public read of a room says which preset it is"
```

### Task 10: The tool texts, the docs, ADR 00NN, and the branch verified

**Files:**
- Create: `docs/adr/00NN-topic-rooms.md` (R25)
- Modify: `src/tools/send.ts` (the description), `README.md`, `docs-site/src/content/docs/guides/manifests.md`, `docs-site/src/content/docs/guides/rooms.md`, `docs-site/src/content/docs/guides/public-rooms.md`, `docs-site/src/content/docs/guides/surface.md`, `plugin/skills/canvas/SKILL.md`, `docs/ARCHITECTURE.md`; regenerated: `docs-site/src/content/docs/reference/tools/bellman_send.md`

No test of its own: its checks are the drift test, the word scan, the measurement and `npm run verify`.

- [ ] **Step 1: `bellman_send`'s description**

Four additions, nothing else (R24):
- In the `action_request` bullet, after "An answer that arrives after the deadline still lands and still counts.": `In a topic room, payload { kind: "surface_proposal", item, base } proposes a card: item is a surface payload or { key, remove: true }, base is the surface_cursor you read. A text or diagram item needs an http or https link in its body, a member holds at most 3 open proposals, and each lives 7 days. A maintainer's human approves it with an action_response of approved: true, which writes the card; if the card's key changed after base the approval is refused as stale (error "stale", with the cursor) and nothing is written.`
- In the `surface` bullet, after the payload shapes: `{ key, restore: <cursor> } re-applies the version of that key written at that cursor, with its author kept (needs write_surface).`
- The `Returns:` line reads `Returns: { room_members, cursor, replayed?, applied? }`, and gains `- applied: the card an approval wrote, { key, cursor }; absent when the approval wrote none.`
- The `Errors:` paragraph gains: `An approval is refused as stale when its card changed after the proposal's base, and as already answered when another answer landed first; nothing is written either way.`

- [ ] **Step 2: The ADR**

````markdown
# ADR 00NN — Topic rooms

**Date:** 2026-10-22 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-22-topic-rooms-design.md` · **Plan:** `docs/superpowers/plans/2026-10-22-topic-rooms.md`

## Context

A public room could hold what agents learned about a subject, but whoever held `write_surface` could change it and nobody else could add to it. A room kept by a few people and proposed to by many needs a contribution that a human approves, an approval that is the write, and a page that says who wrote and who approved each card.

## Decision

1. **`topic` is a preset** (spec D1): a swarm of `maintainer`s, who hold all six verbs, and `contributor`s, who hold `send` and `request_actions`. It has no host and no cadence, and its permanent code seats contributors. A topic room opens as a page.
2. **A contribution is an action request and the approval is the write** (D2). The payload is `{ kind: "surface_proposal", item, base }`. A maintainer's `action_response` with `approved: true` applies the item in the transaction that stores the response, through `BellmanStore.approveProposal`, one call in each store: it reads the request, the key's row and the log from `base`, `decideApproval` decides, and the response, the card's `surface` event (authored by the proposer) and the row, stamped `approvedBy`, commit together.
3. **A refusal writes nothing.** A `base` behind the key, a removal included, is `stale`; an earlier answer makes the later one `answered`; a seat without `write_surface` is recorded and applies nothing. The proposal stays open until a human declines it or seven days pass.
4. **A proposal lives seven days in a topic room, a member holds three, and a text or diagram card links a source** (D3, D4). Elsewhere a `surface_proposal` payload is an ordinary request and keeps thirty minutes.
5. **`restore` is a write** (D5): `{ key, restore: <cursor> }` re-applies a version with its author kept and the restoring seat as approver, in any room.
6. **Readers** see `approved_by`, `{ member_id, label }`, on every read of an item, named by the public name rule on public reads, and `preset` on the public room read.
7. **The dash renders the rest** (D6): the approver on each card and two lines above a topic room's cards.

## Consequences

- A stale proposal holds its proposer's place until a maintainer declines it; the proposer cannot withdraw.
- A card a maintainer writes directly has no approver.
- A pending proposal is in a public room's Log, as every action request is.
- `bellman_sync` in a topic room reads up to seven days of the log while a proposal under a week old exists.
- A rollback is a revert: code that does not know `approvedBy` or `preset` reads past both.
````

- [ ] **Step 3: The docs**

- `README.md`: the manifest section's `preset: review          # pair | swarm | review | social` gains `| topic`; after the paragraph on the hosted seat, a paragraph "A **topic room** (`preset: topic`) …" saying: maintainers hold every verb and contributors hold `send` and `request_actions`; a contributor proposes a card with `bellman_send` (`action_request`, payload `{ kind: "surface_proposal", item, base }`), a maintainer's human approves it and the approval writes the card in one transaction, refused as `stale` when the card's key changed after `base`; a proposal lives seven days, a member holds three open, a text or diagram card links an http or https source; `{ key, restore: <cursor> }` re-applies a version. In the working surface section, "Every preset gives it to the creator's seat alone" gains "(`maintainer` in `topic`, which any maintainer code also seats)", and the list of an item's server-set fields gains `approved_by`. The README's public-room item gains: `GET /public/rooms/:id` also carries `preset`.
- `docs-site/src/content/docs/guides/manifests.md`: the comment, the table (a `topic` row: swarm; `maintainer`, the creator, holds all six; `contributor`, the default, holds `send` and `request_actions`), and the sample refusal `built-in: pair, swarm, review, social, topic; yours: none`; one sentence after the table: `topic` has no host and no heartbeat, and a cite that sets either is refused.
- `docs-site/src/content/docs/guides/rooms.md`: a section "Topic rooms": what the preset is; proposing (the payload, the source, the base you read, three open, seven days); that the maintainers' agents must grant `request_actions` or a proposal is refused naming them; approving (the human decides; `approved: true` writes the card, `approved: false` closes the proposal); `stale` and what to do about it (decline it, the proposer reads again and proposes again); restore; and that a card carries its author and its approver.
- `docs-site/src/content/docs/guides/public-rooms.md`: a section "A public topic room": its permanent code seats contributors; a pending proposal is in the Log before a maintainer approves it, while the page lists only approved cards. (The page's two lines wait for Part 2: R26.)
- `docs-site/src/content/docs/guides/surface.md`: the sentence on who holds `write_surface` gains `maintainer` in `topic`; a short section "Restoring a version": the payload, the three refusals, that the author is kept and `approved_by` names the restorer.
- `plugin/skills/canvas/SKILL.md`: after the paragraph on reading an item back, a paragraph on `{ key, restore: <cursor> }`: the cursor is the one `bellman_sync` or the Log gives for an earlier write of that key.
- `docs/ARCHITECTURE.md`: after the paragraph that begins "`writeSurface` in `src/rooms.ts` is the one write path", a paragraph "A **topic room** (ADR 00NN) …": the roles; that a contribution is an action request whose payload is `{ kind: "surface_proposal", item, base }`; that the approval is `BellmanStore.approveProposal`, one call in each store, in the response's transaction, deciding with `decideApproval` (`answered`, `record`, `stale`, `apply`) and appending the response then the proposer's card with the row stamped `approvedBy`; that the tool's own check for an earlier answer reads before it appends and so cannot stop two approvals writing twice, where the transaction can; and that a refusal writes nothing. In section 4's "**A public room**" paragraph, after the sentence on `GET /public/rooms/:id`: "The room read carries `preset` (ADR 00NN)."
- Section 11, "What connecting costs": measure again as in Setup 4, put the total in the `Tool definitions` row, and above the newest "Re-measured" paragraph: "Re-measured on <date> for topic rooms, by the method below: <n> tokens over the <before> that trunk (`<commit>`) measures, in `bellman_send` (<a> to <b>: the proposal, `restore`, `applied` and the two refusals), `bellman_surface` (<c> to <d>: `approved_by`) and `bellman_start` (<e> to <f>: one preset name). No tool was added. That is <after>." Fill in the figures the two runs printed.

- [ ] **Step 4: Regenerate, scan the words, and run everything**

Run: `npm run docs:gen && npx vitest run tests/docs-reference.test.ts tests/docs-writing.test.ts`
Expected: PASS; before `docs:gen` the drift test fails for `bellman_send` alone.

Run:
```bash
grep -nE -i 'load-bearing|load bearing|worth (saying|stating|noting|knowing|recording)|structural|two sessions|the other session' docs/adr/00NN-topic-rooms.md docs/ARCHITECTURE.md README.md docs-site/src/content/docs/guides/*.md plugin/skills/canvas/SKILL.md plugin/skills/room-manifest/SKILL.md src/proposal.ts src/action-state.ts
npm run verify
jj diff -r 'trunk()..@' --stat
```
Expected: the scan prints nothing new against trunk's copy of these files; `verify` passes; the stat names the spec, this plan, and the files of Tasks 1 to 10, and nothing in `plugin/bridge/`, `extension/`, `src/ui/assets.ts` or `node_modules/`.

- [ ] **Step 5: Commit**

```bash
jj commit -m "ADR 00NN, and the tool texts, the README, the docs site and ARCHITECTURE, for topic rooms on the server"
```

### Part 1's review and PR

- [ ] **The whole-branch review:** one reviewer over the branch's diff from `trunk()`, with this plan and the spec. Fix what it finds, with tests, before the PR.
- [ ] **The PR.** Number the ADR (R25) and replace `00NN` everywhere (`grep -rn 00NN docs`). Read the diff's stat against the file map, set the bookmark, push, and open it. The body says what a room gains (the preset, proposals, the approval and its refusals, `restore`), that `approveProposal` is a new store method in both stores and the contract, that every read of an item carries `approved_by` and the public room read carries `preset`, that `bellman_send`, `bellman_surface` and `bellman_start` changed text and their pages were regenerated, and that the dash's PR follows the deploy.
- [ ] **After the merge:** read the deploy job, not only the merge. Then `curl -s https://mcp.bellman.sh/public/rooms/<a public room> | jq .preset` prints that room's preset, or `null`, and its surface read's items carry `approved_by`. Start no topic room in production before Part 2: the owner's three are "Owner actions".

---

# Part 2 — the dash (one PR, after Part 1 deploys and room pages Part 2 has deployed)

**Checkout:** `git -C ~/src/github.com/bellman-sh/dash fetch origin`, then `git -C ~/src/github.com/bellman-sh/dash worktree add ~/.worktrees/dash-topic-rooms -b mcfearsome/topic-rooms origin/main`, and `npm ci` there; never symlink `node_modules`. Unit tests: `npx vitest run <file>`. Lint: `npm run lint`. The build, which typechecks the app and the Worker: `npm run build`. The Worker in workerd: `npm run test:worker`, or `npm run build && npm --prefix worker-tests run test -- <file>` once `worker-tests` is installed.

- [ ] **Setup 1: Check the server.** `curl -s https://mcp.bellman.sh/public/rooms/<a public room> | jq 'has("preset")'` prints `true`, and that room's `/surface` items carry `approved_by`. If either is missing, Part 1 has not deployed; stop and tell the lead.
- [ ] **Setup 2: Check room pages' Part 2 is in.**

```bash
git -C ~/src/github.com/bellman-sh/dash grep -n -E 'export (function|const) (Article|PublicPage)\b' origin/main -- src/components/room/article.tsx
git -C ~/src/github.com/bellman-sh/dash grep -n -E 'export function (datesLine|pageItems)\b' origin/main -- src/lib/article.ts
git -C ~/src/github.com/bellman-sh/dash grep -n -E 'export function (atomFeed|roomMarkdown|itemMarkdown)\b' origin/main -- worker
```

Expected: each prints its lines. A missing one is a stop: this part edits those files.
- [ ] **Setup 3: Install and verify.** `npm ci && npm run lint && npm test && npm run build && npm run test:worker`. Expected: green.

### Task 11: The approver and the topic lines, in the shared article rules

**Files:**
- Modify: `src/lib/article.ts`, `src/lib/api.ts` (`SurfaceItem.approved_by?`, `PublicRoom.preset?`)
- Test: `src/lib/article.test.ts`

**Interfaces:**
- Consumes: `PageItem`, `pageItems` (room pages Task 6).
- Produces, in `src/lib/article.ts`, which still imports nothing (room pages R28):

```ts
// PageItem.data gains:  approved_by?: { member_id: string; label: string } | null;
/** The name of the member whose approval put the card on the page, or null (topic rooms spec, D2). */
export function approverOf(item: PageItem): string | null;
/** The author, and " \u{B7} approved by <approver>" when there is one: the credit beside a card's dates (D6). */
export function creditLine(author: string, approver: string | null): string;
/** The page's second line, exactly (D6). */
export const TOPIC_NOTE = "Written by agents, approved by people.";
/** What the first line says (D6, R27): the maintainers' names, and how many contributors have a card on the page. */
export interface TopicLines { maintainers: string[]; contributors: number }
/** The creator first, then each approver once in the order the cards are given; contributors are the distinct authors of cards that carry an approver and are not named as maintainers. */
export function topicLines(creator: string, items: readonly PageItem[]): TopicLines;
/** "Maintained by A and B. 3 contributors so far." One name is "A", two "A and B", more "A, B and C"; "1 contributor". */
export function maintainersLine(lines: TopicLines): string;
```

  The names are the ones the page shows, so the caller has already put `@handle` in place of the creator's number (`relabel`, `nameFor`).
- `src/lib/api.ts`: `SurfaceItem.approved_by?: { member_id: string; label: string } | null`, documented "absent from a server that predates topic rooms"; `PublicRoom.preset?: string | null`, the same.

- [ ] **Step 1: Write the failing tests**

`src/lib/article.test.ts`:

```ts
const approvedBy = (key: string, author: string, approver: string | null): PageItem => ({
  origin: { label: author },
  data: { ...item(key).data, approved_by: approver === null ? null : { member_id: "m_x", label: approver } },
});

describe("a card's approver (topic rooms spec, D2 and D6)", () => {
  it("names the approver, and reads null for a card with none or a server that sends no field", () => {
    expect(approverOf(approvedBy("a", "member 3", "member 2"))).toBe("member 2");
    expect(approverOf(approvedBy("b", "member 3", null))).toBeNull();
    expect(approverOf(item("c"))).toBeNull();
  });

  it("writes the credit as the author, then the approver when there is one", () => {
    expect(creditLine("member 3", null)).toBe("member 3");
    expect(creditLine("member 3", "@ada")).toBe("member 3 \u{B7} approved by @ada");
  });
});

describe("a topic room's two lines (D6, R27)", () => {
  const cards = [
    approvedBy("a", "member 3", "@ada"),
    approvedBy("b", "member 4", "member 2"),
    approvedBy("c", "member 3", "@ada"),
    approvedBy("d", "@ada", null),
  ];

  it("names the creator first, then each approver once, and counts the contributors whose cards carry an approver", () => {
    expect(topicLines("@ada", cards)).toEqual({ maintainers: ["@ada", "member 2"], contributors: 2 });
  });

  it("does not count a maintainer as a contributor, though another maintainer approved their card", () => {
    expect(topicLines("@ada", [approvedBy("a", "member 2", "@ada"), approvedBy("b", "member 5", "member 2")]))
      .toEqual({ maintainers: ["@ada", "member 2"], contributors: 1 });
  });

  it("is the creator and no contributors for a room with no cards yet", () => {
    expect(topicLines("@ada", [])).toEqual({ maintainers: ["@ada"], contributors: 0 });
  });

  it("reads as a sentence, and the second line is exactly the spec's", () => {
    expect(maintainersLine({ maintainers: ["@ada"], contributors: 0 })).toBe("Maintained by @ada. 0 contributors so far.");
    expect(maintainersLine({ maintainers: ["@ada", "member 2"], contributors: 1 })).toBe("Maintained by @ada and member 2. 1 contributor so far.");
    expect(maintainersLine({ maintainers: ["@ada", "member 2", "member 7"], contributors: 3 })).toBe("Maintained by @ada, member 2 and member 7. 3 contributors so far.");
    expect(TOPIC_NOTE).toBe("Written by agents, approved by people.");
  });
});
```

(`approverOf`, `creditLine`, `topicLines`, `maintainersLine` and `TOPIC_NOTE` join the import from `@/lib/article`.)

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/lib/article.test.ts`
Expected: FAIL: the five names are not exported.

- [ ] **Step 3: Implement** the Interfaces in `src/lib/article.ts` and the two wire types in `src/lib/api.ts`. `topicLines` walks the items once for the approvers, once for the authors.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/lib/article.test.ts && npm run build`
Expected: PASS, and a build that typechecks the app and the Worker.

- [ ] **Step 5: Commit**

```bash
git add src/lib/article.ts src/lib/article.test.ts src/lib/api.ts
git commit -m "The article rules know a card's approver and a topic room's two lines"
```

### Task 12: The approver on each card, and the lines above the cards

**Files:**
- Modify: `src/components/room/article.tsx` (`Article`, `PublicPage`), `src/routes/public-room.tsx`, `src/lib/canvas.ts` (`toWrite`'s comment)
- Test: `src/components/room/article.test.tsx`, `src/routes/public-room.test.tsx`, `src/router.test.tsx`, `src/lib/canvas.test.ts`

**Interfaces:**
- Consumes: `approverOf`, `creditLine`, `topicLines`, `maintainersLine`, `TOPIC_NOTE` (Task 11); room pages' `Article`, `PublicPage`, `datesLine`; `nameFor` (`src/lib/byline.ts`).
- Produces: `Article`'s line under the title is `creditLine(item.origin.label, approverOf(item))`, then `" \u{B7} "`, then `datesLine(item)`. `PublicPage` takes `topic?: { creator: string }`; when it is set, two `<p>` precede the cards: `maintainersLine(topicLines(topic.creator, items))` and `TOPIC_NOTE`. `PublicRoom` passes `topic={room.preset === "topic" ? { creator: nameFor(room.text.origin.label, room.by) } : undefined}`. The item page needs no change: it renders `Article`.

- [ ] **Step 1: Write the failing tests**

`src/components/room/article.test.tsx`, after the first describe (it already defines `dated`, `reading` and the router mock):

```tsx
describe("a card's credit and a topic room's lines (topic rooms spec, D6)", () => {
  const cards = [
    surfaceItem({ key: "a", kind: "text", title: "A", body: "x https://example.com", approved_by: { member_id: "m_x", label: "member 2" }, ...dated("2026-10-18T09:00:00.000Z") }, "member 3"),
    surfaceItem({ key: "b", kind: "text", title: "B", body: "y https://example.com", approved_by: { member_id: "m_y", label: "@ada" }, ...dated("2026-10-17T09:00:00.000Z") }, "member 4"),
  ];

  it("names a card's approver beside its author and its dates", async () => {
    render(<PublicPage roomId="qs_1" roomKey="mcp" read={reading(cards)} />);
    expect(await screen.findByText("member 3 \u{B7} approved by member 2 \u{B7} written 18 October 2026")).toBeInTheDocument();
    expect(screen.getByText("member 4 \u{B7} approved by @ada \u{B7} written 17 October 2026")).toBeInTheDocument();
  });

  it("says who maintains the room and how many contributors it has had, then that agents wrote it and people approved it, above the cards", async () => {
    render(<PublicPage roomId="qs_1" roomKey="mcp" read={reading(cards)} topic={{ creator: "@ada" }} />);
    const first = await screen.findByText("Maintained by @ada and member 2. 2 contributors so far.");
    const second = screen.getByText("Written by agents, approved by people.");
    const firstCard = screen.getAllByRole("article")[0];
    expect(first.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(second.compareDocumentPosition(firstCard) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("shows neither line for a room that is not a topic room", async () => {
    render(<PublicPage roomId="qs_1" roomKey="blog" read={reading(cards)} />);
    await screen.findAllByRole("article");
    expect(screen.queryByText("Written by agents, approved by people.")).toBeNull();
    expect(screen.queryByText(/^Maintained by/)).toBeNull();
  });
});
```

`src/routes/public-room.test.tsx`: `state` gains `preset: undefined as string | undefined`, `by: null as Byline | null` and `topic: undefined as { creator: string } | undefined` (`Byline` joins the import from `@/lib/api`); the route mock's loader data adds `preset: state.preset, by: state.by`; the `PublicPage` mock room pages added takes and records `topic` (`PublicPage: ({ roomId, topic }: { roomId: string; topic?: { creator: string } }) => { state.read.push(`page:${roomId}`); state.topic = topic; return null }`). Add:

```tsx
describe("a topic room's page (topic rooms spec, D6)", () => {
  it("hands the Page view the creator's name when the room's read says topic, as @handle when the room is signed, and nothing for any other room", () => {
    state.opens = "page"
    state.view = undefined
    state.preset = "topic"
    state.by = null
    render(<PublicRoom />)
    expect(state.topic).toEqual({ creator: "jesse@codenerd" })
    cleanup()
    state.by = { handle: "ada", as: "jesse@codenerd" }
    render(<PublicRoom />)
    expect(state.topic).toEqual({ creator: "@ada" })
    cleanup()
    state.preset = "pair"
    state.topic = undefined
    render(<PublicRoom />)
    expect(state.topic).toBeUndefined()
  })
})
```

`src/router.test.tsx`: `let approver: string | null` and `let publicPreset: string | undefined`, reset in `beforeEach` beside `publicBy`; the stub's surface items for `qs_pub` gain `...(approver ? { approved_by: { member_id: "m_maint", label: approver } } : {})`, and its public room read `...(publicPreset ? { preset: publicPreset } : {})`. In `describe("an item's page (room pages spec, D2)")` and `describe("a public room's page")`:

```tsx
  it("shows the approver beside the author on a card's own page, and the creator who approved it as @handle", async () => {
    approver = CREATOR;
    publicBy = { handle: "ada", as: CREATOR };
    await boot("/r/qs_pub/other");
    expect(await screen.findByText("member 2 \u{B7} approved by @ada \u{B7} written 7 October 2026")).toBeInTheDocument();
  });

  it("shows a topic room's two lines above its articles, the creator named @handle", async () => {
    approver = CREATOR;
    publicBy = { handle: "ada", as: CREATOR };
    publicPreset = "topic";
    publicView = "page";
    await boot("/r/qs_pub");
    expect(await screen.findByText("Maintained by @ada. 1 contributor so far.")).toBeInTheDocument();
    expect(screen.getByText("Written by agents, approved by people.")).toBeInTheDocument();
  });
```

`src/lib/canvas.test.ts`, beside the `toWrite` cases:

```ts
  // R20: the server refuses its own approver on a write, as it refuses cursor and at.
  it("leaves the approver out of a write made from an item it read", () => {
    const read = surfaceItem({ key: "plan", kind: "text", title: "Plan", body: "hi", approved_by: { member_id: "m_maint", label: "member 2" } }).data;
    expect(toWrite(read)).toEqual({ kind: "text", title: "Plan", body: "hi" });
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npx vitest run src/components/room/article.test.tsx src/routes/public-room.test.tsx src/router.test.tsx src/lib/canvas.test.ts`
Expected: FAIL: a card's line has no approver, `PublicPage` ignores `topic`, `PublicRoom` passes none. The `toWrite` case PASSES once `SurfaceItem` has the field (Task 11): it pins what `toWrite` already does.

- [ ] **Step 3: Implement**

`Article`'s line and `PublicPage`'s `topic` prop to Interfaces: the two lines are `<p>`s of text in a block above the first article, under no heading, with a `data-topic-lines=""` attribute so a test or a style can find them. `PublicRoom` passes `topic` as Interfaces say. `toWrite`'s comment names `approved_by` beside `cursor`, `at`, `created_at` and `changed_at`. The header comments of `article.tsx` and `public-room.tsx` gain D6.

- [ ] **Step 4: Run them and watch them pass**

Run: `npx vitest run src/components/room/article.test.tsx src/routes/public-room.test.tsx src/router.test.tsx src/lib/canvas.test.ts && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/room/article.tsx src/components/room/article.test.tsx src/routes/public-room.tsx src/routes/public-room.test.tsx src/router.test.tsx src/lib/canvas.ts src/lib/canvas.test.ts
git commit -m "A card on a room's page names its approver beside its author, and a topic room's page says who maintains it and who wrote what"
```

### Task 13: The Worker names the approver where it names the author

**Files:**
- Modify: `worker/index.ts` (`isSurfaceRead`, `itemPage`'s summary line), `worker/markdown.ts` (`roomMarkdown`, `itemMarkdown`), `worker/feed.ts` (`atomFeed`), `worker-tests/stub.ts` (`post`)
- Test: `worker-tests/item.test.ts`, `worker-tests/markdown.test.ts`, `worker-tests/feed.test.ts`

**Interfaces:**
- Consumes: `approverOf`, `creditLine` (Task 11); `nameFor` (`src/lib/byline.ts`); room pages' Worker symbols.
- Produces: `post(key, { approvedBy?: string })` in `worker-tests/stub.ts`, which sets `data.approved_by` to `{ member_id: "m_maint", label: approvedBy }` and leaves the field out otherwise. `isSurfaceRead` accepts `data.approved_by` absent, null, or an object with a string `member_id` and a string `label`; any other value is a read of the wrong shape (served as the app, kept in no cache). Wherever the Worker writes `<author> \u{B7} <dates>` it writes `creditLine(author, approver)` first, both named through `nameFor(label, room.by)`; the feed adds `<contributor><name>…</name></contributor>` after `<author>` for an approved entry.

- [ ] **Step 1: Write the failing tests**

`worker-tests/item.test.ts`:

```ts
  it("names the approver beside the author in the summary a crawler reads, the creator as @handle", async () => {
    const id = stubRoom("approved", { by: { handle: "ada", as: "member 1" } });
    stubSurface(id, [post("note", { title: "A note", body: "One. https://example.com", label: "member 3", approvedBy: "member 1", created: "2026-10-18T09:00:00.000Z" })]);
    const html = await (await open("/r/approved/note")).text();
    expect(html).toContain("<p>member 3 \u{B7} approved by @ada \u{B7} written 18 October 2026</p>");
  });

  it("serves the app with the template's head when an item's approver is the wrong shape, and keeps it from the cache", async () => {
    const id = stubRoom("odd-approver");
    const odd = post("plan");
    answers[`${API}/public/rooms/${id}/surface`] = {
      status: 200, body: { items: [{ ...odd, data: { ...odd.data, approved_by: "member 1" } }] },
    };
    expect((await open("/r/odd-approver/plan")).status).toBe(200);
    expect(await caches.default.match(`${API}/public/rooms/${id}/surface`)).toBeUndefined();
  });
```

`worker-tests/markdown.test.ts`:

```ts
  it("names the approver after the author, in a room and in an item", async () => {
    const id = stubRoom("md-approved", { room: "Topic", purpose: null, by: { handle: "ada", as: "member 1" }, publicUrl: "https://bellman.sh/r/md-approved" });
    stubSurface(id, [post("tools", { title: "Tools", body: "See https://example.com", label: "member 3", approvedBy: "member 1", created: "2026-10-10T09:00:00.000Z" })]);
    expect(await (await read("/r/md-approved", "text/markdown")).text()).toBe(
      "# Topic\n\n## Tools\n\nmember 3 \u{B7} approved by @ada \u{B7} written 10 October 2026\n\nSee https://example.com\n",
    );
    expect(await (await read("/r/md-approved/tools", "text/markdown")).text()).toBe(
      "[Topic](https://bellman.sh/r/md-approved)\n\n## Tools\n\nmember 3 \u{B7} approved by @ada \u{B7} written 10 October 2026\n\nSee https://example.com\n",
    );
  });
```

`worker-tests/feed.test.ts`:

```ts
  it("names the approver as a contributor of the entry, the creator as @handle", async () => {
    const id = stubRoom("fed-approved", { room: "Topic", purpose: null, by: { handle: "ada", as: "member 1" }, publicUrl: "https://bellman.sh/r/fed-approved" });
    stubSurface(id, [post("tools", { title: "Tools", body: "See https://example.com", label: "member 3", approvedBy: "member 1" })]);
    const xml = await (await feed("fed-approved")).text();
    expect(xml).toContain("<author><name>member 3</name></author>\n<contributor><name>@ada</name></contributor>\n<content");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `npm run build && npm --prefix worker-tests run test -- item.test.ts markdown.test.ts feed.test.ts`
Expected: FAIL: the lines name no approver and the feed has no contributor; the wrong-shape case is served and kept, as nothing checks the field.

- [ ] **Step 3: Implement**

`post` in `worker-tests/stub.ts`; `isSurfaceRead` as in Interfaces; the three writers use `creditLine(nameFor(item.origin.label, room.by), approver === null ? null : nameFor(approver, room.by))`, with the escaping each format already applies to the author (room pages R22) applied to the approver; the feed's `<contributor>` line uses the text escape.

- [ ] **Step 4: Run them and watch them pass**

Run: `npm run test:worker && npm test && npm run build && npm run lint`
Expected: PASS.

- [ ] **Step 5: The words, the diff, and everything**

Run:
```bash
grep -nE -i 'load-bearing|load bearing|worth (saying|stating|noting|knowing|recording)|structural|two sessions|the other session' src/lib/article.ts src/components/room/article.tsx src/routes/public-room.tsx worker/*.ts
npm run lint && npm test && npm run build && npm run test:worker
npx wrangler deploy --dry-run --outdir "$(mktemp -d)"
git diff --stat origin/main...HEAD
```
Expected: the scan prints nothing; everything passes; the dry run bundles `worker/index.ts` with the `ASSETS` binding; the stat names the files of Tasks 11 to 13 and nothing else.

- [ ] **Step 6: Commit**

```bash
git add worker/index.ts worker/markdown.ts worker/feed.ts worker-tests/stub.ts worker-tests/item.test.ts worker-tests/markdown.test.ts worker-tests/feed.test.ts
git commit -m "The item summary, Markdown and feed name a card's approver where they name its author"
```

### Part 2's review and PR

- [ ] **The whole-branch review:** one reviewer over `git diff origin/main...HEAD`, with this plan and the spec. Fix what it finds, with tests, before the PR.
- [ ] **The PR.** Read `git diff --stat origin/main...HEAD` against the file map, then push and open it. The body says what a reader of a topic room now gets (the approver on each card, the two lines above its cards, the approver in the item's summary, Markdown and feed), that it follows the server's PR, and that the lines are derived from the cards the page shows (R27).
- [ ] **After the merge:** read the deploy job and its live checks. Then, once the owner has started a room ("Owner actions"): open `https://bellman.sh/r/mcp`; it opens as a page with the two lines; approve one proposal and reload, and the card names its author and its approver; `curl -s -H 'accept: text/markdown' https://bellman.sh/r/mcp` prints the card with `approved by` in its line.

---

## After this plan

- **The docs, once Part 2 deploys** (R26), a bellman PR:
  - `docs-site/src/content/docs/guides/public-rooms.md`, in the section "A public topic room" Part 1 added: a topic room opens as a page; above its cards two lines say who maintains it and how many contributors have a card on it, then `Written by agents, approved by people.`; each card shows its author, its approver and when it was written and last edited; the approver and the lines are derived from the cards on the page, so a maintainer who has approved nothing is not named until they do.
  - `README.md`, the public rooms item, one sentence: a topic room's page shows who wrote and who approved each card.
- **The three rooms** are the owner actions above.

## Open questions

- **R20, `approved_by`'s shape.** The spec says a member id; the plan sends `{ member_id, label }` so a reader outside the room, and the existing public name rule, can name the approver. An id alone changes Task 5, the public reads and Part 2.
- **R6, the audience of a proposal.** The spec says nothing about the rule that every other member must have granted `request_actions` before an `action_request` is sent. Without the ruling, one contributor who granted nothing, the default, refuses every proposal in a public topic room. The ruling narrows the check to the seats that can answer, and so makes a maintainer's agent grant `request_actions` (Owner actions, step 1).
- **R16, `stale` and a removed key.** The spec reads the key's current cursor, which a removal erases. The plan reads the log from `base` for a key with no row so a removed card is not put back by an old edit. If the owner would rather keep the spec's letter, `decideApproval`'s no-row branch and one contract case go.
- **R9, the seven days belong to topic rooms.** The spec says the deadline follows the request's kind. The plan limits it to topic rooms so no member can keep thousands of requests in every peer's `outstanding` for a week by naming a kind.
- **A maintainer's own card has no approver.** A card a maintainer writes directly carries an author and no approver, and the page shows the author alone. The owner's first cards are such unless they propose from a second seat. Stamping `approvedBy` with the writer in a topic room is a few lines in `writeSurface`; the spec is silent.
- **R27, the page's lines are derived from its cards.** "Contributors whose cards were ever approved" reads as "who have a card on the page", and a maintainer who has approved nothing and did not create the room is not named. A field on the public room read, the maintainers' public names and an approved-contributor count, would give both exactly, at the cost of reading the roster and the log on a read the Worker keeps a minute.
- **R10, the cost of seven days.** A topic room's `bellman_sync` reads up to a week of its log on every poll while a proposal under a week old exists. Fine at the first rooms' size; the upgrade is the oldest open proposal's cursor kept on the record.
- **R17, a stale proposal holds its place.** It stays open and counts toward its proposer's three until a maintainer declines it or seven days pass, and the proposer cannot withdraw it. A withdraw (a response to your own request, accepted only as a decline) is small and the spec has none.
- **R29, a pending proposal is public.** In a public room the Log shows a proposal's whole item before any maintainer has read it. The spec's D8 says as much; the public rooms guide should say it too.
- **The canvas does not show the approver.** The Page view and the item page do (the lead's scope); `Attribution` in the canvas, shared with the members' panel, does not.
- **R13.** A seat with `respond_actions` and no `write_surface` records an approval and closes the proposal with no card. The topic preset cannot reach it; it is the safety net the spec lists, and the proposal reading `answered` is this plan's ruling.
- **R3.** A saved preset named `topic` is shadowed by the built-in, as `social`'s was.
