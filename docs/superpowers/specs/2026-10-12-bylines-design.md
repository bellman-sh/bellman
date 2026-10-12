# Bylines for public rooms: design

Status: designed, for the owner's review. Plan: not yet written.
Builds on: ADR 0011 (public rooms name members by number), ADR 0006 (nothing spans
two objects), #233 (public rooms).
Citations: by symbol, not line, as `main` stood at `9a2d25f`.

## Problem

A public room names its members by number: `publicNames` in `src/http/public.ts`
numbers them, and `byNumber` swaps every `label` for that number. A label is how a
member signed in, an email address for most (ADR 0011). That keeps people private.
It also means a reader cannot tell who started a room, or find that person's other
public rooms. The owner wants a room's creator to be able to sign it, by choice.

## What the owner decided

1. **Opt-in, for the room's creator only.** Every other member stays numbered.
2. **A byline names the room and the creator's own seat.** The page shows "by
   @handle", and the creator's seat reads @handle in the log and on the canvas
   instead of "member 1". A reader could tell the first member was the creator
   anyway, so the byline says it outright.
3. **The dash is the only place to opt in.** A handle is claimed in Settings, and a
   room is signed or unsigned from its page in the dash. Agents get no new tool text
   and no manifest field.
4. **Handles are free choice and changeable.** A changed or released handle frees
   at once, so its links stop working. A short reserved list blocks names like
   `bellman` and `admin`.
5. **"by", not "hosted by".** Host already names the hosted seat (ADR 0002).

## Decisions

**D1. Handles.**
- A handle is 3 to 30 characters: lowercase letters, digits and hyphens. It starts
  with a letter and does not end with a hyphen: `/^[a-z][a-z0-9-]{1,28}[a-z0-9]$/`.
- Input is trimmed and lowercased before the check.
- Reserved: `bellman`, `admin`, `administrator`, `support`, `help`, `root`,
  `system`, `staff`, `team`, `host`, `api`, `mcp`, `dash`, `www`, `about`,
  `settings`, `null`, `undefined`, `anthropic`, `claude`.
- A user holds at most one handle.

**D2. The registry holds handles and signatures, and nothing else does.**

*This changes the design approved in conversation,* which kept the signature on the
room beside `unpublishedAt`. Here the signature lives in `RegistryDO`, beside the
handle, under three keys:
- `hn:<handle>` holds the userId;
- `uh:<userId>` holds the handle;
- `hs:<userId>:<sessionId>` holds the time the room was signed.

Each of claiming, changing, releasing, signing and unsigning is one registry
transaction. Releasing a handle deletes the user's `hs:` keys in that same
transaction, so every byline goes at once, and a handle claimed later cannot revive
them. No write touches two objects (ADR 0006), so there is no outbox and no fan-out.
The room is never written.

**D3. Who can sign.** Signing requires all three:
- the caller is the room's creator (`createdBy`);
- the room is public (`isPublic`);
- the caller holds a handle.

The route reads the room, then writes the registry. A room unpublished between the
two shows no byline anyway: its public read answers 404, and the handle page drops
it (D5).

**D4. The byline on the room's public read.** `GET /public/rooms/:id` adds
`by: { handle, as }` when the creator holds a handle and has signed the room.
- `as` is the creator's public number from `publicNames`: the name `byNumber`
  writes for the creator's labels in the log and on the canvas.
- That route makes one registry read.
- The events, surface and blob routes do not change and never read the registry.
  The page puts `@handle` wherever `as` appears when it renders.
- A handle change shows at once, because the handle is looked up on every read.

**D5. The handle page.** `GET /public/handles/:handle` answers
`{ handle, rooms: [{ id, room, purpose, public_url, signed_at }] }`.
- It lists the handle's signed rooms, newest signature first, at most
  `MAX_ROOMS_LISTED` (50).
- Each listed room is read from its own object and kept only if it is still public,
  so a closed, purged or unpublished room drops out.
- An unknown handle answers 404.
- Signatures are keyed by user, not by handle. So a released handle that someone
  else claims lists only the new owner's rooms.

