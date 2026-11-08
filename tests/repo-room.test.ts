import { describe, expect, it } from "vitest";
import { normalizeRemote } from "../src/room/repo-room.js";

describe("normalizeRemote", () => {
  it("gives one host/owner/repo for the ssh, scp, https and upper-case forms of one repo", () => {
    for (const raw of [
      "git@github.com:bellman-sh/bellman.git",
      "https://github.com/bellman-sh/bellman",
      "ssh://git@github.com/bellman-sh/bellman.git",
      "https://GitHub.com/bellman-sh/bellman.git/",
      "git@GitHub.com:bellman-sh/bellman.git",
    ]) {
      expect(normalizeRemote(raw), raw).toBe("github.com/bellman-sh/bellman");
    }
  });

  it("drops credentials and a port", () => {
    expect(normalizeRemote("https://user:token@github.com/a/b.git")).toBe("github.com/a/b");
    expect(normalizeRemote("ssh://git@gitlab.example.com:2222/group/sub/repo.git")).toBe("gitlab.example.com/group/sub/repo");
  });

  it("answers null for what is not a remote with an owner and a repo", () => {
    for (const raw of ["", "not a url", "https://github.com/", "https://github.com/only", "file:///tmp/repo", "/tmp/repo"]) {
      expect(normalizeRemote(raw), raw).toBeNull();
    }
  });
});
