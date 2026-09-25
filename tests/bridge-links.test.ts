import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { constants as fsConstants, lstatSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadRoomManifest } from "../src/bridge.js";

/**
 * loadRoomManifest refuses a symlinked room.yaml with two layers, and each has to be proved without the
 * other, because in the ordinary case whichever speaks first hides the second:
 *
 *   lstat        asked before the open. Not atomic, but the only layer on a platform whose fs.constants has
 *                no O_NOFOLLOW, which is Windows.
 *   O_NOFOLLOW   in the open itself. Atomic, so it also refuses a link that appears after the lstat looked.
 *
 * The link tests in bridge.test.ts run with both in force, so each passes if EITHER layer works and none
 * could notice one being deleted. These take one layer away at a time. A real Node's fs.constants is
 * read-only and lstat cannot be made late, so both are steered through a mock of node:fs that is the real
 * module until a test says otherwise.
 */
const platform = vi.hoisted(() => ({ hasNoFollow: true, lstatMissesLinks: false }));

vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    // Over a copy: a proxy may not misreport a property that is read-only on its target, as this one is.
    constants: new Proxy({ ...real.constants }, {
      get: (target, key) => (key === "O_NOFOLLOW" && !platform.hasNoFollow ? undefined : Reflect.get(target, key)),
    }),
    // What lstat would have said had the link not been there yet. Only room.yaml is misreported.
    lstatSync: (file: string) => {
      const stats = real.lstatSync(file);
      return platform.lstatMissesLinks && file.endsWith("room.yaml")
        ? Object.assign(Object.create(stats), { isSymbolicLink: () => false })
        : stats;
    },
  };
});

describe("room.yaml links, one layer at a time", () => {
  let dir: string;
  const room = () => path.join(dir, ".bellman", "room.yaml");
  const refusal = /room\.yaml is a symbolic link, and the bridge will not follow one/;

  // A mapping, so being a link is the only reason to refuse it. And a link to nothing, which read as
  // "no room.yaml" when a followed link came back ENOENT.
  const links: Array<[string, () => Promise<void>]> = [
    ["a link to YAML elsewhere", async () => {
      await fs.mkdir(path.join(dir, "elsewhere"));
      await fs.writeFile(path.join(dir, "elsewhere", "secrets.yaml"), "api_key: not-for-the-server\n");
      await fs.symlink(path.join(dir, "elsewhere", "secrets.yaml"), room());
    }],
    ["a link to nothing", () => fs.symlink(path.join(dir, "not-there.yaml"), room())],
  ];

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "bellman-links-"));
    await fs.mkdir(path.join(dir, ".bellman"));
  });

  afterEach(async () => {
    platform.hasNoFollow = true;
    platform.lstatMissesLinks = false;
    await fs.rm(dir, { recursive: true, force: true });
  });

  // Windows makes links only with privileges a runner rarely has, so the link tests skip there like the
  // others. The fallback's happy path below needs no link and runs everywhere.
  it.skipIf(process.platform === "win32").each(links)(
    "lstat alone refuses %s, on a platform with no O_NOFOLLOW",
    async (_name, makeLink) => {
      platform.hasNoFollow = false;
      await makeLink();
      // What makes this a test of lstat: nothing in the open can refuse a link now.
      expect(fsConstants.O_NOFOLLOW).toBeUndefined();

      expect(() => loadRoomManifest(dir)).toThrow(refusal);
    },
  );

  it.skipIf(process.platform === "win32").each(links)(
    "O_NOFOLLOW alone refuses %s, when lstat looked before it was a link",
    async (_name, makeLink) => {
      platform.lstatMissesLinks = true;
      await makeLink();
      // What makes this a test of the open: the check ahead of it saw nothing, and the path is a link.
      expect(lstatSync(room()).isSymbolicLink()).toBe(false);
      expect((await fs.lstat(room())).isSymbolicLink()).toBe(true);

      expect(() => loadRoomManifest(dir)).toThrow(refusal);
    },
  );

  // The Windows path is otherwise unexercised here, and it must still LOAD a file: a fallback that refused
  // everything would pass every refusal test above.
  it("still reads a regular room.yaml where there is no O_NOFOLLOW", async () => {
    platform.hasNoFollow = false;
    await fs.writeFile(room(), "room: x\npreset: pair\n");
    expect(fsConstants.O_NOFOLLOW).toBeUndefined();

    expect(loadRoomManifest(dir)).toEqual({ room: "x", preset: "pair" });
  });

  it("still reads a regular room.yaml when lstat has nothing to say about it", async () => {
    platform.lstatMissesLinks = true;
    await fs.writeFile(room(), "room: x\npreset: pair\n");

    expect(loadRoomManifest(dir)).toEqual({ room: "x", preset: "pair" });
  });
});
