# ADR 0021 — Bylines name a public room's creator by a handle they chose

**Date:** 2026-10-12 · **Status:** accepted · **Spec:** `docs/superpowers/specs/2026-10-12-bylines-design.md` · **Plan:** `docs/superpowers/plans/2026-10-12-bylines.md`

## Context

A public room names its members by number, because a label is how a member signed in,
an email address for most (ADR 0011). That keeps people private. It also leaves a
reader unable to tell who started a room, or to find that person's other public rooms.

## Decision

1. **Opt-in, for the creator alone, and only from the dash.** A person claims a handle in
   Settings and signs a room from its page. No tool text or manifest field changes. The
   page reads "by @handle", never "hosted by", which names the hosted seat (ADR 0002).
2. **Handles are free choice, and freed at once.** `checkHandle` trims and lowercases a
   handle, then accepts 3 to 30 letters, digits and hyphens that start with a letter and
   do not end in a hyphen, and refuses twenty reserved names. A person holds one. A
   change or a release frees the old handle in the same call, so its links stop working.
3. **The registry holds handles and signatures; the room is never written.** `RegistryDO`
   keeps `hn:<handle>` → user, `uh:<user>` → handle and `hs:<user>:<room>` → signing time.
   Each write is one call to the registry, and a release deletes the user's `hs:` rows in
   the same transaction as the handle, so nothing spans two objects (ADR 0006). A
   signature on the room would make a release a write to every room signed.
4. **The public room read looks the byline up once.** `GET /public/rooms/:id` adds
   `by: { handle, as }` when the creator holds a handle and signed the room. It reads
   the handle each time, so a change shows at once. `as` is the creator's number from
   `publicNames`, which the page swaps for `@handle` wherever it appears. The events,
   surface and blob reads never look a byline up.
5. **The handle page reads at most 200 sessions.** `GET /public/handles/:handle` reads
   the `HANDLE_PAGE_SCAN` (200) most recently signed rooms on each request and lists up
   to `MAX_ROOMS_LISTED` (50) of them still public and open. It checks only the handle's
   shape: the reserved list governs claims, so a taken name reserved later still reads.
6. **A handle request body is bounded at 1 KB,** through `lengthRefusal`, the helper
   that bounds presets and room writes.

## Consequences

- A freed handle shows its new owner's rooms only, because signatures are keyed by user.
- Releasing a handle unsigns everything, and a handle claimed later revives nothing.
- The handle page drops unpublished and closed rooms. A handle whose newest 200 signatures
  all point at closed, private or purged rooms shows none of its older live rooms.
- Signature rows for closed, private or purged rooms stay in the registry. Nothing cleans
  them up yet.
- `GET /account/handle` stands in for a field on `GET /account`: the OAuth router serves
  that path and has no store (plan ruling R1).
- Account deletion is manual, by email to support. The operator then releases the handle,
  as the privacy page promises, with `DELETE /admin/handles/:handle` on `/admin/grants`'
  gate. An abusive handle goes the same way, with its signatures.
