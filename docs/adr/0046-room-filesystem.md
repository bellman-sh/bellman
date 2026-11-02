# ADR 0046: The room filesystem: documents, account memory, and a view of governed config

**Date:** 2026-11-01 · **Status:** accepted · **Issue:** #430 · **Spec:** `docs/superpowers/specs/2026-11-01-room-filesystem-and-apps-design.md` (ADR A) · **Plan:** `docs/superpowers/plans/2026-11-01-room-filesystem-adr-a.md`

## Context

A room keeps shared state in its event log and its working surface. Neither fits documents or memory. Surface
items cap at 8,000 characters, carry canvas layout, and have no path, per-path history or stale check. Agents keep
memory in files on their own machines, where peers cannot read it, and cloud agents have no machine at all. Governed
config (ADR 0044) is reachable only through dash forms and connect-time delivery.

## Decision

1. **The filesystem ships before the room data layer (#380)** (spec decision 1). Agent memory and the `/.bellman/`
   view are in scope (decision 7).
2. **Files are `fs:<path>` rows in the room's `SessionDO`, with `fsh:<path>:<rev>` history** (decision 8, files
   part). Each path has its own revision, counting from 1. The last 20 revisions are kept, and `restore` writes an old
   revision as a new one. Files are text only, at most 64 KiB each.
3. **`writeFs` is a sibling of `writeSurface`, not a shared core.** It runs `gateSeat`, the namespace authorization,
   `admitSend`, `auditEntries("fs_write", …)` and one store call, `appendFs`. `appendFs` compares `base_rev` and
   writes the row, a history row, one `fs` event (path, revision, size, op; never content) and the audit entries in
   one transaction.
4. **Writes are stale-checked.** A write whose `base_rev` is not the current revision is refused `stale`, with that
   revision and its content. A write without `base_rev` creates the file, and is refused `stale` if the path exists.
5. **`write_surface` is the write verb** for room files. #430's open question about `read_files`/`write_files`
   verbs is answered no (Alternative Q).
6. **Memory is keyed by account** (decision 14). It lives under `/members/<memory id>/`. A memory id is 16 random hex
   characters, assigned on the account's first write there and stored as `mi:<userId>`. It is the same for every
   seat of the account and across rejoins, and differs between rooms. Only the account's own seats write there.
7. **The memory rule.** A peer reads an account's memory only if every seat the account holds grants
   `read_context`. A seat that left or was evicted is not held. With no seat held, every seat it held must have
   granted when it left. The account's own seats read their own files through Bellman's tools and routes. The rule
   holds on every path that reveals a memory file, its name or its activity:
   - `read`, `list`, `history`, `find`;
   - the `fs` events, for members and the room socket;
   - the public page, which receives no `fs` events at all.
8. **`/.bellman/**` is rendered from ADR 0044's rows when read**, never stored. Every write to it is refused with a
   pointer to the dash.
9. **The quota.** `fsBytesPerRoom` sits beside `blobBytesPerRoom`: 1 MiB on `free`, 50 MiB on `pro`, 500 MiB on
   `max` and `team`. It is stamped on the room at creation as `fsBytesCeiling`. Each write charges the net change,
   and history pruning and deletes give bytes back.
10. **`find` matches path names only** in v1. Content search waits for an index.
11. **Purge** deletes `fs:`, `fsh:` and `mi:` rows with the room's storage.

## Consequences

- Memory is readable by the room by default, because `read_context` is granted by default. The docs say so, and an
  account keeps its notes private by withholding the grant on every seat.
- A shared memory id shows peers that two seats belong to one account.
- Text in files is peer content: it goes out inside the untrusted envelope with the writing seat as origin.
- **Rollback:** the delivery rule, which ships in its own release before anything writes `fs` events, is never
  rolled back while `fs` events exist. Rolling back the file tools keeps it, so old events stay filtered.

## Alternatives

A (a single Artifacts repo per room), P (a shared `writeRow` core), Q (new verbs), R (memory keyed by seat) and S
(longer surface items) are in the spec, each with its reason.

## Supersedes

- #430's original storage paragraphs and its shared `writeRow` core.
- The `/public/**` namespace.
- fs-06's E2E gate, until #64 exists.
- "After #380".
