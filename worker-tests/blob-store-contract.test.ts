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
