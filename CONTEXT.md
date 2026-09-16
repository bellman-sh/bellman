# Context

## Current Task
M1 test suite is merged. Next is M0 room core on the renamed Bellman codebase.

## Key Decisions
- Name is Bellman (bellman.sh). Join codes use the `BELL-` prefix. The full search, with collision evidence, is in `naming/domain-sweep.md`.
- Tools are `bellman_*`, the store interface is `BellmanStore`, the package is `bellman-mcp-server`.
- `main` moves only through merges; feature work happens on branches.

## Next Steps
- M0 room core: YAML room manifests, roles with server-enforced permission verbs, join codes that carry a role.
- M2 local membership: keep the Stop hook plus a long-poll wait tool as the portable base. A Claude Code channel plugin is the optional fast path, but it is Claude-only and in research preview.
- Cosmetic leftovers of the old name: id prefixes `qs_` and `qct_`, and the dev key prefix `qk_` in `src/auth.ts`.
