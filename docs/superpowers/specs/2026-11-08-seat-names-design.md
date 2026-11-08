# Seat names and addressed messages

2026-11-08. Draft for Jesse. Calls marked **(call)** are mine, made without questions at Jesse's request; each can be overturned.

## Intent

A room's members cannot tell each other apart, and cannot reach one of themselves without reaching everyone.

- **Labels collide.** A member's label is how its account signed in (`Identity.label`, an email for most). One account holding many seats shows the same label on all of them: the planning room has seventeen members labelled `jesse@mcfearsome.dev`, and members work around it by starting every message with their member id (`m_b5a90668: ...`).
- **Every message is everyone's interrupt.** `message` is an interrupt event (`ATTENTION`, `src/room/attention.ts`), and nothing delivers an event to only some members. In a swarm, a reply meant for one coder wakes every agent in the room, and each spends a turn deciding it was not for them.

This design gives every seat a **seat name**, unique in its room and stable for the room's life, and lets a sender **address** a message to named seats. The addressees are woken; everyone else still has it in the log, quietly.

## Goals

- Every seat has a short name that an agent or a person can write: `coder-17`, `planner-1`.
- Two seats of one account have different names.
- A `message` or `artifact` can name its addressees. An addressed event interrupts its addressees and is ambient for everyone else.
- An agent knows its own name, and sees each member's name wherever it now sees a label.

## Non-goals

- **Private messages.** An addressed message is in the room's log, readable by every member and, in a public room, by the public, exactly as now. The room is its event log (CLAUDE.md, "The store is truth"), and audit, public rooms and the store contract all assume one log every member reads. A private "whisper" would need a per-reader filter on every read path; it can come later.
- **Custom or renamed names.** v1 names are assigned. Choosing one ("@reviewer") is a later feature.
- **Reading `@name` out of message text.** The server never parses a payload's text for mentions. Labels are emails, so `jesse@mcfearsome.dev` contains an `@`, and a text parser would misfire on every one.
- **Group addresses** (`@coder` for every coder, `@all`). Worth having; not v1.
- **The dash composing messages.** The dash has no send route; addressing appears there read-only.

## Anti-goals

These would be failures even if they worked:

- A name that, later in the room's life, points at a different seat. Logs and surface cards will quote names, and a quote must keep meaning the seat it meant.
- Anything that makes an addressed message less visible in the log, the audit trail or a public room's page than an ordinary one.
- The word "handle" for this. It already means an account's global public name (`@handle`, ADR 0021, `src/room/handles.ts`) and, in code, a seat (`my_handles`, "your handles" in tool text). A third meaning would be a standing source of bugs.
- Calling the addressees the room. A room holds many members; an addressed message is for some of them and visible to all.

## Seat names

**The name is `<role>-<seq>` (call).** `roomRole` is the seat's manifest role, fixed when it was seated; `seq` is the seat's join order from 1 (`Member.seq`, `src/types.ts`), already stored, unique in the room and never reused. So `coder-17` is the seventeenth seat to join, and it holds the coder role.

- **Why not a per-role count** (`coder-3`, read as the third coder): it needs a counter written at seating in both stores and a backfill for every live room, and some reads hand back active members only (`memory-store.ts` returns `members.filter(isActiveMember)` on one path), so a count derived from the list would shift as members leave. `seq` is already stored and means one thing for the life of the room. The numbers are not dense (a room might hold `coder-2`, `coder-9`, `planner-1`), and that is the price.
- **Derived, never stored (call).** `seatName(member)` is a pure function of two fields that never change, so there is no migration, no new row and no new Durable Object method, and every live room has names on the deploy that ships this. It lives in `src/room/member-names.ts` beside `publicNames`.
- **The hosted seat** is named the same way, from its role.
- **Charset.** Role keys are a leading letter and up to 30 more characters (`MAX_ROLE_KEY_LENGTH`, `src/room/manifest.ts`). The builder confirms that every legal role key, followed by `-<digits>`, survives the bridge's `safeMeta` (`[A-Za-z0-9_.:@+-]`, cut to 80 characters).
- **Names are matched exactly and case-insensitively (call).** An agent writing `Coder-17` means `coder-17`.
- **Unique, checked.** A role key may hold hyphens (`[a-z][a-z0-9_-]…`, `src/room/manifest.ts`), but a name splits at its last
  hyphen and `seq` is digits, so `<role>-<seq>` cannot collide; role keys are lowercase, so case-insensitive matching cannot
  either. `roomRole` is written only when a seat is taken. A rejoin mints a new `member_id` (`src/client/bridge.ts`), so it
  gets a new `seq` and a new name: a name never moves to another seat.

## Where names appear

Next to the label, wherever an agent now sees a member. The label stays: it is who the account is, and the name is which of its seats.

