# ADR 0010 — Join codes carry a role

**Date:** 2026-09-29 · **Status:** accepted · **Recorded:** 2026-10-09 · **Closes:** #3 · **Spec:** `docs/superpowers/specs/2026-09-27-role-carrying-join-codes-design.md`

## Context

A code named a room and nothing else, so every joiner landed in `default_role`
(#3). The server told a room's seats apart (ADR 0009) and gave no way to hand
someone the `reviewer` one. `bellman_invite` (#19) already minted and revoked codes
at any time, and `Session.joinCode`, one nullable string, could not hold a reviewer
code and a contributor code at once. A code is relayed by people, read down a phone
line or pasted into a chat, and whoever relays it should be able to say what it is.

## Decision

1. **The role is the code's last group, spelled out.** `renderJoinCode` in
   `src/codes.ts` writes `BELL-7F3K-92-REVIEWER`: two random groups from a
   31-character alphabet without `0`, `1`, `I`, `L` or `O`, then the role in
   capitals with `_` as `-`, one-to-one because a role key holds no `-`.
   `normalizeJoinCode` folds case, whitespace and `_` back.
2. **Nothing parses a code.** `getSessionByJoinCode` matches the whole string
   against the room's record and returns the role from the record, so a
   hand-edited role group is a code that was never issued and resolves nothing.
3. **One live code per role.** `Session.joinCodes` maps each role to `{ code,
   expiresAt }`, so two live codes for one seat cannot be represented.
   `bellman_start` mints the default role's code; `bellman_invite` mints for a
   named role, or the default, and retires only that role's previous code.
   Replacing a live code needs `revoke` as well as `invite` (#90, in #176), and
   `setJoinCode` checks and writes in one operation. A bare revoke retires every
   code; a revoke naming a role retires one.
4. **A code seats whoever redeems it while it lives.** It lives 15 minutes
   (`JOIN_CODE_TTL`) unless first its role's code is reissued or revoked, a member
   in that role is evicted, or the room fills or closes. A seating that fills the
   room retires every code in its own transaction, and a close retires them with
   it or in the call that follows; a closed room's code resolves nothing either
   way. Redeeming does not consume it, so in a swarm room one code seats joiner
   after joiner until one of those ends it.
5. **The seat is fixed at the preview.** `bellman_connect` records the code's role
   in the pending connect and shows it as `your_role` and `your_verbs`.
   `bellman_confirm` takes only the connect token, single use and good for 10
   minutes, and seats that role; a revoke between the two does not undo it.
6. **A code is shared as a link.** `join_url` is `https://bellman.sh/j/<code>`
   (`JOIN_URL_BASE`, #180), a page rendered from the code alone that calls no
   server, so a chat app fetching it to unfurl learns nothing and takes no seat.

## Consequences

- Seat names travel with the code: whoever it passes through learns the room has
  a `reviewer` seat. A 31-character role makes a 44-character code, and nothing
  truncates it; `MAX_JOIN_CODE_LENGTH` bounds `bellman_connect`'s input to fit.
- Minting a second code for a role ends the first, or is refused to a seat without
  `revoke`. Several live codes for one role are out of the spec's scope.
- `invite` chooses the joiner's authority. Its holder may mint any declared role's
  code, its own seat's included by leaving and rejoining, so a weak seat holding
  `invite` can promote itself. #96 documented this in `bellman_start` rather than
  adopt a subset rule, which would forbid a doorkeeper seat holding `invite` and
  `revoke` alone.
- A swarm code pasted where strangers read it seats each of them who redeems it
  in its 15 minutes, until the room fills: since #200 that is up to 99 joiners,
  where the plan caps of 8 and 25 bounded it before. `bellman_start` tells an
  agent to share `public_url`, never `join_url`, for this reason.
- Each code's pointer in the registry is put and dropped through the room's outbox
  (ADR 0006), and resolution checks the code against the room's own record, so a
  pointer that lingers resolves nothing.
