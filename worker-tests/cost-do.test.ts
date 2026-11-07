/** The CostStore contract against `CostDO` in real workerd, each case on an object of its own. */
import { env } from "cloudflare:test";
import type { CostDO } from "../src/workerd/cost-do.js";
import type { CostStore } from "../src/cost/records.js";
import { describeCostStoreContract } from "../tests/helpers/cost-store-contract.js";

const namespace = (env as unknown as { COST: DurableObjectNamespace<CostDO> }).COST;
let n = 0;

describeCostStoreContract("CostDO", () =>
  namespace.get(namespace.idFromName(`cost_contract_${Date.now().toString(36)}_${n++}`)) as unknown as CostStore);
