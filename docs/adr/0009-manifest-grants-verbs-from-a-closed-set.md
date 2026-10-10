# ADR 0009 — The manifest grants roles verbs from a closed set

**Date:** 2026-09-27 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #1, #2 · **Spec:** `docs/superpowers/specs/2026-09-23-room-manifests-design.md`, `docs/superpowers/specs/2026-09-25-permission-verbs-design.md`

## Context

Rooms were created ad hoc, with nothing saying what a room was or who in it might
do what (#1). Authority was `capabilities`, which each member declared about
itself, and a hardcoded creator-only rule on `bellman_invite` (#2). A check in a
client is advisory, because a peer's client is not yours. A joiner's human decides
on the preview, so a preview naming authority the server does not enforce is the
failure both issues set out to prevent. #72 (2026-09-25) declared verbs and
enforced none; #89 enforced them.

## Decision

1. **Every room is declared, once.** `bellman_start` takes a manifest that cites a
   preset (`pair`, `swarm`, `review`, `social`, or one the person saved) or authors
   `mode`, `roles`, `default_role` and `creator_role`. `resolveManifest` in
   `src/manifest.ts` refuses a malformed one before any plan, org or quota check,
   and the stored manifest never changes: new rules mean a new room (room
   manifests spec D6).
2. **A role's `can` lists verbs from a closed set.** `VERBS` is `send`, `invite`,
   `revoke`, `request_actions`, `respond_actions` and `write_surface` (#187); any
   other, or a duplicate, is refused. A room declares 1 to 16 roles, keyed
   `[a-z][a-z0-9_]{0,30}` and never `__proto__`, `constructor` or `prototype`. A
   verb lands with the operation it gates: `audit` and `close_room` left the first
   enum because no room-scoped operation answers to either (room manifests spec
   D2).
3. **One verb per operation, enforced by the server.** `SEND_VERB` in
   `src/tools/kit.ts` gives each `bellman_send` kind one verb: `send` for
   `message`, `artifact`, `brief_update` and `progress`; `request_actions` for
   `action_request`; `respond_actions` for `action_response`; `write_surface` for
   `surface`, and for blob uploads. `bellman_invite` needs `invite`, and revoking
   `revoke` (ADR 0010). `denyVerb` in `src/roles.ts` runs before the payload and
   occupancy checks, and its refusal names the verb the seat lacks.
4. **Reading, joining and leaving are never gated.** `bellman_sync`,
   `bellman_connect`, `bellman_confirm`, `bellman_leave` and reads of the surface
   need no verb, so a seat with `can: []` reads the whole room.
5. **A verb is the seat's authority; a capability is the recipient's consent.**
   Both stay (permission verbs spec D1). The verb is checked first, and a member
   may still refuse delivery of what a sender's role permits (ADR 0008).
6. **An org admin holds nothing in a room.** `denyVerb` takes a session and a
   member and cannot see an `Identity`, so a platform role buys no authority in a
   room, and there is no break-glass (permission verbs spec D2). `verbsOfRole`
   answers `[]` for a role the manifest does not define, so an unknown seat holds
   nothing.

## Consequences

- The verbs a joiner is shown are the verbs enforced: `roomPreview` reads
  `your_verbs` through `verbsOfRole`, the accessor `denyVerb` uses.
- Every preset gives `invite`, `revoke` and `write_surface` to the creator's seat
  alone. `swarm`'s `observer` holds nothing; `social`'s `guest` and `host` hold
  `send`.
- Verbs do not compose. A seat without `send` can neither update its brief nor
  answer the heartbeat, so `resolveManifest` refuses a role on the heartbeat that
  lacks it. A host's role must hold exactly `send` (ADR 0002).
- `invite` reaches every declared seat, the holder's own by leaving and rejoining
  (ADR 0010), and a room whose manifest gives nobody `invite` cannot be reopened.
- Authority no verb names stays with the creator: `bellman_evict` checks
  `session.createdBy`, and so does making a public room private (ADR 0011).
