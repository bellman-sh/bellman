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
      // Delivers exactly the declared length in its first chunks and then runs on: a store that was
      // told the length has been given everything it expected by the time the overrun shows.
      await refusal("55".repeat(16), stream(text("toolong"), 3), 3);
    });

    // A name is the client's word and is any text, and R2 keeps it in metadata that travels as an HTTP header
    // value. Over memory this is the identity; over R2 it is the store's own encoding and decoding agreeing, which
    // is the one thing the simulator would let a missing encoding get away with. The percent sign is the case an
    // encoding that did not escape its own escape would turn into a different name on the way back.
    it("round-trips a name that is not ASCII, or that holds a percent sign, through head and get", async () => {
      const names = ["résumé (1).md", "报告 最终版.pdf", "100% a%41.txt"];
      for (const [i, name] of names.entries()) {
        const id = `7${i}`.repeat(16);
        await store.put(sid, id, stream(text("x")), meta(1, { name }));
        expect((await store.head(sid, id))?.name, `head: ${name}`).toBe(name);
        const got = await store.get(sid, id);
        if (got === null || "unchanged" in got) throw new Error("expected the object");
        expect(got.name, `get: ${name}`).toBe(name);
        await drain(got.body);
      }
    });

    it("replaces an object put again under the same id", async () => {
      await store.put(sid, "44".repeat(16), stream(text("one")), meta(3));
      await store.put(sid, "44".repeat(16), stream(text("two!")), meta(4, { name: "two.txt" }));
      expect(await store.head(sid, "44".repeat(16))).toMatchObject({ bytes: 4, name: "two.txt" });
    });

    // The listing and the purge (#65) work on a room's prefix and on nothing else: D1 again, for the
    // calls that reach many objects at once. The foreign room's id is `${sid}_other`, which shares every
    // character of the prefix up to the slash, so a prefix that forgot its terminator would take it too.
    it("lists a room's objects with their sizes and deletes exactly those, leaving another room's", async () => {
      const mine = ["a1", "a2", "a3"].map((p) => p.repeat(16));
      for (const [i, id] of mine.entries()) await store.put(sid, id, stream(text("x".repeat(i + 3))), meta(i + 3));
      await store.put(`${sid}_other`, "b1".repeat(16), stream(text("keep")), meta(4));

      const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : 1);
      expect((await store.list(sid)).sort(byId)).toEqual(mine.map((id, i) => ({ id, bytes: i + 3 })));
      expect(await store.list(`${sid}_other`)).toEqual([{ id: "b1".repeat(16), bytes: 4 }]);

      expect(await store.deleteAll(sid)).toBe(3);
      expect(await store.list(sid)).toEqual([]);
      for (const id of mine) expect(await store.head(sid, id), id).toBeNull();
      expect(await store.head(`${sid}_other`, "b1".repeat(16)), "another room's object is left").not.toBeNull();
      expect(await store.deleteAll(sid), "a second call finds nothing").toBe(0);
    });

    it("lists nothing and deletes nothing for a room that never held an object", async () => {
      expect(await store.list(sid)).toEqual([]);
      expect(await store.deleteAll(sid)).toBe(0);
    });

    // R2 answers at most 1,000 keys a page, so a room one object past that is the smallest one whose
    // listing and deletion have to follow a cursor. A store that read the first page only would answer
    // 1,000 and leave the last object behind.
    it("lists and deletes a room that holds more objects than one page of a listing", async () => {
      const ids = Array.from({ length: 1_001 }, (_, i) => i.toString(16).padStart(32, "0"));
      for (let from = 0; from < ids.length; from += 100) {
        await Promise.all(ids.slice(from, from + 100).map((id) =>
          store.put(sid, id, new Uint8Array([1]).buffer as ArrayBuffer, meta(1))));
      }

      expect((await store.list(sid)).map((o) => o.id).sort()).toEqual(ids);
      expect(await store.deleteAll(sid)).toBe(ids.length);
      expect(await store.list(sid)).toEqual([]);
    });
  });
}
