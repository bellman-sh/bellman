# Surface Blobs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give a room's surface a home for bytes — documents and images in an R2 bucket keyed by room, uploaded and downloaded through two HTTP routes under membership and the `write_surface` verb, referenced by two new item kinds, `file` and `image`, and uploaded from Claude Code in one call with the bridge's `bellman_upload`.

**Architecture:** Bytes live in R2 under `rooms/<sessionId>/<blobId>` with the object's own metadata as the metadata; nothing in the room object describes a blob. The room's byte ceiling is stamped on its record at creation from the creator's plan, as `maxMembers` is, and the charge reads it there. The bucket sits behind a seam, `BlobStore` (`src/blobs.ts`, runtime-free), with `MemoryBlobStore` for tests and `R2BlobStore` (`src/blobs-r2.ts`, Workers-only) for production, the split the store already has. The upload route puts the object and then charges the room's `blobBytes` in one `SessionDO` transaction, deleting the object on a refused charge; the download route serves bytes under membership, never as HTML. A `file` or `image` item names a blob id, and `writeSurface` copies the object's metadata onto the item from a `head`. The bridge reads a local file, posts it with the bearer it already holds, then calls the upstream `bellman_send`.

**Tech Stack:** TypeScript, zod 4, vitest (two programs: `tests/` over `MemoryStore` and `MemoryBlobStore`, `worker-tests/` over `DurableObjectStore` and `R2BlobStore` in workerd), Cloudflare Workers, Durable Objects (SQLite-backed), R2.

**Spec:** `docs/superpowers/specs/2026-10-06-surface-blobs-design.md`. The plan argues from it; read both. Piece 1's plan, `docs/superpowers/plans/2026-10-06-working-surface.md`, is the model for every task's shape and for the write path these kinds slot into.

**Where this plan departs from the spec's text**, each with its reason in the task that makes it: (1) `BlobStore.put` takes `BlobPut`, the metadata without `etag`, because the store sets the etag and a caller cannot supply it (Task 1); (2) `get` answers `{ unchanged: true, etag }` for a precondition that held, not the bare `"unchanged"`, because a 304 must carry the ETag (Task 1); (3) the image allowlist, the signatures and the name rules live in `src/blobs.ts`, and the head and the metadata copy in `writeSurface` (`src/rooms.ts`), where piece 1 put the write — the spec's Files table says `src/surface.ts` and `src/tools/send.ts` (Tasks 1 and 4); (4) a charge refused for a room that no longer exists answers 404, and a body that does not match its `Content-Length` answers 400, neither of which D2 or D3 names (Task 6); (5) a name over 200 characters after stripping is refused, not truncated (Task 1). Nothing else differs.

## Global Constraints

- **Commit signed, in this worktree, with git:** `git -c commit.gpgsign=true commit -S -m "..."`. `main`'s ruleset rejects unsigned commits, so the flags say so on the command line whatever the config holds (today only the global config sets `gpgsign`). If the commit dies with `1Password: failed to fill whole buffer`, the agent is locked: report it, hand the human the command to run with `!`, never pass `--no-gpg-sign`.
- **Never `git commit -a` and never stage `CLAUDE.md`:** a wrapper appends a Dual-Graph block to it at session start; it belongs to no commit.
- **Commit subjects are sentences**, the way `git log` reads: "Give a room's bytes a bucket", not "feat: r2".
- **A pre-tool gate in this environment may refuse a first Bash command or a new-file Write until facts are stated.** State the request in one sentence and what the command verifies or produces, then retry the same command. It is a gate, not a failure.
- **Two test programs.** Nothing new under `tests/` may import `src/store-do.ts`, `src/worker.ts`, `src/oauth/store.ts` or the new `src/blobs-r2.ts`: two existing files (`tests/store-do-wiring.test.ts`, `tests/worker-ws.test.ts`) do, behind a `vi.mock("cloudflare:workers")` stub and outside the Node typecheck, and a third is not wanted. `npm test` runs the root program; `npm run test:worker` runs `worker-tests/` in workerd and installs its own dependencies on first run (slow; run it where the plan says, not after every step).
- **`npm run verify`** is typecheck, worker typecheck, build, test and worker tests. It is the last step of the last task, and nothing lands on `main` without it.
- **A task that leaves a program red says so and names the task that clears it.** Between Task 4 and Task 7, and only then, `npm run typecheck:worker` names exactly one error, `src/worker.ts` calling `buildServer` with two arguments; Task 7 clears it. `npm run typecheck`, `npm run build` and `npm test` are green at the end of every task.
- **Bounds, verbatim from the spec, every one a `ponytail:` constant:** `MAX_BLOB_BYTES` = 25 MB per file (`25 * 1024 * 1024`); `blobBytesPerRoom` = 50 MB on `free`, 500 MB on `pro`, 5 GB on `team`; `MAX_BLOB_NAME_CHARS` = 200; the image allowlist is exactly `image/png`, `image/jpeg`, `image/gif`, `image/webp`; the key is `rooms/<sessionId>/<blobId>` with `blobId` sixteen random bytes as hex; a download is `Cache-Control: private, max-age=300`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: sandbox`, always.
- **zod 4's `.max()` counts code points.** Every byte-ish bound is a `.length` refine (`boundedText` in `src/surface.ts`); the name bound here is `.length` too, so one unit is used everywhere.
- **Runtime-free modules:** `src/surface.ts`, `src/projections.ts`, `src/rooms.ts`, and now `src/blobs.ts` and `src/http/rooms.ts`, import neither `@modelcontextprotocol/sdk` nor `cloudflare:workers`, directly or transitively. `tests/projections.test.ts` walks the graph from each root and fails otherwise. `src/blobs-r2.ts` is Workers-only and joins the `exclude` list in `tsconfig.json` beside `src/store-do.ts`.
- **The route's caller is composed, not simplified.** `roomCaller` in `src/worker.ts` is `resolveCaller` (an access token, then the `BELLMAN_KEYS` map) and then the authorization server's `caller` (the panel cookie). A `BELLMAN_KEY` bearer never reaches `caller`, so "use the `caller` seam" on its own would lock every bridge out of the routes; and a bearer that is present and bad must not fall through to a cookie. Keep both halves.
- **The quota ceiling is the room's.** `Session.blobBytesCeiling` is stamped by `bellman_start` from the creator's plan, as `maxMembers` and `expiresAt` are, and the upload route and `chargeBlobBytes` read it off the record; no route ever consults a plan. A room written before the field reads the free plan's ceiling.
- **Nothing in a store branches on an event's type**, and **an idempotent replay applies no surface write.** The blob metadata rides the item the caller hands the store; the store never asks what a `file` is.
- **Peer content is untrusted, everywhere.** A blob's `name` and `type` are a member's words and are stored as labels; the download route serves nothing as `text/html`, and the item carries the server's record of the object, never the writer's claim.
- **A room holds many members.** Say *members*, *the room*, *peers* — never "two sessions" or "the other session" — in every comment, docblock, commit message and document this plan produces.
- **Every new assertion is run against a broken implementation before it is trusted**, with the red output quoted in the step, and **every check has a positive control.** Where a step says "break it to see the control", that is the control, not ceremony.
- **The description a tool ships is its only documentation.** `tests/tools/surface.test.ts` pins that every send kind is named in `bellman_send`'s description and that the server's tool count stays nine; `tests/extension.test.ts` pins the bundle's list against the bridge's real surface.

## Review Focus

Five inputs the spec implies and no test in the spec's own list exercises. Each has its test in the task named; the one thing no test can see, in item 2, has a check that fails.

1. **A body shorter than its `Content-Length`** — a client that died mid-body, or lied. No object may remain and nothing may be charged. Both stores refuse it with `BlobLengthError` and nothing stored: `exactLength` is the one place the rule lives, `readExactly` reads through it for the in-memory store and `R2BlobStore` pipes through it into R2's `FixedLengthStream` (Task 1, the contract's "refuses a body whose length is not the declared one", which Task 5 runs in workerd). The route maps that one class to 400 and charges nothing (Task 6, "stores and charges nothing for a body that ends short"). The route reads only the class, so the contract is what makes the 400 hold over R2.
2. **The Worker's own wiring** — the real `BLOBS` binding, the real `SessionDO` charge, and a key-map bearer resolved through `roomCaller` each have a request through the real `fetch` in Task 7, `worker-tests/blobs-route.test.ts` (`worker-tests/panel-wiring.test.ts` exists because a line exactly like these was once absent with every test green). The fourth input, `/rooms/` dispatched ahead of the OAuth routes, no request can see: `handleOAuth` has no `/rooms/` branch and answers `undefined`. Task 7 Step 6 and Task 10 Step 2 guard its order with a line-number check that fails when the order is wrong.
3. **A `file` item sent back as it was read** — `blob: { id, bytes, type, name }` is refused by name for `bytes`, the server's field; stripped to `{ id }` it is accepted and the row keeps the object's metadata; `blob: null` on a text item is accepted. zod reports a nested issue before a top-level one and the refusal names only the first, so Task 4's "reads a file item back with its blob, and accepts it back once the server's fields are stripped" asserts each step's first issue by its path (`blob: `, which the refusal's own prefix `blob? }` does not contain) and by the key it names.
4. **A `name` that is a path, carries control characters, or is Unicode with spaces and parentheses** — stored as a label, sent back RFC 8187-encoded in `Content-Disposition`; empty or over 200 characters after stripping is 400. Task 1 (`sanitizeName`, `attachmentDisposition`) and Task 6 ("treats the name as a label").
5. **An upload that succeeded whose placement is refused** — a `.png` that is not a PNG is stored as `application/octet-stream`, so the bridge's `image` default is refused by the server; the error must carry the blob id, bytes and type so the caller places it as a `file` without uploading (and being charged) twice. Task 8, "reports a refused placement with the blob it uploaded".

---

### Task 1: The blob seam — `src/blobs.ts`, its pure rules, `MemoryBlobStore`, and the contract

**Files:**
- Create: `src/blobs.ts`
- Create: `tests/helpers/blob-bytes.ts`
- Create: `tests/blobs.test.ts`
- Create: `tests/helpers/blob-store-contract.ts`
- Create: `tests/blob-store.test.ts`

**Interfaces:**
- Produces: `MAX_BLOB_BYTES`, `MAX_BLOB_NAME_CHARS`, `OCTET_STREAM`, `IMAGE_TYPES`, `isImageType`, `SNIFF_BYTES`, `sniffImageType(head: Uint8Array): ImageType | null`, `normalizeMediaType(claimed: string | null): string`, `storedType(claimed: string | null, head: Uint8Array): string`, `sanitizeName(raw: string | null): string | null`, `attachmentDisposition(name: string): string`, `newBlobId(): string`, `BLOB_ID` (regex), `isBlobId(id)`, `blobKey(sessionId, id)`, `blobBytesUsed(s: StoredSession): number`, `readHead(body, n): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }>`, `exactLength(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array>`, `readExactly(body, expected): Promise<Uint8Array>`, `class BlobLengthError`.
- Produces: in `tests/helpers/blob-bytes.ts`, the byte fixtures every blob test shares — `text(s): Uint8Array<ArrayBuffer>`, `stream(data, chunk = 4): ReadableStream<Uint8Array>`, `drain(body): Promise<Uint8Array>` and `PNG` (a 16-byte PNG header, `Uint8Array<ArrayBuffer>`). Tasks 4, 6 and 8 import them and declare none of their own.
- Produces: `interface BlobMeta { bytes; type; name; by; at; etag }`, `interface BlobObject extends BlobMeta { body: ReadableStream<Uint8Array> }`, `type BlobPut = Omit<BlobMeta, "etag">`, `type BlobRead = BlobObject | { unchanged: true; etag: string } | null`, `interface BlobStore { put(sessionId, id, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void>; head(sessionId, id): Promise<BlobMeta | null>; get(sessionId, id, ifNoneMatch?: string): Promise<BlobRead>; delete(sessionId, id): Promise<void> }`, `class MemoryBlobStore implements BlobStore`.
- Produces: `describeBlobStoreContract(name: string, makeStore: () => BlobStore): void` in `tests/helpers/blob-store-contract.ts`.
- Consumes: `StoredSession` (type only) from `src/stored-session.ts`. `blobBytes?` arrives on it in Task 2; until then `blobBytesUsed` reads through the cast shown below, which Task 2 removes.

Three rulings, stated once here. The spec's `put` takes a `BlobMeta` that includes `etag`; the store is what sets an etag, so `put` takes `Omit<BlobMeta, "etag">`. The spec's `get` answers the bare string `"unchanged"`; a 304 must carry the ETag (RFC 9110 §15.4.5 lists it among the fields a 304 MUST generate), so `get` answers `{ unchanged: true, etag }` instead — the same information R2 hands back when a precondition fails. And the length rule exists once: `exactLength` wraps a body in a stream that errors with `BlobLengthError` the moment the body is known not to be `expected` bytes, a chunk that takes it past or an end that falls short. `readExactly` reads through it for `MemoryBlobStore`, and Task 5's `R2BlobStore` pipes through it into R2's `FixedLengthStream`, so both stores refuse the same bodies with the same class — the only thing the route maps to 400.

- [ ] **Step 1: Write the failing tests for the pure rules**

First the byte fixtures every blob test shares. Create `tests/helpers/blob-bytes.ts`:

```ts
/**
 * Byte fixtures for the blob tests (#183): declared once, here, so the root
 * program's tests, the contract that workerd also runs, and the route and bridge
 * tests all read the same bytes.
 */
export const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

/** A body in chunks of `chunk` bytes, the way a request body arrives. */
export const stream = (data: Uint8Array, chunk = 4): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.byteLength; i += chunk) c.enqueue(data.subarray(i, i + chunk));
      c.close();
    },
  });

export const drain = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(body).arrayBuffer());

/** The PNG signature, then an IHDR chunk's length and name: enough to be sniffed as a PNG. */
export const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
```

Then create `tests/blobs.test.ts`:

```ts
/**
 * The pure rules of a blob (#183): the id and the key, the image allowlist and
 * the signatures behind it, how a claimed type becomes a stored one, the name
 * as a label, and the three stream helpers the route and the stores lean on. The
 * stores and the routes are tested elsewhere; this is the part both ends must
 * agree on.
 */
import { describe, it, expect } from "vitest";
import {
  BLOB_ID, IMAGE_TYPES, MAX_BLOB_BYTES, MAX_BLOB_NAME_CHARS, OCTET_STREAM, SNIFF_BYTES,
  BlobLengthError, attachmentDisposition, blobBytesUsed, blobKey, exactLength, isBlobId,
  newBlobId, normalizeMediaType, readExactly, readHead, sanitizeName, sniffImageType, storedType,
} from "../src/blobs.js";
import { PNG, drain, stream, text } from "./helpers/blob-bytes.js";

const bytes = (...b: number[]) => new Uint8Array(b);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1);
const GIF = text("GIF89a......");
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);

describe("the bounds", () => {
  it("are the spec's numbers", () => {
    expect(MAX_BLOB_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_BLOB_NAME_CHARS).toBe(200);
    expect([...IMAGE_TYPES]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    expect(SNIFF_BYTES).toBe(12);
  });
});

describe("the id and the key", () => {
  it("mints 32 hex characters, fresh each time, and the key is the room's prefix", () => {
    const a = newBlobId();
    const b = newBlobId();
    expect(a).toMatch(BLOB_ID);
    expect(a).not.toBe(b);
    expect(isBlobId(a)).toBe(true);
    expect(blobKey("qs_1", a)).toBe(`rooms/qs_1/${a}`);
  });

  it.each(["", "ABCDEF0123456789ABCDEF0123456789", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "../x"])(
    "refuses %j as an id", (id) => {
      expect(isBlobId(id)).toBe(false);
    },
  );
});

describe("sniffImageType", () => {
  it("names the four by their first bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("names nothing for text, for a RIFF that is not WEBP, and for too few bytes", () => {
    expect(sniffImageType(text("<svg xmlns=..."))).toBeNull();
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull();
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull();
    expect(sniffImageType(bytes())).toBeNull();
  });
});

describe("storedType (D6)", () => {
  it("keeps an image claim only when the bytes agree", () => {
    expect(storedType("image/png", PNG)).toBe("image/png");
    expect(storedType("image/png", JPEG)).toBe(OCTET_STREAM);
    expect(storedType("image/png", text("not a png at all"))).toBe(OCTET_STREAM);
    expect(storedType("image/jpeg", JPEG)).toBe("image/jpeg");
    expect(storedType("image/svg+xml", text("<svg/>"))).toBe(OCTET_STREAM);
    expect(storedType("image/bmp", bytes(0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(OCTET_STREAM);
  });

  it("keeps a non-image claim as a normalised label, since the download never serves it", () => {
    expect(storedType("text/markdown; charset=utf-8", text("# hi"))).toBe("text/markdown");
    expect(storedType("Application/PDF", text("%PDF"))).toBe("application/pdf");
    expect(storedType("text/html", text("<!doctype html>"))).toBe("text/html");
  });

  it("falls back to an octet-stream for no claim, an empty one, a malformed one, or one too long", () => {
    expect(normalizeMediaType(null)).toBe(OCTET_STREAM);
    expect(normalizeMediaType("")).toBe(OCTET_STREAM);
    expect(normalizeMediaType("text")).toBe(OCTET_STREAM);
    expect(normalizeMediaType("text/plain/extra")).toBe(OCTET_STREAM);
    expect(normalizeMediaType("text/ plain")).toBe(OCTET_STREAM);
    expect(normalizeMediaType(`text/${"x".repeat(100)}`)).toBe(OCTET_STREAM);
  });
});

describe("sanitizeName (D6)", () => {
  it("keeps a plain name and trims it", () => {
    expect(sanitizeName("notes.md")).toBe("notes.md");
    expect(sanitizeName("  résumé (1).pdf ")).toBe("résumé (1).pdf");
  });

  // Review Focus 4: a path is a label here, never a path.
  it("strips path separators and control characters", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeName("C:\\Users\\me\\x.txt")).toBe("C:Usersmex.txt");
    expect(sanitizeName("a\u0000b\u001fc\u007fd.txt")).toBe("abcd.txt");
    expect(sanitizeName("line\nbreak.txt")).toBe("linebreak.txt");
  });

  it("refuses an absent, empty or over-long name rather than inventing or truncating one", () => {
    expect(sanitizeName(null)).toBeNull();
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName("///")).toBeNull();
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName("n".repeat(MAX_BLOB_NAME_CHARS))).toBe("n".repeat(MAX_BLOB_NAME_CHARS));
    expect(sanitizeName("n".repeat(MAX_BLOB_NAME_CHARS + 1))).toBeNull();
    // Code units, as every surface bound counts: 100 astral characters is 200 units.
    expect(sanitizeName("𝄞".repeat(100))).toBe("𝄞".repeat(100));
    expect(sanitizeName("𝄞".repeat(101))).toBeNull();
  });
});

