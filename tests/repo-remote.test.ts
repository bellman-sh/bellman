import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchJoin, remoteOf, type Run } from "../src/client/repo-remote.js";

const dirs: string[] = [];
const temp = () => {
  const dir = mkdtempSync(join(tmpdir(), "rr-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("remoteOf", () => {
  it("reads a git repo's origin, normalized", () => {
    const dir = temp();
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:bellman-sh/bellman.git"], { cwd: dir });
    expect(remoteOf(dir)).toBe("github.com/bellman-sh/bellman");
  });

  it("is null outside a repo", () => {
    expect(remoteOf(temp())).toBeNull();
  });

  it("falls back to jj's origin when git has none", () => {
    const exec: Run = (cmd, args) => {
      if (cmd === "git") throw new Error("not a git repository");
      // Never a snapshot: a stale workspace refuses one, and a fresh one writes an operation nobody asked for.
      if (args[0] !== "--ignore-working-copy") throw new Error("would snapshot the working copy");
      return "upstream https://github.com/other/fork.git\norigin https://github.com/bellman-sh/bellman.git\n";
    };
    expect(remoteOf("/nowhere", exec)).toBe("github.com/bellman-sh/bellman");
    expect(remoteOf("/nowhere", () => { throw new Error("no"); })).toBeNull();
  });
});

describe("launchJoin", () => {
  const bridge = () => ({ join: vi.fn(async () => undefined), joinBound: vi.fn(async () => undefined) });

  it("joins from a code when one is set, and never looks for a binding", () => {
    const b = bridge();
    const find = vi.fn(() => "github.com/a/b");
    launchJoin(b, "BELL-AAAA-11-HELPER", "/repo", "repo", find);
    expect(b.join).toHaveBeenCalledWith("BELL-AAAA-11-HELPER", "repo");
    expect(b.joinBound).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });

  it("joins the repo's default room without a code, and does nothing outside a repo", () => {
    const b = bridge();
    launchJoin(b, undefined, "/repo", "repo", () => "github.com/a/b");
    expect(b.joinBound).toHaveBeenCalledWith("github.com/a/b", "repo");
    const none = bridge();
    launchJoin(none, "", "/tmp", "tmp", () => null);
    expect([none.join.mock.calls.length, none.joinBound.mock.calls.length]).toEqual([0, 0]);
  });
});
