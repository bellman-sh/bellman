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
