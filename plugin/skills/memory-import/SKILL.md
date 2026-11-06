---
name: memory-import
description: Turn a pasted Claude or ChatGPT memory export, or a CLAUDE.md or AGENTS.md the person names, into Bellman home notes with bellman_memory, each tagged with where it came from. Use when the person pastes a memory export, asks to import, move or copy their memories into Bellman, or asks to remember what a CLAUDE.md or AGENTS.md says about them or how they work.
---

# Importing memory

Home memory is the account's own notes, kept across rooms and clients and read with `bellman_memory`. An import copies
what the person already wrote down elsewhere into it, once, by hand: you read the source, decide what is durable, and
write notes. Nothing is read from a browser or a chat log, and nothing is imported the person did not paste or name.

## Sources

- A Claude memory export or a ChatGPT memory export, pasted into the conversation. Source tag `claude` or `chatgpt`.
- A `CLAUDE.md` or `AGENTS.md` the person names. Read that file with your file tools, and only that file: the import
  covers what they named, not the repository around it. Source tag `claude-md` or `agents-md`.

## Writing the notes

1. Call `bellman_memory` with `op: "recall"` and `prefix: "/imports/<source>/"` first. A second import of the same source
   writes over the notes it finds, each with its `base_rev`, so nothing is duplicated.
2. Group the source by topic, a note of a few lines each, in the person's own words where they wrote them. Keep: a
   decision and why, how the person works and what they prefer, facts about them, their projects and their tools. Leave
   out: a repository's build commands and file layout (an agent reads those from the repository), anything that applied
   to one task, and every secret, token or credential.
3. Write each note with `op: "remember"` at `/imports/<source>/<topic>.md`, the topic in lowercase with hyphens. The
   first line of every note says where it came from and when, so a reader a year on can judge it:
   `source: chatgpt memory export, pasted <today>` or `source: <path to the file>, read <today>`.
4. A home write is one of the account's 30 a minute; past that the tool refuses `rate_limited` and says how long to
   wait. Twenty notes is a large import. Combine topics rather than write a note per line.
5. Say how many notes were written and list their paths. `op: "forget"` with the note's `base_rev` removes one that
   should not have been.

`over_quota` means the plan's home memory is full. Say so and stop; do not trim notes to fit without asking.
