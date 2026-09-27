# Server-Enforced Permission Verbs (M0) — Design

Issue: [#2 M0: Roles with server-enforced permission verbs](https://github.com/bellman-sh/bellman/issues/2)
Status: approved design, pending implementation plan
Depends on: #1 (landed — [room manifests](2026-09-23-room-manifests-design.md))
Blocks: #3 (role-carrying join codes)
Generalises: [room scribe](2026-09-25-room-scribe-design.md) D5

## Problem

#1 gave every room a declared manifest: a closed verb enum, a `roles` table,
and a `roomRole` on every member. Nothing reads any of it at call time.

The gap is not cosmetic. `bellman_connect` shows a joiner the verbs their seat
would hold, and then — because there is no guard — tells them the truth:

> The room's verbs are the creator's declared rules, not yet enforced at call
> time: read them as stated intent, not a guarantee.

A joiner's human approves a room on the strength of that preview. Today the
preview is advisory. #2 makes it a fact.

Authority meanwhile lives in the wrong place. `Member.capabilities` is declared
by each member **about themselves** and checked in two ad-hoc spots inside
`bellman_send`. Self-declared authority is not authority.

### Why server-side

Bellman is cross-provider by design: a GPT agent's output lands in a Claude
context and vice versa. A client-side permission check is advisory, because the
other client is not yours. The server is the only party both sides trust.

## Decisions

### D1 — Verbs and capabilities are two layers. Both stay.

Issue #2 opens by proposing that `capabilities` move into roles. It does not,
and #1's design already said why: they answer different questions.

| | question | declared by | direction |
|---|---|---|---|
| **verb** | what may this seat *do*? | the room's manifest | sender-side |
| **capability** | what may be delivered *to me*? | the member, about themselves | recipient-side |

A member may still refuse delivery of something the sender's role permits.
Collapsing the two would delete recipient consent, which is a different feature
and not one this issue asked to remove.

So #2 adds a **new check site** — a guard at the top of each handler, in front
of the existing recipient-side filter — and rewrites nothing in `bellman_send`'s
fan-out. `Member.capabilities`, the `Capability` type, `CapabilitiesShape` and
`MemberPatch.capabilities` are untouched.

**Precedence.** The verb guard runs first. A member who lacks `send` in a room
where nobody granted `receive_messages` hears about their own role, not about
the recipients — the sender-side fact is the one they can act on.

### D2 — An org admin holds nothing in a room, and that is structural.

There are two things called "role" and they are not the same thing:

- `Identity.role` (`"member" | "admin"`) is **platform-level**: who administers
  an org. It is gated by plan and it is what `/admin/grants` and `bellman_audit`
  check.
- `Member.roomRole` is **per-room**: what you may do inside one session.

An org admin is not automatically anything in a room. A room's creator need not
be an org admin. Getting this wrong would silently grant people authority they
did not buy and did not expect, so the separation is enforced by construction
rather than by discipline:

> **`Identity.role` appears in no room guard.** Every room authorization
> question is answered by `src/roles.ts`, whose functions take a `Session` and a
> `Member` and cannot see an `Identity` at all.

That is a grep-able invariant — `grep -n 'identity\.role' src/server.ts` should
only ever find `bellman_audit` — and it has a test: an `admin` identity seated
as a swarm `observer` is refused `send`.

There is deliberately **no break-glass**. An org admin cannot act in a room
their seat does not permit, even in their own org. The recovery path for a room
whose only invite-holder left is to start a new room — cheap, and it keeps the
preview honest, which is the whole point of the issue.

### D3 — One verb per operation, including `brief_update`.

| operation | verb |
|---|---|
| `bellman_send` type `message` | `send` |
| `bellman_send` type `artifact` | `send` |
| `bellman_send` type `action_request` | `request_actions` |
| `bellman_send` type `action_response` | `respond_actions` |
| `bellman_send` type `brief_update` | `send` |
| `bellman_invite` | `invite` |
| `bellman_invite` with `revoke: true` | `revoke` |

Ungated, and staying that way: `bellman_sync`, `bellman_leave`,
`bellman_connect`, `bellman_confirm`. Reading is implied by membership, a member
must always be able to leave, and the two connect phases happen before a seat
exists.

`brief_update` was the only ambiguous one. It writes the sender's own brief, but
it also appends a `brief_update` event that puts their prose into every peer's
context — which is sending. Gating it on `send` keeps the rule exceptionless and
matches what the `observer` role already promises its readers: *"Reads the room.
Sends nothing."*

The consequence is real and accepted: a member in a verbless seat keeps the
brief they joined with for the life of the room. A seat that may not speak may
not restate itself either.

`invite` and `revoke` are separate verbs because #1's enum made them separate.
A role may hold one without the other, and the guard respects that rather than
treating `revoke` as a weaker `invite`.

### D4 — The guard is inline, not a wrapper.

`bellman_send`'s required verb depends on `type`; `bellman_invite`'s depends on
`revoke`. Any declarative tool→verb table is therefore already a function of the
arguments, so a `registerTool` wrapper would need the same per-branch logic plus
the indirection. It would also move the check out of the handler a reader is
reading.

One call at the top of the branch. Nothing else.

### D5 — The accessor fails closed.

`verbsOfRole` returns `[]` for a role name the manifest does not define, guarded
with `Object.hasOwn`.

This cannot happen today: both seats are assigned from `manifest.creatorRole`
and `manifest.defaultRole`, which `resolveManifest` checked against `roles`, and
`RoleKeyShape` bans the three prototype-reachable names precisely so a bare
lookup is safe. But sessions round-trip through JSON in Durable Objects, #3 is
about to make join codes carry a role, and a total accessor costs one line. An
unknown seat holds nothing.

## Architecture

### `src/roles.ts` — new, the only place roles are indexed

```ts
/** The verbs a role holds. Fails closed: an undefined role holds nothing (D5). */
export function verbsOfRole(m: RoomManifest, role: string): readonly Verb[];

/** null when allowed; otherwise the error message naming the seat and the verb. */
export function denyVerb(s: Session, me: Member, verb: Verb): string | null;
```

Two functions, no class, no state. `denyVerb` takes a `Session` and a `Member`
and so is structurally incapable of consulting an `Identity` (D2).

`roomPreview` in `src/server.ts` currently indexes `m.roles[viewerRole]?.can`
directly to build `your_verbs`. It switches to `verbsOfRole`, so the verbs a
joiner is **shown** and the verbs **enforced** are computed by one function and
cannot drift apart. That is the invariant the whole issue rests on.

### The denial message

The issue requires "an explicit error naming what they lack, not a silent
no-op". `denyVerb` returns:

```
your role "observer" does not hold the verb "send" (it holds: none).
your role "reviewer" does not hold the verb "request_actions" (it holds: send, respond_actions).
```

`fail()` prefixes `Error: `. The message names the seat, the verb, and what the
seat *does* hold — enough for the agent to tell its human "ask the lead to do
this" rather than retry. Every value in it is server-controlled: role keys match
`[a-z][a-z0-9_]{0,30}`, verbs come from the closed enum. No caller-supplied
string is echoed, so there is nothing to bound or escape.

### Check ordering in `bellman_send`

The guard goes immediately after `findMember`, **before** the payload-size check
and before `others.length === 0`.

Authority is a property of the seat, independent of the payload and of who is
listening. Two reasons the order matters:

1. An observer should hear "your role does not hold send", not "payload too
   large" — the verb denial is the stable, actionable truth; the size one sends
   them off to shorten a message they were never allowed to send.
2. `others.length === 0` leaks room occupancy. A member with no authority to act
   should not learn who is present by probing.

`brief_update` is guarded before `s.updateMember`, so a denial writes nothing.

### `bellman_invite`

```ts
// Roles land in M0; until then the creator is the only one who can reopen the door.
if (session.createdBy !== identity.userId) {
  return fail("only the session creator can issue join codes.");
}
```

is deleted and replaced by `denyVerb(session, me, revoke ? "revoke" : "invite")`.
That placeholder — comment included — is what the issue names. M0 is here.

Two consequences, both intended:

- A manifest may now grant a joiner `invite`. Under the placeholder only the
  creator ever could, regardless of what any role declared.
- A **sealed room** — one where no role holds `invite` — can be reopened by
  nobody, including its creator. `tests/manifest.test.ts` already declares
  sealed rooms legal ("allows a sealed room where nobody can invite"), so this
  is the declared behaviour arriving, not a regression.

`Session.createdBy` stays as provenance. After this change nothing reads it to
decide authority.

## Relationship to the room scribe

The [scribe design](2026-09-25-room-scribe-design.md) is approved and
unimplemented, and its D5 names this issue directly:

> `summarize` joins the verb enum […] When #2 lands, the rule generalises from
> "the creator" to "any role holding `summarize`", and the verb is already there.

Neither design blocks the other, but whichever lands second does the join:

- **#2 first** (the expected order). `summarize` is still absent from `VERBS`,
  which is correct — #1's rule is that a verb enters the enum in the PR that
  adds its operation. The scribe PR then adds `summarize` to `VERBS`, grants it
  to `peer_a`/`lead`/`author`, and writes its handler's guard as
  `denyVerb(session, me, "summarize")` from the start. It never writes an
  ownership check at all.
- **Scribe first.** Its interim ownership check (`session.createdBy`) becomes
  the second thing #2 deletes, alongside `bellman_invite`'s, and the scribe's
  handler joins D3's table.

One knock-on either way: the scribe's D5 justifies its ownership check by
pointing at `bellman_invite` as "an existing pattern". This design removes that
example, so if the scribe lands afterwards, that sentence is stale and the
check should be written as a verb guard directly.

Two inaccuracies in the scribe doc noted, **not fixed here** — they belong to
that design and to whoever implements it: it calls `summarize` "the eighth
verb" when the enum now holds five (it would be the sixth), and its claim that
ownership checks "live alongside the unenforced verbs as an existing pattern"
expires with this PR.

## The promises that come due

#1 wrote, in four places, that verbs are not enforced. All of them change here,
and one of them is a test built to fail today:

| location | today | after |
|---|---|---|
| `tests/tools/exchange.test.ts:449` | a `describe` proving a role's verbs are *not* enforced, commented "expected to FAIL the day #2 enforces verbs" | deleted, replaced by `tests/tools/verbs.test.ts` |
| `tests/tools/surface.test.ts:116` | pins that three tool descriptions contain "not yet enforced at call time" | inverted: pins that they state enforcement |
| `src/server.ts` tool descriptions — `bellman_start`, `bellman_connect`, `bellman_confirm` (the three that return a `room` block) | "declared, not yet enforced at call time" | the verbs your seat holds are enforced by the server |
| `src/server.ts` `roomPreview` docblock | "Nothing enforces them at call time until #2" | describes the guard, points at `src/roles.ts` |
| `README.md` ×4 | "verbs are declared, not yet enforced" | the same correction |

The tripwire test is why this list is trustworthy rather than a hope.

## Testing

`tests/tools/verbs.test.ts` — new. The issue is explicit that the current
capability checks "have exactly one shape of test each" and that denial paths
are the point.

1. **The matrix.** Each of the seven (operation → verb) pairs from D3, twice: a
   seat holding the verb succeeds, a seat lacking it returns `isError` with a
   message naming the role and the verb.
2. **No silent no-op, proved.** Every denial asserts `session.events` is
   unchanged afterwards. This is the requirement stated as an assertion rather
   than as prose.
3. **A denied `brief_update` leaves the stored brief untouched** — the guard
   runs before the write, not after.
4. **The collision (D2).** An identity with `role: "admin"` seated as a swarm
   `observer` is refused `send`. Platform authority buys nothing in a room.
5. **Fail closed (D5).** A member whose `roomRole` names no role in the manifest
   is refused every verb. Constructed by seating a member directly through
   `MemoryStore`, since no tool path can produce it.
6. **Ungated stays ungated.** That same observer can still `bellman_sync` and
   `bellman_leave`.
7. **Preset end-to-end.** In a `review` room the reviewer's `action_response`
   is allowed and their `action_request` is refused — the preset's declared
   asymmetry, now enforced.

`tests/tools/invite.test.ts` — the creator-only assertions become role-based,
including a seat holding `invite` but not `revoke` being refused on
`revoke: true`.

**Every new assertion must be seen to fail before it is trusted.** A denial test
passes for free if the operation was already failing for an unrelated reason — a
missing `ref_id`, an empty room, a frozen session. Two safeguards: each matrix
row runs its holder case first, so a denial that "passes" against a broken
operation is caught by its own inverse; and the implementation plan stubs
`denyVerb` to return `null` unconditionally once and confirms the suite goes
red before the real guard is written.

## Files

| File | Change |
|---|---|
| `src/roles.ts` | **new** — `verbsOfRole`, `denyVerb` |
| `src/server.ts` | guard in `bellman_send` (per kind) and `bellman_invite` (per branch); delete the `createdBy` authority check; `roomPreview` reads through `verbsOfRole`; three tool descriptions |
| `README.md` | four lines |
| `tests/tools/verbs.test.ts` | **new** — the denial matrix |
| `tests/tools/exchange.test.ts` | delete the "declared, not yet enforced" tripwire |
| `tests/tools/surface.test.ts` | invert the enforcement pin |
| `tests/tools/invite.test.ts` | creator-only → role-based |
| `src/types.ts` | **unchanged** — `Capability` and `Member.capabilities` stay (D1) |
| `src/store.ts`, `src/store-do.ts` | **unchanged** — no new state, no new method |

## Out of scope

- **#3** — join codes that carry a role. Until then every joiner gets
  `defaultRole`, and this design does not care which seat they got.
- **`summarize`** and the scribe's handler. The verb enters the enum in the PR
  that adds its operation, per #1's rule.
- Changing a member's role mid-room. #1's D6 makes manifests immutable after
  creation; promotion needs a store method and an audit story of its own.
- Any change to `Capability` or recipient-side consent (D1).
- Break-glass for org admins (D2).
