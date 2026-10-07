/**
 * bellman_upload (#183, D7): the bridge reads a local file, posts it to the
 * room's blob route with the bearer it holds, then places it through the
 * upstream bellman_send — one call. The route is the real one, inside the fake
 * server, over a MemoryBlobStore the upstream's writeSurface then heads: what
 * the bridge uploaded is what the item names.
 *
 * The read is bounded to an upload root: BELLMAN_UPLOAD_ROOT, else the directory
 * the bridge was started in. Every test but the ones about the root itself runs
 * with it set to `dir`, where its files are; `outside` is a directory it does
 * not cover.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { resolveIdentity } from "../src/auth.js";
import { MAX_BLOB_BYTES } from "../src/blobs.js";
import { createBridge, readLocalFile, typeFromExtension, type Remote } from "../src/bridge.js";
import { buildServer } from "../src/server.js";
import { PNG } from "./helpers/blob-bytes.js";
import { fakeBellman, ISSUER, type FakeBellman } from "./helpers/fake-bellman.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ROOM = "qs_upload";
const jesse = resolveIdentity(`Bearer ${DEV_KEY.jesse}`)!;

let fake: FakeBellman;
let dir: string;
let outside: string;
let rootBefore: string | undefined;
let fetches: number;
let posted: string[];
let sends: number;
let bridge: ReturnType<typeof createBridge>;
let client: Client;

/** The real tool handlers over the fake's own stores, so the placement heads the blob the route stored. */
async function remoteFor(): Promise<Remote> {
  const server = buildServer(jesse, fake.store, fake.blobs);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const upstream = new Client({ name: "bridge-remote", version: "0.0.1" });
  await Promise.all([server.connect(serverSide), upstream.connect(clientSide)]);
  return {
    listTools: () => upstream.listTools(),
    callTool: (params) => {
      if (params.name === "bellman_send") sends++;
      return upstream.callTool(params) as Promise<CallToolResult>;
    },
    close: () => upstream.close(),
  };
}

/** The network the bridge posts through: the fake's own `fetch`, with what was asked of it written down. */
const recording = ((input, init) => {
  fetches++;
  posted.push(String(input));
  return fake.fetch(input, init);
}) as typeof fetch;

