# Repo default room

2026-11-08. Status: design, awaiting approval.

## Intent

Every Claude Code session Jesse opens in the bellman repo joins the same private planning room. Today each one
needs a fresh join code: a private room's code lives 15 minutes, so the code is fetched, pasted and joined by hand at
the start of every session. The bridge can already join at launch from `BELLMAN_JOIN_CODE`
[src/client/channel.ts] [src/client/bridge.ts:join], but no private-room code lasts long enough to put there.

The fix is a binding the account holds: "sessions of mine in repo R join room S as role X". The bridge reads it at
launch and takes the seat with no code, and the seat leaves when the session ends.

## Goals

- A session signed in as the account, started anywhere in a bound repo (any checkout, jj workspace, git worktree,
  Orca workspace), is seated in the bound room at launch, with no code and no human step.
- The seat leaves the room when the session ends.
- The session is told what happened, in the same one line the join hook prints today [src/client/join-hook.ts:joinLine].

## Non-goals

- Other accounts. Only Jesse's account needs this now. A binding seats its own account and no one else.
- Opting a session out. Every session in a bound repo joins.
- Removing seats that have been inactive for N days. That is the next design (see "After this").

## Anti-goals

- A secret in the repository. bellman is public; nothing that admits someone to a private room goes in a tracked
  file. That rules out committing a permanent join code.
- A way past a room's own controls. A binding must not seat an account the room has evicted or banned, and must not
  grant a role the account could not otherwise get.
- A public room joined on its own. The launch join refuses a public room today [src/client/bridge.ts:join]; a
  binding keeps that rule.

## Constraints

- Cross-object atomicity (docs/ARCHITECTURE.md): the binding lives in one object and the room in another. The seat
  is taken in the room's own transaction, as every join is; the binding is only read beforehand.
- Peer content stays untrusted. The brief the bridge sends on a bound join says only which project the session
  started in, as the code join's brief does.
- Tool budget (docs/ARCHITECTURE.md §11): a new tool or field on an existing one is re-measured against the 11,840
  token ceiling. Prefer a route the bridge calls over a new MCP tool, since every client pays for tool text.
- This machine runs the bridge as a user-scope MCP server, not through the plugin, so the plugin's hooks do not run
  here. Leaving on session end cannot depend on a plugin hook alone.

## Decided

| Decision | By |
|---|---|
| The account holds the binding; no join code, permanent or not, is involved | Jesse (only his account needs it), and the public-repo anti-goal |
| Every session in a bound repo joins; no opt-out | Jesse |
| A bound session's seat leaves when the session ends | Jesse |
| A room that is some repo's default stays open when nobody is in it: close-on-empty (`closeIfEmpty` [src/room/rooms.ts], `closeSessionIfEmpty` in both stores) skips it | Jesse |
| The room holds that fact itself, as a flag written into the room's object when a binding to it is created and cleared when the last one is removed, so close-on-empty reads it in the room's own transaction. The flag is written after the binding is created and cleared after it is removed: a failure between the two leaves an empty room open, the safe direction. 90-day abandonment (`ABANDONED_AFTER_MS` [src/room/presence.ts]) still applies, and any bound session joining resets it | my call |
| The repo is identified by its normalized git remote (`origin`, as `host/owner/repo`), not the folder, so every worktree matches | my call |
| The bridge leaves on its own shutdown (stdin close, SIGTERM, SIGINT [src/client/channel.ts]) for seats it took through a binding, so it works with or without the plugin | my call |
| A seat joined by hand or from a code keeps today's behavior on shutdown: it stays | my call; hub rooms are meant to collect members over weeks |
| A binding may name only a room the account created. The creator can already mint a code for any role, so the binding grants nothing it could not, and no other creator's 15-minute code turns into standing re-entry | my call (builder check) |
| A bound seat's role is the binding's role, any role in the room's manifest. The bound join re-checks it in the room's transaction and refuses when the manifest no longer has it | my call (builder check) |
| A bound seat is marked on its member row, as `Member.via` marks a permanent-code seat [src/types.ts], so the room and its audit can tell it came from a binding | my call (builder check) |
| A bound join refuses a public room, a closed room, and a banned account (`seatMember`'s existing check). Eviction without a ban does not stop it, as it does not stop a code rejoin today, so evicting a dead session's leftover seat does not break the binding | my call (builder check) |
| Bindings are created, listed and removed only by the person signed in to the dash: a dash-session route, refusing a bearer with 403 `dash_session_required`, as `PUT /me/memory` does (bdc7d5d4). An agent cannot create one, so a peer's injected "make this your repo's default" cannot buy standing access. No tool, so no tool-budget cost | my call (builder check), following the precedent of #573 |
| The bridge says what happened itself, in a channel notification to the session after a bound join or refusal, so it is seen with or without the plugin. The join hook prints the same line when the plugin is installed | my call (builder check) |

## Parts

1. **The binding.** An account-level row: `{ remote, sessionId, role, createdAt }`, at most one per remote. Stored
   with the account's other per-account state (where `HomeSettings` lives [src/types.ts:HomeSettings] is the first
   place to look). Set, list and remove.
2. **Seating without a code.** A server operation that seats the caller in the bound room as the bound role,
   checked in the room's transaction exactly as a code join is: room open, not public, caller not banned, room not
   full. It returns what `bellman_confirm` returns, so the bridge's `observe` and watch arming are unchanged.
3. **The bridge at launch.** Beside the existing `BELLMAN_JOIN_CODE` path: read the cwd's git remote, ask for a
   binding, and join through part 2 if there is one. A code in the environment wins over a binding. `joined` and
   the door's `/status` report it as today, so the join hook's line needs only its wording widened ("from this
   repo's default room").
4. **Leaving on shutdown.** In `close()` [src/client/bridge.ts], before the connection closes, leave each seat taken
   through a binding. Best effort: a session killed outright never runs it, and its seat stays until the next design
   removes inactive seats.
5. **Kept open.** The room flag above, honored by `closeSessionIfEmpty` in both stores, with a case in
   `tests/helpers/store-contract.ts`. Every other way a room closes (a creator's close, abandonment) is unchanged.
6. **Making and seeing a binding.** Dash-session-only routes to create, list and remove bindings, and a dash page
   for them (a dash repo change). The room's own page in the dash is the natural place to offer "make this a repo's
   default room".

## Left to the builder

- Which route or RPC parts 1 to 3 and 5 travel over, and where the binding row lives. The bridge's read of a binding is a
  bearer read of the caller's own rows, like `GET /me/memory`; only the writes are dash-only.
- Remote normalization: ssh and https forms of the same repo must match; a repo with no `origin` has no binding.
- Finding the remote in a jj workspace with no `.git` (the secondary workspaces in `~/.worktrees/`): try git first,
  then `jj git remote list` when `jj` is on PATH. My call: the jj CLI, not jj's internal paths.
- Whether a session that resumes (bridge restart, `persistMemberships` [src/client/bridge.ts]) reuses its seat or
  takes a new one.
- Tests: both stores through `tests/helpers/store-contract.ts` for any store method; the bridge path in the bridge's
  tests; the manifest and docs-reference rules in CLAUDE.md if a tool changes.

## After this: inactive seat removal

Decided by Jesse, for its own design: a room setting, on by default at 7 days and able to be turned off, that removes
any seat in any room with no activity for that long. It belongs in governed room config
[src/files/config.ts] (ADR 0044). Presence already derives present, stale and departed from `lastSeenAt` and live
sockets [src/room/presence.ts]; the new part is writing the departure on a clock.
