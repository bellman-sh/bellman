import { MemoryAuthStore } from "../src/oauth/storage.js";
import { describeAuthStoreContract } from "./helpers/auth-store-contract.js";

// The in-memory store, under the root program. The same cases run against the Durable
// Object's store in worker-tests/auth-client-count.test.ts, which is the half that can
// fail: this one counts its map and cannot be off by one.
describeAuthStoreContract("MemoryAuthStore", () => new MemoryAuthStore());