describe("attachmentDisposition", () => {
  it("encodes the name as an RFC 8187 ext-value, including the characters encodeURIComponent leaves alone", () => {
    expect(attachmentDisposition("notes.md")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(attachmentDisposition("résumé (1).pdf")).toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf");
    expect(attachmentDisposition("it's*.txt")).toBe("attachment; filename*=UTF-8''it%27s%2A.txt");
  });
});

describe("blobBytesUsed", () => {
  it("reads 0 off a record that was never charged, and the number off one that was", () => {
    const record = { blobBytes: undefined } as unknown as Parameters<typeof blobBytesUsed>[0];
    // `blobBytes` is not on `StoredSession` until Task 2, so the charged record is asserted into shape.
    const charged = { ...record, blobBytes: 1234 } as typeof record;
    expect(blobBytesUsed(record)).toBe(0);
    expect(blobBytesUsed(charged)).toBe(1234);
  });
});

describe("readHead", () => {
  it("hands back the first n bytes and a stream that still carries all of them", async () => {
    const data = text("abcdefghijklmnopqrstuvwxyz");
    const { head, rest } = await readHead(stream(data, 5), 12);
    expect(new TextDecoder().decode(head)).toBe("abcdefghijkl");
    expect(await drain(rest)).toEqual(data);
  });

  it("hands back what there is when the body is shorter than n, and an empty head for an empty body", async () => {
    const short = await readHead(stream(text("abc")), 12);
    expect(new TextDecoder().decode(short.head)).toBe("abc");
    expect(await drain(short.rest)).toEqual(text("abc"));
    const empty = await readHead(stream(text("")), 12);
    expect(empty.head.byteLength).toBe(0);
    expect(await drain(empty.rest)).toEqual(text(""));
  });
});

describe("readExactly", () => {
  it("reads a stream or a buffer of exactly the declared length", async () => {
    expect(await readExactly(stream(text("hello")), 5)).toEqual(text("hello"));
    expect(await readExactly(text("hello").buffer as ArrayBuffer, 5)).toEqual(text("hello"));
  });

  // Review Focus 1: a body that ends short or runs long is refused, not stored short.
  it("refuses a body that ends short, and one that runs long", async () => {
    await expect(readExactly(stream(text("hell")), 5)).rejects.toBeInstanceOf(BlobLengthError);
    await expect(readExactly(stream(text("hello!")), 5)).rejects.toBeInstanceOf(BlobLengthError);
    await expect(readExactly(text("hello!").buffer as ArrayBuffer, 5)).rejects.toBeInstanceOf(BlobLengthError);
  });
});

// The rule once, for both stores: readExactly reads through it, and R2BlobStore (Task 5) pipes through it.
describe("exactLength", () => {
  it("hands every chunk through unchanged when the body is the declared length", async () => {
    const data = text("exactly this");
    expect(await drain(exactLength(stream(data, 5), data.byteLength))).toEqual(data);
  });

  it("errors with BlobLengthError, naming both numbers, when the body ends short and when it runs long", async () => {
    const short = drain(exactLength(stream(text("hell")), 5));
    await expect(short).rejects.toBeInstanceOf(BlobLengthError);
    await expect(short).rejects.toMatchObject({ expected: 5, got: 4 });
    const long = drain(exactLength(stream(text("hello!")), 5));
    await expect(long).rejects.toMatchObject({ expected: 5, got: 6 });
  });

  it("takes an empty body for zero bytes and refuses it for any more", async () => {
    expect(await drain(exactLength(stream(text("")), 0))).toEqual(text(""));
    await expect(drain(exactLength(stream(text("")), 1))).rejects.toBeInstanceOf(BlobLengthError);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/blobs.test.ts`
Expected: FAIL — `Cannot find module '../src/blobs.js'`.

- [ ] **Step 3: Create `src/blobs.ts`**

```ts
/**
 * Blobs on the working surface (#183): the storage seam a room's bytes go
 * through, and the pure rules both ends of it apply — the key, the id, the image
 * allowlist and the signatures behind it, the name a blob is labelled with, the
 * bounds, and the three stream helpers the upload route and the stores need.
 *
 * Runtime-free — no MCP SDK, no `cloudflare:workers` — because the routes, the
 * tool handlers and both test programs import it. `blobs-r2.ts` is the Workers
 * half, and the only file that touches a bucket.
 */
import type { StoredSession } from "./stored-session.js";

// ponytail: ceilings, not tuned. 25 MB is a quarter of the zone's 100 MB request
// bound; a cap raised past it is a different route (multipart), not a bigger
// number. 200 characters of name is a label, never a path.
export const MAX_BLOB_BYTES = 25 * 1024 * 1024;
export const MAX_BLOB_NAME_CHARS = 200;

/** What a blob is stored as when its claimed type is not one the server stands behind. */
export const OCTET_STREAM = "application/octet-stream";

/**
 * The image types a download is served as (spec D4) and an `image` item may
 * reference (D5). SVG is deliberately absent: it is scriptable, and a type on
 * this list is served inline.
 */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const isImageType = (type: string): type is ImageType =>
  (IMAGE_TYPES as readonly string[]).includes(type);

/** How many leading bytes `sniffImageType` needs: WebP's marker ends at byte 12. */
export const SNIFF_BYTES = 12;

/**
 * The type the first bytes say, or null when they say none of the four (D6).
 * PNG and GIF are a fixed prefix; JPEG is the SOI marker; WebP is RIFF, a
 * length, then WEBP. A short head fails every comparison, which is a null.
 */
export function sniffImageType(head: Uint8Array): ImageType | null {
  const at = (i: number, ...expected: number[]) => expected.every((b, j) => head[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

// ponytail: 100 characters of media type; RFC 6838 allows 127 a side and nobody sends it.
const MAX_MEDIA_TYPE_CHARS = 100;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

/** `type/subtype`, lower-cased, parameters dropped; an octet-stream for anything else. */
export function normalizeMediaType(claimed: string | null): string {
  const bare = (claimed ?? "").split(";")[0].trim().toLowerCase();
  return bare.length > 0 && bare.length <= MAX_MEDIA_TYPE_CHARS && MEDIA_TYPE.test(bare)
    ? bare
    : OCTET_STREAM;
}

/**
 * The type a blob is stored with (D6): the server's word, never the client's.
 *
 * An image claim is held to the bytes: kept only when it is on the allowlist
 * AND the signature agrees, and otherwise stored as an octet-stream — a body
 * that is not a PNG is not served as one, whatever its header said. Any other
 * claim is kept as a normalised label, because the download route never serves
 * it as a Content-Type anyway (D4): it is for a reader choosing an icon, and for
 * piece 4 to know an artifact is HTML.
 */
export function storedType(claimed: string | null, head: Uint8Array): string {
  const type = normalizeMediaType(claimed);
  if (!type.startsWith("image/")) return type;
  return isImageType(type) && sniffImageType(head) === type ? type : OCTET_STREAM;
}

/**
 * A name as it is stored and later sent back in Content-Disposition (D6): a
 * label, never a path. Path separators and control characters are stripped and
 * the rest trimmed; what is left must be 1 to 200 code units (`.length`, the
 * unit every surface bound uses), or the name is refused — null, for the route
 * to answer 400, rather than truncated or invented.
 */
export function sanitizeName(raw: string | null): string | null {
  if (raw === null) return null;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\\/\u0000-\u001f\u007f]/g, "").trim();
  return name.length >= 1 && name.length <= MAX_BLOB_NAME_CHARS ? name : null;
}

/**
 * RFC 8187 ext-value. `encodeURIComponent` leaves `!'()*` alone, and of those
 * only `!` is an attr-char, so the other four are encoded by hand.
 */
const extValue = (s: string): string =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** The disposition every non-image download carries (D4). */
export const attachmentDisposition = (name: string): string =>
  `attachment; filename*=UTF-8''${extValue(name)}`;

// ponytail: 128 bits, not tuned. An id only has to be unguessable and fresh; the
// room's prefix, never the id, is what says whose a blob is.
/** Sixteen random bytes as hex (D1). */
export function newBlobId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const BLOB_ID = /^[a-f0-9]{32}$/;
export const isBlobId = (id: string): boolean => BLOB_ID.test(id);

/** The object key (D1). The prefix is the ownership: a room reads under its own and nothing else. */
export const blobKey = (sessionId: string, id: string): string => `rooms/${sessionId}/${id}`;

/**
 * The bytes charged to this room so far, 0 for a room never charged. The
 * Durable Objects store lifts the field to 0 in `hydrateStoredSession`; the
 * in-memory store does not hydrate, so this reads through `?? 0` as
 * `surfaceCursor` does.
 */
export const blobBytesUsed = (s: StoredSession): number =>
  (s as { blobBytes?: number }).blobBytes ?? 0;

/** The object's metadata, as the store reports it. `etag` is the store's own. */
export interface BlobMeta {
  bytes: number;
  type: string;
  name: string;
  /** The uploading member's handle. */
  by: string;
  at: number;
  /** Quoted, as an HTTP ETag is. */
  etag: string;
}

export interface BlobObject extends BlobMeta {
  body: ReadableStream<Uint8Array>;
}

/** What a put supplies: everything but the etag, which the store sets. */
export type BlobPut = Omit<BlobMeta, "etag">;

/** What a read answers: the object, a precondition that held, or nothing. */
export type BlobRead = BlobObject | { unchanged: true; etag: string } | null;

/**
 * The storage boundary for bytes (spec D5), keyed by room and id so a foreign
 * room's id resolves nowhere. Two implementations: `MemoryBlobStore` below for
 * tests and `npm start`, `R2BlobStore` in blobs-r2.ts for production. The
 * contract suite in tests/helpers/blob-store-contract.ts runs against both.
 */
export interface BlobStore {
  /**
   * Store `body` under this room and id. `meta.bytes` is the length the body
   * must have: a body that ends short or runs long is refused with a
   * `BlobLengthError` and nothing is stored, so an object that exists is exactly
   * as long as its metadata says — and the route, which maps that one class to
   * 400, can say so over either store.
   */
  put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void>;
  head(sessionId: string, id: string): Promise<BlobMeta | null>;
  /** With `ifNoneMatch`, the request's If-None-Match as sent; a match answers `{ unchanged, etag }`. */
  get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobRead>;
  /** Idempotent: deleting nothing is not an error. */
  delete(sessionId: string, id: string): Promise<void>;
}

/** A body whose length is not the one declared. The route answers 400 from it. */
export class BlobLengthError extends Error {
  constructor(readonly expected: number, readonly got: number) {
    super(`body did not match Content-Length: ${expected} bytes declared, ${got} received`);
  }
}

/**
 * Up to `n` leading bytes, and the body again with nothing missing. The route
 * reads a head to sniff an image claim (D6), then hands `rest` — every chunk
 * read so far, then the remainder — to the store, so nothing is buffered beyond
 * the first chunk the runtime delivered.
 */
export async function readHead(
  body: ReadableStream<Uint8Array>,
  n: number,
): Promise<{ head: Uint8Array; rest: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let have = 0;
  while (have < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    have += value.byteLength;
  }
  const joined = new Uint8Array(have);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  let replayed = false;
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!replayed) {
        replayed = true;
        if (joined.byteLength > 0) {
          controller.enqueue(joined);
          return;
        }
      }
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return { head: joined.subarray(0, n), rest };
}

/**
 * The body again, erroring with `BlobLengthError` the moment it is known not to
 * be `expected` bytes: when a chunk takes it past, and when it ends short. The
 * one place the length rule lives. `readExactly` reads through it for the
 * in-memory store, and `R2BlobStore` pipes it into R2's `FixedLengthStream`
 * (which gives R2 the length it needs, and which this runs ahead of), so both
 * stores refuse the same bodies with the same class and the route needs one
 * line to answer 400 for either.
 */
export function exactLength(body: ReadableStream<Uint8Array>, expected: number): ReadableStream<Uint8Array> {
  let received = 0;
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        received += chunk.byteLength;
        if (received > expected) throw new BlobLengthError(expected, received);
        controller.enqueue(chunk);
      },
      flush() {
        if (received !== expected) throw new BlobLengthError(expected, received);
      },
    }),
  );
}

/** The whole body, refusing one whose length is not `expected`. */
export async function readExactly(
  body: ReadableStream<Uint8Array> | ArrayBuffer,
  expected: number,
): Promise<Uint8Array> {
  if (body instanceof ArrayBuffer) {
    if (body.byteLength !== expected) throw new BlobLengthError(expected, body.byteLength);
    return new Uint8Array(body);
  }
  // `exactLength` guarantees the chunks add up to `expected`, so `out` never overflows
  // and a short body rejects here rather than coming back zero-padded.
  const out = new Uint8Array(expected);
  let filled = 0;
  const reader = exactLength(body, expected).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.set(value, filled);
    filled += value.byteLength;
  }
}

/** A quoted SHA-256 of the bytes: stable, comparable, and shaped like the ETag R2 reports. */
async function contentEtag(bytes: Uint8Array): Promise<string> {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return `"${[...digest].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** If-None-Match as HTTP reads it: `*`, or a list of tags, a weak one compared by value. */
function etagMatches(header: string, etag: string): boolean {
  if (header.trim() === "*") return true;
  const strip = (t: string) => t.trim().replace(/^W\//, "");
  return header.split(",").some((t) => strip(t) === strip(etag));
}

/**
 * The in-memory blob store. Bytes are copied on the way in and out, as
 * MemoryStore detaches what it hands back: a caller that kept its buffer must
 * not be able to rewrite what was stored.
 */
export class MemoryBlobStore implements BlobStore {
  private objects = new Map<string, { bytes: Uint8Array; meta: BlobMeta }>();

  async put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void> {
    const bytes = await readExactly(body, meta.bytes);
    const etag = await contentEtag(bytes);
    this.objects.set(blobKey(sessionId, id), { bytes: bytes.slice(), meta: { ...meta, etag } });
  }

  async head(sessionId: string, id: string): Promise<BlobMeta | null> {
    const object = this.objects.get(blobKey(sessionId, id));
    return object ? { ...object.meta } : null;
  }

  async get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobRead> {
    const object = this.objects.get(blobKey(sessionId, id));
    if (!object) return null;
    if (ifNoneMatch !== undefined && etagMatches(ifNoneMatch, object.meta.etag)) {
      return { unchanged: true, etag: object.meta.etag };
    }
    const copy = object.bytes.slice();
    return {
      ...object.meta,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(copy);
          controller.close();
        },
      }),
    };
  }

  async delete(sessionId: string, id: string): Promise<void> {
    this.objects.delete(blobKey(sessionId, id));
  }
}
```

- [ ] **Step 4: Run the pure-rule tests**

Run: `npx vitest run tests/blobs.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the contract**

Create `tests/helpers/blob-store-contract.ts`:

```ts
/**
 * Conformance suite for the BlobStore seam (#183). Every implementation passes
 * it identically: MemoryBlobStore under the root program (tests/blob-store.test.ts),
 * R2BlobStore inside workerd with a real R2 binding
 * (worker-tests/blob-store-contract.test.ts). A divergence between them shows up
 * here rather than in production.
 *
 * Every case uses a session id of its own, so isolation does not depend on the
 * worker pool's `reset()` emptying the bucket between cases.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { BlobLengthError, type BlobMeta, type BlobStore } from "../../src/blobs.js";
import { drain, stream, text } from "./blob-bytes.js";

const meta = (bytes: number, over: Partial<Omit<BlobMeta, "etag">> = {}) => ({
  bytes, type: "text/markdown", name: "notes.md", by: "m_creator", at: 1_700_000_000_000, ...over,
});

export function describeBlobStoreContract(name: string, makeStore: () => BlobStore): void {
  describe(`BlobStore contract: ${name}`, () => {
    let store: BlobStore;
    let sid: string;
    let n = 0;

    beforeEach(() => {
      store = makeStore();
      sid = `qs_blob_${Date.now().toString(36)}_${n++}`;
    });

    it("answers nothing for a blob never put", async () => {
      expect(await store.head(sid, "0123456789abcdef0123456789abcdef")).toBeNull();
      expect(await store.get(sid, "0123456789abcdef0123456789abcdef")).toBeNull();
    });

    it("put then head returns the metadata, with the store's own etag", async () => {
      await store.put(sid, "aa".repeat(16), stream(text("# notes\n")), meta(8));
      const head = await store.head(sid, "aa".repeat(16));
      expect(head).toMatchObject({ bytes: 8, type: "text/markdown", name: "notes.md", by: "m_creator", at: 1_700_000_000_000 });
      expect(head!.etag).toEqual(expect.any(String));
      expect(head!.etag.length).toBeGreaterThan(2);
    });

    it("get streams the bytes back with the same metadata", async () => {
      const data = text("0123456789abcdefghij");
      await store.put(sid, "bb".repeat(16), stream(data, 7), meta(20, { type: "application/pdf", name: "x.pdf" }));
      const head = (await store.head(sid, "bb".repeat(16)))!;
      const got = await store.get(sid, "bb".repeat(16));
      if (got === null || "unchanged" in got) throw new Error(`expected the object, got ${JSON.stringify(got)}`);
      expect(await drain(got.body)).toEqual(data);
      expect(got).toMatchObject({ bytes: 20, type: "application/pdf", name: "x.pdf", etag: head.etag });
    });

    it("stores an ArrayBuffer body like a stream", async () => {
      await store.put(sid, "cc".repeat(16), text("buffer").buffer as ArrayBuffer, meta(6));
      const got = await store.get(sid, "cc".repeat(16));
      if (got === null || "unchanged" in got) throw new Error("expected the object");
      expect(await drain(got.body)).toEqual(text("buffer"));
    });

    /** D1: the prefix is the ownership. */
    it("does not resolve a foreign room's id, for head, get or delete", async () => {
      await store.put(sid, "dd".repeat(16), stream(text("mine")), meta(4));
      expect(await store.head(`${sid}_other`, "dd".repeat(16))).toBeNull();
      expect(await store.get(`${sid}_other`, "dd".repeat(16))).toBeNull();
      await store.delete(`${sid}_other`, "dd".repeat(16));
      expect(await store.head(sid, "dd".repeat(16))).not.toBeNull();
    });

    it("delete then head is null, and deleting nothing is a no-op", async () => {
      await store.put(sid, "ee".repeat(16), stream(text("gone")), meta(4));
      await store.delete(sid, "ee".repeat(16));
      expect(await store.head(sid, "ee".repeat(16))).toBeNull();
      expect(await store.get(sid, "ee".repeat(16))).toBeNull();
      await store.delete(sid, "ee".repeat(16));
    });

    it("answers unchanged for the current etag, and the bytes for any other", async () => {
      await store.put(sid, "ff".repeat(16), stream(text("same")), meta(4));
      const { etag } = (await store.head(sid, "ff".repeat(16)))!;
      expect(await store.get(sid, "ff".repeat(16), etag)).toEqual({ unchanged: true, etag });
      const other = await store.get(sid, "ff".repeat(16), '"not-this-one"');
      if (other === null || "unchanged" in other) throw new Error("a non-matching tag must answer the object");
      expect(await drain(other.body)).toEqual(text("same"));
    });

    // Review Focus 1: an object that exists is exactly as long as its metadata says, and the
    // refusal is the one class the route maps to 400 — over R2 as over memory.
    it("refuses a body whose length is not the declared one, with BlobLengthError, and stores nothing", async () => {
      const refusal = async (id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, declared: number) => {
        const error = await store.put(sid, id, body, meta(declared)).then(() => null, (e: unknown) => e);
        expect(error, "the put must be refused").toBeInstanceOf(BlobLengthError);
        expect(error).toMatchObject({ expected: declared });
        expect(await store.head(sid, id), "and store nothing").toBeNull();
      };
      await refusal("11".repeat(16), stream(text("short")), 10);
      await refusal("22".repeat(16), stream(text("too long")), 3);
      await refusal("33".repeat(16), text("buf").buffer as ArrayBuffer, 4);
    });

    it("replaces an object put again under the same id", async () => {
      await store.put(sid, "44".repeat(16), stream(text("one")), meta(3));
      await store.put(sid, "44".repeat(16), stream(text("two!")), meta(4, { name: "two.txt" }));
      expect(await store.head(sid, "44".repeat(16))).toMatchObject({ bytes: 4, name: "two.txt" });
    });
  });
}
```

Create `tests/blob-store.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { MemoryBlobStore } from "../src/blobs.js";
import { text } from "./helpers/blob-bytes.js";
import { describeBlobStoreContract } from "./helpers/blob-store-contract.js";

describeBlobStoreContract("MemoryBlobStore", () => new MemoryBlobStore());

