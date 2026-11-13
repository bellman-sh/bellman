# Glossary

Terms whose meaning in Bellman is narrower than everyday use. Created lazily (`docs/agents/domain.md`).

- **Account**: a Bellman user id. A person's own seats, and the seats of agents signed in as that user id, belong to
  one account.
- **Seat**: one place in a room, with its own member id and one role. An account can hold several seats in a room.
  Code and older docs also call it a member or a handle.
- **Seat name**: a seat's name in its room, `<role>-<seq>` (`coder-17`), derived and never reused (ADR 0048). Not a
  handle, which is an account's public name (ADR 0021).
- **Addressed message**: a `message` or `artifact` sent with `to`, naming seats (ADR 0048). It wakes only those seats and
  is ambient for the rest; every member can still read it.
- **Member**: a participant in the room, in the everyday sense. "Members" means the room's participants. Bellman
  never uses the word for "two sessions".
- **Room file**: a text file at a path in a room (ADR 0046), stored as an `fs:` row with its last 20 revisions.
- **Memory id**: an opaque random id an account has in one room, used in `/members/<memory id>/` paths (room notes). It is the same
  for all the account's seats and across rejoins, and reveals nothing about the account.
- **Home room**: an account's hidden one-member room holding its home memory (ADR 0047). Its id is derived from the
  user id and never returned; it is never listed, joined or public.
- **Home memory**: the files in an account's home room. Every seat the account holds reads them, in any room; peers
  never do. A **home note** is one of them.
- **Room notes**: an account's files under `/members/<memory id>/` in a room. Peers read them only when the account
  turns on **notes sharing** for that room and every seat it holds grants `read_context` (ADR 0047).
- **Room fact**: a file under `/facts/` in a room, written only by an approved fact proposal or a passed decision, with
  its proposer, approver and source in its front matter.
- **Lookup log**: the record of every agent read of an account's home memory, kept in its home room and shown only to
  the account.
- **Room socket**: the WebSocket the dash shares across members. It reads the room as no account, so it never
  receives a brief a member withholds, or memory files and their events.
- **Public page**: a public room's page and outside readers, which read through `publicReadEvent`. It receives no
  `fs` events.
- **Governed config**: room settings a person with `govern` changes in the dash, inside the manifest (ADR 0044).
- **App**: web pages plus server code that agents write under `/apps/<key>/` in a room and members open in the dash
  (ADR 0049). Its source is one Artifacts repo, its data its own `AppDO`'s SQLite.
- **App key**: an app's name within its room, the `<key>` in `/apps/<key>/` and the key of its one `app` surface item.
- **App id**: 20 random hex characters naming an app's origin, `https://<app id>.<apps domain>`; its previews use
  `https://p-<app id>.<apps domain>`.
- **App author**: for a version, the seat that published it, stamped by the server; publishing vouches for code
  another seat wrote. For a draft, the seat that wrote it.
- **Version**: one tree of an app's source, named by its version hash. States: `draft`, `checking`, `passed`,
  `failed`, `pending_approval`, `live`, `denied`, `superseded`, `stopped`.
- **Capability set**: what a version asks to reach in its `app.json`: `db`, or `room` with a scope; `ai` with a
  budget; in phase B, hosts and secrets. The **base set** is `db` alone and needs no approval. The **current approved
  set** is the one set per app a human last approved, or the base set.
- **Verdict**: the gate's result for one (version hash, bundle hash), with its findings and the version of every check
  it ran.
- **Run click**: a viewer's consent to run an app's server code, recorded per approved set; a new set asks again.
- **Preview**: a version opened before it is live, on the app's `p-` origin, with no `env.AI`, `env.ROOM` or network
  and a throwaway database.
- **Kill flag**: an operator's switch on one app or on a room's apps, read on every request, alarm and binding call.
