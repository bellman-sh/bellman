# Context

## Current Task
Bellman is live at `https://mcp.bellman.sh/mcp` on Workers + Durable Objects, with bearer keys and GitHub/Google sign-in. Backlog: #1–#3, #5, #12, #18, #20.

## Key Decisions
- The repo is colocated jj: a detached git HEAD is normal, drive it with `jj`. `main` moves only through merges, so even a doc change goes via a branch and PR.
- Workers + Durable Objects is production (`SessionDO` per session, a singleton `RegistryDO`, one `AuditDO` per org). The Node server with `MemoryStore` is local development only.
- Claude Code talks to Bellman through the local bridge (`dist/channel.js`), which pushes peer events as channel notifications, or queues them for the Stop hook under `BELLMAN_DELIVERY=hook`. Peer content keeps its untrusted wrapper the whole way.

## Next Steps
- #12: run the store contract suite against `DurableObjectStore`. It is the only store serving production and is verified solely by the smoke run.
- M0 room core in order — #1 manifests, then #2 permission verbs, then #3 role-carrying codes. #18 and #20 both wait on those.
- Try the Claude Desktop connector now OAuth is live. A signed-in identity gets the free plan unless `BELLMAN_USERS` grants it a plan, role and org.