// What the contract leaves to each store: R2 decides its own weak and list comparison, so only
// this store's is pinned here, as RFC 9110 reads If-None-Match.
describe("MemoryBlobStore: If-None-Match as HTTP reads it", () => {
  const id = "aa".repeat(16);
  const stored = async () => {
    const store = new MemoryBlobStore();
    await store.put("qs_etag", id, text("same").buffer, { bytes: 4, type: "text/plain", name: "s.txt", by: "m_creator", at: 1 });
    return { store, etag: (await store.head("qs_etag", id))!.etag };
  };

  it("answers unchanged for *, for a weak copy of the tag, and for a list that holds it", async () => {
    const { store, etag } = await stored();
    for (const header of ["*", `W/${etag}`, `"nope", ${etag}`, ` ${etag} `]) {
      expect(await store.get("qs_etag", id, header), header).toEqual({ unchanged: true, etag });
    }
  });

  it("answers the object for a list that does not hold it", async () => {
    const { store } = await stored();
    expect(await store.get("qs_etag", id, '"nope", W/"also-not"')).toMatchObject({ bytes: 4, type: "text/plain" });
  });
});
```

- [ ] **Step 6: Run the contract over the memory store**

Run: `npx vitest run tests/blob-store.test.ts && npm run typecheck`
Expected: PASS — the nine contract cases and the memory store's own two; the typecheck is clean.

- [ ] **Step 7: Break each rule once to see the controls**

In `exactLength`'s `flush`, change `if (received !== expected) throw new BlobLengthError(expected, received);` to `if (false) throw new BlobLengthError(expected, received);`. Run `npx vitest run tests/blob-store.test.ts tests/blobs.test.ts`: the contract's "refuses a body whose length is not the declared one" goes red on its first `refusal` with `the put must be refused: expected null to be an instance of BlobLengthError` (the short body was zero-padded and stored), and `exactLength`'s "errors with BlobLengthError…" and `readExactly`'s "refuses a body that ends short" go red because the promise resolves instead of rejecting. Restore.

In `exactLength`'s `transform`, change `if (received > expected) throw new BlobLengthError(expected, received);` to `if (false) throw new BlobLengthError(expected, received);`. Run the same two files: `readExactly`'s "refuses a body that ends short, and one that runs long" and the contract's refusal of `"too long"` go red, because a chunk past the end now reaches `out.set` and the rejection is a `RangeError` where `BlobLengthError` is expected. Restore.

In `etagMatches`, make `strip` the identity (`(t) => t.trim()`). Run `npx vitest run tests/blob-store.test.ts`: "answers unchanged for *, for a weak copy of the tag, and for a list that holds it" goes red naming the `W/"…"` header, the store answering the object where `{ unchanged: true, etag }` was expected. Restore.

Then the rest of the file, one break at a time, each restored before the next, each run with `npx vitest run tests/blobs.test.ts tests/blob-store.test.ts`. Every rule in this file has a break below. What has none needs none: "the bounds" compares a literal with a literal, and "answers nothing for a blob never put" is the baseline that every other case's put-then-find is the positive control for. Where a red output carries a random id or a long string it is abbreviated.

| In `src/blobs.ts`, change | Goes red | First red expectation |
|---|---|---|
| `sniffImageType`: the PNG line's `0x89` to `0x88` | "names the four by their first bytes"; `storedType`'s "keeps an image claim only when the bytes agree" | `expected null to be 'image/png'`; `expected 'application/octet-stream' to be 'image/png'` |
| `sniffImageType`: delete `&& at(8, 0x57, 0x45, 0x42, 0x50)` | "names nothing for text, for a RIFF that is not WEBP, and for too few bytes" | `expected 'image/webp' to be null` |
| `storedType`: the last line becomes `return isImageType(type) ? type : OCTET_STREAM;` | "keeps an image claim only when the bytes agree" | `expected 'image/png' to be 'application/octet-stream'` |
| `normalizeMediaType`: `.split(";")[0].trim()` to `.trim()` | "keeps a non-image claim as a normalised label" | `expected 'application/octet-stream' to be 'text/markdown'` |
| `normalizeMediaType`: delete `bare.length <= MAX_MEDIA_TYPE_CHARS &&` | "falls back to an octet-stream for no claim, an empty one, a malformed one, or one too long" | its last expectation: the 105-character type comes back where the octet-stream was expected |
| `sanitizeName`: `/[\\/\u0000-\u001f\u007f]/g` to `/[\u0000-\u001f\u007f]/g` | "strips path separators and control characters" | `expected '../../etc/passwd' to be '....etcpasswd'` |
| `sanitizeName`: delete `.trim()` | "keeps a plain name and trims it" | `expected '  résumé (1).pdf ' to be 'résumé (1).pdf'` |
| `sanitizeName`: `name.length <= MAX_BLOB_NAME_CHARS` to `name.length < MAX_BLOB_NAME_CHARS` | "refuses an absent, empty or over-long name rather than inventing or truncating one" | the 200-character name comes back `null` where it was expected whole |
| `attachmentDisposition`'s `extValue`: `/['()*]/g` to `/['()]/g` | "encodes the name as an RFC 8187 ext-value…" | its third expectation: `…it%27s*.txt` where `…it%27s%2A.txt` was expected |
| `BLOB_ID`: `/^[a-f0-9]{32}$/` to `/[a-f0-9]{32}/` | `refuses "0123456789abcdef0123456789abcdef0" as an id` | `expected true to be false` |
| `blobKey`: `` `rooms/${sessionId}/${id}` `` to `` `rooms/${id}` `` | "mints 32 hex characters, fresh each time, and the key is the room's prefix"; the contract's "does not resolve a foreign room's id, for head, get or delete" | `expected 'rooms/3f9a…' to be 'rooms/qs_1/3f9a…'`; `expected { bytes: 4, … } to be null` |
| `newBlobId`: `crypto.getRandomValues(new Uint8Array(16))` to `new Uint8Array(16)` | "mints 32 hex characters, fresh each time, and the key is the room's prefix" | `expected '00000000000000000000000000000000' not to be '00000000000000000000000000000000'` |
| `blobBytesUsed`: `?? 0` to `?? 1` | "reads 0 off a record that was never charged, and the number off one that was" | `expected 1 to be 0` |
| `readHead`: `joined.subarray(0, n)` to `joined` | "hands back the first n bytes and a stream that still carries all of them" | `expected 'abcdefghijklmno' to be 'abcdefghijkl'` |
| `readHead`: `if (joined.byteLength > 0) {` to `if (false) {` | the same test, and "hands back what there is when the body is shorter than n, and an empty head for an empty body" | the replay drops the head's chunks, so `rest` carries 11 bytes where 26 went in: a `toEqual` mismatch of two `Uint8Array`s |
| `MemoryBlobStore.put`: `meta: { ...meta, etag }` to `meta: { ...meta, bytes: 0, etag }` | "put then head returns the metadata, with the store's own etag"; "get streams the bytes back with the same metadata" | `expected { bytes: 0, … } to match object { bytes: 8, type: 'text/markdown', … }` |
| `MemoryBlobStore.get`: `controller.enqueue(copy);` to `controller.enqueue(new Uint8Array(copy.byteLength));` | "get streams the bytes back with the same metadata"; "stores an ArrayBuffer body like a stream" | a `toEqual` mismatch: the bytes come back zeroed |
| `MemoryBlobStore.delete`: the `this.objects.delete(…)` line to `void blobKey(sessionId, id);` | "delete then head is null, and deleting nothing is a no-op" | `expected { bytes: 4, … } to be null` |
| `MemoryBlobStore.get`: the `if (ifNoneMatch !== undefined && etagMatches(…)) {` line to `if (false) {` | "answers unchanged for the current etag, and the bytes for any other", and the memory store's tag cases | the object where `{ unchanged: true, etag }` was expected |
| `MemoryBlobStore.put`: prefix the `this.objects.set(…` line with `if (!this.objects.has(blobKey(sessionId, id)))` | "replaces an object put again under the same id" | `expected { bytes: 3, … } to match object { bytes: 4, name: 'two.txt' }` |

- [ ] **Step 8: Commit**

```bash
git add src/blobs.ts tests/helpers/blob-bytes.ts tests/blobs.test.ts tests/helpers/blob-store-contract.ts tests/blob-store.test.ts
git -c commit.gpgsign=true commit -S -m "Give a room's bytes a seam: the blob store contract, its pure rules, and the in-memory store"
```

---

### Task 2: The schema — `BlobRef`, the item's `blob`, the quota, the record's `blobBytes`, and the shape that accepts `blob`

**Files:**
- Modify: `src/types.ts` (`BlobRef`, `SurfaceKind`, `SurfaceItem.blob`, `Entitlements.blobBytesPerRoom`)
- Modify: `src/auth.ts` (`ENTITLEMENTS`)
- Modify: `src/tools/start.ts` (the ceiling stamped at creation)
- Modify: `src/stored-session.ts` (`StoredSession.blobBytes`, `hydrateStoredSession`)
- Modify: `tests/helpers/fixtures.ts` (`session()`)
- Modify: `src/blobs.ts` (`blobBytesUsed` loses its cast)
- Modify: `src/projections.ts` (`surfaceItem`)
- Modify: `src/surface.ts` (`SURFACE_KINDS`, `SurfaceItemShape.blob`, the rule, the normalised item)
- Modify: `tests/auth.test.ts`, `tests/stored-session.test.ts`, `tests/working-surface.test.ts`, `tests/helpers/store-contract.ts`, `tests/tools/working-surface.test.ts`

**Interfaces:**
- Produces: `BlobRef { id; bytes; type; name }`; `SurfaceKind` += `"file" | "image"`; `SurfaceItem.blob: BlobRef | null`; `Entitlements.blobBytesPerRoom: number` (50 MB / 500 MB / 5 GB); `StoredSession.blobBytes?: number`, lifted to `0`.
- Produces: `Session.blobBytesCeiling: number` — stamped by `bellman_start` from `entitlementsFor(identity).blobBytesPerRoom` as `maxMembers` is, and never consulted against a plan again; `hydrateStoredSession` lifts a missing one to the free plan's ceiling, the conservative default for rooms that predate the field, which expire with them.
- Produces: `SURFACE_KINDS` including `"file"` and `"image"`, with the rule that holds them (Step 7).
- Produces: `normalizeSurfaceWrite` answers `{ ok: true; write; blobId: string | null }` — `blobId` is the id a `file` or `image` payload named, null for every other kind; the item in `write` carries `blob: null` until `writeSurface` fills it from the object (Task 4).
- Produces: `surfaceItem(row).data.blob`, `null` for a row written before this field.
- Consumes: `BLOB_ID` from Task 1.

The `blob` payload shape is strict `{ id }`. `bytes`, `type` and `name` are the server's to set (D5), so they are refused by name as `cursor` and `at` are — a client sending a `file` item back as it read it strips three fields inside `blob` as it strips two at the top. The join preview's index is unchanged: a blob-backed item reads `chars: 0` there, and its size and name are not shown before joining.

The two kinds land here with the rule that holds them, and not in Task 4, so that `npm run typecheck` and `npm run build` are green at the end of this task: the rule compares the kind with `"file"` and `"image"`, and the compiler refuses that comparison while `SURFACE_KINDS` lacks them. The cost is a window, Task 2 to Task 4, in which `writeSurface` has not yet looked a blob up and an item of either kind would be stored with `blob: null`. Nothing in this branch writes one in that window, and nothing deploys between tasks.

- [ ] **Step 1: Update the pins so they fail first**

In `tests/auth.test.ts`, the "describes creation limits only" case: `blobBytesPerRoom` joins the list, and the docblock above it gains one sentence.

```ts
  /**
   * INVARIANT 1: entitlements gate session CREATION only. A join-side field
   * appearing here would mean being invited into a room had started to depend
   * on what you pay — this test is the tripwire. `blobBytesPerRoom` (#183)
   * bounds what a room stores, not who may join it.
   */
  it("describes creation limits only — no join-side gating exists", () => {
    const creationOnlyFields = [
      "modes", "maxMembers", "sessionTtlMs", "monthlyCreates", "orgScoping", "audit", "blobBytesPerRoom",
    ].sort();
```

and, in the "plan entitlements" describe beside the `monthlyCreates` ordering lines:

```ts
    expect(ENTITLEMENTS.free.blobBytesPerRoom).toBe(50 * 1024 * 1024);
    expect(ENTITLEMENTS.pro.blobBytesPerRoom).toBe(500 * 1024 * 1024);
    expect(ENTITLEMENTS.team.blobBytesPerRoom).toBe(5 * 1024 * 1024 * 1024);
```

In `tests/stored-session.test.ts`, append:

```ts
/**
 * A record written before blobs (#183): it has no `blobBytes`. The key is
 * ABSENT, not undefined, which is what Durable Object storage hands back.
 */
describe("hydrateStoredSession — a record stored before blobs", () => {
  /** Nothing was ever charged there, which is what 0 says; a quota check cannot add to undefined. */
  it("reads a missing blobBytes as 0", () => {
    const { events: _events, ...raw } = session();
    expect("blobBytes" in raw).toBe(false);
    expect(hydrateStoredSession(raw)!.blobBytes).toBe(0);
  });

  /** A default that clobbered would hand every room its whole quota back on each read. */
  it("leaves a blobBytes the room has already charged alone", () => {
    const { events: _events, ...raw } = session();
    expect(hydrateStoredSession({ ...raw, blobBytes: 4096 })!.blobBytes).toBe(4096);
  });

  /** A room written before the ceiling existed reads the free plan's: conservative, and it expires with the room. */
  it("reads a missing blobBytesCeiling as the free ceiling, and leaves a stamped one alone", () => {
    const { events: _events, blobBytesCeiling: _ceiling, ...raw } = session();
    expect("blobBytesCeiling" in raw).toBe(false);
    expect(hydrateStoredSession(raw)!.blobBytesCeiling).toBe(ENTITLEMENTS.free.blobBytesPerRoom);
    expect(hydrateStoredSession({ ...raw, blobBytesCeiling: 7 })!.blobBytesCeiling).toBe(7);
  });
});
```

with `import { ENTITLEMENTS } from "../src/auth.js";` added to that file's imports.

In `tests/helpers/fixtures.ts`, `session()` gains `blobBytesCeiling: ENTITLEMENTS.team.blobBytesPerRoom,` after `maxMembers: 2,` (the fixture's creator is on the team plan), with `import { ENTITLEMENTS } from "../../src/auth.js";` added.

In `tests/working-surface.test.ts`: `item()` gains `blob: null` after `placement: null`; the D9 "puts the whole item inside an envelope" expectation gains `blob: null` after `placement: null`; and append to the "the trust split (D9)" describe:

```ts
  it("shows a blob-backed row's blob in the envelope and keeps it out of the index", () => {
    const file: SurfaceRow = {
      ...row, key: "deck", kind: "file", title: "The deck", body: null,
      blob: { id: "ab".repeat(16), bytes: 1234, type: "application/pdf", name: "deck.pdf" },
    };
    expect(surfaceItem(file).data).toMatchObject({ kind: "file", body: null, blob: file.blob });
    const [entry] = surfaceIndex([file]);
    expect(entry).not.toHaveProperty("blob");
    expect(entry.chars).toBe(0);
  });

  it("reads a row written before blobs as blob: null", () => {
    const legacy = { ...row } as Partial<SurfaceRow>;
    delete legacy.blob;
    expect(surfaceItem(legacy as SurfaceRow).data.blob).toBeNull();
  });
```

In `tests/helpers/store-contract.ts`, the surface rows block's `plan()` gains `blob: null`:

```ts
      const plan = (body = "1. read\n2. write"): SurfaceItem => ({
        key: "plan", kind: "text", title: "Plan", body, ends: null, placement: null, blob: null,
      });
```

In `tests/tools/working-surface.test.ts`, the first case's row expectation gains `blob: null`:

```ts
    expect(await rows(p)).toEqual([{
      key: "plan", kind: "text", title: "Plan", body: "1. read\n2. write", ends: null, placement: null, blob: null,
      cursor: last.cursor, at: last.at, byMemberId: p.creatorMemberId, byLabel: p.creator.identity.label,
    }]);
```

and in "accepts an item as it was read, null fields and all", the positive control for `plan` gains `blob: null`:

```ts
    expect(item("plan")).toMatchObject({ title: null, ends: null, placement: null, blob: null, cursor: expect.any(Number) });
```

and the "holds each kind to its rule" case gains the blob-backed kinds' rule after the `ends: null` refusal. It answers before any blob is looked up, so none of these needs a blob in the room, and each asserts the field by its `"path: "` or by the key the issue names — never a bare word the refusal's own prefix (`… placement?, blob? } or { key, remove: true }: `) already contains:

```ts
    // A file or an image names a blob (#183) and carries no body; nothing else names one.
    const id = "ab".repeat(16);
    await refused(p, { key: "t3", kind: "text", body: "x", blob: { id } }, "names a blob");
    await refused(p, { key: "c3", kind: "connector", ends: { from: "plan", to: "arch" }, blob: { id } }, "names a blob");
    await refused(p, { key: "f", kind: "file" }, "needs blob");
    await refused(p, { key: "f", kind: "file", blob: null }, "needs blob");
    await refused(p, { key: "f", kind: "file", blob: { id }, body: "and a body" }, "no body");
    await refused(p, { key: "f", kind: "image", blob: { id }, ends: { from: "plan", to: "arch" } }, "only a connector has ends");
    await refused(p, { key: "f", kind: "file", blob: { id: "nope" } }, "blob.id: ");
    await refused(p, { key: "f", kind: "file", blob: { id, bytes: 5 } }, "blob: ");
    await refused(p, { key: "f", kind: "file", blob: { id, type: "image/png", name: "x" } }, '"type"');
```

- [ ] **Step 2: Run them to confirm they fail**

Run: `npx vitest run tests/auth.test.ts tests/stored-session.test.ts tests/working-surface.test.ts tests/tools/working-surface.test.ts`
Expected: FAIL — the fields pin reports `blobBytesPerRoom` missing; `blobBytes` reads `undefined`; the envelope lacks `blob`; the blob-backed refusals come back as `kind: Invalid option…` and the "names a blob" ones as `Unrecognized key: "blob"` rather than the rule; and the typecheck of the fixtures is not yet broken because vitest does not typecheck.

- [ ] **Step 3: Add the types**

In `src/types.ts`, after `Entitlements`' `audit: boolean;`:

```ts
  /**
   * The bytes a room may hold in its blob store (#183, spec D3), charged per
   * room on `chargeBlobBytes` and never against a monthly figure: a room is what
   * a plan already rations.
   */
  blobBytesPerRoom: number;
```

Replace the `SurfaceKind` declaration and its docblock:

```ts
/**
 * The kinds a surface item can be (#129). Closed, like SEND_KINDS: every kind a
 * client is shown maps to a shape the server validates, and a kind lands with
 * its validator. `file` and `image` (#183) reference a blob; `html` arrives
 * with piece 4.
 */
export type SurfaceKind = "text" | "link" | "diagram" | "connector" | "file" | "image";
```

Add before `SurfaceItem`:

```ts
/**
 * A blob an item references (#183, D5): the object's metadata as the server
 * stored it, never the writer's claim. The writer names only the id; the
 * server reads the rest off the object when the item is placed.
 */
export interface BlobRef {
  id: string;        // [a-f0-9]{32}
  bytes: number;
  type: string;      // as stored, after D6
  name: string;      // as stored, after D6
}
```

In `Session`, after `maxMembers: number;`:

```ts
  /**
   * The bytes this room's blob store may hold (#183, D3), stamped at creation
   * from the creator's plan as `maxMembers` is, and never consulted against a
   * plan again: a free member in a team room shares the team room's ceiling,
   * which is what "a room is what a plan rations" means. Rows written before
   * the field read the free plan's ceiling through `hydrateStoredSession`.
   */
  blobBytesCeiling: number;
```

In `SurfaceItem`, after `placement: Placement | null;`:

```ts
  /** The blob a `file` or `image` names; null for every other kind. */
  blob: BlobRef | null;
```

and extend its docblock's last sentence: "`body` is markdown for `text`, a URL for `link`, mermaid source for `diagram`, a label for `connector`, and absent for `file` and `image`, whose bytes are the blob's."

- [ ] **Step 4: The quota**

In `src/auth.ts`, add to each plan after `audit`, with one comment above `ENTITLEMENTS`'s `free` entry:

```ts
    // ponytail: per-room blob ceilings (#183), not tuned: 50 MB, 500 MB, 5 GB.
    // A room is what a plan already rations, so nothing here is monthly.
    blobBytesPerRoom: 50 * 1024 * 1024,
```

```ts
    blobBytesPerRoom: 500 * 1024 * 1024,
```

```ts
    blobBytesPerRoom: 5 * 1024 * 1024 * 1024,
```

In `src/tools/start.ts`, the `Session` literal gains, after `maxMembers: manifest.mode === "pair" ? 2 : ent.maxMembers,`:

```ts
        // The room's own byte ceiling (#183), from the plan creating it, as the
        // seat count and the TTL are. Nothing downstream asks a plan again.
        blobBytesCeiling: ent.blobBytesPerRoom,
```

- [ ] **Step 5: The record's `blobBytes`**

In `src/stored-session.ts`, add to `StoredSession` after `surfaceCursor?: number;`:

```ts
  /**
   * The bytes charged to this room's blob store so far (#183): the sum every
   * successful `chargeBlobBytes` added, and nothing credits it — a deletion is a
   * retention decision (#65) and lands with its own credit. Absent on rows
   * written before this landed; `hydrateStoredSession` lifts it to 0 and
   * `blobBytesUsed` in blobs.ts reads it through `?? 0` for the in-memory
   * store, which does not hydrate.
   */
  blobBytes?: number;
```

Add to the file's imports:

```ts
import { ENTITLEMENTS } from "./auth.js";
```

In `hydrateStoredSession`'s returned object, after `surfaceCursor: row.surfaceCursor ?? 0,`:

```ts
    blobBytes: row.blobBytes ?? 0,
    // Required on the type, absent on a row written before #183: the cast says
    // so where `??` alone would read as redundant.
    blobBytesCeiling: (row as { blobBytesCeiling?: number }).blobBytesCeiling ?? ENTITLEMENTS.free.blobBytesPerRoom,
```

In the function's docblock: "Five changes to the stored shape" becomes "Seven changes to the stored shape", "All five live here" becomes "All seven live here", and the bullet list gains, after the surfaceCursor bullet:

```
 * - **blobBytes** (#183) defaults to `0`: a room written before blobs existed
 *   has been charged nothing, which is what 0 says.
 * - **blobBytesCeiling** (#183) defaults to the free plan's ceiling. A room
 *   written before the field was stamped from no plan, so the conservative
 *   number is the honest one, and it expires with the room rather than being
 *   migrated.
```

In `src/blobs.ts`, `blobBytesUsed` loses its cast:

```ts
export const blobBytesUsed = (s: StoredSession): number => s.blobBytes ?? 0;
```

- [ ] **Step 6: The projection**

In `src/projections.ts`, `surfaceItem`'s data gains, after `placement: r.placement,`:

```ts
      // `?? null` for rows written before blobs (#183): a reader never tells
      // "absent" from "null", and a legacy row has no key at all.
      blob: r.blob ?? null,
```

`surfaceIndex` is unchanged on purpose: `bytes` is the server's number and `name` is author prose, and the preview shows neither — a code holder who never joins reads that the room keeps a file, not what it is called.

- [ ] **Step 7: The shape and the rule**

In `src/surface.ts`, add to the imports:

```ts
import { BLOB_ID } from "./blobs.js";
```

`SURFACE_KINDS` gains the two kinds, so that the rule below compiles and a `file` or an `image` parses:

```ts
export const SURFACE_KINDS = ["text", "link", "diagram", "connector", "file", "image"] as const satisfies readonly SurfaceKind[];
```

After `EndsShape`:

```ts
/**
 * The blob a `file` or `image` names (#183, D5): the id and nothing else.
 * `bytes`, `type` and `name` are the server's to set from the object, so an item
 * sent back as it was read is refused for them until the sender takes them off,
 * as it is for `cursor` and `at`.
 */
const BlobShape = z.strictObject({
  id: z.string().regex(BLOB_ID, "must be the 32 hex characters an upload returned"),
});
```

In `SurfaceItemShape`, after `placement`:

```ts
  blob: BlobShape.nullish(),
```

In `normalizeSurfaceWrite`: the return type becomes

```ts
): { ok: true; write: SurfaceWrite; blobId: string | null } | { ok: false; reason: string } {
```

the removal arm returns `{ ok: true, write: { key: parsed.data.key, item: null }, blobId: null }`, the shape-failure prefix becomes `surface payload must be { key, kind, title?, body?, ends?, placement?, blob? } or { key, remove: true }: ...`, and the kind rules become:

```ts
  // A file or an image is blob-backed (#183): its bytes are the object's, so it
  // names a blob and carries no body. Nothing else may name one.
  const blobBacked = v.kind === "file" || v.kind === "image";
  if (v.kind === "connector") {
    if (!v.ends) return refuse("a connector needs ends { from, to } naming two items");
    if (v.ends.from === v.ends.to) return refuse("a connector's ends must differ");
    if (v.placement) return refuse("a connector has no placement; it is drawn between its ends");
  } else {
    if (v.ends) return refuse("only a connector has ends");
    if (blobBacked) {
      if (!v.blob) return refuse("a file or an image needs blob { id } naming a blob uploaded to this room");
      if (v.body) return refuse("a file or an image has no body; its bytes are the blob's");
    } else if (!v.body) {
      return refuse("needs a body");
    }
  }
  if (v.blob && !blobBacked) return refuse("only a file or an image names a blob");
```

and the success return:

```ts
  return {
    ok: true,
    write: {
      key: v.key,
      item: {
        key: v.key,
        kind: v.kind,
        title: v.title ?? null,
        body: v.body ?? null,
        ends: v.ends ?? null,
        placement: v.placement ?? null,
        // Filled from the object by writeSurface (D5): the writer's word is the id alone.
        blob: null,
      },
    },
    blobId: v.blob?.id ?? null,
  };
```

Update the function's docblock: after "that a connector's ends exist", add "and that a blob exists and is what its kind needs — both are `writeSurface`'s reads."

- [ ] **Step 8: Run the tests and both typechecks**

Run: `npx vitest run tests/auth.test.ts tests/stored-session.test.ts tests/working-surface.test.ts tests/tools/working-surface.test.ts tests/store.test.ts tests/blobs.test.ts && npm run typecheck && npm run typecheck:worker`
Expected: PASS, and both typechecks clean. (Every `SurfaceItem` literal in `src/`, `tests/` and `worker-tests/` is named in Step 1 or spreads one that is; there is no other to find.)

- [ ] **Step 9: Break the lift and the rule to see the controls**

In `hydrateStoredSession`, change `blobBytes: row.blobBytes ?? 0` to `blobBytes: row.blobBytes`. Run `npx vitest run tests/stored-session.test.ts`: "reads a missing blobBytes as 0" goes red with `expected undefined to be 0`. Restore. Then change the ceiling's default to `?? 0`: "reads a missing blobBytesCeiling as the free ceiling" goes red with `expected 0 to be 52428800`. Restore.

In `normalizeSurfaceWrite`, delete the line `if (v.blob && !blobBacked) return refuse("only a file or an image names a blob");`. Run `npx vitest run tests/tools/working-surface.test.ts -t "holds each kind"`: the two "names a blob" refusals go red — the write succeeds (`expected false to be true`). Restore. Then delete, one at a time, `if (!v.blob) return refuse("a file or an image needs blob { id } …");` and `if (v.body) return refuse("a file or an image has no body; …");`: the "needs blob" and the "no body" refusals each go red the same way (a `file` with no blob, or with a body, is accepted). Restore each.

- [ ] **Step 10: Commit**

```bash
git add src/types.ts src/auth.ts src/tools/start.ts src/stored-session.ts src/blobs.ts src/projections.ts src/surface.ts tests/auth.test.ts tests/stored-session.test.ts tests/helpers/fixtures.ts tests/working-surface.test.ts tests/helpers/store-contract.ts tests/tools/working-surface.test.ts
git -c commit.gpgsign=true commit -S -m "Give an item a blob, a room the byte ceiling its plan stamps, and the record the bytes it has charged"
```

---

### Task 3: The charge — `chargeBlobBytes` in the contract, in `MemoryStore`, and in `SessionDO`

**Files:**
- Modify: `src/store.ts` (`BlobCharge`, `decideBlobCharge`, `BellmanStore.chargeBlobBytes`, `MemoryStore.chargeBlobBytes`)
- Modify: `src/store-do.ts` (`SessionDO.chargeBlobBytes`, `DurableObjectStore.chargeBlobBytes`)
- Modify: `tests/helpers/store-contract.ts` (new `describe`), run through `tests/store.test.ts` and `worker-tests/store-contract.test.ts`

**Interfaces:**
- Produces: `type BlobCharge = { ok: true; used: number } | { ok: false; reason: "over_quota" | "frozen" | "closed" | "not_found"; used: number }` in `src/store.ts`; `BellmanStore.chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge>` — no ceiling argument: the room object reads its own `blobBytesCeiling`.
- Produces: `decideBlobCharge(s: Pick<StoredSession, "frozenAt" | "blobBytesCeiling" | "blobBytes">, closed: boolean, bytes: number): BlobCharge` in `src/store.ts` — the charge rule, once. Both stores call it, as both call `applySurfaceWrite` for the surface rows and `markRemoved` for a cut; the one input they compute differently, whether the room reads as closed, is passed in.
- Consumes: `blobBytesUsed` from Task 1; `StoredSession.blobBytes` and `Session.blobBytesCeiling` from Task 2; `readsClosed` (already in `src/store-do.ts`).

- [ ] **Step 1: Write the contract cases**

In `tests/helpers/store-contract.ts`, add the import:

```ts
import { blobBytesUsed } from "../../src/blobs.js";
```

and, inside `describeStoreContract`'s `describe`, after the "the surface rows" block and before the "recording a member out at an event's cursor" comment, a new block:

```ts
    /**
     * The quota's bound (#183, D3). The read of the total and the write that
     * raises it are one operation, decided in the room object; the route's
     * pre-check is a courtesy. The store charges bytes it is handed and never
     * asks what they are for.
     */
    describe("charging a room for its blobs", () => {
      const used = async (id: string) => blobBytesUsed((await store.getSession(id))!);

      it("reads 0 off a room never charged, and charges to the room's own ceiling", async () => {
        const s = session({ blobBytesCeiling: 100 });
        await store.createSession(s);
        expect(await used(s.id)).toBe(0);
        expect(await store.chargeBlobBytes(s.id, 60)).toEqual({ ok: true, used: 60 });
        expect(await store.chargeBlobBytes(s.id, 40)).toEqual({ ok: true, used: 100 });
        expect(await used(s.id)).toBe(100);
      });

      it("refuses past the ceiling, reports the total, and charges nothing for a refusal", async () => {
        const s = session({ blobBytesCeiling: 100 });
        await store.createSession(s);
        await store.chargeBlobBytes(s.id, 90);
        expect(await store.chargeBlobBytes(s.id, 11)).toEqual({ ok: false, reason: "over_quota", used: 90 });
        expect(await used(s.id)).toBe(90);
        // The controls: the ten that fit exactly land, and the ceiling is this
        // room's own — a roomier record takes what this one refused.
        expect(await store.chargeBlobBytes(s.id, 10)).toEqual({ ok: true, used: 100 });
        const roomy = session({ id: "qs_roomy", blobBytesCeiling: 1_000 });
        await store.createSession(roomy);
        expect(await store.chargeBlobBytes(roomy.id, 101)).toEqual({ ok: true, used: 101 });
      });

      it("refuses a frozen room and a closed one, with the total", async () => {
        const s = session({ blobBytesCeiling: 100 });
        await store.createSession(s);
        await store.chargeBlobBytes(s.id, 5);
        await store.freezeSession(s.id, Date.now());
        expect(await store.chargeBlobBytes(s.id, 1)).toEqual({ ok: false, reason: "frozen", used: 5 });
        await store.freezeSession(s.id, null);
        await store.closeSession(s.id);
        expect(await store.chargeBlobBytes(s.id, 1)).toEqual({ ok: false, reason: "closed", used: 5 });
        expect(await used(s.id)).toBe(5);
      });

      it("answers not_found for a room that does not exist", async () => {
        expect(await store.chargeBlobBytes("qs_nobody", 1)).toEqual({ ok: false, reason: "not_found", used: 0 });
      });

      it("reads a room past its TTL as closed", async () => {
        const s = session({ expiresAt: Date.now() - 1 });
        await store.createSession(s);
        expect(await store.chargeBlobBytes(s.id, 1)).toMatchObject({ ok: false, reason: "closed" });
      });
    });
```

- [ ] **Step 2: Run the root contract to confirm it fails**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — `store.chargeBlobBytes is not a function`, five cases.

- [ ] **Step 3: Extend the interface and `MemoryStore`**

In `src/store.ts`, after `SetJoinCode`:

```ts
/** What a blob charge did (#183, D3). `used` is the room's total after the call, or as it stood when refused. */
export type BlobCharge =
  | { ok: true; used: number }
  | { ok: false; reason: "over_quota" | "frozen" | "closed" | "not_found"; used: number };

/**
 * The charge rule (#183, D3), applied by both stores and decided nowhere else: the
 * order of the refusals, what `used` says on each, and the one comparison that is
 * the bound. Whether the room reads as closed is the caller's, because that is the
 * one input the stores compute differently (`expireIfDue` in `MemoryStore`,
 * `readsClosed` in the room object). Returns the refusal, or the new total for the
 * caller to write.
 */
export function decideBlobCharge(
  s: Pick<StoredSession, "frozenAt" | "blobBytesCeiling" | "blobBytes">,
  closed: boolean,
  bytes: number,
): BlobCharge {
  const used = s.blobBytes ?? 0;
  if (closed) return { ok: false, reason: "closed", used };
  if (s.frozenAt !== null) return { ok: false, reason: "frozen", used };
  if (used + bytes > s.blobBytesCeiling) return { ok: false, reason: "over_quota", used };
  return { ok: true, used: used + bytes };
}
```

In `BellmanStore`, after `surfaceOf`:

```ts
  /**
   * Charge `bytes` to this room's blob total unless that would pass the
   * room's own `blobBytesCeiling` (#183, D3), stamped at creation from the
   * plan that made it. The read and the write are one operation, for
   * seatMember's reason: two uploads landing together must not both read the
   * same total and both fit the last megabyte. Refused for a closed or frozen
   * room as every write is, with the total it would have charged against, and
   * `not_found` for no room. The upload route pre-checks the ceiling as a
   * courtesy and this is the bound: a refusal here is what deletes the object
   * just put. Nothing credits the total; retention (#65) will.
   */
  chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge>;
```

In `MemoryStore`, after `surfaceOf`:

```ts
  async chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge> {
    // No await from the read to the write — the rule, and the reason, seatMember
    // gives. `expireIfDue` first, as getSession does: a room past its TTL is
    // closed whether or not anything has written that down yet.
    const s = this.sessions.get(sessionId);
    if (!s) return { ok: false, reason: "not_found", used: 0 };
    this.expireIfDue(s, Date.now());
    const charge = decideBlobCharge(s, s.closed, bytes);
    if (charge.ok) (s as { blobBytes?: number }).blobBytes = charge.used;
    return charge;
  }
```

`getSession` needs no change: it hands back a detached copy of the stored record without its events, so a `blobBytes` set on the record rides along, and `blobBytesUsed` reads `?? 0` for a record it was never set on.

- [ ] **Step 4: Run the root contract**

Run: `npx vitest run tests/store.test.ts && npm run typecheck`
Expected: PASS. `npm run typecheck:worker` FAILS now, because `DurableObjectStore` does not implement `chargeBlobBytes` — the next step.

- [ ] **Step 5: The Durable Object**

In `src/store-do.ts`, add `BlobCharge` to the `import type { GrantDelete, GrantWrite, SetJoinCode } from "./store.js";` line, and `decideBlobCharge` to the value import from `./store.js` that names `connectedAmong`, `creditReport` and the others.

On `SessionDO`, after `surfaceOf`:

```ts
  /**
   * The quota's bound (#183, D3), decided in this object in one transaction
   * against the ceiling stamped on its own record: the read of the total and
   * the write that raises it are one unit, so two uploads cannot both fit the
   * last megabyte. A room past its TTL reads as closed through `readsClosed`,
   * the rule every reader of "closed" shares; the rest of the decision is
   * `decideBlobCharge`'s, the same call `MemoryStore` makes. Nothing is written
   * for a refusal. `blobBytes` is the sum charged so far; nothing here credits it.
   */
  async chargeBlobBytes(bytes: number): Promise<BlobCharge> {
    return this.ctx.storage.transaction<BlobCharge>(async (txn) => {
      const s = await this.stored(txn);
      if (!s) return { ok: false, reason: "not_found", used: 0 };
      const charge = decideBlobCharge(s, readsClosed(s, Date.now()), bytes);
      if (charge.ok) await txn.put("session", { ...s, blobBytes: charge.used });
      return charge;
    });
  }
```

On `DurableObjectStore`, after `surfaceOf`:

```ts
  async chargeBlobBytes(sessionId: string, bytes: number): Promise<BlobCharge> {
    return this.session(sessionId).chargeBlobBytes(bytes);
  }
```

- [ ] **Step 6: Typecheck the Worker and run the contract in workerd**

Run: `npm run typecheck:worker && npm run test:worker`
Expected: both clean; the five new "charging a room for its blobs" cases pass against `DurableObjectStore`. The worker run installs `worker-tests/`' own dependencies on first run and takes minutes.

- [ ] **Step 7: Break the bound to see the control**

In `decideBlobCharge`, change `used + bytes > s.blobBytesCeiling` to `used + bytes > s.blobBytesCeiling * 2`. Run `npx vitest run tests/store.test.ts -t "refuses past the ceiling"` and `npm --prefix worker-tests run test -- -t "refuses past the ceiling"`: both go red with `expected { ok: true, used: 101 } to deeply equal { ok: false, reason: 'over_quota', used: 90 }` — one rule, so one mutation reaches both stores. Restore.

- [ ] **Step 8: Commit**

```bash
git add src/store.ts src/store-do.ts tests/helpers/store-contract.ts
git -c commit.gpgsign=true commit -S -m "Charge a room's blob bytes in the room object, in one transaction, against the ceiling its record carries"
```

---

### Task 4: The write — `file` and `image` through `writeSurface`, and `buildServer` taking the blob store

**Files:**
- Modify: `src/rooms.ts` (`writeSurface` gains `blobs`; `gateSeat` is exported)
- Modify: `src/tools/send.ts` (`registerSend` gains `blobs`; the description)
- Modify: `src/server.ts` (`buildServer(identity, s, blobs)`)
- Modify: `src/app.ts`, `src/index.ts`
- Modify: `tests/helpers/harness.ts`, `tests/extension.test.ts`, `tests/bridge.test.ts`, `tests/bridge-bus.test.ts`, `tests/bus-e2e.test.ts`, `tests/http.test.ts`
- Test: `tests/tools/working-surface.test.ts` (new `describe`)

**Interfaces:**
- Produces: `writeSurface(store, blobs: BlobStore, actor, sessionId, memberId, payload, idempotencyKey?)` — the `blobs` parameter is second, beside the store; `gateSeat` is exported unchanged.
- Produces: `buildServer(identity: Identity, s: BellmanStore, blobs: BlobStore)`, no default; `registerSend(server, identity, s, blobs)`; `createApp(store, blobs)`.
- Produces: `Harness` gains `readonly blobs: BlobStore` (default `new MemoryBlobStore()`), second constructor argument.
- Consumes: `BlobStore`, `MemoryBlobStore`, `IMAGE_TYPES`, `isImageType`, `newBlobId` from Task 1 and its byte fixtures `PNG` and `text` in `tests/helpers/blob-bytes.ts`; `normalizeSurfaceWrite`'s `blobId` and the two kinds in `SURFACE_KINDS` from Task 2 — the rule that holds a `file` to a blob and no body is already tested there, so none of that is repeated here.

`buildServer` takes the store with no default on purpose: a default of `new MemoryBlobStore()` would let a deploy that forgot the binding serve a blob store that forgets every object when the isolate does, with every test green.

- [ ] **Step 1: Write the failing tool tests**

Append to `tests/tools/working-surface.test.ts`. The file imports nothing from `src/blobs.js` yet, so add two import lines beside the others:

```ts
import { IMAGE_TYPES, newBlobId } from "../../src/blobs.js";
import { PNG, text } from "../helpers/blob-bytes.js";
```

and append:

```ts
describe("file and image items (#183)", () => {
  const MD = text("# notes\n");

  /** A blob in the harness's store, as the upload route would have left it. */
  const stored = async (p: PairedSession, type: string, bytes: Uint8Array, name = "notes.md", room = p.sessionId) => {
    const id = newBlobId();
    await h.blobs.put(room, id, bytes.buffer.slice(0, bytes.byteLength) as ArrayBuffer, {
      bytes: bytes.byteLength, type, name, by: p.creatorMemberId, at: 1_700_000_000_000,
    });
    return id;
  };

  const refusedWith = async (p: PairedSession, payload: Record<string, unknown>, words: string) => {
    const before = await eventCount(p);
    const out = await write(p, payload);
    expect(out.isError, JSON.stringify(payload).slice(0, 80)).toBe(true);
    expect(out.text, JSON.stringify(payload).slice(0, 80)).toContain(words);
    expect(await eventCount(p)).toBe(before);
  };

  it("places a file carrying the object's metadata, which the payload never named", async () => {
    const p = await pairUp(h);
    const id = await stored(p, "text/markdown", MD);
    const out = await write(p, { key: "notes", kind: "file", blob: { id }, title: "Notes" });
    expect(out.isError, out.text).toBe(false);

    const [row] = await rows(p);
    expect(row).toMatchObject({
      key: "notes", kind: "file", title: "Notes", body: null, ends: null, placement: null,
      blob: { id, bytes: MD.byteLength, type: "text/markdown", name: "notes.md" },
    });
    const last = (await h.store.eventsAfter(p.sessionId, 0)).at(-1)!;
    expect(last.payload).toMatchObject({ key: "notes", kind: "file", blob: { id, bytes: MD.byteLength, name: "notes.md" } });
    const audit = (await h.store.auditForOrg(p.creator.identity.orgId!, 50)).at(-1)!;
    expect(audit.detail).toEqual({ key: "notes", kind: "file", chars: 0, bytes: MD.byteLength });
  });

  it("places an image over an allowlisted blob, and refuses one over anything else", async () => {
    const p = await pairUp(h);
    const png = await stored(p, "image/png", PNG, "shot.png");
    const ok = await write(p, { key: "shot", kind: "image", blob: { id: png }, placement: { x: 10, y: 20, w: 320, h: 240 } });
    expect(ok.isError, ok.text).toBe(false);
    expect((await rows(p))[0]).toMatchObject({ kind: "image", blob: { id: png, type: "image/png" }, placement: { x: 10, y: 20, w: 320, h: 240 } });

    const md = await stored(p, "text/markdown", MD);
    await refusedWith(p, { key: "not_an_image", kind: "image", blob: { id: md } }, "not an image");
    // What an upload claiming a PNG that was not one is stored as (D6).
    const bytes = await stored(p, "application/octet-stream", MD, "fake.png");
    await refusedWith(p, { key: "fake", kind: "image", blob: { id: bytes } }, "not an image");
    // The same blob places as a file: the refusal is about the kind, not the blob.
    const asFile = await write(p, { key: "fake", kind: "file", blob: { id: bytes } });
    expect(asFile.isError, asFile.text).toBe(false);
    const refusal = (await write(p, { key: "fake2", kind: "image", blob: { id: bytes } })).text;
    for (const type of IMAGE_TYPES) {
      expect(refusal, "the refusal names every type that would have been accepted").toContain(type);
    }
  });

  it("refuses a blob that was never uploaded, and one uploaded to another room", async () => {
    const p = await pairUp(h);
    await refusedWith(p, { key: "ghost", kind: "file", blob: { id: newBlobId() } }, "no blob");
    const elsewhere = await stored(p, "text/markdown", MD, "notes.md", "qs_another_room");
    await refusedWith(p, { key: "theirs", kind: "file", blob: { id: elsewhere } }, "no blob");
    expect(await rows(p)).toEqual([]);
  });

  // Review Focus 3: read, edit, send back works for a blob-backed item too, once the server's
  // fields come off — the three inside `blob` as well as the two on top. zod reports the nested
  // issue before the top-level one and the refusal names only the first, so each step asserts
  // its first issue by its path (`blob: `; the refusal's own prefix says `blob? }`, never
  // `blob: `) and by the key it names, and says which issue is not the first.
  it("reads a file item back with its blob, and accepts it back once the server's fields are stripped", async () => {
    const p = await pairUp(h);
    const id = await stored(p, "text/markdown", MD);
    await write(p, { key: "notes", kind: "file", blob: { id }, title: "Notes" });
    const read = await p.creator.call("bellman_sync", {
      session_id: p.sessionId, member_id: p.creatorMemberId, since_cursor: 0, surface: true,
    });
    const [item] = (read.data.surface as { items: { data: Record<string, unknown> }[] }).items.map((i) => i.data);
    expect(item.blob).toEqual({ id, bytes: MD.byteLength, type: "text/markdown", name: "notes.md" });

    // As read: the blob's three server fields are the first issue; cursor and at are the second.
    const asRead = await write(p, { ...item, title: "Renamed" });
    expect(asRead.isError).toBe(true);
    expect(asRead.text).toContain("blob: ");
    expect(asRead.text).toContain('"bytes"');
    expect(asRead.text).not.toContain('"cursor"');

    // The blob reduced to its id: the top-level pair is the first issue now, and the blob is not named.
    const blobFixed = await write(p, { ...item, blob: { id }, title: "Renamed" });
    expect(blobFixed.isError).toBe(true);
    expect(blobFixed.text).toContain('"cursor"');
    expect(blobFixed.text).not.toContain("blob: ");

    // cursor and at off, the blob left as read: the blob again, by name.
    const { cursor: _c, at: _a, ...rest } = item;
    const stripped = await write(p, { ...rest, title: "Renamed" });
    expect(stripped.isError).toBe(true);
    expect(stripped.text).toContain("blob: ");
    expect(stripped.text).toContain('"bytes"');

    // All of it off: accepted, and the row keeps the object's own metadata.
    const edited = await write(p, { ...rest, blob: { id }, title: "Renamed" });
    expect(edited.isError, edited.text).toBe(false);
    expect((await rows(p))[0]).toMatchObject({
      title: "Renamed", blob: { id, bytes: MD.byteLength, type: "text/markdown", name: "notes.md" },
    });
  });

  it("leaves the blob where it is when the item is replaced or removed", async () => {
    const p = await pairUp(h);
    const id = await stored(p, "text/markdown", MD);
    const before = await h.blobs.head(p.sessionId, id);
    expect(before, "the blob is there to begin with").toMatchObject({ bytes: MD.byteLength, name: "notes.md" });
    await write(p, { key: "notes", kind: "file", blob: { id } });
    await write(p, { key: "notes", kind: "text", body: "replaced by prose" });
    expect(await h.blobs.head(p.sessionId, id)).toEqual(before);
    await write(p, { key: "notes", remove: true });
    expect(await h.blobs.head(p.sessionId, id)).toEqual(before);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/tools/working-surface.test.ts -t "file and image"`
Expected: FAIL — `h.blobs` is undefined (`Harness` has no blob store yet); and once it exists, the placement cases fail because `writeSurface` has not yet looked a blob up (a `file` is stored with `blob: null`).

- [ ] **Step 3: Resolve the blob in `writeSurface`, and export the gate**

In `src/rooms.ts`, add the import:

```ts
import { IMAGE_TYPES, isImageType, type BlobStore } from "./blobs.js";
```

Change `async function gateSeat(` to `export async function gateSeat(`, and add one sentence to its docblock: "Exported for the upload route (#183), which runs it as the tool does and maps its codes to statuses."

Change `writeSurface`'s signature:

```ts
export async function writeSurface(
  store: BellmanStore,
  blobs: BlobStore,
  actor: Identity,
  sessionId: string,
  memberId: string,
  payload: unknown,
  idempotencyKey?: string,
): Promise<RoomResult<{ cursor: number; replayed: boolean; roomMembers: string[] }>> {
```

Replace `const { write } = normalized;` with:

```ts
  let { write } = normalized;

  // A blob-backed item carries the object's metadata, not the writer's (#183,
  // D5): the writer named an id, and what readers get is what the bucket holds
  // under this room's prefix. `head` resolves nothing from another room (D1),
  // so a foreign id is "no blob" here too. The image check is on the STORED
  // type, which D6 already decided at upload.
  if (normalized.blobId !== null && write.item !== null) {
    const meta = await blobs.head(sessionId, normalized.blobId);
    if (!meta) {
      return refuse("invalid", `surface ${write.item.kind} "${write.key}": no blob ${normalized.blobId} has been uploaded to this room.`);
    }
    if (write.item.kind === "image" && !isImageType(meta.type)) {
      return refuse(
        "invalid",
        `surface image "${write.key}": blob ${normalized.blobId} is stored as ${meta.type}, which is not an image this server serves as one (${IMAGE_TYPES.join(", ")}); place it as a file.`,
      );
    }
    write = {
      key: write.key,
      item: { ...write.item, blob: { id: normalized.blobId, bytes: meta.bytes, type: meta.type, name: meta.name } },
    };
  }
```

In the audit call, the detail for a written item gains the blob's bytes:

```ts
      write.item !== null
        ? {
            key: write.key, kind: write.item.kind, chars: write.item.body?.length ?? 0,
            ...(write.item.blob ? { bytes: write.item.blob.bytes } : {}),
          }
        : { key: write.key, removed: true },
```

In the docblock, the order sentence becomes: "the seat's guards (`gateSeat`, which also touches the caller), the payload's shape and each kind's rule, the blob a file or image names, the rows for the cap and a connector's ends, the append with the row riding it, the audit row."

- [ ] **Step 4: Thread the store through `registerSend` and `buildServer`**

In `src/tools/send.ts`: add `import type { BlobStore } from "../blobs.js";`, change the signature to `export function registerSend(server: McpServer, identity: Identity, s: BellmanStore, blobs: BlobStore): void`, and the call to `writeSurface(s, blobs, identity, session_id, member_id, payload, idempotency_key)`.

In the description, the `"surface"` entry's first line and kinds line become:

```
      "surface"        — write or replace a named item on the room's working surface, or remove one. Payload { key, kind, title?, body?, ends?, placement?, blob? } or { key, remove: true }.
                         Kinds: text (markdown in body), link (an http/https URL in body), diagram (mermaid source in body), connector (ends: { from, to } naming two items on the surface; no placement), file and image (blob: { id } naming a blob uploaded to this room — POST /rooms/:id/blobs, or the bridge's bellman_upload, which uploads and places in one call; no body; the item comes back with the object's bytes, type and name, and an image needs a blob stored as image/png, image/jpeg, image/gif or image/webp). placement is { x, y, w?, h? }: x and y unbounded, w and h positive when given.
```

In `src/server.ts`: add `import type { BlobStore } from "./blobs.js";`, change the signature to `export function buildServer(identity: Identity, s: BellmanStore, blobs: BlobStore): McpServer`, and the call to `registerSend(server, identity, s, blobs);`. Add to the docblock: "`blobs` is the blob seam (#183), handed only to `bellman_send`, whose `file` and `image` items read it; it has no default, so a deploy that forgets the binding does not compile rather than serving a store that forgets."

In `src/app.ts`: add `import type { BlobStore } from "./blobs.js";`, change to `export function createApp(store: BellmanStore, blobs: BlobStore): Express`, and the call to `buildServer(identity, store, blobs)`.

In `src/index.ts`: add `import { MemoryBlobStore } from "./blobs.js";` and change to `const app = createApp(store, new MemoryBlobStore());`.

- [ ] **Step 5: The harness and every other caller**

In `tests/helpers/harness.ts`: add `import { MemoryBlobStore, type BlobStore } from "../../src/blobs.js";`, give `Harness` a second field and argument, and pass it:

```ts
export class Harness {
  readonly store: BellmanStore;
  readonly blobs: BlobStore;
  private readonly peers: Peer[] = [];

  constructor(store: BellmanStore = new MemoryStore(), blobs: BlobStore = new MemoryBlobStore()) {
    this.store = store;
    this.blobs = blobs;
  }
```

and `buildServer(identity, this.store, this.blobs)` in `connectAs`.

In each of `tests/extension.test.ts`, `tests/bridge.test.ts`, `tests/bridge-bus.test.ts` and `tests/bus-e2e.test.ts`, add `import { MemoryBlobStore } from "../src/blobs.js";` and change the one `buildServer(identity, store)` call to `buildServer(identity, store, new MemoryBlobStore())`. In `tests/http.test.ts`, add the same import and change `createApp(store)` to `createApp(store, new MemoryBlobStore())`.

- [ ] **Step 6: Run the tool tests and the Node typecheck**

Run: `npx vitest run tests/tools/working-surface.test.ts tests/tools/surface.test.ts tests/tools/verbs.test.ts tests/http.test.ts tests/extension.test.ts && npm run typecheck`
Expected: PASS, and the typecheck is clean. `npm run typecheck:worker` names exactly one error, `src/worker.ts` calling `buildServer` with two arguments; Task 7 supplies the third. Carry on.

- [ ] **Step 7: Break the metadata copy, the allowlist check and the blob's survival to see the controls**

In `writeSurface`, change `blob: { id: normalized.blobId, bytes: meta.bytes, type: meta.type, name: meta.name }` to `blob: { id: normalized.blobId, bytes: 0, type: meta.type, name: "" }`. Run `npx vitest run tests/tools/working-surface.test.ts -t "places a file carrying"`: red on the row's `blob` (`bytes: 0` where `8` was expected). Restore.

Then change `!isImageType(meta.type)` to `false`. Run `-t "places an image over"`: "not an image" is never said — red with `expected false to be true`. Restore.

Then, in `writeSurface` right after `const byKey = new Map(…)`, add `const gone = byKey.get(write.key)?.blob; if (gone) await blobs.delete(sessionId, gone.id);` — the deletion the spec's D8 rules out. Run `-t "leaves the blob where it is"`: red, `head` answering `null` where the metadata read before the replace was expected. Restore.

- [ ] **Step 8: Run the whole root program**

Run: `npm test`
Expected: all green. (Every `buildServer(` and `createApp(` call in `src/`, `tests/`, `worker-tests/` and `scripts/` is named in Steps 4 and 5, or is `src/worker.ts`, which Task 7 supplies.)

- [ ] **Step 9: Commit**

```bash
git add src/rooms.ts src/tools/send.ts src/server.ts src/app.ts src/index.ts tests/helpers/harness.ts tests/extension.test.ts tests/bridge.test.ts tests/bridge-bus.test.ts tests/bus-e2e.test.ts tests/http.test.ts tests/tools/working-surface.test.ts
git -c commit.gpgsign=true commit -S -m "Place a file or an image on the surface, carrying the object's metadata and never the writer's"
```

---

### Task 5: The bucket — `R2BlobStore`, the `BLOBS` binding, and the contract in workerd

**Files:**
- Create: `src/blobs-r2.ts`
- Modify: `tsconfig.json`, `tsconfig.test.json` (`exclude`)
- Modify: `tests/projections.test.ts` (a fourth root)
- Modify: `wrangler.toml`, `worker-tests/wrangler.toml` (`[[r2_buckets]]`)
- Modify: `worker-tests/README.md`
- Create: `worker-tests/blob-store-contract.test.ts`

**Interfaces:**
- Produces: `class R2BlobStore implements BlobStore` with `constructor(bucket: R2Bucket)`.
- Consumes: `BlobStore`, `BlobMeta`, `BlobPut`, `BlobRead`, `BlobLengthError`, `exactLength`, `blobKey`, `OCTET_STREAM` from Task 1; `describeBlobStoreContract` from Task 1.

The ruling on Review Focus 1: R2's own error for a body of the wrong length is not told apart from any other failure of the put — workerd's `FixedLengthStream` errors the stream with its own `TypeError`, and the put rejects with whatever R2 makes of that. So the rule is not left to R2. `exactLength` (Task 1) runs ahead of the `FixedLengthStream` and errors with `BlobLengthError` first, the put and the pipe are settled together, and the store throws the pipe's `BlobLengthError` in preference to R2's rejection. The contract (Task 1) now requires that class from both stores, and Step 6 runs it in workerd; that is the proof, and Step 7 breaks it.

- [ ] **Step 1: Add the bindings**

In `wrangler.toml`, after the `AUTH` Durable Object binding and before the migrations:

```toml
# The room blob store (#183): one bucket, keyed rooms/<sessionId>/<blobId>, and
# private — every byte leaves through the download route, under membership.
# `npx wrangler r2 bucket create bellman-blobs` once, before the first deploy.
[[r2_buckets]]
binding = "BLOBS"
bucket_name = "bellman-blobs"
```

In `worker-tests/wrangler.toml`, after the `AUTH` binding:

```toml
[[r2_buckets]]
binding = "BLOBS"
bucket_name = "bellman-blobs"
```

In `worker-tests/README.md`, the last section becomes:

```markdown
## What `wrangler.toml` here is for

The pool reads Durable Object and R2 bindings and migrations from a wrangler
config. This one mirrors the real `../wrangler.toml`'s DO topology, its `BLOBS`
bucket and its compatibility settings and nothing else — no routes, no custom
domain, no observability. When the DO topology or the bindings change in the
real file, change them here too.
```

and the opening sentence of the file gains the second suite: "It exists to run two things: the `BellmanStore` contract suite (`../tests/helpers/store-contract.ts`) against `DurableObjectStore`, and the `BlobStore` contract suite (`../tests/helpers/blob-store-contract.ts`) against `R2BlobStore`, in real workerd, with real Durable Objects and a real R2 binding — issues #12 and #183."

- [ ] **Step 2: Write the workerd contract runner**

Create `worker-tests/blob-store-contract.test.ts`:

```ts
/**
 * The BlobStore contract suite, unmodified, against the store that serves
 * production — a real R2 binding, in real workerd. Every case names a session
 * id of its own (see the suite), so nothing here depends on `reset()` emptying
 * the bucket.
 */
import { env } from "cloudflare:test";
import { R2BlobStore } from "../src/blobs-r2.js";
import { describeBlobStoreContract } from "../tests/helpers/blob-store-contract.js";

const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;

describeBlobStoreContract("R2BlobStore", () => new R2BlobStore(bucket));
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `npm --prefix worker-tests run test -- blob-store-contract`
Expected: FAIL — `Cannot find module '../src/blobs-r2.js'`.

- [ ] **Step 4: Create `src/blobs-r2.ts`**

```ts
/// <reference types="@cloudflare/workers-types" />
import {
  BlobLengthError, OCTET_STREAM, blobKey, exactLength,
  type BlobMeta, type BlobPut, type BlobRead, type BlobStore,
} from "./blobs.js";

/**
 * The R2 half of the blob seam (#183, spec D1): one bucket, keyed
 * `rooms/<sessionId>/<id>`, the object's own metadata as the metadata —
 * `httpMetadata.contentType` as decided at upload, `customMetadata` carrying
 * the name, the uploading member and the time. No row anywhere describes a
 * blob: the one that holds the bytes is the one that cannot lie about them.
 *
 * Workers-only, and excluded from the Node build as store-do.ts is:
 * `FixedLengthStream` and the R2 types exist only in workerd. The root test
 * program runs the same contract over MemoryBlobStore; worker-tests runs it here.
 */
export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void> {
    const key = blobKey(sessionId, id);
    const options: R2PutOptions = {
      httpMetadata: { contentType: meta.type },
      // Strings only: that is what customMetadata holds.
      customMetadata: { name: meta.name, by: meta.by, at: String(meta.at) },
    };
    if (body instanceof ArrayBuffer) {
      // R2 would store a buffer of any length happily; an object is exactly as long as its metadata says.
      if (body.byteLength !== meta.bytes) throw new BlobLengthError(meta.bytes, body.byteLength);
      await this.bucket.put(key, body, options);
      return;
    }
    // R2 streams a body in only when it knows the length — "Provided readable
    // stream must have a known length" otherwise. A request body qualifies; the
    // stream the route rebuilt after reading its first bytes (readHead) does
    // not, so the body goes through a FixedLengthStream, which gives R2 its
    // length. The length RULE is not the FixedLengthStream's: it errors with its
    // own TypeError, which cannot be told from any other failure of the put.
    // `exactLength` runs ahead of it and errors with BlobLengthError first, and
    // the two halves are settled together so that error is the one thrown — the
    // class the route maps to 400 — and neither rejection is left unhandled.
    const fixed = new FixedLengthStream(meta.bytes);
    const [stored, piped] = await Promise.allSettled([
      this.bucket.put(key, fixed.readable, options),
      exactLength(body, meta.bytes).pipeTo(fixed.writable),
    ]);
    if (piped.status === "rejected" && piped.reason instanceof BlobLengthError) throw piped.reason;
    if (stored.status === "rejected") throw stored.reason;
    if (piped.status === "rejected") throw piped.reason;
  }

  async head(sessionId: string, id: string): Promise<BlobMeta | null> {
    const object = await this.bucket.head(blobKey(sessionId, id));
    return object ? metaOf(object) : null;
  }

  async get(sessionId: string, id: string, ifNoneMatch?: string): Promise<BlobRead> {
    const key = blobKey(sessionId, id);
    // The request's header as sent: R2 evaluates If-None-Match itself, weak
    // tags and lists included, which is why the store takes the raw value.
    // Asserted, not inferred: the conditional's branches are subtype-reduced to
    // `R2Object`, and `"body" in object` would then leave `body` as `unknown`.
    const object = (ifNoneMatch === undefined
      ? await this.bucket.get(key)
      : await this.bucket.get(key, { onlyIf: new Headers({ "if-none-match": ifNoneMatch }) })
    ) as R2ObjectBody | R2Object | null;
    if (!object) return null;
    // A precondition that held comes back as the object without a body.
    if (!("body" in object)) return { unchanged: true, etag: object.httpEtag };
    return { ...metaOf(object), body: object.body };
  }

  async delete(sessionId: string, id: string): Promise<void> {
    await this.bucket.delete(blobKey(sessionId, id));
  }
}

function metaOf(object: R2Object): BlobMeta {
  return {
    bytes: object.size,
    type: object.httpMetadata?.contentType ?? OCTET_STREAM,
    name: object.customMetadata?.name ?? "",
    by: object.customMetadata?.by ?? "",
    at: Number(object.customMetadata?.at ?? 0),
    etag: object.httpEtag,
  };
}
```

The ArrayBuffer branch checks the length itself and throws the same class, because R2 would store a buffer of any length happily and the contract pins that an object is exactly as long as its metadata says.

- [ ] **Step 5: Keep the Node build and the root typecheck clear of it**

In `tsconfig.json`: `"exclude": ["src/worker.ts", "src/store-do.ts", "src/oauth/store.ts", "src/blobs-r2.ts"]`.

In `tsconfig.test.json`, the `exclude` list gains `"src/blobs-r2.ts"` after `"src/oauth/store.ts"`, and the comment above it gains: "`src/blobs-r2.ts` (#183) is a Workers file for the same reason, and is kept out the same way."

In `tests/projections.test.ts`, the `it.each` table of roots gains a row, and so does the "resolves every local specifier" case:

```ts
  it.each([
    ["projections.ts", resolve(SRC, "projections.ts")],
    ["public-event.ts", resolve(SRC, "public-event.ts")],
    ["rooms.ts", resolve(SRC, "rooms.ts")],
    ["blobs.ts", resolve(SRC, "blobs.ts")],
  ])("%s pulls in no runtime, transitively", (_name, entry) => {
```

```ts
    reachable(resolve(SRC, "rooms.ts"));
    reachable(resolve(SRC, "blobs.ts"));
    expect(unresolved).toEqual([]);
```

(`http/rooms.ts` joins both lists in Task 6, when it exists.) Add to the file's docblock: "`src/blobs.ts` is the fourth root (#183): the blob seam both the routes and the tool handlers import, with `blobs-r2.ts` the Workers half it must never reach."

- [ ] **Step 6: Typecheck both programs and run the contract in workerd**

Run: `npm run typecheck && npx vitest run tests/projections.test.ts && npm run typecheck:worker; npm --prefix worker-tests run test -- blob-store-contract`
Expected: the Node typecheck and the walk pass; `npm run typecheck:worker` names exactly one error, `src/worker.ts` calling `buildServer` with two arguments (Task 7 supplies the third); the nine contract cases pass against `R2BlobStore`, "refuses a body whose length is not the declared one" among them — which is the proof that a short or long body is refused with `BlobLengthError` in workerd, not only in memory.

- [ ] **Step 7: Break the length declaration, the length rule and the metadata to see the controls**

In `R2BlobStore.put`, replace the stream branch (from `const fixed = …` to the last `if (piped.status …)` line) with `await this.bucket.put(key, body, options);`. Run `npm --prefix worker-tests run test -- blob-store-contract`: every stream case goes red with `TypeError: Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)`. Restore.

Then, in the same branch, replace `exactLength(body, meta.bytes)` with `body`. Run the same: "refuses a body whose length is not the declared one" goes red on `the put must be refused` — the stream cases are refused by `FixedLengthStream`'s own error, which is not a `BlobLengthError` — and the other eight cases stay green. That is the contract doing its job for Review Focus 1. Restore.

Then in `metaOf`, read `bytes: 0`. Run the same: "put then head returns the metadata" goes red (`bytes: 0` where `8` was expected). Restore.

- [ ] **Step 8: Commit**

```bash
git add src/blobs-r2.ts tsconfig.json tsconfig.test.json tests/projections.test.ts wrangler.toml worker-tests/wrangler.toml worker-tests/README.md worker-tests/blob-store-contract.test.ts
git -c commit.gpgsign=true commit -S -m "Put a room's bytes in R2 under the room's prefix, and run the blob contract in workerd"
```

---

### Task 6: The doors — `src/http/rooms.ts`: upload, download, and the tests over the memory stores

**Files:**
- Create: `src/http/rooms.ts`
- Create: `tests/http-blobs.test.ts`
- Modify: `tests/projections.test.ts` (a fifth root)

**Interfaces:**
- Produces: `interface RoomCaller { identity: Identity; via: "bearer" | "cookie" }`, `interface RoomRouteDeps { store: BellmanStore; blobs: BlobStore; caller: (request: Request) => Promise<RoomCaller | null>; panelOrigins: readonly string[] }`, `roomRoutes(request: Request, deps: RoomRouteDeps): Promise<Response | undefined>` — `undefined` for a path outside `/rooms/`, a `Response` for everything under it.
- Consumes: `gateSeat`, `findMember`, `RoomFailure` (rooms.ts); `isRemovedMember`, `BellmanStore` (store.ts); everything named from `src/blobs.ts`; `allowedOrigin`, `corsHeaders`, `csrfRefusal`, `preflightResponse` (`src/oauth/browser.ts`).

The ceiling the route pre-checks is the room's own `blobBytesCeiling`, read off the record `gateSeat` returns; the charge reads the same record, so no route consults a plan. Two rulings. A stranger's 404 is decided by the route's own `findMember` before `gateSeat` runs, so the gate's `forbidden` means the seat — it left, or lacks the verb — and is 403; the gate's codes are otherwise mapped through a closed table. A member a creator removed is refused 403, not 404: it is not a stranger, and `/ws` answers 403 for an identity that owns only removed handles.

- [ ] **Step 1: Write the failing tests**

Create `tests/http-blobs.test.ts`:

```ts
/**
 * The room blob routes (#183) over MemoryStore and MemoryBlobStore: the upload
 * door and its order of refusals, the put-then-charge, and the download under
 * membership with the headers spec D4 names. Driven directly — a web Request
 * in, a Response out — with no listener, which is why the module is
 * runtime-free. Who is calling is a stub over the dev keys: the seam under
 * test is the route, and the cookie session store has tests/panel-session.test.ts.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolveIdentity } from "../src/auth.js";
import {
  MAX_BLOB_BYTES, MAX_BLOB_NAME_CHARS, MemoryBlobStore, blobBytesUsed, newBlobId, type BlobPut,
} from "../src/blobs.js";
import { roomRoutes, type RoomCaller, type RoomRouteDeps } from "../src/http/rooms.js";
import { MemoryStore, type BlobCharge } from "../src/store.js";
import { PNG, text } from "./helpers/blob-bytes.js";
import { member, session } from "./helpers/fixtures.js";
import { DEV_KEY } from "./helpers/harness.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";
const ROOM = "qs_blobs";

/** A blob store that remembers every put, so a test can show nothing was stored, or that a refusal cleaned up. */
class RecordingBlobStore extends MemoryBlobStore {
  puts: { sessionId: string; id: string }[] = [];
  override async put(sessionId: string, id: string, body: ReadableStream<Uint8Array> | ArrayBuffer, meta: BlobPut): Promise<void> {
    this.puts.push({ sessionId, id });
    return super.put(sessionId, id, body, meta);
  }
}

let store: MemoryStore;
let blobs: RecordingBlobStore;
let deps: RoomRouteDeps;

/** Bearer: a dev key. Cookie: the dev key as the cookie's value, read straight off it. */
const caller = async (request: Request): Promise<RoomCaller | null> => {
  const bearer = resolveIdentity(request.headers.get("authorization") ?? undefined);
  if (bearer) return { identity: bearer, via: "bearer" };
  const cookie = /bellman_session=([^;]+)/.exec(request.headers.get("cookie") ?? "")?.[1];
  const identity = cookie ? resolveIdentity(`Bearer ${cookie}`) : null;
  return identity ? { identity, via: "cookie" } : null;
};

beforeEach(async () => {
  store = new MemoryStore();
  blobs = new RecordingBlobStore();
  deps = { store, blobs, caller, panelOrigins: [PANEL] };
  // jesse (peer_a) holds write_surface; peer (peer_b) does not; outsider holds no
  // handle. The ceiling is the room's, stamped on its record (D3): small, so the
  // quota cases need no large bodies.
  await store.createSession(session({
    id: ROOM,
    blobBytesCeiling: 1024,
    members: [member(), member({ memberId: "m_peer", userId: "u_peer", label: "peer@codenerd", roomRole: "peer_b" })],
  }));
});

interface UploadOptions {
  member?: string | null;
  name?: string | null;
  type?: string;
  /** null leaves Content-Length off; undefined sets it from the body. */
  length?: string | null;
  headers?: Record<string, string>;
  room?: string;
  cookie?: string;
  /** Replaces the body: a stream the test can watch, or null for no body at all. */
  body?: ReadableStream<Uint8Array> | null;
}

function uploadRequest(key: string | null, body: Uint8Array<ArrayBuffer> | string, over: UploadOptions = {}): Request {
  const bytes = typeof body === "string" ? text(body) : body;
  const headers: Record<string, string> = { "content-type": over.type ?? "text/plain", ...(over.headers ?? {}) };
  if (key) headers.authorization = `Bearer ${key}`;
  if (over.cookie) headers.cookie = `__Host-bellman_session=${over.cookie}`;
  if (over.length !== null) headers["content-length"] = over.length ?? String(bytes.byteLength);
  const url = new URL(`${ISSUER}/rooms/${over.room ?? ROOM}/blobs`);
  if (over.member !== null) url.searchParams.set("member_id", over.member ?? "m_creator");
  if (over.name !== null) url.searchParams.set("name", over.name ?? "notes.txt");
  const init: RequestInit & { duplex?: "half" } = { method: "POST", headers, body: over.body === undefined ? bytes : over.body };
  if (over.body instanceof ReadableStream) init.duplex = "half";
  return new Request(url, init);
}

const upload = (key: string | null, body: Uint8Array<ArrayBuffer> | string, over: UploadOptions = {}) =>
  roomRoutes(uploadRequest(key, body, over), deps);
const download = (key: string | null, id: string, headers: Record<string, string> = {}, room = ROOM) =>
  roomRoutes(
    new Request(`${ISSUER}/rooms/${room}/blobs/${id}`, {
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
    }),
    deps,
  );
const used = async () => blobBytesUsed((await store.getSession(ROOM))!);

/** An upload that must land, answering what it stored. */
async function stored(body: Uint8Array<ArrayBuffer> | string, over: UploadOptions = {}) {
  const res = (await upload(DEV_KEY.jesse, body, over))!;
  expect(res.status, await res.clone().text()).toBe(201);
  return (await res.json()) as { blob_id: string; bytes: number; type: string; name: string };
}

/** A store whose charge always refuses with `reason`, standing in for a room that changed while the bytes were in flight. */
function refusingStore(reason: "frozen" | "closed" | "over_quota" | "not_found"): MemoryStore {
  return new (class extends MemoryStore {
    override async chargeBlobBytes(): Promise<BlobCharge> {
      return { ok: false, reason, used: 0 };
    }
  })();
}

describe("POST /rooms/:id/blobs", () => {
  it("stores the bytes, answers 201 with the id and what it stored, and charges the room", async () => {
    const out = await stored("hello", { name: "hello.txt", type: "text/plain" });
    expect(out).toEqual({ blob_id: expect.stringMatching(/^[a-f0-9]{32}$/), bytes: 5, type: "text/plain", name: "hello.txt" });
    expect(await blobs.head(ROOM, out.blob_id)).toMatchObject({ bytes: 5, type: "text/plain", name: "hello.txt", by: "m_creator" });
    expect(await used()).toBe(5);
  });

  it("accepts an empty file", async () => {
    const out = await stored("", { name: "empty.txt", length: "0", body: null });
    expect(out.bytes).toBe(0);
    expect(await blobs.head(ROOM, out.blob_id)).toMatchObject({ bytes: 0 });
  });

  it("answers 401 with no credential, and stores nothing", async () => {
    expect((await upload(null, "x"))!.status).toBe(401);
    expect(blobs.puts).toEqual([]);
  });

  it("answers 404 to a stranger, to a handle that is not the caller's, and for an unknown room alike", async () => {
    const stranger = (await upload(DEV_KEY.outsider, "x"))!;
    const notTheirs = (await upload(DEV_KEY.peer, "x", { member: "m_creator" }))!;
    const unknown = (await upload(DEV_KEY.jesse, "x", { room: "qs_nowhere" }))!;
    expect([stranger.status, notTheirs.status, unknown.status]).toEqual([404, 404, 404]);
    expect(await stranger.text()).toBe(await unknown.text());
    expect(blobs.puts).toEqual([]);
  });

  it("answers 403 to a seat without write_surface, naming the verb, and to a seat that has left", async () => {
    const verbless = (await upload(DEV_KEY.peer, "x", { member: "m_peer" }))!;
    expect(verbless.status).toBe(403);
    expect(await verbless.text()).toContain("write_surface");
    await store.updateMember(ROOM, "m_creator", { leftAt: Date.now() });
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(403);
    expect(blobs.puts).toEqual([]);
  });

  it("answers 411 without a length and 413 over the cap or the quota, before a byte is read", async () => {
    let reads = 0;
    const untouched = () =>
      new ReadableStream<Uint8Array>({
        pull() {
          reads++;
          throw new Error("the body was read");
        },
      });
    expect((await upload(DEV_KEY.jesse, "x", { length: null, body: untouched() }))!.status).toBe(411);
    expect((await upload(DEV_KEY.jesse, "x", { length: "abc", body: untouched() }))!.status).toBe(411);
    expect((await upload(DEV_KEY.jesse, "x", { length: "-1", body: untouched() }))!.status).toBe(411);
    const overCap = (await upload(DEV_KEY.jesse, "x", { length: String(MAX_BLOB_BYTES + 1), body: untouched() }))!;
    expect(overCap.status).toBe(413);
    expect(await overCap.json()).toMatchObject({ error: "too_large" });
    // The cap itself passes the header check; the quota's courtesy check then
    // refuses it from the record, still without a byte read.
    const atCap = (await upload(DEV_KEY.jesse, "x", { length: String(MAX_BLOB_BYTES), body: untouched() }))!;
    expect(atCap.status).toBe(413);
    expect(await atCap.json()).toMatchObject({ error: "over_quota" });
    expect(reads, "no byte read before any of these").toBe(0);
    expect(blobs.puts).toEqual([]);
  });

  it("refuses a cookie upload without an allowlisted Origin, and accepts one from the panel with CORS", async () => {
    const forged = (await upload(null, "x", { cookie: DEV_KEY.jesse }))!;
    expect(forged.status).toBe(403);
    expect(await forged.text()).toContain("Origin");
    expect((await upload(null, "x", { cookie: DEV_KEY.jesse, headers: { origin: "https://evil.example" } }))!.status).toBe(403);
    expect(blobs.puts).toEqual([]);
    // The control: the same cookie from the panel lands, and a bearer needs no Origin.
    const fromPanel = (await upload(null, "x", { cookie: DEV_KEY.jesse, headers: { origin: PANEL } }))!;
    expect(fromPanel.status).toBe(201);
    expect(fromPanel.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(fromPanel.headers.get("access-control-allow-credentials")).toBe("true");
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(201);
  });

  it("refuses an over-quota upload before the bytes move, against the room's own ceiling", async () => {
    await store.createSession(session({ id: "qs_small", blobBytesCeiling: 10, members: [member()] }));
    const small = { room: "qs_small" };
    const usedSmall = async () => blobBytesUsed((await store.getSession("qs_small"))!);
    const TEN = "0123456789";
    const ELEVEN = "0123456789a";
    const refused = (await upload(DEV_KEY.jesse, ELEVEN, small))!;
    expect(refused.status).toBe(413);
    expect(await refused.json()).toMatchObject({ error: "over_quota", used: 0, ceiling: 10 });
    expect(blobs.puts).toEqual([]);
    expect(await usedSmall()).toBe(0);
    // The controls: ten bytes fit exactly, the next byte is refused, and the
    // same eleven bytes land in the room whose record says 1024.
    expect((await upload(DEV_KEY.jesse, TEN, small))!.status).toBe(201);
    expect(await usedSmall()).toBe(10);
    expect((await upload(DEV_KEY.jesse, "x", small))!.status).toBe(413);
    expect((await upload(DEV_KEY.jesse, ELEVEN))!.status).toBe(201);
  });

  it("deletes the object when the charge refuses after the put (D3: put, then charge)", async () => {
    for (const [reason, status] of [["frozen", 409], ["closed", 409], ["over_quota", 413], ["not_found", 404]] as const) {
      const refusing = refusingStore(reason);
      await refusing.createSession(session({ id: ROOM, members: [member()] }));
      const before = blobs.puts.length;
      const res = (await roomRoutes(uploadRequest(DEV_KEY.jesse, "bytes in flight"), { ...deps, store: refusing }))!;
      expect(res.status, reason).toBe(status);
      expect(await res.json(), reason).toMatchObject({ error: reason });
      expect(blobs.puts, "the object was put before the charge decided").toHaveLength(before + 1);
      expect(await blobs.head(ROOM, blobs.puts[before].id), "and deleted when the charge refused").toBeNull();
    }
  });

  // Review Focus 1. The route maps one class, and both stores throw it (Tasks 1 and 5), so this
  // answer is the same over R2.
  it("stores and charges nothing for a body that ends short of its Content-Length", async () => {
    const res = (await upload(DEV_KEY.jesse, "short", { length: "10" }))!;
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: "invalid_request",
      error_description: "body did not match Content-Length: 10 bytes declared, 5 received",
    });
    expect(blobs.puts).toHaveLength(1);
    expect(await blobs.head(ROOM, blobs.puts[0].id)).toBeNull();
    expect(await used()).toBe(0);
  });

  it("stores a claimed PNG that is not one as an octet-stream, and a real one as image/png (D6)", async () => {
    expect((await stored("<html>not a png</html>", { name: "fake.png", type: "image/png" })).type).toBe("application/octet-stream");
    expect((await stored(PNG, { name: "real.png", type: "image/png" })).type).toBe("image/png");
    expect((await stored("<svg xmlns='http://www.w3.org/2000/svg'/>", { name: "v.svg", type: "image/svg+xml" })).type).toBe("application/octet-stream");
    expect((await stored("# notes", { name: "n.md", type: "text/markdown; charset=utf-8" })).type).toBe("text/markdown");
  });

  // Review Focus 4.
  it("treats the name as a label: stripped of paths and control characters, bounded, required", async () => {
    expect((await stored("x", { name: "../../etc/passwd" })).name).toBe("....etcpasswd");
    expect((await stored("x", { name: " résumé (1).pdf " })).name).toBe("résumé (1).pdf");
    expect((await stored("x", { name: "a\u0000b\nc.txt" })).name).toBe("abc.txt");
    for (const name of [null, "", "///", "n".repeat(MAX_BLOB_NAME_CHARS + 1)]) {
      expect((await upload(DEV_KEY.jesse, "x", { name }))!.status, JSON.stringify(name)).toBe(400);
    }
    expect((await upload(DEV_KEY.jesse, "x", { member: null }))!.status).toBe(400);
  });

  it("refuses an upload into a frozen room and a closed one with 409", async () => {
    await store.freezeSession(ROOM, Date.now());
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(409);
    await store.freezeSession(ROOM, null);
    await store.closeSession(ROOM);
    expect((await upload(DEV_KEY.jesse, "x"))!.status).toBe(409);
    expect(blobs.puts).toEqual([]);
  });

  it("answers a preflight for the panel, 405 for the wrong method, and leaves other paths alone", async () => {
    const pre = (await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/blobs`, { method: "OPTIONS", headers: { origin: PANEL } }), deps))!;
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    const wrong = (await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/blobs`, { headers: { authorization: `Bearer ${DEV_KEY.jesse}` } }), deps))!;
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get("allow")).toBe("POST");
    expect((await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/nothing`), deps))!.status).toBe(404);
    expect(await roomRoutes(new Request(`${ISSUER}/account`), deps)).toBeUndefined();
  });
});

describe("GET /rooms/:id/blobs/:blobId", () => {
  it("serves an image inline as stored, with nosniff, sandbox, a private cache, an ETag, its length and CORS", async () => {
    const { blob_id } = await stored(PNG, { name: "real.png", type: "image/png" });
    const res = (await download(DEV_KEY.jesse, blob_id, { origin: PANEL }))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("content-disposition")).toBeNull();
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("sandbox");
    expect(res.headers.get("cache-control")).toBe("private, max-age=300");
    expect(res.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(res.headers.get("etag")).toMatch(/^".+"$/);
    expect(res.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(res.headers.get("vary")).toBe("Origin");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("serves everything else as an octet-stream download — the SVG, the false PNG and the HTML included — never as HTML", async () => {
    const cases = [
      await stored("<!doctype html><script>alert(1)</script>", { name: "page.html", type: "text/html" }),
      await stored("<svg xmlns='http://www.w3.org/2000/svg'/>", { name: "v.svg", type: "image/svg+xml" }),
      await stored("<html>not a png</html>", { name: "fake.png", type: "image/png" }),
      await stored("# notes", { name: "résumé (1).md", type: "text/markdown" }),
    ];
    for (const { blob_id, name } of cases) {
      const res = (await download(DEV_KEY.jesse, blob_id))!;
      expect(res.status, name).toBe(200);
      expect(res.headers.get("content-type"), name).toBe("application/octet-stream");
      expect(res.headers.get("content-disposition"), name).toMatch(/^attachment; filename\*=UTF-8''/);
      expect(res.headers.get("x-content-type-options"), name).toBe("nosniff");
      expect(res.headers.get("content-security-policy"), name).toBe("sandbox");
    }
    const md = cases[3];
    expect((await download(DEV_KEY.jesse, md.blob_id))!.headers.get("content-disposition"))
      .toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.md");
  });

  it("answers 304 to a matching If-None-Match, with the ETag, CORS and no body", async () => {
    const { blob_id } = await stored("cached", { name: "c.txt" });
    const etag = (await download(DEV_KEY.jesse, blob_id))!.headers.get("etag")!;
    const again = (await download(DEV_KEY.jesse, blob_id, { "if-none-match": etag, origin: PANEL }))!;
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(again.headers.get("cache-control")).toBe("private, max-age=300");
    expect(again.headers.get("access-control-allow-origin")).toBe(PANEL);
    expect(await again.text()).toBe("");
    expect((await download(DEV_KEY.jesse, blob_id, { "if-none-match": '"something-else"' }))!.status).toBe(200);
  });

  it("answers 401 with no credential, and 404 to a stranger, for an unknown room, an unknown id and a malformed one alike", async () => {
    const { blob_id } = await stored("x");
    expect((await download(null, blob_id))!.status).toBe(401);
    const stranger = (await download(DEV_KEY.outsider, blob_id))!;
    const unknownRoom = (await download(DEV_KEY.jesse, blob_id, {}, "qs_nowhere"))!;
    const unknownId = (await download(DEV_KEY.jesse, newBlobId()))!;
    const malformed = (await download(DEV_KEY.jesse, "zz".repeat(16)))!;
    for (const res of [stranger, unknownRoom, unknownId, malformed]) expect(res.status).toBe(404);
    expect(await stranger.text()).toBe(await unknownRoom.text());
    const posted = (await roomRoutes(new Request(`${ISSUER}/rooms/${ROOM}/blobs/${blob_id}`, { method: "POST", headers: { authorization: `Bearer ${DEV_KEY.jesse}` } }), deps))!;
    expect(posted.status).toBe(405);
    expect(posted.headers.get("allow")).toBe("GET");
  });

  it("serves a member whatever its verbs, one who left or timed out, a closed room and a frozen one", async () => {
    const { blob_id } = await stored("x");
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    // A departure and a timed-out seat are one record: leftAt set, no cut.
    await store.updateMember(ROOM, "m_peer", { leftAt: Date.now() });
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    await store.freezeSession(ROOM, Date.now());
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    await store.freezeSession(ROOM, null);
    await store.closeSession(ROOM);
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(200);
    expect((await download(DEV_KEY.jesse, blob_id))!.status).toBe(200);
  });

  it("refuses a member a creator removed, as /ws does", async () => {
    const { blob_id } = await stored("x");
    const evicted = await store.appendEvent(ROOM, {
      type: "member_evicted", fromMemberId: "system", fromUserId: "u_jesse", fromLabel: "jesse@codenerd",
      payload: { member_id: "m_peer" }, refId: null,
    }, { markRemoved: "m_peer" });
    expect(evicted).not.toBeNull();
    expect((await download(DEV_KEY.peer, blob_id))!.status).toBe(403);
    // The control: the creator still reads it.
    expect((await download(DEV_KEY.jesse, blob_id))!.status).toBe(200);
  });
});

```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npx vitest run tests/http-blobs.test.ts`
Expected: FAIL — `Cannot find module '../src/http/rooms.js'`.

- [ ] **Step 3: Create `src/http/rooms.ts`**

```ts
/**
 * The HTTP room routes (#183; #49 is where the rest go): the two doors a
 * room's bytes pass through — `POST /rooms/:id/blobs` and
 * `GET /rooms/:id/blobs/:blobId` — and where piece 3's room routes go next.
 *
 * Runtime-free, like rooms.ts: a web Request in, a Response out, so the Worker
 * dispatches here and the root test program drives the same code over
 * MemoryStore and MemoryBlobStore with no listener. Who is calling is handed in
 * (`deps.caller`): the Worker composes it from the bearer paths /mcp takes and
 * the authorization server's own `caller`, so what counts as a caller cannot
 * differ between a tool and a route (spec D2).
 *
 * A transport's job is translation. `gateSeat` decides and this maps its code
 * to a status, the way rooms.ts says a route should; `RoomFailure` is a closed
 * union, so a code the table below forgets is a compile error.
 */
import {
  BlobLengthError, MAX_BLOB_BYTES, MAX_BLOB_NAME_CHARS, OCTET_STREAM, SNIFF_BYTES,
  attachmentDisposition, blobBytesUsed, blobKey, isBlobId, isImageType, newBlobId, readHead,
  sanitizeName, storedType, type BlobStore,
} from "../blobs.js";
import { allowedOrigin, corsHeaders, csrfRefusal, preflightResponse } from "../oauth/browser.js";
import { findMember, gateSeat, type RoomFailure } from "../rooms.js";
import { isRemovedMember, type BellmanStore } from "../store.js";
import type { Identity } from "../types.js";

/** Who is calling a room route, and how. `via` feeds the CSRF check and nothing else. */
export interface RoomCaller {
  identity: Identity;
  via: "bearer" | "cookie";
}

export interface RoomRouteDeps {
  store: BellmanStore;
  blobs: BlobStore;
  /** Bearer or cookie, or null. The Worker builds it from `resolveCaller` and the OAuth `caller`. */
  caller: (request: Request) => Promise<RoomCaller | null>;
  /** The panel's origins: CORS, the preflight, and the CSRF check. */
  panelOrigins: readonly string[];
}

const UPLOAD = /^\/rooms\/([^/]+)\/blobs$/;
const DOWNLOAD = /^\/rooms\/([^/]+)\/blobs\/([^/]+)$/;

/** A refusal's status from the code the operation answered with. Closed: a new code is a compile error here. */
const STATUS: Record<RoomFailure, number> = {
  not_found: 404, closed: 409, frozen: 409, forbidden: 403, conflict: 409, invalid: 400,
};

// ponytail: five minutes of private caching, not tuned. It is also how long a
// browser may go on serving bytes to a member removed in the meantime; the
// cut is enforced at the route, not in a cache.
/** The headers every download carries (D4), on a 200 and a 304 alike. */
const DOWNLOAD_HEADERS = {
  "cache-control": "private, max-age=300",
  "x-content-type-options": "nosniff",
  "content-security-policy": "sandbox",
} as const;

const json = (status: number, body: unknown, origin: string | undefined) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(origin) },
  });

/** The shape the OAuth routes answer errors in, so the panel reads one error form. */
const problem = (status: number, error: string, description: string, origin: string | undefined) =>
  json(status, { error, error_description: description }, origin);

const overQuota = (used: number, ceiling: number, bytes: number, origin: string | undefined) =>
  json(413, {
    error: "over_quota",
    error_description: `this room holds ${used} of ${ceiling} bytes, and ${bytes} more would pass its plan's ceiling`,
    used,
    ceiling,
  }, origin);

const methodNotAllowed = (allow: string, origin: string | undefined) =>
  new Response("Method not allowed", { status: 405, headers: { allow, ...corsHeaders(origin) } });

/**
 * The room routes. `undefined` for a path outside `/rooms/`, so the Worker
 * carries on to the next module; everything under the prefix is answered here,
 * a path this module does not know included.
 */
export async function roomRoutes(request: Request, deps: RoomRouteDeps): Promise<Response | undefined> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  if (!path.startsWith("/rooms/")) return undefined;
  const origin = allowedOrigin(request, deps.panelOrigins);
  // The panel's upload sets a Content-Type that is not a simple one, so the
  // browser asks first. 204 either way: a stranger's preflight carries no grant.
  if (request.method === "OPTIONS") return preflightResponse(origin);

  const upload = UPLOAD.exec(path);
  if (upload) {
    if (request.method !== "POST") return methodNotAllowed("POST", origin);
    return uploadBlob(request, url, upload[1], origin, deps);
  }
  const download = DOWNLOAD.exec(path);
  if (download) {
    if (request.method !== "GET") return methodNotAllowed("GET", origin);
    return downloadBlob(request, download[1], download[2], origin, deps);
  }
  return problem(404, "not_found", "no such route", origin);
}

/**
 * The upload door (D2, D3). Everything that can be refused from the headers is,
 * before a byte of the body is read: the caller, the CSRF check for a cookie,
 * the parameters, the length and the cap. Then the room's own guards through
 * `gateSeat` — the same gate the tool runs — the quota's courtesy check, and
 * only then the body: a head to decide the type (D6), the put, the charge, and
 * a delete if the charge refused.
 */
async function uploadBlob(
  request: Request,
  url: URL,
  sessionId: string,
  origin: string | undefined,
  deps: RoomRouteDeps,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);
  // Before anything that writes: gateSeat touches the caller's lastSeenAt, and a
  // forged request must not do even that. Bearer callers are exempt.
  const refusal = csrfRefusal(request, who.via, origin);
  if (refusal) return refusal;

  const memberId = url.searchParams.get("member_id") ?? "";
  if (!memberId) return problem(400, "invalid_request", "member_id is required", origin);
  const name = sanitizeName(url.searchParams.get("name"));
  if (name === null) {
    return problem(
      400, "invalid_request",
      `name is required: 1 to ${MAX_BLOB_NAME_CHARS} characters once path separators and control characters are stripped`,
      origin,
    );
  }

  // From the header, before a byte is read: the cap is enforced here, and R2
  // streams a body in only against a declared length.
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared))) {
    return problem(411, "length_required", "Content-Length is required, as a non-negative integer", origin);
  }
  const bytes = Number(declared);
  if (bytes > MAX_BLOB_BYTES) return problem(413, "too_large", `a blob is at most ${MAX_BLOB_BYTES} bytes`, origin);

  // A stranger's answer is the unknown room's answer: a handle that is not the
  // caller's is 404 here, before the gate, whose `forbidden` then means the seat
  // — it left, or lacks the verb — and is 403.
  const found = await deps.store.getSession(sessionId);
  if (!found || !findMember(found, memberId, who.identity)) {
    return problem(404, "not_found", "no such room, or no member of yours in it", origin);
  }
  const gate = await gateSeat(deps.store, who.identity, sessionId, memberId, "write_surface");
  if (!gate.ok) return problem(STATUS[gate.code], gate.code, gate.reason, origin);
  const session = gate.value;

  // The courtesy check (D3), against the ceiling stamped on the room at creation
  // from the plan that made it (`blobBytesCeiling`, as `maxMembers` is): a
  // hopeless upload is refused before the bytes move. The charge below is the
  // bound, and reads the same record inside the room object.
  const ceiling = session.blobBytesCeiling;
  const used = blobBytesUsed(session);
  if (used + bytes > ceiling) return overQuota(used, ceiling, bytes, origin);

  // No body arrives as null; a zero-byte file is a file.
  const body = request.body ?? new ReadableStream<Uint8Array>({ start: (controller) => controller.close() });
  const { head, rest } = await readHead(body, SNIFF_BYTES);
  const type = storedType(request.headers.get("content-type"), head);
  const id = newBlobId();
  try {
    await deps.blobs.put(sessionId, id, rest, { bytes, type, name, by: memberId, at: Date.now() });
  } catch (err) {
    // The one class both stores throw for a body that is not its declared length (Task 1's
    // contract, run over R2 by Task 5): a client that died mid-body, or lied.
    if (err instanceof BlobLengthError) return problem(400, "invalid_request", err.message, origin);
    throw err;
  }

  // Put, then charge (D3). A refused charge — over quota, or a room that froze
  // or closed while the bytes were in flight — deletes the object; a delete that
  // fails leaves an orphan the prefix finds (#65). The other order was rejected
  // in the spec: a charge reserved for a body that never completes is a phantom
  // nothing can list, where an orphan costs storage and is findable.
  const charge = await deps.store.chargeBlobBytes(sessionId, bytes);
  if (!charge.ok) {
    await deps.blobs.delete(sessionId, id).catch((err: unknown) => {
      console.error(`orphaned blob ${blobKey(sessionId, id)} after a refused charge:`, err);
    });
    if (charge.reason === "over_quota") return overQuota(charge.used, ceiling, bytes, origin);
    if (charge.reason === "not_found") return problem(404, "not_found", "no such room", origin);
    return problem(409, charge.reason, `the room is ${charge.reason} and takes no upload`, origin);
  }
  return json(201, { blob_id: id, bytes, type, name }, origin);
}

/**
 * The download door (D4). Membership is the rule: an identity holding a handle
 * a `/ws` watch would admit — in the room, left of its own accord, or timed
 * out. A member a creator removed is refused, as `/ws` refuses it (#113): the
 * cut bounds what it reads, and a blob carries no cursor to compare with. A
 * closed room serves, as every read of a closed room does, and so does a
 * frozen one. An unknown room, a room the caller is no member of, an unknown
 * id and a malformed one are one answer, so a stranger learns nothing.
 */
async function downloadBlob(
  request: Request,
  sessionId: string,
  blobId: string,
  origin: string | undefined,
  deps: RoomRouteDeps,
): Promise<Response> {
  const who = await deps.caller(request);
  if (!who) return problem(401, "unauthorized", "sign in, or send a bearer token", origin);

  const notFound = () => problem(404, "not_found", "no such blob", origin);
  const session = await deps.store.getSession(sessionId);
  const mine = session?.members.filter((m) => m.userId === who.identity.userId) ?? [];
  if (!session || mine.length === 0) return notFound();
  if (mine.every(isRemovedMember)) {
    return problem(403, "forbidden", "a member the room's creator removed cannot read its blobs", origin);
  }
  if (!isBlobId(blobId)) return notFound();

  const read = await deps.blobs.get(sessionId, blobId, request.headers.get("if-none-match") ?? undefined);
  if (read === null) return notFound();
  const headers: Record<string, string> = { ...DOWNLOAD_HEADERS, ...corsHeaders(origin), etag: read.etag };
  if ("unchanged" in read) return new Response(null, { status: 304, headers });

  // As stored only for an image on the allowlist, served inline. Everything
  // else — a PDF, markdown, an SVG, an HTML artifact (piece 4) — is an
  // octet-stream download under its label. Nothing from here is ever text/html.
  const image = isImageType(read.type);
  headers["content-type"] = image ? read.type : OCTET_STREAM;
  headers["content-length"] = String(read.bytes);
  if (!image) headers["content-disposition"] = attachmentDisposition(read.name);
  return new Response(read.body, { status: 200, headers });
}
```

- [ ] **Step 4: Add the root to the walk**

In `tests/projections.test.ts`, add `["http/rooms.ts", resolve(SRC, "http/rooms.ts")],` to the `it.each` table and `reachable(resolve(SRC, "http/rooms.ts"));` to "resolves every local specifier". Add to the docblock: "`src/http/rooms.ts` is the fifth (#183): the routes the Worker dispatches to and the root program drives directly, which only holds while they import no runtime."

- [ ] **Step 5: Run the tests, the walk and the typecheck**

Run: `npx vitest run tests/http-blobs.test.ts tests/projections.test.ts && npm run typecheck`
Expected: PASS. If the first case answers 411, Node's `Request` dropped the `content-length` header — it keeps one a caller sets (checked against Node 22's undici before this plan was written), so that would be a header name typo in `uploadRequest`.

- [ ] **Step 6: Break four rules to see four controls**

Each separately, restoring between them, running `npx vitest run tests/http-blobs.test.ts`:

1. Delete the `await deps.blobs.delete(...)` call in `uploadBlob`: "deletes the object when the charge refuses after the put" goes red (`expected not null to be null`, "and deleted when the charge refused").
2. Change `if (bytes > MAX_BLOB_BYTES)` to `if (false)`: "answers 411 without a length and 413 over the cap" goes red — the over-cap request is answered `over_quota`, not `too_large` (`expected { error: 'over_quota' } to match { error: 'too_large' }`).
3. Delete `if (!image) headers["content-disposition"] = ...`: "serves everything else as an octet-stream download" goes red (`expected null to match /^attachment; .../`).
4. Delete the `mine.every(isRemovedMember)` branch: "refuses a member a creator removed" goes red (`expected 200 to be 403`).

- [ ] **Step 7: Commit**

```bash
git add src/http/rooms.ts tests/http-blobs.test.ts tests/projections.test.ts
git -c commit.gpgsign=true commit -S -m "Open the two doors a room's bytes pass through: upload under the seat gate, download under membership"
```

---

### Task 7: The two servers — the Worker's `BLOBS` binding, `/rooms/` ahead of the OAuth routes, `caller` exported and composed, the Node server's mount, and the proof in workerd

**Files:**
- Modify: `src/oauth/routes.ts` (`caller` exported)
- Modify: `src/worker.ts` (`WorkerEnv.BLOBS`, `roomCaller`, the dispatch, `buildServer`'s third argument)
- Modify: `src/app.ts` (the `/rooms` mount), `tests/http.test.ts` (one round trip)
- Create: `worker-tests/blobs-route.test.ts`

**Interfaces:**
- Produces: `export async function caller(request, config)` in `src/oauth/routes.ts`, unchanged in behaviour.
- Produces: `WorkerEnv.BLOBS: R2Bucket`; `roomCaller(request, env, oauth?): Promise<RoomCaller | null>` (module-private in `src/worker.ts`).
- Produces: `createApp(store, blobs)` mounts `/rooms` over the same `MemoryBlobStore` it hands `buildServer`, with the static key map as the only caller.
- Consumes: `roomRoutes`, `RoomCaller` (Task 6); `R2BlobStore` (Task 5).

- [ ] **Step 1: Write the failing workerd test**

Create `worker-tests/blobs-route.test.ts`:

```ts
/**
 * The Worker actually serves the room routes (#183, Review Focus 2).
 *
 * tests/http-blobs.test.ts proves the module over the memory stores. This
 * proves what only a request through the real `fetch` handler can: that the
 * `BLOBS` binding reaches `R2BlobStore`, that the charge lands in the real
 * SessionDO, that a key-map bearer resolves through `roomCaller`, and that a
 * body of the wrong length is a 400 over the real bucket. panel-wiring.test.ts
 * exists because a line exactly like these was once absent with every test
 * green. What no request here can see is the order of dispatch, `/rooms/` ahead
 * of the OAuth routes: `handleOAuth` answers `undefined` for it either way.
 * Task 7 Step 6 and Task 10 Step 2 check that order by line number instead.
 *
 * The key is the one vitest.config.ts binds (`qk_ws_test`, u_jesse), and the
 * room is created through the real DurableObjectStore with that identity in
 * the creator's seat, which holds write_surface. The bodies are streams, so the
 * explicit Content-Length is the only length a request has, as it is behind the
 * edge, which sets the header from the real body.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/worker.js";
import { DurableObjectStore } from "../src/store-do.js";
import { blobBytesUsed } from "../src/blobs.js";
import { member, session } from "../tests/helpers/fixtures.js";
import { stream, text } from "../tests/helpers/blob-bytes.js";

const ORIGIN = "https://mcp.example.test";
const KEY = "qk_ws_test";
const ROOM = "qs_blobs_route";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const workerEnv = env as unknown as Parameters<typeof worker.fetch>[1];
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(`${ORIGIN}${path}`, init), workerEnv, ctx);

describe("the Worker serves /rooms/:id/blobs", () => {
  it("uploads through the real binding, charges the real room object, and serves the bytes back", async () => {
    const store = new DurableObjectStore(workerEnv as never);
    await store.createSession(session({ id: ROOM, members: [member()] }));

    const body = text("# notes\n");
    const uploaded = await call(`/rooms/${ROOM}/blobs?member_id=m_creator&name=notes.md`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/markdown", "content-length": String(body.byteLength) },
      body: stream(body),
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id, bytes, type } = (await uploaded.json()) as { blob_id: string; bytes: number; type: string };
    expect(bytes).toBe(body.byteLength);
    expect(type).toBe("text/markdown");

    // The binding, not a memory store: the object is in the bucket under the room's prefix.
    const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;
    const object = await bucket.head(`rooms/${ROOM}/${blob_id}`);
    expect(object?.size).toBe(body.byteLength);
    expect(object?.customMetadata?.name).toBe("notes.md");

    // The charge landed in SessionDO, through the facade's chargeBlobBytes.
    expect(blobBytesUsed((await store.getSession(ROOM))!)).toBe(body.byteLength);

    const served = await call(`/rooms/${ROOM}/blobs/${blob_id}`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(body);
  });

  // From the room routes, not from the Worker's plain-text "Not found" fall-through: the body is
  // the module's own JSON, exactly.
  it("answers no credential 401 and a stranger 404 as the room routes' own JSON", async () => {
    const anonymous = await call(`/rooms/${ROOM}/blobs/0123456789abcdef0123456789abcdef`);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toEqual({ error: "unauthorized", error_description: "sign in, or send a bearer token" });
    const stranger = await call(`/rooms/qs_nowhere/blobs/0123456789abcdef0123456789abcdef`, {
      headers: { authorization: `Bearer ${KEY}` },
    });
    expect(stranger.status).toBe(404);
    expect(stranger.headers.get("content-type")).toBe("application/json");
    expect(await stranger.json()).toEqual({ error: "not_found", error_description: "no such blob" });
  });

  // Review Focus 1, end to end: the route maps `BlobLengthError` to 400, and over the real bucket
  // that class comes from `R2BlobStore` (Task 5), not from the memory store the route tests use.
  it("answers a body shorter than its Content-Length 400 over the real bucket, and charges and stores nothing", async () => {
    const room = "qs_blobs_short";
    const store = new DurableObjectStore(workerEnv as never);
    await store.createSession(session({ id: room, members: [member()] }));

    const short = await call(`/rooms/${room}/blobs?member_id=m_creator&name=short.txt`, {
      method: "POST",
      headers: { authorization: `Bearer ${KEY}`, "content-type": "text/plain", "content-length": "10" },
      body: stream(text("short")),
    });
    expect(short.status, await short.clone().text()).toBe(400);
    expect(await short.json()).toEqual({
      error: "invalid_request",
      error_description: "body did not match Content-Length: 10 bytes declared, 5 received",
    });

    const bucket = (env as unknown as { BLOBS: R2Bucket }).BLOBS;
    expect((await bucket.list({ prefix: `rooms/${room}/` })).objects).toEqual([]);
    expect(blobBytesUsed((await store.getSession(room))!)).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `npm --prefix worker-tests run test -- blobs-route`
Expected: FAIL — the uploads answer 404 `Not found` as plain text from the `/mcp` fall-through. (The pool bundles the Worker without typechecking, so the missing third `buildServer` argument does not stop the file from loading.)

If the cases answer 411 once the route is wired, workerd's `Request` did not keep the explicit `content-length` on a stream body, which is the only length these requests have; production never takes that path, because the edge sets the header from the real body. Report BLOCKED with the response. Task 6 pins the route's rule over the memory stores; what this file adds is the wiring, and there is no honest way to fake the header around it.

- [ ] **Step 3: Export `caller`**

In `src/oauth/routes.ts`, change `async function caller(` to `export async function caller(` and add to its docblock: "Exported for the room routes (#183), which the Worker composes it into so a route and a tool cannot disagree about who someone is."

- [ ] **Step 4: Wire the Worker**

In `src/worker.ts`, the imports (the `./auth.js` line is unchanged):

```ts
import { R2BlobStore } from "./blobs-r2.js";
import { roomRoutes, type RoomCaller } from "./http/rooms.js";
import { caller, handleOAuth, identityFromAccessToken, unauthorizedHeaders, type OAuthConfig } from "./oauth/routes.js";
```

In `WorkerEnv`, after `AUTH`:

```ts
  /** The room blob store (#183): one private bucket, keyed by room. */
  BLOBS: R2Bucket;
```

After `resolveCaller`:

```ts
/**
 * Who is calling a room route, and how (#183). The bearer paths /mcp takes —
 * an access token, then the key map — and then the panel cookie through the
 * authorization server's own `caller`, so a route and a tool cannot disagree
 * about who someone is. A bearer that is present and bad stops here: `caller`
 * sees the header, fails the token, and never falls through to a cookie.
 */
async function roomCaller(request: Request, env: WorkerEnv, oauth?: OAuthConfig): Promise<RoomCaller | null> {
  const identity = await resolveCaller(request, env, oauth);
  if (identity) return { identity, via: "bearer" };
  if (!oauth) return null;
  const who = await caller(request, oauth);
  return who ? { identity: who.identity, via: who.via } : null;
}
```

In `fetch`, after `const oauth = oauthConfig(request, env, store);`:

```ts
    const blobs = new R2BlobStore(env.BLOBS);
```

After the Stripe webhook branch and before `if (oauth) { const handled = await handleOAuth(...) }`:

```ts
    // The room routes (#183), ahead of the OAuth routes: /rooms/ is that
    // module's prefix. An upload is a write, so the fail-closed guard /ws has
    // covers it too — a deploy with neither a key map nor OAuth serves no room.
    if (url.pathname.startsWith("/rooms/")) {
      const blocked = unconfigured(env, oauth);
      if (blocked) return blocked;
      const handled = await roomRoutes(request, {
        store,
        blobs,
        caller: (req) => roomCaller(req, env, oauth),
        panelOrigins: oauth?.panelOrigins ?? [],
      });
      if (handled) return handled;
    }
```

And the `/mcp` branch: `const server = buildServer(identity, store, blobs);`.

- [ ] **Step 5: Typecheck the Worker and run the two workerd files**

Run: `npm run typecheck:worker && npm --prefix worker-tests run test -- blobs-route panel-wiring`
Expected: both clean; the three new cases pass against the real Worker, bucket and object.

- [ ] **Step 6: Break the dispatch and the caller to see the controls, and check the order no request can see**

The order first. No request can see whether `/rooms/` is dispatched ahead of the OAuth routes — `handleOAuth` answers `undefined` for it either way — so this command checks the two lines' positions instead, and says so when they are wrong:

```bash
awk '/url\.pathname\.startsWith\("\/rooms\/"\)/ && !a {a=NR} /await handleOAuth\(request, oauth\)/ && !b {b=NR} END { if (a && b && a < b) print "worker: /rooms/ before handleOAuth"; else { print "ORDER WRONG: rooms=" a " oauth=" b; exit 1 } }' src/worker.ts
```

Expected: `worker: /rooms/ before handleOAuth`. Now move the `/rooms/` block below the `if (oauth) { ... handleOAuth ... }` block and above `/healthz`. Run `npm --prefix worker-tests run test -- blobs-route`: still green, for the reason above; run the command again: it prints `ORDER WRONG: …` and exits 1. Restore the block ahead of the OAuth routes. Then delete the block outright: "uploads through the real binding" goes red with `expected 404 to be 201` and the body `Not found`. Restore.

Then in `roomCaller`, change `if (identity) return { identity, via: "bearer" };` to `if (identity) return null;`: the same case goes red with `expected 401 to be 201`. Restore.

- [ ] **Step 7: Write the failing round trip over the Node server**

Add `import { text } from "./helpers/blob-bytes.js";` beside the file's other helper import, and append to `tests/http.test.ts`:

```ts
describe("the room routes over the Node server (#183)", () => {
  it("uploads and downloads a blob through the app, and the tool heads what the route stored", async () => {
    const jesse = await mcpClient("qk_dev_jesse");
    const started = await call(jesse, "bellman_start", { manifest: manifestFixture(), brief: brief() });
    expect(started.isError, started.text).toBe(false);
    const sessionId = String(started.data.session_id);
    const memberId = String(started.data.member_id);

    const body = text("# notes\n");
    const uploaded = await fetch(`${base}/rooms/${sessionId}/blobs?member_id=${memberId}&name=notes.md`, {
      method: "POST",
      headers: { authorization: "Bearer qk_dev_jesse", "content-type": "text/markdown" },
      body,
    });
    expect(uploaded.status, await uploaded.clone().text()).toBe(201);
    const { blob_id, bytes } = (await uploaded.json()) as { blob_id: string; bytes: number };
    expect(bytes).toBe(body.byteLength);

    // The same MemoryBlobStore behind the tool: the placement heads the object the route stored.
    const placed = await call(jesse, "bellman_send", {
      session_id: sessionId, member_id: memberId, type: "surface",
      payload: { key: "notes", kind: "file", blob: { id: blob_id } },
    });
    expect(placed.isError, placed.text).toBe(false);

    const served = await fetch(`${base}/rooms/${sessionId}/blobs/${blob_id}`, { headers: { authorization: "Bearer qk_dev_jesse" } });
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/octet-stream");
    expect(served.headers.get("content-disposition")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(served.headers.get("content-security-policy")).toBe("sandbox");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(body);

    expect((await fetch(`${base}/rooms/${sessionId}/blobs/${blob_id}`)).status).toBe(401);
    expect((await fetch(`${base}/rooms/${sessionId}/blobs`, { method: "POST", headers: { authorization: "Bearer qk_dev_jesse" }, body: "x" })).status).toBe(400);
    await jesse.close();
  });
});
```

The last line is a POST with no `member_id`, answered 400 by the route before the body is touched; `fetch` itself sets `Content-Length` for a buffer body, so neither upload names it.

- [ ] **Step 8: Run it to confirm it fails**

Run: `npx vitest run tests/http.test.ts -t "room routes"`
Expected: FAIL — the upload answers 404 (Express's default for an unknown path).

- [ ] **Step 9: Mount the routes on the Node server**

In `src/app.ts`, the imports become:

```ts
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import express, { type Express, type Request as ExpressRequest } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { resolveIdentity } from "./auth.js";
import type { BlobStore } from "./blobs.js";
import { roomRoutes } from "./http/rooms.js";
import { buildServer } from "./server.js";
import type { BellmanStore } from "./store.js";
```

and, in `createApp`, BEFORE `app.use(express.json({ limit: "1mb" }));`:

```ts
  /**
   * The room routes (#183), mounted ahead of the JSON body parser so an
   * upload's body reaches the route as the stream it was sent as. Express
   * speaks Node's req/res and the module speaks Request/Response, so this
   * translates: the headers and the body in (streamed, duplex half), the
   * status, headers and body out. The Node server is local development and
   * what `npm run smoke` and a bridge's bellman_upload point at, so the doors
   * open here too — over the same MemoryBlobStore `buildServer` heads, with
   * the static key map as the only caller (there is no OAuth and no panel here).
   */
  app.use("/rooms", async (req, res) => {
    const answer = await roomRoutes(toRequest(req), {
      store,
      blobs,
      caller: async (request) => {
        const identity = resolveIdentity(request.headers.get("authorization") ?? undefined);
        return identity ? { identity, via: "bearer" } : null;
      },
      panelOrigins: [],
    });
    if (!answer) {
      res.status(404).send("Not found");
      return;
    }
    res.status(answer.status);
    answer.headers.forEach((value, name) => res.setHeader(name, value));
    if (!answer.body) {
      res.end();
      return;
    }
    Readable.fromWeb(answer.body as unknown as NodeReadableStream).pipe(res);
  });
```

and, after `createApp`, at module level:

```ts
/** Node's request as the web one the route reads: the full original URL, every header, the body as a stream. */
function toRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const each of value) headers.append(name, each);
  }
  const bodiless = req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS";
  const init: RequestInit & { duplex?: "half" } = { method: req.method, headers };
  if (!bodiless) {
    init.body = Readable.toWeb(req) as unknown as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(`${req.protocol}://${req.get("host") ?? "localhost"}${req.originalUrl}`, init);
}
```

Update the docblock of `createApp`: after "so a Workers/DO port can reuse the routing without Node's listener." add "The room routes (#183) are the one piece shared as a module rather than re-typed: `src/http/rooms.ts` serves both, and this file only translates."

- [ ] **Step 10: Run the Node round trip and the whole HTTP file**

Run: `npx vitest run tests/http.test.ts && npm run typecheck`
Expected: PASS, the 9-tool pin included, and the typecheck is clean.

- [ ] **Step 11: Break the mount order to see the control**

Move the `app.use("/rooms", ...)` block BELOW `app.use(express.json({ limit: "1mb" }))`, and for the moment change the test's upload to `content-type: application/json` with the body `{}` (valid JSON, so the parser accepts and drains it). Run `npx vitest run tests/http.test.ts -t "room routes"`: red — the parser consumed the body, and the route, handed an empty stream against a declared `Content-Length: 2`, answers 400 `body did not match Content-Length: 2 bytes declared, 0 received` where 201 was expected. With the order right (Step 9) the same JSON upload is stored, so the order is the only difference. Then check the order by position, which also fails while the block is moved:

```bash
awk '/app\.use\("\/rooms"/ && !a {a=NR} /app\.use\(express\.json\(/ && !b {b=NR} END { if (a && b && a < b) print "app: /rooms before the JSON parser"; else { print "ORDER WRONG: rooms=" a " json=" b; exit 1 } }' src/app.ts
```

Expected once restored: `app: /rooms before the JSON parser`; while moved: `ORDER WRONG: …`. Restore both the block and the test.

- [ ] **Step 12: Commit**

```bash
git add src/oauth/routes.ts src/worker.ts src/app.ts tests/http.test.ts worker-tests/blobs-route.test.ts
git -c commit.gpgsign=true commit -S -m "Open the doors on both servers: the Worker over the real bucket, the Node server over memory, and prove the wiring in workerd"
```

---

### Task 8: The bridge — `bellman_upload`, the fake server's blob route, and the bundle

**Files:**
- Modify: `src/bridge.ts` (`UploadOptions`, `BridgeOptions.upload`, `UPLOAD_TOOL`, `readLocalFile`, `typeFromExtension`, `uploadAndPlace`, the listing and the dispatch)
- Modify: `src/channel.ts` (the `upload` option)
- Modify: `tests/helpers/fake-bellman.ts` (`keys`, `store`, `blobs`, the `/rooms/` branch)
- Modify: `extension/manifest.json`, `extension/README.md` (the bundle's surface is now the server's nine tools and the bridge's three), `tests/extension.test.ts` (the count)
- Modify: `tests/bridge.test.ts` — **four** pins on the bridge's tool list: the channel-delivery list (the one the plan always named), the hook-delivery list, the "second listing" after a rejected `tools/list`, and the `local` set the remote-tools comparison excludes
- Create: `tests/bridge-upload.test.ts`

**Interfaces:**
- Produces: `interface UploadOptions { serverUrl: string; bearer: () => string | Promise<string>; fetchImpl?: typeof fetch }`; `BridgeOptions.upload?: UploadOptions`; `readLocalFile(path): { bytes: Buffer<ArrayBuffer> }` and `typeFromExtension(path): string`, both exported; the tool `bellman_upload`, listed in both delivery modes. `Buffer<ArrayBuffer>` and not bare `Buffer`: the compiler's `BodyInit` takes the first and refuses the second, and `readFileSync` hands back the first.
- Produces: `fakeBellman({ keys })`, and `FakeBellman.store: MemoryStore`, `FakeBellman.blobs: MemoryBlobStore`.
- Consumes: `roomRoutes`, `RoomCaller` (Task 6); `caller` (Task 7); `MAX_BLOB_BYTES`, `isImageType`, `OCTET_STREAM` (Task 1). The fake's room is a `session()` fixture, so its ceiling is the fixture's.

`bellman_upload` is listed always, in both delivery modes, and without an upload target (a test bridge built with no `upload`) answers an error naming that. The bundle therefore declares twelve tools: the server's nine, and the bridge's three.

- [ ] **Step 1: Give the fake server the blob route**

In `tests/helpers/fake-bellman.ts`, the imports gain:

```ts
import { MemoryBlobStore } from "../../src/blobs.js";
import { roomRoutes } from "../../src/http/rooms.js";
import { caller } from "../../src/oauth/routes.js";
import { MemoryStore } from "../../src/store.js";
```

`FakeBellmanOptions` gains:

```ts
  /** Static bearer keys the room routes accept, as the Worker's BELLMAN_KEYS map. */
  keys?: Record<string, Identity>;
```

`FakeBellman` gains:

```ts
  /** The room routes' store and blob store, so a test can seed a room and read what an upload left. */
  store: MemoryStore;
  blobs: MemoryBlobStore;
```

In `fakeBellman`, destructure `keys = {}` beside `overrides`, create the two stores after `registrations`, and add to `serve` before the `/mcp` check:

```ts
    // The room routes (#183), composed as the Worker composes them: the
    // authorization server's caller (an access token, then a cookie), and the
    // static key map a bridge with BELLMAN_KEY presents.
    if (url.pathname.startsWith("/rooms/")) {
      const handled = await roomRoutes(request, {
        store,
        blobs,
        caller: async (req) => {
          const who = await caller(req, config);
          if (who) return { identity: who.identity, via: who.via };
          const identity = resolveIdentity(req.headers.get("authorization") ?? undefined, JSON.stringify(keys));
          return identity ? { identity, via: "bearer" } : null;
        },
        panelOrigins: config.panelOrigins ?? [],
      });
      return handled ?? new Response("not found", { status: 404 });
    }
```

with `const store = new MemoryStore(); const blobs = new MemoryBlobStore();` declared above `serve`, and `store, blobs,` added to the returned object.

- [ ] **Step 2: Write the failing bridge tests**

Create `tests/bridge-upload.test.ts`:

```ts
/**
 * bellman_upload (#183, D7): the bridge reads a local file, posts it to the
 * room's blob route with the bearer it holds, then places it through the
 * upstream bellman_send — one call. The route is the real one, inside the fake
 * server, over a MemoryBlobStore the upstream's writeSurface then heads: what
 * the bridge uploaded is what the item names.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
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
let fetches: number;
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

beforeEach(async () => {
  fake = fakeBellman({ keys: { [DEV_KEY.jesse]: jesse } });
  await fake.store.createSession(session({ id: ROOM, members: [member()] }));
  dir = mkdtempSync(join(tmpdir(), "bellman-upload-"));
  fetches = 0;
  sends = 0;
  bridge = createBridge({
    delivery: "channel",
    remote: remoteFor,
    upload: {
      serverUrl: `${ISSUER}/mcp`,
      bearer: () => DEV_KEY.jesse,
      fetchImpl: ((input, init) => {
        fetches++;
        return fake.fetch(input, init);
      }) as typeof fetch,
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "claude-code", version: "0.0.1" });
  await Promise.all([bridge.server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await bridge.close();
  await client.close();
  rmSync(dir, { recursive: true, force: true });
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
    expect(readLocalFile(path).bytes.toString()).toBe("regular");
    expect(() => readLocalFile(dir)).toThrow(/not a regular file/);
    expect(() => readLocalFile(join(dir, "nope"))).toThrow(/could not be read/);
  });
});
```

- [ ] **Step 3: Run them to confirm they fail**

Run: `npx vitest run tests/bridge-upload.test.ts`
Expected: FAIL — `readLocalFile` and `typeFromExtension` are not exported, and `bellman_upload` is not a tool the bridge knows (`Tool bellman_upload not found` from the upstream).

- [ ] **Step 4: Add the tool to the bridge**

In `src/bridge.ts`, the `node:fs` and `node:path` imports become:

```ts
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
```

and add:

```ts
import { MAX_BLOB_BYTES, OCTET_STREAM, isImageType } from "./blobs.js";
```

After `BridgeBus`:

```ts
/**
 * Where bellman_upload posts, and as whom (#183, D7). The server URL is the one
 * the bridge has (.../mcp); the blob routes live on its origin. `bearer` is read
 * on every upload, because an access token lasts ten minutes. `fetchImpl` is for
 * tests, which hand in a fake server's.
 */
export interface UploadOptions {
  serverUrl: string;
  bearer: () => string | Promise<string>;
  fetchImpl?: typeof fetch;
}
```

In `BridgeOptions`, after `bus?: BridgeBus;`:

```ts
  /** The upload target for bellman_upload. Absent, the tool is listed and refuses with a message. */
  upload?: UploadOptions;
```

After `WHOAMI_TOOL`:

```ts
const UPLOAD_TOOL: Tool = {
  name: "bellman_upload",
  title: "Upload a file and place it on the room's surface",
  description: `Read a file from this machine, upload it to the room's blob store, and place it on the working surface as a file or image item, in one call. Local to this bridge: the server has no binary channel, so a hosted connector uploads through the control panel instead.

Args:
  - session_id, member_id: your handles from start/confirm; the seat must hold write_surface
  - path: a regular file on this machine (not a symbolic link), at most ${MAX_BLOB_BYTES} bytes
  - key: the surface key to place it under; an item already there is replaced
  - kind: "file" | "image". Default: image when the file's type is image/png, image/jpeg, image/gif or image/webp, else file
  - title?, placement? ({ x, y, w?, h? }): as on bellman_send type "surface"
The type is taken from the file's extension. The server checks an image's bytes against that claim and stores a mismatch as application/octet-stream. A placement the server refuses — an image over a mismatched type, a key it does not accept, a surface that is full — is reported with the blob's id, bytes and stored type, so you can place it again with bellman_send, without uploading again.

Returns: { blob_id, bytes, type, cursor, room_members } — type is what the server stored, cursor is the surface event's, room_members is bellman_send's (not a read receipt).`,
  // The bounds on key, title and placement are the server's, held in one place
  // (`SurfaceKeyShape`, `boundedText` in surface.ts); this schema names the
  // fields and carries no number it could drift from.
  inputSchema: {
    type: "object",
    properties: {
      session_id: { type: "string" },
      member_id: { type: "string" },
      path: { type: "string" },
      key: { type: "string" },
      kind: { type: "string", enum: ["file", "image"] },
      title: { type: "string" },
      placement: {
        type: "object",
        properties: { x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } },
        required: ["x", "y"],
      },
    },
    required: ["session_id", "member_id", "path", "key"],
  },
  annotations: {
    readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false,
  },
};

// ponytail: a short table, not a MIME database. Unknown is an octet-stream, and
// the server decides what an image really is either way (D6).
const TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json",
  yaml: "application/yaml", yml: "application/yaml", html: "text/html", htm: "text/html", pdf: "application/pdf",
};

/** The type a file is claimed as, from its extension alone. */
export function typeFromExtension(path: string): string {
  return TYPES[extname(path).slice(1).toLowerCase()] ?? OCTET_STREAM;
}

/**
 * A regular file's bytes, read through one descriptor so nothing can change
 * between the check and the read. A symbolic link is refused, as room.yaml's is
 * and for the same reason — the bridge sends what it reads to a server, and a
 * link would send whatever it points at; so is anything that is not a regular
 * file, and so is a file over the cap, before a byte of it is read. O_NOFOLLOW
 * refuses a link in the open itself where the platform has it, and the lstat
 * is what refuses one where it does not (Windows).
 */
export function readLocalFile(path: string): { bytes: Buffer<ArrayBuffer> } {
  const link = () =>
    new Error(`${path} is a symbolic link, and the bridge will not follow one: whatever it points at would be read and sent to the server. Pass the file itself.`);
  if (isSymlink(path)) throw link();
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  } catch (e) {
    if ((e as { code?: string }).code === "ELOOP") throw link();
    throw new Error(`${path} could not be read: ${(e as Error).message}`);
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile()) throw new Error(`${path} is not a regular file`);
    if (info.size > MAX_BLOB_BYTES) {
      throw new Error(`${path} is ${info.size} bytes, and a blob is at most ${MAX_BLOB_BYTES}`);
    }
    return { bytes: readFileSync(fd) };
  } finally {
    closeSync(fd);
  }
}
```

In `createBridge`, the listing:

```ts
    const local = delivery === "hook" ? [WAIT_TOOL, WHOAMI_TOOL, UPLOAD_TOOL] : [WHOAMI_TOOL, UPLOAD_TOOL];
