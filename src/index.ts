import { createApp } from "./app.js";
import { MemoryBlobStore } from "./blobs.js";
import { tickStep } from "./heartbeat.js";
import { MemoryHost, nodeModel } from "./host-memory.js";
import { hostedSeatOn } from "./host.js";
import { MemoryStore } from "./store.js";

const port = parseInt(process.env.PORT || "3900", 10);

// One blob store for the routes, the tools and the store: the purge deletes from the same bucket they serve.
const blobs = new MemoryBlobStore();
// The hosted seat (hosted seat spec, D7). It is off unless BELLMAN_HOSTED_SEAT=on, read once
// here so that the tools' refusal of a hosted room and the seat's answer to a wake cannot
// disagree. On, it asks this server's own fake model unless BELLMAN_REAL_MODEL=1 is set beside
// ANTHROPIC_API_KEY, or MODEL_URL points elsewhere (M11).
const hostedSeat = hostedSeatOn(process.env.BELLMAN_HOSTED_SEAT);
const model = nodeModel(process.env, port);
const store = new MemoryStore({ blobs, host: (w) => void host.wake(w) });
const host = new MemoryHost(store, { modelUrl: model.modelUrl, apiKey: model.apiKey, enabled: hostedSeat });
const app = createApp(store, blobs, { hostedSeat });

// Periodic expiry of sessions and pending connect tokens, and the heartbeat: what
// SessionDO's alarm does for one room, tick for every room (#111, #188).
setInterval(() => {
  // sweep is async now; a rejection here must not take down the process.
  store.sweep(Date.now()).catch((err) => console.error("sweep failed:", err));
  try {
    store.tick(Date.now(), tickStep);
  } catch (err) {
    console.error("tick failed:", err);
  }
}, 60_000).unref();

app.listen(port, () => {
  console.error(`bellman-mcp-server listening on http://localhost:${port}/mcp`);
  console.error(hostedSeat ? model.says : "hosted seat: off; set BELLMAN_HOSTED_SEAT=on to start hosted rooms on this server");
});
