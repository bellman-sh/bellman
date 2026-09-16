import { createApp } from "./app.js";
import { MemoryStore, type BellmanStore } from "./store.js";

const store: BellmanStore = new MemoryStore();
const app = createApp(store);

// Periodic expiry of sessions and pending connect tokens.
setInterval(() => {
  // sweep is async now; a rejection here must not take down the process.
  store.sweep(Date.now()).catch((err) => console.error("sweep failed:", err));
}, 60_000).unref();

const port = parseInt(process.env.PORT || "3900", 10);
app.listen(port, () => {
  console.error(`bellman-mcp-server listening on http://localhost:${port}/mcp`);
});