```

and the dispatch, after the `WAIT_TOOL` line:

```ts
    if (name === UPLOAD_TOOL.name) return uploadAndPlace(args);
```

After `waitForQueued`:

```ts
  /**
   * bellman_upload (#183, D7): read, post, place. The upload is refused locally
   * for a link, a non-file or an oversized file before anything leaves the
   * machine. The post carries the bearer the bridge holds and sets
   * Content-Length itself — the route requires it, a real fetch keeps a
   * caller's value when it matches the body, and a fake server's Request
   * computes none. The placement is the upstream bellman_send, observed like
   * any other so the membership it reveals is watched. A placement the server
   * refuses, for whatever reason, is reported with the blob's id, bytes and
   * type: the bytes are stored and charged, and the caller places them again
   * (as a file, if an image was the trouble) rather than uploading twice.
   */
  async function uploadAndPlace(args: Record<string, unknown>): Promise<CallToolResult> {
    const fail = (text: string): CallToolResult => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
    if (!opts.upload) return fail("this bridge has no upload target configured, so bellman_upload cannot post anything");
    const sessionId = String(args.session_id ?? "");
    const memberId = String(args.member_id ?? "");
    const path = String(args.path ?? "");
    const key = String(args.key ?? "");
    if (!sessionId || !memberId || !path || !key) return fail("session_id, member_id, path and key are required");

    let file: { bytes: Buffer<ArrayBuffer> };
    try {
      file = readLocalFile(path);
    } catch (e) {
      return fail((e as Error).message);
    }
    const claimed = typeFromExtension(path);
    const kind = args.kind === "file" || args.kind === "image" ? args.kind : isImageType(claimed) ? "image" : "file";

    const target = new URL(`/rooms/${encodeURIComponent(sessionId)}/blobs`, opts.upload.serverUrl);
    target.searchParams.set("member_id", memberId);
    target.searchParams.set("name", basename(path));
    let response: Response;
    try {
      response = await (opts.upload.fetchImpl ?? fetch)(target, {
        method: "POST",
        headers: {
          authorization: `Bearer ${await opts.upload.bearer()}`,
          "content-type": claimed,
          "content-length": String(file.bytes.byteLength),
        },
        body: file.bytes,
      });
    } catch (e) {
      return fail(`upload failed: ${(e as Error).message}`);
    }
    if (response.status !== 201) {
      const detail = await response.text().catch(() => "");
      return fail(`upload refused (${response.status}): ${detail.slice(0, 300)}`);
    }
    const uploaded = (await response.json()) as { blob_id: string; bytes: number; type: string; name: string };

    const payload: Record<string, unknown> = { key, kind, blob: { id: uploaded.blob_id } };
    if (args.title !== undefined) payload.title = args.title;
    if (args.placement !== undefined) payload.placement = args.placement;
    const sendArgs = { session_id: sessionId, member_id: memberId, type: "surface", payload };
    const placed = await (await remote()).callTool({ name: "bellman_send", arguments: sendArgs });
    observe("bellman_send", sendArgs, placed);
    if (placed.isError) {
      return fail(
        `uploaded blob ${uploaded.blob_id} (${uploaded.bytes} bytes, stored as ${uploaded.type}) but could not place it as ${kind} "${key}": ` +
          `${textOf(placed).replace(/^Error: /, "")} Place it with bellman_send type "surface", payload { key, kind: "file", blob: { id: "${uploaded.blob_id}" } }, rather than uploading again.`,
      );
    }
    const out = (placed.structuredContent ?? {}) as Record<string, unknown>;
    const result = { blob_id: uploaded.blob_id, bytes: uploaded.bytes, type: uploaded.type, cursor: out.cursor, room_members: out.room_members };
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: result };
  }
