---
name: verify
description: Verify the Bellman server end to end, the way a user runs it - install, build, `npm start`, then drive a real room through scripts/smoke.ts against it, and report PASS or FAIL with the failing step. Use when asked to verify, smoke-test, or confirm a server change works outside the unit tests.
---

# Verify

Runs the local Node server exactly as `npm start` serves it (MemoryStore, real HTTP, real MCP over Streamable HTTP) and drives one room through its whole life with `scripts/smoke.ts`: three MCP clients start an org-only pair room, preview and confirm a join, exchange briefs, long-poll a message, run an action request and its response, read the audit log, and leave. Nothing in that path is mocked; the dev bearer keys (`qk_dev_jesse`, `qk_dev_peer`, `qk_dev_outsider`) are the local server's own identities. A run takes about 20 s, 2 minutes at most.

This is not `npm run verify` (typecheck + unit tests). Run that before a commit; run this to see the server work.

## Steps

Run each command from the repo root and keep its output. Each step ends when its command has exited (or, for step 3, when the server answers); a step whose command fails ends the run: go to step 6 and report FAIL at that step.

1. **Install.** `[ -d node_modules ] || npm ci --no-audit --no-fund`. Done when `node_modules/express` exists.
2. **Build.** `npm run build`. Done on exit 0; `dist/index.js` is what `npm start` runs, so a stale `dist/` would verify old code.
3. **Start the server** in the background on a port nothing else holds (3900 is the usual dev server; use 3917), with its log captured:
   ```bash
   PORT=3917 npm start > "$TMPDIR/bellman-verify.log" 2>&1 &
   for i in $(seq 1 30); do curl -sf http://localhost:3917/healthz && break; sleep 0.5; done
   ```
   Done when `/healthz` answers and the log shows `listening on http://localhost:3917/mcp`. No answer in 15 s is FAIL at "start"; quote the log.
4. **Drive the flow.** `BELLMAN_URL=http://localhost:3917/mcp npm run smoke`. Each check prints one line, `✅` or `❌`, under a `— section —` header. The `/ws` section prints "skipped" against Node: only a Workers runtime serves `/ws` (`npm run dev:worker` and `BELLMAN_URL` at it covers that leg).
5. **Stop the server.** `kill $(lsof -ti tcp:3917)`, always, including after a failure in step 4.
6. **Report**, in this shape:
   ```
   1 install   ok
   2 build     ok
   3 start     ok (listening on :3917)
   4 flow
     tool discovery            ✅ every tool this run calls is listed
     join flow: preview → ...  ❌ outsider blocked by org_only
     ...one line per check, copied from the smoke output...
   5 stop      ok
   FAIL at step 4, "join flow: preview → confirm": outsider blocked by org_only
   ```
   The verdict is the last line. PASS needs every step ok, every check `✅`, and smoke's `ALL SMOKE CHECKS PASSED` with exit 0. Otherwise FAIL, naming the step, and for step 4 the section and text of the first `❌` (or "crashed" with the error when smoke prints `Smoke test crashed`). A later `❌` can be a consequence of the first; list them all, name the first.
