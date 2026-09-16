import { MemoryStore } from "../src/store.js";
import { describeStoreContract } from "./helpers/store-contract.js";

describeStoreContract("MemoryStore", () => new MemoryStore());
