# ADR 0020 — A public room may hold a permanent code for its default seat

**Date:** 2026-10-12 · **Status:** accepted; decision 5 amended by ADR 0022 · **Amends:** ADR 0010, decision 4

## Context

A code lives 15 minutes (ADR 0010), which suits a code handed to one person and is
no use on a page. A public room (ADR 0011) is run in the open, and its creator wants
a link to put on a site, a post or a README that seats whoever follows it next
month. The only way to keep such a link working was to mint a fresh code every 15
minutes. A code that does not expire is a standing invitation to anyone who finds
it, so it belongs only where the room has already given up confidentiality and the
seat it grants is the one the room means newcomers to have.

## Decision

1. **`bellman_invite` takes `permanent`, false unless given.** With `permanent:
   true` it mints a code with no expiry, refused unless the room is public
   (`isPublic`) and the role is the room's default (`manifest.defaultRole`, omitted
   or named). The verbs are unchanged: issuing needs `invite`, and replacing a live
   code, permanent or not, also needs `revoke`.
2. **A null expiry is a permanent code.** `JoinCodeRecord.expiresAt` is `number |
   null`, and `codeIsLive` in `src/store.ts` is the one reading of it: both stores'
   `getSessionByJoinCode`, `setJoinCode`'s replace check and `removeMember`'s
   retire check, `revokeInvite`, and the `join_codes` projection. Every place that
   formats the expiry writes null for it.
3. **The store refuses a permanent code to a room that is not public.**
   `setJoinCode` answers `not_public` in the operation that writes the code, for the
   reason it decides `replaceLive` there (#90): a room made private between the
   caller's read and the write would otherwise keep a code that making it private
   had already retired. `isPublic` moved to `src/store.ts` for this, and
   `src/rooms.ts` re-exports it.
4. **A full room keeps it.** A seating that fills the room retires every temporary
   code and keeps a permanent one, and `codesCleared` says whether it retired any.
   While the room is full the code resolves and the join is refused as full; when a
   seat frees, the same link seats the next person.
5. **It lives until it is revoked, the room is made private, or the room closes.**
   Revoking its role or every role retires it, and so does evicting a member of its
   seat, as for any live code. `unpublishSession` retires the room's permanent codes
   in the write that makes it private, and the Durable Object queues their registry
   drops in that transaction, as `clearJoinCodes` does. A temporary code is left to
   run out. Closing already retires every code.
6. **It says what it is.** The tool answers `join_code_expires_at: null` and
   `permanent: true`, and its `share_instructions` say how long the link works. The
   `invite_issued` event carries `expires_at: null` and `permanent: true`, and the
   audit row `permanent: true`. `bellman_rooms` lists the code with `expires_at:
   null`.

## Consequences

- A permanent code seats every stranger who redeems it, until the room fills, for as
  long as it lives. That is the point, and it is why the code is limited to a public
  room's default seat: the room's work is readable anyway, and the seat is the one
  its creator chose for newcomers. A more capable seat still takes a code that
  expires.
- Making a room private shuts its permanent door without an event, as making it
  private announces nothing else. A link already on a page then resolves nothing.
- `public_url` is still the link for reading (ADR 0011). `join_url` seats whoever
  redeems it, and `bellman_start` still says so of the code it returns, which
  expires.
- One code per role still holds (ADR 0010, decision 3). Issuing a temporary code
  for the default role replaces a live permanent one, which takes `revoke`.
- Rolling back makes a permanent code resolve nothing: the older build compares the
  null with the clock and reads it as expired.