```

- [ ] **Step 5: Hand the bridge its target**

In `src/channel.ts`, the `createBridge` call gains, after `whoami,`:

```ts
  /**
   * Where bellman_upload posts (#183): the blob routes on this server's origin,
   * as whoever the bridge is — the BELLMAN_KEY, or the cached sign-in's access
   * token, read on every upload because it rotates every ten minutes.
   */
  upload: { serverUrl: url, bearer: busCredentials(url, key).bearer },
```

- [ ] **Step 6: The bundle, and the pins**

In `extension/manifest.json`, after the `bellman_whoami` entry:

```json
    {
      "name": "bellman_upload",
      "description": "Upload a file from this machine and place it on the room's surface, in one call."
    },
```

In `tests/extension.test.ts`: the count case becomes "declares exactly twelve tools" with `toHaveLength(12)`, and its comment "Eleven is the server's nine plus the bridge's two." becomes "Twelve is the server's nine plus the bridge's three."

In `extension/README.md`, the paragraph that starts "That surface is the server's eight tools plus the bridge's own two, and *which* of its own depends on the delivery mode — `bellman_wait` exists under `hook` and not under `channel`." (point 4, about the manifest's tool list) now reads "That surface is the server's nine tools plus the bridge's own three, and *which* of its own depends on the delivery mode — `bellman_wait` exists under `hook` and not under `channel`, while `bellman_whoami` and `bellman_upload` exist under both." and keeps its last sentence, "So the test asserts the declared mode as well; without that, the comparison would be circular."

`tests/bridge.test.ts` pins the bridge's tool list in **four** places, and `bellman_upload` is listed in both delivery modes, so all four change. First, the "declares itself a channel ... and proxies the Bellman tools" expectation gains `"bellman_upload"` in sorted position:

```ts
    expect(names).toEqual([
      "bellman_audit", "bellman_confirm", "bellman_connect", "bellman_evict",
      "bellman_invite", "bellman_leave", "bellman_send", "bellman_start",
      "bellman_sync", "bellman_upload", "bellman_whoami",
    ]);