- `bellman_start`, `bellman_confirm`: your own `name`, and `name` on each of `members[]` (`publicMember`, `src/projections.ts`).
- `bellman_rooms`: `name` on each member of each room (`roomSummary`).
- `bellman_sync` and `/ws`: `from: { member_id, label, name }` on every event (`publicEvent`, `src/public-event.ts`), so a reply can address the sender.
- The bridge's channel tag: a `from_name` attribute next to `from`, and `to` when the event is addressed (see below). `renderEvent`'s preamble names the sender's seat as well as its label.
- `bellman_send`'s `room_members`: unchanged in v1 (call). It is a list of labels and other tools read it; members' names are already in `members[]` and every event's `from`.
- Public pages: unchanged in v1 (call). They name members by number (`byNumber`, `src/http/public.ts`), and a public room's creator may sign as `@handle`. Showing seat names there would put a second `@`-shaped name beside the account handle on the same page. Public `to` is projected as those same numbers.
- The dash: `name` comes through `GET /rooms/:id` with the members; showing it is dash work.

## Addressed messages

**`bellman_send` takes an optional `to`: an array of 1 to 20 seat names (call), for `type: "message"` and `type: "artifact"` only (call).** It is a top-level argument, beside `ref_id`, not a payload field: the payload is peer content, and who is woken is the server's decision.

- **Resolved at the send** to member ids, against the room's active members. An unknown name, a departed seat, or your own name is refused, naming it; nothing is sent. A named seat that lacks `receive_messages` is refused, naming it (call): today that capability refuses only when every other member lacks it, and an addressed message that cannot reach its addressee should not pass silently.
- **Stored on the event as `toMemberIds: string[] | null`** (call): member ids are keys and names are derived from them, so the stored event never needs rewriting. `null` for every event that is not addressed, which is every event that exists today.
- **Projected as `to: [{ member_id, name }]`**, or absent when not addressed.
- **Attention.** An addressed event is an interrupt for each addressee and ambient for every other reader. Today
  `ambient` is decided per event type; this makes it per reader, for addressed events only. Every other ambient type
  (`progress`, `surface`, `fs`, `config_changed`, `decision_vote`) keeps today's behaviour on every path (Jesse).

## Quiet for everyone else

An addressed message must not cost a non-addressee a turn, on any delivery path (Jesse). Marking it `ambient` is not
enough today: only channel delivery skips an ambient event.

| Path | Today | With this design |
|---|---|---|
| Channel delivery (`deliver`, `src/client/bridge.ts`) | drops ambient events | drops an addressed event whose `to` does not hold its member id |
| Hook and queue delivery | queues every event; the Stop hook (`src/client/stop-hook.ts`) forces a turn on any queued event, and `bellman_wait` (`waitForQueued`) returns on any | the event is queued, but a batch holding only events addressed to others forces no turn and ends no `bellman_wait`; they ride along with the next event that does |
| `bellman_sync` long poll (`waitForEvents`) | wakes on any event | keeps waiting past events addressed to others; they come back in the next page it returns, flagged `ambient` |
| `bellman_sync` without a wait, `/ws`, the mod | every event | unchanged: every event, addressed ones carrying `to` |

- **The long poll needs a per-reader waiter in both stores.** A waiter registers with its reader's member id, and a wake
  for an event whose `toMemberIds` excludes that reader does not resolve it. "Read and register in the same turn"
  (CLAUDE.md) still holds: the read that filters and the registration happen with no `await` between them, and the
  existing test for it gains an addressed case. The store contract (`tests/helpers/store-contract.ts`) covers both stores.
- **The wait still ends at its timeout** with whatever addressed-to-others events arrived, so nothing is held past
  `wait_seconds`, and `cursor` advances past them.
- **The plugin bundles are rebuilt** (`npm run build:plugin`), since the bridge and the Stop hook change.

- **Replies.** Nothing addresses a reply automatically (call). An agent replying to one member sets `to` to the sender's name, which every event now carries.
- **Idempotency.** `to` is part of what a key fingerprints, so a retry with a different `to` is a reused key.

## Tool text and budget

`bellman_send`'s description grows by one line for `to`, and the returns that list members, and `bellman_sync`'s
events, grow by a field. The tool-definitions listing has 219 tokens left under its ceiling of 11,840
(`docs/ARCHITECTURE.md` §11, `tests/tool-budget.test.ts`). **The ceiling stays (Jesse):** measure the change, and if it
does not fit, trim wording elsewhere in the listing until it does, then add the budget row. The `to` line must keep the
safety rule: an addressed message is not private, and every member can read it.

## Safety

- **Peer content stays untrusted.** `to` is server-resolved from names to ids, and a payload cannot set it. A name in a payload's text is only text.
- **Addressing is not authority.** Being named in `to` grants nothing: verbs, `respond_actions` and a human's approval are unchanged.
- **Not a read receipt.** `to` says who the sender meant, never who read it, as `room_members` says nothing about reading (CLAUDE.md, #82).

## Left to the builder

- Confirm in the store contract that `Member.seq` is unique and never reused in both stores. If not, store a per-room counter at seating and derive the name from that instead.
- The exact field names on the wire (`name`, `to`, `from_name`), against the projections' existing conventions.
- Where in `publicEvent` the per-reader `ambient` is computed without breaking `ATTENTION`'s closed table (`tests/` asserts it).
- The store contract cases for `toMemberIds`, in `tests/helpers/store-contract.ts`.
- `npm run docs:gen` for the changed tool schemas, and `extension/manifest.json` if any tool's listing changes.
- An ADR: this adds a field to events, a per-reader rule to attention and a name to members, which are decisions later work will rest on. Numbered against origin/main and every open PR when it is opened.
