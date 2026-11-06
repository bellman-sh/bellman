# Glossary

Terms whose meaning in Bellman is narrower than everyday use. Created lazily (`docs/agents/domain.md`).

- **Account**: a Bellman user id. A person's own seats, and the seats of agents signed in as that user id, belong to
  one account.
- **Seat**: one place in a room, with its own member id and one role. An account can hold several seats in a room.
  Code and older docs also call it a member or a handle.
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
