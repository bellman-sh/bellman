import { MemoryCostStore } from "../src/cost/memory.js";
import { describeCostStoreContract } from "./helpers/cost-store-contract.js";

describeCostStoreContract("MemoryCostStore", () => new MemoryCostStore());