```

Second, "is offered and answered under hook delivery too, alongside bellman_wait": its `names` becomes `[...remoteToolNames, "bellman_upload", "bellman_wait", "bellman_whoami"]` — sorted, `bellman_sync` being the last of `remoteToolNames`. Third, "retires on a rejected tools/list too, not only on a tool call": the remote there lists no tools, so the second listing is the bridge's own, in the order `createBridge` lists them, and `second: ["bellman_whoami"]` becomes `second: ["bellman_whoami", "bellman_upload"]`. Fourth, in the `describe("the tools the bridge lists")` comparison of the remote's tools with the bridge's, `const local = new Set(["bellman_start", "bellman_wait", "bellman_whoami"])` gains `"bellman_upload"`, and the comment above it, which names the local tools it leaves out, names it too.

- [ ] **Step 7: Run the bridge, extension and fake-server tests, and the typecheck**

Run: `npx vitest run tests/bridge-upload.test.ts tests/bridge.test.ts tests/extension.test.ts tests/oauth-flow.test.ts tests/bridge-delivery.test.ts && npm run typecheck && npm run typecheck:worker && npm run build`
Expected: PASS, and all three programs clean — `typecheck:worker` is clean now that Task 7 has supplied `buildServer`'s third argument, and `build` compiles `src/bridge.ts`, which is where a `Buffer` that is not `Buffer<ArrayBuffer>` would be refused.

- [ ] **Step 8: Break the local refusal to see the control**

In `readLocalFile`, delete the `if (isSymlink(path)) throw link();` line AND change `O_NOFOLLOW` to `0` (either alone leaves the other guard standing, and the test stays green). Run `npx vitest run tests/bridge-upload.test.ts -t "refuses a symbolic link"`: red on the link's row — the link is read and sent, so `expected false to be true`. Restore both.

Then in `uploadAndPlace`, change the refused-placement message to drop `${uploaded.blob_id}`: "reports a refused placement with the blob it uploaded" goes red (`expected undefined to be defined`). Restore.

- [ ] **Step 9: Commit**

```bash
git add src/bridge.ts src/channel.ts tests/helpers/fake-bellman.ts extension/manifest.json extension/README.md tests/extension.test.ts tests/bridge.test.ts tests/bridge-upload.test.ts
git -c commit.gpgsign=true commit -S -m "Upload a file from Claude Code and place it on the surface in one call"
```

---

### Task 9: The documents

**Files:**
- Modify: `README.md`, `skills/room-manifest/SKILL.md`, `docs/ARCHITECTURE.md`

- [ ] **Step 1: README**

In "The working surface", the first bullet's kinds line becomes:

```
  body?, ends?, placement?, blob? }`, or remove with `{ key, remove: true }`. Kinds:
  `text`, `link`, `diagram`, `connector`, `file`, `image`. Items replace by key;
  every version stays in the log at its cursor.
```

