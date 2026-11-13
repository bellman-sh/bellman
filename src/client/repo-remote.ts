/**
 * The repo a session was started in, for its default room (docs/superpowers/specs/2026-11-08-repo-default-room-design.md):
 * the cwd's `origin` remote, from git, or from jj in a jj workspace that has no `.git`. Normalized, or null.
 */
import { execFileSync } from "node:child_process";
import { normalizeRemote } from "../room/remote.js";

/** Runs one command in `cwd` and returns its stdout; throws on a failure or after two seconds. */
export type Run = (cmd: string, args: string[], cwd: string) => string;

const run: Run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, timeout: 2_000, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" });

/** `git remote get-url origin`, else the `origin` line of `jj --ignore-working-copy git remote list`; null when neither gives a remote. */
export function remoteOf(cwd: string, exec: Run = run): string | null {
  const tries: Array<[string, string[], (out: string) => string | undefined]> = [
    ["git", ["remote", "get-url", "origin"], (out) => out.trim()],
    // No snapshot: a stale workspace refuses one, and a fresh one would write an operation at every launch.
    ["jj", ["--ignore-working-copy", "git", "remote", "list"], (out) => /^origin\s+(\S+)/m.exec(out)?.[1]],
  ];
  for (const [cmd, args, pick] of tries) {
    try {
      const found = pick(exec(cmd, args, cwd));
      const remote = found ? normalizeRemote(found) : null;
      if (remote) return remote;
    } catch {
      // Not a repo of that kind, or the tool is not installed: try the next.
    }
  }
  return null;
}

/**
 * The join at launch: from `BELLMAN_JOIN_CODE` when one is set, which wins; else from the cwd's repo's default room,
 * when it has a remote. Not awaited by the caller: a sign-in either may wait on must not hold up the handshake.
 *
 * Not from the default room in a headless Claude Code (`claude -p` and the Agent SDK set `CLAUDE_CODE_ENTRYPOINT` to
 * `sdk-…`): that is a script, not a person's session. Another plugin's session summary runs `claude --model haiku -p`
 * in the repo, and each run took a seat in the room and, exiting at once, left it behind (#603). A code is still
 * honoured there: setting one is asking for the join.
 */
export function launchJoin(
  bridge: { join(code: string, project: string): Promise<unknown>; joinBound(remote: string, project: string): Promise<unknown> },
  code: string | undefined,
  cwd: string,
  project: string,
  find: (cwd: string) => string | null = remoteOf,
  entrypoint: string | undefined = process.env.CLAUDE_CODE_ENTRYPOINT,
): void {
  if (code) {
    void bridge.join(code, project);
    return;
  }
  if (entrypoint?.startsWith("sdk-")) return;
  const remote = find(cwd);
  if (remote) void bridge.joinBound(remote, project);
}
