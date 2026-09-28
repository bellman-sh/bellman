# Role-Carrying Join Codes (M0) — Design

Issue: [#3 M0: Join codes carry a role](https://github.com/bellman-sh/bellman/issues/3)
Status: approved design, pending implementation plan
Depends on: #1 (landed — [room manifests](2026-09-23-room-manifests-design.md)),
#2 (landed — [permission verbs](2026-09-25-permission-verbs-design.md))

## Problem

`BELL-7F3K-92` names a room and nothing else. Every joiner arrives identical,
and what they may do is settled afterwards.

#2 made a room's verbs real at call time, and closed by writing down what it
did not do:

> **#3** — join codes that carry a role. Until then every joiner gets
> `defaultRole`, and this design does not care which seat they got.

That is the gap. A room can declare a `reviewer` seat and an `author` seat, and
the server will now enforce the difference — but there is no way to hand
somebody the reviewer one. `bellman_connect` previews `manifest.defaultRole`
because that is the only seat a joiner can ever land in.

### What changed since the issue was filed

The issue's Scope leads with the encoding, and its Constraints section is about
the alphabet. Both are now the smaller half of the work.

Codes stopped being a property of creation. `bellman_invite` mints a fresh code
at any time, retires the previous one, and revokes. So role-carrying codes have
to work with reissue: minting a code *for a role*, and revoking *that role's*
code without disturbing the others.

`Session.joinCode` is a single nullable string. It cannot hold a reviewer code
and a contributor code at the same time, and that — not the encoding — is the
substantive change.

One correction to the issue while we are here: it fixes the body as Crockford
base32. `src/codes.ts` does not use Crockford. It uses a 31-character alphabet,
`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, which drops `0` and `1` outright rather than
folding them onto `O` and `I` the way Crockford does, and also drops `U`. The
distinction does not affect this design — see D1 — but the issue should not be
read as a description of the repo.

## Decisions

### D1 — The role is a third group, spelled out.

`BELL-7F3K-92-REVIEWER`. An underscore in the role name renders as a hyphen:
`peer_a` becomes `BELL-7F3K-92-PEER-A`.

The alternative was an opaque code with the role held only in the store. The
deciding argument for spelling it out is the relay path Bellman actually
depends on: a code gets read down a phone line or pasted into a chat, and the
person relaying it should be able to say what they are handing over.

**The restricted alphabet does not apply to this group, and does not need to.**
`src/codes.ts` excludes `0`, `1`, `I`, `L`, `O`, `U` because the 4- and 2-character
groups are random, where a reader has no word context to disambiguate `0` from
`O`. A role group is a word. `OBSERVER` dictated aloud is unambiguous despite
its `O`, in the way `BELL-O7F3` would not be.

The `_` → `-` rendering is safe because it is a bijection: `RoleKeyShape`
(`src/manifest.ts:59`) is `^[a-z][a-z0-9_]{0,30}$`, so a role name can never
itself contain a hyphen.

Accepted costs, both real:

- **Seat names leak.** Anyone a code passes through learns that the room has a
  seat called `reviewer`. Judged acceptable: the code is already a secret
  handed to a person you are inviting, and the name tells them nothing they
  will not see in the preview seconds later.
- **Length is the creator's to control.** Presets are short — `peer_a`,
  `peer_b`, `lead`, `helper`, `author`, `reviewer` — so the common code is
  `BELL-7F3K-92-REVIEWER`, 21 characters. A custom manifest may name a role up
  to 31 characters and get a 44-character code. **No cap, no truncation.**
  Truncating would make the group a hint rather than the name, which discards
  the readability the group exists for; and the creator chose the name.

### D2 — The whole string is the index key.

The store indexes the full rendered code, role group included.

So `BELL-7F3K-92-ADMIN`, hand-edited from a code issued as
`BELL-7F3K-92-REVIEWER`, is a string that was never issued. It returns "not
found". So does `BELL-7F3K-92` with the group stripped off.

This is the reason there is no validation to get wrong. The alternative —
keying on `BELL-7F3K-92` and comparing the suffix against the record — needs a
mismatch branch that has to stay correct forever. Here, tampering fails closed
by construction, and the role group adds entropy instead of spending it.

### D3 — One live code per role, held in a map keyed by role.

```ts
export interface JoinCodeRecord { code: string; expiresAt: number; }

interface Session {
  joinCodes: Record<string, JoinCodeRecord>;   // role name -> its live code
  // joinCode, joinCodeExpiresAt: removed
}
```

The map key **is** the one-per-role invariant. Two live reviewer codes are
unrepresentable rather than prevented by a check, and the number of live codes
is bounded for free: manifests are immutable after `createSession` (#1's D6),
so it can never exceed the declared role count. No cap to choose, no code-id
concept, no listing tool.

The known wart: hand a reviewer code to one person, mint a second reviewer code
for someone else, and the first dies. Onboarding three contributors separately
therefore needs three roles or three sequential joins. A list of independently
revocable codes would fix that, at the price of a cap that has to be defended
and a way to enumerate what is outstanding. Deferred; the issue asks for a code
per role, and this is that.

`joinCode` is **removed**, not kept as a derived convenience alongside the map.
`src/types.ts:66` already states the rule:

> There is no `mode` here: read `session.manifest.mode`. Two fields for one
> fact could disagree.

A `joinCode` mirroring `joinCodes[defaultRole]` is exactly that disagreement.

### D4 — The server renders codes. It never parses them.

```ts
export function renderJoinCode(role: string): string {
  return `BELL-${chunk(4)}-${chunk(2)}-${role.toUpperCase().replaceAll("_", "-")}`;
}
```

The record holds the rendered uppercase string in `code` and the lowercase
manifest key as its map key, so nothing ever splits a code back apart. D1's
`_` → `-` rule is a rendering rule, not a parsing rule.

This follows from D2 rather than being an independent choice: if the whole
string is the key, the suffix is never consulted for meaning, so there is
nothing to parse. It deletes the class of bugs a parser would invite —
off-by-one on group boundaries, a role name that round-trips wrong, a
hand-edited suffix believed over the record.

`normalizeJoinCode` gains one fold: `_` → `-`, so someone typing `PEER_A` from
memory still resolves.

### D5 — The joiner's role is captured at connect, not re-resolved at confirm.

`PendingConnect` gains `roomRole`. `bellman_confirm` receives only the token,
never the code, so the role has to be recorded at preview time.

The consequence, written down so nobody discovers it later: **a revoke landing
between connect and confirm does not cancel an in-flight confirm**, bounded by
the 10-minute connect-token TTL.

The alternative — store the code on the pending record and re-resolve it at
confirm — was rejected because D3 makes it worse, not better. Issuing retires
the previous code for that role, so a joiner who previewed legitimately would
be bumped whenever anybody minted a fresh code for the same seat. That failure
is more common than the one it fixes, and it punishes the wrong person.

No role validation is needed at confirm. Manifests are immutable after
creation, so the role cannot vanish between the two calls, and `verbsOfRole`
fails closed regardless. `src/roles.ts:9` anticipated this:

> sessions round-trip through JSON in Durable Objects and #3 is about to make
> join codes carry a role, so an unrecognised seat holds no authority rather
> than throwing.

### D6 — A bare revoke retires every code.

| call | effect |
|---|---|
| `invite()` | mints for `defaultRole`, retiring only that role's previous code |
| `invite(role)` | mints for `role`, leaving other roles' codes live |
| `invite(revoke: true, role)` | retires that role's code only |
| `invite(revoke: true)` | retires **every** code |

Deliberately asymmetric: for issuing, an absent role means "the usual seat";
for revoking, it means "all of them".

The failure modes are asymmetric, so the defaults are too. Revoking more than
intended is recoverable — mint again, you hold `invite`. Revoking less than
intended is silent: someone shuts the door, walks away, and leaves another
role's code live. The existing tool text already frames revoke as "close the
door and leave it closed"; with several doors, the unqualified phrase should
mean all of them.

An unknown role fails, naming the roles the manifest declares.

### D7 — `closeSession` and expiry both clear codes.

A tidy-up inside the lines this change already rewrites.

`SessionDO.closeSession` (`src/store-do.ts:145`) sets `closed: true` and leaves
`joinCode` set with its registry row live, relying on `getSessionByJoinCode`'s
`s.closed` guard. The expiry path (`src/store-do.ts:210`) nulls the code. The
two disagree.

It is untidy rather than wrong — the `closed` guard catches it, and orphan rows
collide with nothing. But registry rows are global and never collected, and the
per-role model multiplies them by the role count. Both paths route through
`clearJoinCodes`.

## Architecture

### The store seam

```ts
/** The code string's suffix is for the human relaying it. The record is authority. */
getSessionByJoinCode(code: string): Promise<{ session: Session; role: string } | undefined>;

/** Issue a code for one role, retiring only that role's previous code. False means frozen. */
setJoinCode(sessionId: string, role: string, code: string, expiresAt: number): Promise<boolean>;

/** Retire one role's code. Idempotent. */
consumeJoinCode(sessionId: string, role: string): Promise<void>;

/** Retire every code — a pair session filling, a session closing. Idempotent. */
clearJoinCodes(sessionId: string): Promise<void>;
```

`getSessionByJoinCode` returns the role beside the session rather than letting
callers derive it from the string. That is what makes D2 hold in practice:
there is no code path that reads the suffix, so there is none that can be
fooled by a doctored one.

`clearJoinCodes` is new because the single-field model got it free — closing
nulled one field. With a map, "no code should work" becomes an explicit
operation that drops N registry rows.

Resolution keeps its existing shape: registry hop, then session, then verify.
The verify goes from `s.joinCode !== code` to finding the record whose `code`
matches — an O(roles) scan over a handful of entries, inside a DO that has
already been woken.

### Durable Objects

The registry stays a pure `code -> sessionId` pointer. Holding the role there
instead was considered and rejected: `bellman_invite` must retire *this role's*
previous code, and a code-keyed index cannot answer "what is reviewer's current
code?" without a second index; and a closed session would leave orphan rows
with nothing to reconcile against.

`SessionDO.setJoinCode` already returns the code it replaced so the caller can
drop it from the registry (`src/store-do.ts:111`). That extends directly:
`setJoinCode(role, ...)` returns the previous code for that role, and
`clearJoinCodes()` returns the full list so `DurableObjectStore` drops them all.

### Legacy sessions

A `SessionDO` deployed today holds `{ joinCode, joinCodeExpiresAt }`, and that
code may sit in somebody's clipboard for another 15 minutes.
`SessionDO.stored()` lifts on read:

```ts
joinCodes: s.joinCode
  ? { [s.manifest.defaultRole]: { code: s.joinCode, expiresAt: s.joinCodeExpiresAt } }
  : {}
```

and **strips both legacy fields**, so a lifted session can never carry two
shapes at once — otherwise `joinCode` becomes the stale mirror D3 removed it to
avoid. Every write already does `put("session", { ...s, ... })`, so the first
write after a lift persists the new shape. Self-healing, no migration job.

Read-time rather than bulk because there is no list to iterate: the registry
indexes by creator and by code, never "all sessions" — the constraint
`src/store-do.ts:457` already documents for a different gap.

The legacy code has no role group and needs no special handling. By D2 the
record's `code` is that string verbatim: it resolves, carries `defaultRole`,
and expires naturally. **The registry needs no migration** — `code -> sessionId`
is role-agnostic, so every existing row keeps working.

### The tool surface

**`bellman_start`** mints one code for `manifest.defaultRole`, unchanged in
every respect except that a pair room's code now reads `BELL-7F3K-92-PEER-B`.
The response field stays a plain string.

**`bellman_connect`** resolves `{ session, role }` and previews that role —
`roomPreview(session, hit.role)` in place of
`roomPreview(session, session.manifest.defaultRole)` (`src/server.ts:429`).
`roomPreview` already takes the role as a parameter, so `your_role` and
`your_verbs` follow for free. This is the issue's second scope bullet.

**`bellman_confirm`** seats the joiner as `pending.roomRole` in place of
`session.manifest.defaultRole` (`src/server.ts:483`), and previews the same
(`src/server.ts:520`). The issue's third scope bullet.

**`bellman_invite`** gains an optional `role`, per D6. The `invite_issued` and
`invite_revoked` events and the audit entries gain the role: the existing
promise that reopening the door is never silent should extend to which door.

**Revoke ordering is preserved.** `denyVerb` (`src/server.ts:567`) runs before
the empty-code early return (`src/server.ts:570`), and
`tests/tools/verbs.test.ts:409` exists to pin that order. The early return
becomes "no codes are live"; the ordering does not move.

**Pair fill.** `src/server.ts:498`'s `consumeJoinCode(joined.id)` becomes
`clearJoinCodes(joined.id)`. A full pair session has no seat for any role, so
retiring only the default role's code would leave others live against a room
nobody can enter.

## Testing

`tests/helpers/store-contract.ts` is where the per-role semantics are pinned,
since it is what makes both stores answer identically:

1. Two roles hold live codes at once; resolving each returns its own role.
2. Issuing for `reviewer` retires `reviewer`'s old code and leaves
   `contributor`'s resolving. The invariant the whole issue turns on.
3. A tampered suffix does not resolve, and neither does a truncated one.
4. `clearJoinCodes` retires all of them, idempotently.
5. A legacy `{ joinCode, joinCodeExpiresAt }` session resolves under
   `defaultRole` and reads back with no legacy fields.

Tool-level, through the in-memory MCP client: a joiner redeeming the reviewer
code sees `your_role: reviewer` in the `bellman_connect` preview **and** is
seated as reviewer after confirm. Both, because either one alone would make the
preview a lie.

**Every one of these is run against a deliberately broken implementation before
it counts as passing** — for (2), a `setJoinCode` that clears the whole map; for
(3), a resolver that ignores the suffix; for (5), a lift that keeps the legacy
fields. A test that has not been watched to fail is not yet evidence.

## Files

| File | Change |
|---|---|
| `src/types.ts` | `JoinCodeRecord`; `Session.joinCodes` replaces `joinCode` / `joinCodeExpiresAt`; `PendingConnect.roomRole` |
| `src/codes.ts` | `renderJoinCode(role)` replaces `generateJoinCode()`; `normalizeJoinCode` folds `_` → `-` |
| `src/store.ts` | the four-method seam; `MemoryStore.byJoinCode` keyed per code, cleared per role |
| `src/store-do.ts` | `SessionDO` per-role writes returning retired codes; read-time legacy lift; `clearJoinCodes` on close and expiry (D7) |
| `src/server.ts` | `bellman_invite` gains `role`; connect previews the code's role; confirm seats it; pair fill clears all; four tool descriptions |
| `tests/helpers/store-contract.ts` | the five cases above |
| `tests/helpers/fixtures.ts` | `session()` builds `joinCodes` |
| `tests/helpers/flows.ts` | join helper takes an optional role |
| `tests/codes.test.ts` | rendering, including `_` → `-` and a 31-character role |
| `tests/tools/invite.test.ts` | per-role issue and revoke; bare revoke clears all |
| `tests/tools/handshake.test.ts` | preview and seat the code's role |
| `tests/store-do-wiring.test.ts` | legacy lift, extending the existing legacy fixture |
| `src/roles.ts` | **unchanged** — `verbsOfRole` already fails closed on an unknown seat |
| `src/manifest.ts` | **unchanged** — no new role-name constraint (D1) |

## Out of scope

- **Several live codes for one role.** D3's wart. Needs a cap, a code identity
  and a way to enumerate outstanding codes; a separate issue if onboarding
  people one at a time proves to be the common case.
- **Changing a member's role mid-room.** #1's D6 makes manifests immutable
  after creation; promotion needs a store method and an audit story of its own.
  Unchanged by this.
- **Listing a room's live codes.** No tool reads `joinCodes` wholesale. Add it
  when something needs it.
- **Per-role TTL or per-role capacity.** Every code keeps the single
  15-minute `JOIN_CODE_TTL`, and `maxMembers` stays a room-wide number.
- **Anything about the alphabet.** The random groups are untouched; the
  correction in Problem is a note about the issue text, not a change.