and a new bullet follows it:

```markdown
- A `file` or an `image` names a blob. Upload the bytes first — `POST
  /rooms/:id/blobs?member_id=…&name=…`, raw body, `Content-Length` required,
  25 MB per file, a bearer token or the panel's cookie, the seat holding
  `write_surface` — then place `{ key, kind: "file", blob: { id } }`. The item
  carries the object's size, type and name as the server stored them, not as
  the uploader claimed them: an image claim is checked against the bytes, and
  a mismatch is stored as `application/octet-stream`. `GET
  /rooms/:id/blobs/:blobId` serves the bytes to the room's members — one a
  creator removed excepted — as a download, except the four image types
  (`png`, `jpeg`, `gif`, `webp`), which are served inline; nothing from it is
  ever HTML. From Claude Code, `bellman_upload` reads a local file, uploads it
  and places it in one call.
```

The closing paragraph of the section becomes: "A canvas to see it on and sandboxed HTML artifacts are the next two pieces; the designs are in `docs/superpowers/specs/`."

In "What a plan gates", the table gains a column:

```
| | modes | members | lifetime | rooms / month | blobs / room | |
| --- | --- | --- | --- | --- | --- | --- |
| `free` | pair | 2 | 4 hours | 20 | 50 MB | |
| `pro` | pair, swarm | 8 | 72 hours | 500 | 500 MB | |
| `team` | pair, swarm | 25 | 30 days | 5,000 | 5 GB | `org_only` scoping, audit trail |
```

