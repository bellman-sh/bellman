# Context

## Current Task
M1 test suite is merged. The backlog now lives in GitHub issues #1–#7 (labels `M0`, `M2`, `chore`). Next up is M0 room core.

## Key Decisions
- Name is Bellman (bellman.sh). Join codes use the `BELL-` prefix. The full search, with collision evidence, is in `naming/domain-sweep.md`.
- Tools are `bellman_*`, the store interface is `BellmanStore`, the package is `bellman-mcp-server`.
- `main` moves only through merges; feature work happens on branches.

## Next Steps
- M0 room core, in dependency order: #1 YAML manifests → #2 server-enforced role verbs → #3 role-carrying join codes. #1 blocks the other two.
- #5 rename leftovers (`qs_`, `qct_`, `qk_`, ~30 call sites) — mechanical, and cheapest before M0 code lands on top of it.
- M2 local membership (#4): Stop hook plus a long-poll wait tool is the portable base. Claude Code channels are the Claude-only fast path, still research preview.
