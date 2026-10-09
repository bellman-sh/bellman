import { createApp } from "./app.js";
import { MemoryBlobStore } from "./blobs.js";
import { tickStep } from "./heartbeat.js";
import { ANTHROPIC_MESSAGES_URL } from "./host.js";
import { MemoryHost } from "./host-memory.js";
import { MemoryStore } from "./store.js";

const port = parseInt(process.env.PORT || "3900", 10);

// The hosted seat (hosted seat spec, D7). With neither MODEL_URL nor a key it asks
// this server's own fake model, so a host runs locally with no key.
const store = new MemoryStore({ host: (w) => void host.wake(w) });
const host = new MemoryHost(store, {
  modelUrl: process.env.MODEL_URL ?? (process.env.ANTHROPIC_API_KEY ? ANTHROPIC_MESSAGES_URL : `http://localhost:${port}/__fake-model`),
  apiKey: process.env.ANTHROPIC_API_KEY,
});
const app = createApp(store, new MemoryBlobStore());

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
});