beforeEach(async () => {
  fake = fakeBellman({ keys: { [DEV_KEY.jesse]: jesse } });
  await fake.store.createSession(session({ id: ROOM, members: [member()] }));
  dir = mkdtempSync(join(tmpdir(), "bellman-upload-"));
  outside = mkdtempSync(join(tmpdir(), "bellman-outside-"));
  rootBefore = process.env.BELLMAN_UPLOAD_ROOT;
  process.env.BELLMAN_UPLOAD_ROOT = dir;
  fetches = 0;
  posted = [];
  sends = 0;
  bridge = createBridge({
    delivery: "channel",
    remote: remoteFor,
    upload: {
      serverUrl: `${ISSUER}/mcp`,
      bearer: () => DEV_KEY.jesse,
      fetchImpl: recording,
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "claude-code", version: "0.0.1" });
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await bridge.close();
  await client.close();
  vi.restoreAllMocks();
  if (rootBefore === undefined) delete process.env.BELLMAN_UPLOAD_ROOT;
  else process.env.BELLMAN_UPLOAD_ROOT = rootBefore;
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

async function upload(args: Record<string, unknown>) {
  const res = (await client.callTool({ name: "bellman_upload", arguments: { session_id: ROOM, member_id: "m_creator", ...args } })) as CallToolResult;
  return {
    isError: Boolean(res.isError),
    data: (res.structuredContent ?? {}) as Record<string, unknown>,
    text: (res.content ?? []).map((b) => (b.type === "text" ? b.text : "")).join("\n"),
  };
}

const file = (name: string, content: Uint8Array | string) => {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
};

describe("bellman_upload", () => {
  it("is listed, with its arguments", async () => {
    const tool = (await client.listTools()).tools.find((t) => t.name === "bellman_upload")!;
    expect(tool).toBeDefined();
    expect(tool.inputSchema.required).toEqual(["session_id", "member_id", "path", "key"]);
    expect(tool.annotations?.readOnlyHint).toBe(false);
  });

  // What the agent is told, which is the artifact: the root a path must be under, and what a hosted connector
  // has instead, which is nothing yet. The panel's upload is piece 3, so the description must not say it exists.
  it("tells the agent where it may read from, and that a hosted connector has no such tool", async () => {
    const description = (await client.listTools()).tools.find((t) => t.name === "bellman_upload")!.description!;
    expect(description).toContain("a regular file under the upload root (the directory the bridge was started in, or BELLMAN_UPLOAD_ROOT; / for any file)");
    expect(description).toContain("a hosted connector has no bellman_upload; the control panel's upload comes with the canvas");
    expect(description).not.toContain("uploads through the control panel");
  });

  it("uploads a regular file and places it as a file item, in one call", async () => {
    const path = file("notes.md", "# notes\n");
    const out = await upload({ path, key: "notes", title: "Notes" });
    expect(out.isError, out.text).toBe(false);
    expect(out.data).toMatchObject({ bytes: 8, type: "text/markdown", cursor: expect.any(Number), room_members: [] });
    const id = String(out.data.blob_id);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(await fake.blobs.head(ROOM, id)).toMatchObject({ bytes: 8, type: "text/markdown", name: "notes.md", by: "m_creator" });
    const [row] = await fake.store.surfaceOf(ROOM);
    expect(row).toMatchObject({ key: "notes", kind: "file", title: "Notes", blob: { id, bytes: 8, type: "text/markdown", name: "notes.md" } });
    expect(fetches).toBe(1);
    expect(sends).toBe(1);
    // The membership the send revealed is watched, as any bellman_send's is.
    expect(bridge.watching().map((w) => w.member_id)).toEqual(["m_creator"]);
  });

  // The fake routes on the path alone, so every test above would pass if the post went to some other
  // origin. This one reads where it went. A second bridge on an origin and port of its own is what tells
  // "the origin it was configured with" from "the one the first bridge happens to use".
  it("posts to the origin it was configured with, at the room's blob route and nowhere else", async () => {
    const out = await upload({ path: file("notes.md", "# notes\n"), key: "notes" });
    expect(out.isError, out.text).toBe(false);
    expect(posted).toHaveLength(1);
    const first = new URL(posted[0]);
    expect(`${first.origin}${first.pathname}`).toBe(`${ISSUER}/rooms/${ROOM}/blobs`);
    expect(Object.fromEntries(first.searchParams)).toEqual({ member_id: "m_creator", name: "notes.md" });

    posted = [];
    const elsewhere = createBridge({
      delivery: "channel",
      remote: remoteFor,
      upload: { serverUrl: "https://bellman.example.invalid:8443/mcp", bearer: () => DEV_KEY.jesse, fetchImpl: recording },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "elsewhere", version: "0.0.1" });
    await Promise.all([elsewhere.server.connect(serverSide), c.connect(clientSide)]);
    try {
      const res = (await c.callTool({
        name: "bellman_upload",
        arguments: { session_id: ROOM, member_id: "m_creator", path: file("again.md", "again"), key: "again" },
      })) as CallToolResult;
      expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
      expect(posted).toHaveLength(1);
      const second = new URL(posted[0]);
      expect(`${second.origin}${second.pathname}`).toBe(`https://bellman.example.invalid:8443/rooms/${ROOM}/blobs`);
    } finally {
      await elsewhere.close();
      await c.close();
    }
  });

  it("defaults the kind from the type: a PNG is an image, placed where asked", async () => {
    const path = file("shot.png", PNG);
    const out = await upload({ path, key: "shot", placement: { x: 1, y: 2, w: 320, h: 240 } });
    expect(out.isError, out.text).toBe(false);
    expect(out.data.type).toBe("image/png");
    const [row] = await fake.store.surfaceOf(ROOM);
    expect(row).toMatchObject({ kind: "image", blob: { type: "image/png", name: "shot.png" }, placement: { x: 1, y: 2, w: 320, h: 240 } });
  });

  it("takes an explicit kind over the default", async () => {
    const out = await upload({ path: file("shot.png", PNG), key: "shot", kind: "file" });
    expect(out.isError, out.text).toBe(false);
    expect((await fake.store.surfaceOf(ROOM))[0].kind).toBe("file");
  });

  it("refuses a symbolic link, a directory, a missing path and an oversized file locally, with nothing sent", async () => {
    const target = file("real.txt", "x");
    const link = join(dir, "link.txt");
    symlinkSync(target, link);
    const sub = join(dir, "sub");
    mkdirSync(sub);
    const huge = file("huge.bin", "");
    truncateSync(huge, MAX_BLOB_BYTES + 1);
    for (const [path, words] of [
      [link, "symbolic link"],
      [sub, "not a regular file"],
      [join(dir, "missing.txt"), "could not be read"],
      [huge, `at most ${MAX_BLOB_BYTES}`],
    ] as const) {
      const out = await upload({ path, key: "k" });
      expect(out.isError, path).toBe(true);
      expect(out.text, path).toContain(words);
    }
    expect(fetches).toBe(0);
    expect(sends).toBe(0);
    expect(await fake.store.surfaceOf(ROOM)).toEqual([]);
    // The control: the file the link points at uploads fine by its own path.
    expect((await upload({ path: target, key: "k" })).isError).toBe(false);
  });

  // Review Focus 5: the bytes are not lost when the placement is refused.
  it("reports a refused placement with the blob it uploaded, so the caller can place it as a file", async () => {
    const out = await upload({ path: file("fake.png", "<html>not a png</html>"), key: "fake" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("not an image");
    const id = /blob ([a-f0-9]{32})/.exec(out.text)?.[1];
    expect(id, out.text).toBeDefined();
    expect(out.text).toContain("application/octet-stream");
    // The three above are satisfied by the server's own refusal, which names the id and the type, so
    // they cannot tell whether the bridge said anything. These are the bridge's words alone: that the
    // upload happened, with its size and stored type, and the placement that needs no second upload.
    expect(out.text).toContain(`uploaded blob ${id} (22 bytes, stored as application/octet-stream)`);
    expect(out.text).toContain(`blob: { id: "${id}" }`);
    expect(await fake.blobs.head(ROOM, id!)).toMatchObject({ type: "application/octet-stream" });
    expect(await fake.store.surfaceOf(ROOM)).toEqual([]);
    expect(fetches).toBe(1);
    // And the recovery the error points at works without a second upload.
    const placed = (await client.callTool({
      name: "bellman_send",
      arguments: { session_id: ROOM, member_id: "m_creator", type: "surface", payload: { key: "fake", kind: "file", blob: { id } } },
    })) as CallToolResult;
    expect(Boolean(placed.isError)).toBe(false);
    expect(fetches).toBe(1);
  });

  it("reports a refused upload with the server's status", async () => {
    await fake.store.freezeSession(ROOM, Date.now());
    const out = await upload({ path: file("n.md", "x"), key: "n" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain("409");
    expect(sends).toBe(0);
  });

  // A signed-in bearer is the cached access token, which lasts ten minutes. The bridge cannot refresh it itself;
  // the MCP transport does, on a 401 of its own, and writes the new token where `bearer` reads it. So a 401 on
  // the post is answered by asking the held connection for something, and posting again if the bearer changed.
  // Here the connection's tools/list is what swaps the token: all the bridge can see of a refresh is the file.
  const uploadingThrough = async (bearer: () => string, onList: () => void) => {
    const through = createBridge({
      delivery: "channel",
      remote: async () => {
        const upstream = await remoteFor();
        return { ...upstream, listTools: () => (onList(), upstream.listTools()) };
      },
      upload: { serverUrl: `${ISSUER}/mcp`, bearer, fetchImpl: recording },
    });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "refreshing", version: "0.0.1" });
    await Promise.all([through.server.connect(serverSide), c.connect(clientSide)]);
    try {
      const res = (await c.callTool({
        name: "bellman_upload",
        arguments: { session_id: ROOM, member_id: "m_creator", path: file("n.md", "x"), key: "n" },
      })) as CallToolResult;
      return { isError: Boolean(res.isError), text: (res.content as { text: string }[]).map((b) => b.text).join("\n") };
    } finally {
      await through.close();
      await c.close();
    }
  };

  it("answers a 401 by letting the connection refresh the sign-in, then posts once more", async () => {
    let token = "qk_expired";
    let listed = 0;
    const out = await uploadingThrough(() => token, () => {
      listed++;
      token = DEV_KEY.jesse;
    });
    expect(out.isError, out.text).toBe(false);
    expect({ fetches, listed, sends }).toEqual({ fetches: 2, listed: 1, sends: 1 });
    expect((await fake.store.surfaceOf(ROOM)).map((row) => row.key)).toEqual(["n"]);
  });

  it("reports a 401 as it was, without a second post, when the bearer is the one that was refused", async () => {
    const out = await uploadingThrough(() => "qk_not_a_key", () => {});
    expect(out.isError).toBe(true);
    expect(out.text).toContain("upload refused (401)");
    expect({ fetches, sends }).toEqual({ fetches: 1, sends: 0 });
    expect(await fake.store.surfaceOf(ROOM)).toEqual([]);
  });

  it("fails plainly on a bridge with no upload target", async () => {
    const bare = createBridge({ delivery: "channel", remote: remoteFor });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "bare", version: "0.0.1" });
    await Promise.all([bare.server.connect(serverSide), c.connect(clientSide)]);
    try {
      expect((await c.listTools()).tools.map((t) => t.name)).toContain("bellman_upload");
      const res = (await c.callTool({ name: "bellman_upload", arguments: { session_id: ROOM, member_id: "m_creator", path: file("n.md", "x"), key: "n" } })) as CallToolResult;
      expect(res.isError).toBe(true);
      expect((res.content[0] as { text: string }).text).toContain("no upload target");
    } finally {
      await bare.close();
      await c.close();
    }
  });
});

// D7: the read is bounded. The agent driving the bridge may already read the filesystem, but a one-call send
// to every member of a room is new, and a line that arrives as peer content must not be able to ship a key file.
describe("bellman_upload's upload root", () => {
  /** Nothing was read into a request: no post, no placement, and the surface as it was. */
  const sentNothing = async () => {
    expect(fetches).toBe(0);
    expect(sends).toBe(0);
    expect(await fake.store.surfaceOf(ROOM)).toEqual([]);
  };
  const setRoot = (value: string | undefined) => {
    if (value === undefined) delete process.env.BELLMAN_UPLOAD_ROOT;
    else process.env.BELLMAN_UPLOAD_ROOT = value;
  };
  const rowKeys = async () => (await fake.store.surfaceOf(ROOM)).map((row) => row.key).sort();

  it("refuses a regular file outside the root, naming the path and the root, with nothing fetched or sent", async () => {
    const secret = join(outside, "id_rsa");
    writeFileSync(secret, "not for the room");
    const out = await upload({ path: secret, key: "keys" });
    expect(out.isError).toBe(true);
    expect(out.text).toBe(
      `Error: ${secret} is outside the upload root ${dir}: the bridge uploads only from the directory it was started in, or from BELLMAN_UPLOAD_ROOT when that is set (/ for any file).`,
    );
    await sentNothing();
  });

  it("uploads that same file once BELLMAN_UPLOAD_ROOT names its directory, and when it is /", async () => {
    const path = join(outside, "notes.md");
    writeFileSync(path, "# notes\n");
    expect((await upload({ path, key: "refused" })).isError, "the root of this test does not cover it").toBe(true);
    setRoot(outside);
    const named = await upload({ path, key: "named" });
    expect(named.isError, named.text).toBe(false);
    setRoot("/");
    const anywhere = await upload({ path, key: "anywhere" });
    expect(anywhere.isError, anywhere.text).toBe(false);
    expect(await rowKeys()).toEqual(["anywhere", "named"]);
  });

  it("resolves the root as it does the path: a root that is itself a link covers what its target holds", async () => {
    const door = join(outside, "door");
    symlinkSync(dir, door);
    setRoot(door);
    const out = await upload({ path: file("in.md", "in"), key: "inside" });
    expect(out.isError, out.text).toBe(false);
  });

  // The leaf here is a regular file, so the symbolic-link refusal and O_NOFOLLOW both pass it: the link is in
  // a parent. Only the comparison of resolved paths sees where it goes.
  it("refuses a regular file reached through a directory link that leaves the root", async () => {
    writeFileSync(join(outside, "file.txt"), "x");
    symlinkSync(outside, join(dir, "link"));
    const through = join(dir, "link", "file.txt");
    const out = await upload({ path: through, key: "k" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`${through} is outside the upload root ${dir}`);
    await sentNothing();
    // The control: a directory link that stays inside the root is no way out, and its file reads.
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "f.txt"), "y");
    symlinkSync(join(dir, "real"), join(dir, "inner"));
    const inner = await upload({ path: join(dir, "inner", "f.txt"), key: "k" });
    expect(inner.isError, inner.text).toBe(false);
  });

  it("does not take a sibling whose name begins with the root's for a path under it", async () => {
    const sibling = `${dir}-evil`;
    mkdirSync(sibling);
    try {
      writeFileSync(join(sibling, "f.txt"), "x");
      const out = await upload({ path: join(sibling, "f.txt"), key: "k" });
      expect(out.isError).toBe(true);
      expect(out.text).toContain(`outside the upload root ${dir}:`);
      await sentNothing();
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it("refuses everything, naming the root, when the root does not exist", async () => {
    const gone = join(dir, "no-such-dir");
    setRoot(gone);
    const out = await upload({ path: file("n.md", "x"), key: "n" });
    expect(out.isError).toBe(true);
    expect(out.text).toContain(`the upload root ${gone} does not exist`);
    await sentNothing();
  });

  it("starts from the directory the bridge was started in when BELLMAN_UPLOAD_ROOT is unset or empty", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(dir);
    const elsewhere = join(outside, "there.md");
    writeFileSync(elsewhere, "out");
    for (const value of [undefined, ""]) {
      setRoot(value);
      const inside = await upload({ path: file("here.md", "in"), key: "inside" });
      expect(inside.isError, `${JSON.stringify(value)}: ${inside.text}`).toBe(false);
      const refused = await upload({ path: elsewhere, key: "outside" });
      expect(refused.isError, JSON.stringify(value)).toBe(true);
      expect(refused.text, JSON.stringify(value)).toContain(`outside the upload root ${dir}:`);
    }
    expect(await rowKeys()).toEqual(["inside"]);
  });

  // A bridge started where the home directory is, or anywhere above it, would make every file under it an upload
  // candidate, every key a person owns among them, with nobody having said so. So the working-directory default is
  // refused there, before anything is read: one predicate, whether the directory is `/`, the home directory or
  // something between, and so one message. Naming the directory is saying so on purpose, and stays allowed.
  const containsHomeMessage = (cwd: string) =>
    `the bridge was started in ${cwd}, which contains your home directory, so every file under it would be an upload candidate (your keys included): set BELLMAN_UPLOAD_ROOT to the directory to upload from (${cwd} to allow that much on purpose).`;

  /** Runs `body` with `os.homedir()` answering `home`. It follows HOME (USERPROFILE on Windows), so no real home is touched. */
  const withHome = async (home: string, body: () => Promise<void>) => {
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      await body();
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  };

  it("refuses the working-directory default when it is the filesystem root, and takes / when it is named", async () => {
    vi.spyOn(process, "cwd").mockReturnValue("/");
    const path = join(outside, "notes.md");
    writeFileSync(path, "# notes\n");
    for (const value of [undefined, ""]) {
      setRoot(value);
      const out = await upload({ path, key: "k" });
      expect(out.isError, JSON.stringify(value)).toBe(true);
      expect(out.text, JSON.stringify(value)).toBe(`Error: ${containsHomeMessage("/")}`);
      await sentNothing();
    }
    setRoot("/");
    const named = await upload({ path, key: "k" });
    expect(named.isError, named.text).toBe(false);
  });

  // The filesystem root holds everything, so it is refused whether or not a home can be found to compare it with:
  // a bare container with no HOME and no account entry must not read `/` as fine for want of a home.
  it("refuses the filesystem root as the default even when no home directory can be found", async () => {
    await withHome(join(dir, "no-such-home"), async () => {
      vi.spyOn(process, "cwd").mockReturnValue("/");
      setRoot(undefined);
      const out = await upload({ path: file("n.md", "x"), key: "k" });
      expect(out.isError).toBe(true);
      expect(out.text).toBe(`Error: ${containsHomeMessage("/")}`);
      await sentNothing();
    });
  });

  // `os.homedir()` follows HOME, which is how this stands a home up in a temp directory instead of touching the real
  // one. It is a link to the working directory, so the two are the same directory by different paths and only a
  // check that resolves both sides sees it. Naming the home directory is saying so on purpose.
  it("refuses the working-directory default when it is the home directory, and takes the home directory when it is named", async () => {
    const home = join(outside, "home");
    symlinkSync(dir, home);
    await withHome(home, async () => {
      vi.spyOn(process, "cwd").mockReturnValue(dir);
      const path = file("notes.md", "# notes\n");
      for (const value of [undefined, ""]) {
        setRoot(value);
        const out = await upload({ path, key: "k" });
        expect(out.isError, JSON.stringify(value)).toBe(true);
        expect(out.text, JSON.stringify(value)).toBe(`Error: ${containsHomeMessage(dir)}`);
        await sentNothing();
      }
      setRoot(home);
      const named = await upload({ path, key: "k" });
      expect(named.isError, named.text).toBe(false);
    });
  });

  // Above the home directory is as much a place to refuse as the home directory is: `/Users` holds every account's
  // home. The prefix has to end at a separator, or a directory whose name only begins like the home's would be
  // refused with it, and the one beside the home here, `m` next to `me`, is there for that.
  it("refuses the working-directory default when it is above the home directory, however far, and not one that only looks like it", async () => {
    const top = join(outside, "top");
    const home = join(top, "people", "me");
    const lookalike = join(top, "people", "m");
    mkdirSync(home, { recursive: true });
    mkdirSync(lookalike);
    writeFileSync(join(lookalike, "n.md"), "# notes\n");
    await withHome(home, async () => {
      const cwd = vi.spyOn(process, "cwd");
      setRoot(undefined);
      for (const above of [join(top, "people"), top]) {
        cwd.mockReturnValue(above);
        const out = await upload({ path: join(lookalike, "n.md"), key: "k" });
        expect(out.isError, above).toBe(true);
        expect(out.text, above).toBe(`Error: ${containsHomeMessage(above)}`);
        await sentNothing();
      }
      // The control: a directory that is not above the home, though its name is the start of the home's, is a root.
      cwd.mockReturnValue(lookalike);
      const beside = await upload({ path: join(lookalike, "n.md"), key: "k" });
      expect(beside.isError, beside.text).toBe(false);
    });
  });

  // On a disk that ignores case, a home reached in another case is still the home directory. The plain realpath
  // keeps the case it is given, so a guard built on it would let that through; the native one reports what the disk
  // holds. A case-sensitive disk has no such path, and the test says so and stops.
  it("refuses the home directory reached in another case, on a disk that ignores case", async (context) => {
    const shouted = dir.toUpperCase();
    context.skip(!existsSync(shouted), "this disk is case-sensitive");
    await withHome(dir, async () => {
      vi.spyOn(process, "cwd").mockReturnValue(shouted);
      setRoot(undefined);
      const out = await upload({ path: file("notes.md", "# notes\n"), key: "k" });
      expect(out.isError).toBe(true);
      expect(out.text).toBe(`Error: ${containsHomeMessage(shouted)}`);
      await sentNothing();
    });
  });
});

describe("the local half", () => {
  it("types a file from its extension, case-insensitively, and falls back to an octet-stream", () => {
    expect(typeFromExtension("/a/b/photo.JPG")).toBe("image/jpeg");
    expect(typeFromExtension("deck.pdf")).toBe("application/pdf");
    expect(typeFromExtension("notes.md")).toBe("text/markdown");
    expect(typeFromExtension("page.html")).toBe("text/html");
    expect(typeFromExtension("diagram.svg")).toBe("image/svg+xml");
    expect(typeFromExtension("archive.tar.gz")).toBe("application/octet-stream");
    expect(typeFromExtension("Makefile")).toBe("application/octet-stream");
  });

  it("reads a regular file through one descriptor and refuses everything else", () => {
    const path = join(dir, "r.txt");
    writeFileSync(path, "regular");
    expect(readLocalFile(path, dir).bytes.toString()).toBe("regular");
    // The root itself is covered (so what is refused here is the kind of thing it is), and what is not there is not read.
    expect(() => readLocalFile(dir, dir)).toThrow(/not a regular file/);
    expect(() => readLocalFile(join(dir, "nope"), dir)).toThrow(/could not be read/);
  });
});