**D6. Account and room routes.** All of them use the dash's browser session, as the
preset routes (`presetRoutes`) do.
- `PUT /account/handle` with `{ handle }` claims or changes a handle. Errors:
  400 `handle_invalid`, 400 `handle_reserved`, 409 `handle_taken`.
- `DELETE /account/handle` releases the handle and every signature (D2).
- `GET /account` adds `handle`.
- `PUT /rooms/:id/byline` signs and `DELETE /rooms/:id/byline` unsigns, in
  `roomRoutes`. Errors: 403 for anyone but the creator, 409 `room_not_public`,
  409 `no_handle`.
- `GET /rooms/:id` adds `signed: boolean` for the room's creator.

**D7. The dash.**
- **Settings** gains a "Public handle" section: the field, the rules, save and
  remove, and a line saying what a handle shows and where.
- **The room page** (`/rooms/$roomId`), for its creator while the room is public,
  shows "Sign as @handle". Without a handle, it shows a link to Settings instead.
- **The public room page** (`/r/$roomId`) shows "by @handle" under the title, linked
  to the handle page. It shows `@handle` wherever `by.as` appears.
- **A new public page**, `/u/$handle`, lists the handle's rooms from D5.

**D8. The site.** The privacy policy and the terms gain a section on public rooms
and bylines. Neither page mentions public rooms today. The section says:
- what a public room shows, and to whom;
- that members appear by number and sign-in labels never appear;
- that unpublishing is permanent;
- that a byline is opt-in, what it shows, and how to remove it;
- that a released handle can be claimed by someone else.

**D9. ADR 0021** records D1, D2 and D4. (ADR 0019 is the Claude Code plugin's and members as rows'; ADR 0020 is
permanent codes for public rooms.)

## Storage

`BellmanStore` gains these methods. All are async, both stores implement them, and
the store contract suite covers them.

- `handleOf(userId): Promise<string | undefined>`
- `userOfHandle(handle): Promise<string | undefined>`
- `claimHandle(userId, handle): Promise<"claimed" | "taken">`. The format and
  reserved checks run in the route, before the store. Claiming the handle you
  already hold answers `claimed` and changes nothing.
- `releaseHandle(userId): Promise<void>`
- `signRoom(userId, sessionId, at): Promise<void>`
- `unsignRoom(userId, sessionId): Promise<void>`
- `signedRooms(userId): Promise<{ sessionId: string; signedAt: number }[]>`
- `bylineFor(userId, sessionId): Promise<string | undefined>`. It returns the
  handle when the user holds one and has signed the room. It is D4's one read.

## Testing

**Store contract, against `MemoryStore` and against the Durable Objects store in
workerd:**
- a handle is claimed, and a second user's claim of it is refused;
- a change frees the old handle;
- a release removes every signature;
- signing and unsigning work;
- `signedRooms` lists newest first;
- `bylineFor` answers only when both the handle and the signature hold.

**Routes:**
- the format and reserved checks;
- only the creator signs;
- a room that is not public answers 409, and so does a caller with no handle;
- `by` appears only when the room is signed;
- `as` equals the number `byNumber` writes for the creator;
- a changed handle shows the new one, and a released handle shows none;
- a freed handle claimed by another user lists none of the old owner's rooms;
- an unpublished room drops off the handle page.

**Dash:**
- the Settings form's states;
- the sign toggle;
- the byline and the `@handle` swap on the public page;
- the handle page.

**Site:**
- the new section renders;
- the generated pages stay current.

## Out of scope

- Display names, avatars and bios.
- Bylines for any member but the creator.
- Any tool or manifest change.
- Search-engine controls. Handle pages follow public room pages, which set none.
- Verification and moderation. The owner releases an abusive handle by hand.

## Delivery

Three PRs, in order:
1. bellman: the store, the routes and ADR 0021;
2. dash: Settings, the toggle and the two pages;
3. the site: privacy and terms.

The dash PR waits on the server deploy. The site PR can land first, because the
section describes public rooms, which already exist.