and one sentence after the table's paragraph about cross-org audit: "A room's blob ceiling is stamped on the room when it is created, from the plan that creates it — as its seat count and lifetime are — so every member shares it whatever their own plan, and it never counts against the monthly figure. The local Node server (`npm start`) serves the upload and download routes too, over an in-memory blob store."

In "Use it from Claude Code", after the sentence ending "`bellman_whoami` to see which account a room will show peers.", add a paragraph:

```markdown
The bridge adds one more tool of its own: `bellman_upload` reads a file on
this machine — a regular file, not a symbolic link, at most 25 MB — uploads it
to the room with the credential the bridge holds, and places it on the working
surface as a `file` or an `image`, in one call. A hosted connector has no
filesystem; it uploads through the control panel instead.
```

- [ ] **Step 2: The skill**

In `skills/room-manifest/SKILL.md`, the `write_surface` row of the verb table becomes:

```
| `write_surface` | `bellman_send` type `surface` — writing or removing an item on the room's working surface, and uploading the bytes a `file` or `image` item names (`POST /rooms/:id/blobs`; the bridge's `bellman_upload` does both) |
```

Run `npx vitest run tests/room-manifest-skill.test.ts` — PASS; the test pins the preset tables and the verb set, not this row's wording, except that its table pattern (`^\| \`verb\` \| [^|]*\|$`) needs the row's second cell to hold no `|`, which this one does not.

- [ ] **Step 3: ARCHITECTURE**

Frontmatter: `siblings:` gains `superpowers/specs/2026-10-06-surface-blobs-design.md`; `last-updated` becomes `2026-10-07`; `last-verified-against-source` becomes the short hash of Task 8's commit (`git rev-parse --short HEAD`).

In §5's storage diagram, after the `objects` subgraph's closing `end`, add:

```
    BLOB["BlobStore<br/>src/blobs.ts"]
    R2["R2 — bellman-blobs<br/>rooms/&lt;sessionId&gt;/&lt;blobId&gt;<br/>the object's metadata is the metadata"]
    MEMB["MemoryBlobStore<br/>tests, npm start"] -.implements.-> BLOB
    R2S["R2BlobStore<br/>src/blobs-r2.ts"] -.implements.-> BLOB
    R2S --> R2
```

After the "The working surface" subsection, a new one:

```markdown
### Blobs

A `file` or an `image` item (#183) names bytes that live in R2, under
`rooms/<sessionId>/<blobId>`, behind the second seam this module has:
`BlobStore` (`src/blobs.ts`, runtime-free), with `MemoryBlobStore` for tests
and `npm start` and `R2BlobStore` (`src/blobs-r2.ts`, Workers-only) for
production, held to one contract by `tests/helpers/blob-store-contract.ts` the
way the two session stores are. No row in the room object describes a blob:
the object's own metadata — the type as decided at upload, the name, the
uploading member, the time — is the metadata, because a row and an object are
two systems with no transaction between them, and the one holding the bytes
is the one that cannot lie about them. The prefix is the ownership; a foreign
room's id resolves nowhere.

The bytes go up through `POST /rooms/:id/blobs` and come down through
`GET /rooms/:id/blobs/:blobId` (`src/http/rooms.ts`, the module #49's routes
join). The upload is gated as the tool is — the same `caller` seam as
`/account`, the same `gateSeat` and `write_surface` verb — and the download
is membership: a member a creator removed is refused, as `/ws` refuses it.
The type is the server's word: an image claim is read against the four
signatures and a mismatch is stored as `application/octet-stream`; the
download serves an image on the allowlist inline and everything else as an
octet-stream attachment, with `nosniff` and `Content-Security-Policy:
sandbox` on every byte, so nothing from this origin is ever rendered as
HTML. When the item is placed, `writeSurface` `head`s the object and copies
its metadata onto the item: what readers see is the bucket's record, never
the writer's claim. Removing or replacing the item leaves the blob where it
is; the event that placed it still names it, and deletion is #65's.

The quota is two numbers on the session record: `blobBytesCeiling`, stamped
at creation from the creator's plan (`blobBytesPerRoom`: 50 MB, 500 MB, 5 GB)
as `maxMembers` is, so a room never consults a plan again and every member
shares the room's ceiling; and `blobBytes`, the sum charged so far, raised in
one `SessionDO` transaction by `chargeBlobBytes`. A room written before the
ceiling existed reads the free plan's. The route puts the object and then
charges — section 9 says why that order — and deletes the object when the
charge refuses. The Node server mounts the same routes over `MemoryBlobStore`,
translating Express's req/res to the Request/Response the module speaks.
```

In §7, after the "`<` is escaped" bullet:

```markdown
- **A blob is served under membership, typed by the server, and never as
  HTML.** The bucket has no public URL and no presigned one; every byte leaves
  through the download route. The type an upload claims is checked against
  the bytes, and the route serves only an allowlisted image inline — a PDF,
  an SVG or an HTML artifact is an octet-stream download under `nosniff` and
  `Content-Security-Policy: sandbox`. Together those are what let piece 4
  store an artifact as a blob without the route becoming an XSS vector on
  `mcp.bellman.sh`. A blob's name is a label, stripped of path separators,
  and never derives a key.
```

In §9, after the paragraph beginning "Its audit rows ride the outbox" and before "**A lost write: durable delivery.**":

```markdown
A blob upload (#183) is the newest window, and it spans a Durable Object and
R2, where no outbox reaches. The route puts the object, then charges the
room's `blobBytes` inside `SessionDO` in one transaction, and deletes the
object if the charge refuses. The other order was rejected on purpose: a
charge reserved before an upload that never completes — the client dies
mid-body — is a phantom that locks quota with nothing anywhere to list, while
an object nobody charged for costs storage only and `list({ prefix })` finds
it. Both are this section's window; put-then-charge is the side on which the
loss is findable, and retention (#65) is what sweeps it.
```

§11: re-measure as the section describes — `bellman_send`'s description grew by the `file` and `image` sentence — and record the new total and the delta beside the table, or write "not re-measured after #183" beside it rather than leaving the old number standing as current.

- [ ] **Step 4: Nothing in the documents says "two sessions"**

Run:

```bash
[ "$(printf 'the other session\n' | grep -c 'two sessions\|the other session')" = 1 ] && echo "the pattern matches the phrase it hunts"
grep -n "two sessions\|the other session" README.md docs/ARCHITECTURE.md skills/room-manifest/SKILL.md src/blobs.ts src/blobs-r2.ts src/http/rooms.ts src/bridge.ts; [ $? = 1 ] && echo "no peer-counting phrases"
```

Expected: both `the pattern matches the phrase it hunts` and `no peer-counting phrases`. The first line is the positive control; the second prints only when `grep` exits 1, which is "no match" — an exit of 2 (a file that is not there) prints nothing.

- [ ] **Step 5: Commit**

```bash
git add README.md skills/room-manifest/SKILL.md docs/ARCHITECTURE.md
git -c commit.gpgsign=true commit -S -m "Say in the README and the architecture where a room's bytes live and how they get there"
```

---

### Task 10: Verify, and stop

**Files:** none new.

- [ ] **Step 1: The whole thing**

Run: `npm run verify`
Expected: typecheck, worker typecheck, build, the root program and the worker program all green.

- [ ] **Step 2: No control left in the tree**

Every task broke a line to see a control and restored it. A mutation left behind that turns no test red would ship, and `npm run verify` cannot see it, so this step checks, for the line each control touched, that the right line is there. Each check can fail: it names the exact text the restored tree holds and on how many lines, and prints `WRONG` when that is not so. The positive controls are built in — `blobs.delete(` is counted 0 times in `src/rooms.ts` only because the same call is counted once in `src/http/rooms.ts`, which shows the pattern can match, and the `if (false)` sweep first proves its pattern matches the mutation it hunts.

```bash
bad=0; checks=0
has() { checks=$((checks + 1)); n=$(grep -cF -- "$3" "$2"); [ "$n" = "$1" ] || { echo "WRONG ($n lines, want $1) in $2: $3"; bad=1; }; }
# Task 1: both halves of the length rule, and the tag comparison
has 1 src/blobs.ts 'if (received > expected) throw new BlobLengthError(expected, received);'
has 1 src/blobs.ts 'if (received !== expected) throw new BlobLengthError(expected, received);'
has 1 src/blobs.ts 'const strip = (t: string) => t.trim().replace(/^W\//, "");'
# Task 2: the lift, the ceiling's default, and the three rules
has 1 src/stored-session.ts 'blobBytes: row.blobBytes ?? 0,'
has 1 src/stored-session.ts '?? ENTITLEMENTS.free.blobBytesPerRoom,'
has 1 src/surface.ts 'if (!v.blob) return refuse("a file or an image needs blob { id }'
has 1 src/surface.ts 'if (v.body) return refuse("a file or an image has no body;'
has 1 src/surface.ts 'if (v.blob && !blobBacked) return refuse("only a file or an image names a blob");'
# Task 3: the bound, in one place
has 1 src/store.ts 'if (used + bytes > s.blobBytesCeiling) return { ok: false, reason: "over_quota", used };'
has 0 src/store-do.ts 'blobBytesCeiling'
# Task 4: the metadata copy, the allowlist check, and that the write deletes nothing
has 1 src/rooms.ts 'blob: { id: normalized.blobId, bytes: meta.bytes, type: meta.type, name: meta.name }'
has 1 src/rooms.ts 'write.item.kind === "image" && !isImageType(meta.type)'
has 0 src/rooms.ts 'blobs.delete('
has 1 src/http/rooms.ts 'await deps.blobs.delete(sessionId, id).catch('
# Task 5: the length declaration, the length rule, and the metadata read
has 1 src/blobs-r2.ts 'const fixed = new FixedLengthStream(meta.bytes);'
has 1 src/blobs-r2.ts 'exactLength(body, meta.bytes).pipeTo(fixed.writable),'
has 1 src/blobs-r2.ts 'bytes: object.size,'
# Task 6: the cap, the download's disposition, and the removed-member refusal
has 1 src/http/rooms.ts 'if (bytes > MAX_BLOB_BYTES)'
has 1 src/http/rooms.ts 'if (!image) headers["content-disposition"] = attachmentDisposition(read.name);'
has 1 src/http/rooms.ts 'if (mine.every(isRemovedMember)) {'
# Task 7: the bearer path through roomCaller
has 1 src/worker.ts 'if (identity) return { identity, via: "bearer" };'
# Task 8: the link guard, both opens (room.yaml's and the upload's), and the blob id in the refusal
has 1 src/bridge.ts 'if (isSymlink(path)) throw link();'
has 2 src/bridge.ts 'fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK'
has 1 src/bridge.ts 'uploaded blob ${uploaded.blob_id}'
[ $bad = 0 ] && echo "all $checks checks hold"
printf 'if (false) x\n' | grep -q 'if (false)' && echo "the sweep's pattern matches the mutation it hunts"
grep -rn 'if (false)' src; [ $? = 1 ] && echo "no 'if (false)' under src"
```

Then run Task 7 Step 6's order command and Step 11's again. Expected: no `WRONG` line, then `all 24 checks hold`, the two sweep lines, and the two order lines (`worker: /rooms/ before handleOAuth`, `app: /rooms before the JSON parser`). The two order commands are the only guard on the order, which no request can see.

- [ ] **Step 3: The bucket exists before the deploy**

This is a note for the controller, not a step to run here: `npx wrangler r2 bucket create bellman-blobs` once, before the first `npm run deploy` of this branch, or the Worker fails to bind `BLOBS`.

- [ ] **Step 4: Stop**

Do not push and do not open a PR. The push and the PR are the controller's: the body is one paragraph per decision D1–D8 from the spec, `Closes #183`, the note that #185's tool shipped here as `bellman_upload`, and the five rulings that cost something if wrong — the ceiling stamped on the room at creation (a room that predates it reads the free ceiling), the strict `blob: { id }` shape, the route's caller composed from `resolveCaller` and the OAuth `caller`, the length rule living once in `exactLength` with R2's own error never trusted to say "short body" (Task 5 runs the contract that proves it in workerd), and the charge rule living once in `decideBlobCharge` so the two stores cannot drift.
