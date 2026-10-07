import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { renderJoin, verdictMessage } from "./join.js";
import { renderMonitor } from "./monitor.js";
import { pickScreen, type ToolOutcome } from "./screen.js";
import { el } from "./shared.js";

/** How often the monitor re-reads bellman_rooms while the page is visible. */
const POLL_MS = 15_000;

const root = document.getElementById("root")!;
const app = new App({ name: "Bellman", version: "0.1.0" });
/** session_id to the first last_event cursor this view saw (spec D4). */
const seen = new Map<string, number>();
let poll: number | undefined;

function show(node: HTMLElement): void {
  root.replaceChildren(node);
}

function stopPolling(): void {
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
}

function startPolling(): void {
  stopPolling();
  poll = window.setInterval(() => {
    if (document.visibilityState === "visible") void refresh();
  }, POLL_MS);
}

/**
 * The monitor's own read. Only ever bellman_rooms (spec D3): through the
 * bridge, a bellman_sync from here would count as the agent having seen the
 * events it returned, and they would never reach it.
 */
async function refresh(): Promise<void> {
  try {
    render(await app.callServerTool({ name: "bellman_rooms", arguments: {} }));
  } catch (err) {
    show(el("p", { class: "error" }, `Refresh failed: ${err instanceof Error ? err.message : String(err)}`));
  }
}

function render(result: ToolOutcome): void {
  const screen = pickScreen(result);
  switch (screen.kind) {
    case "join":
      stopPolling();
      show(renderJoin(screen.data, (verdict) => {
        // The human's decision, handed to the agent as one user message of
        // identifiers (spec D5, D6). The agent calls bellman_confirm itself.
        void app.sendMessage({ role: "user", content: [{ type: "text", text: verdictMessage(verdict) }] });
      }));
      return;
    case "monitor":
      show(renderMonitor(screen.data, seen, () => void refresh()));
      startPolling();
      return;
    case "error":
      show(el("p", { class: "error" }, screen.text));
      return;
    case "none":
      show(el("p", { class: "muted" }, screen.text));
      return;
  }
}

// Handlers before connect: the host may send the result straight after.
app.ontoolresult = (result) => render(result as ToolOutcome);
app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
};

void (async () => {
  await app.connect();
  const theme = app.getHostContext()?.theme;
  if (theme) applyDocumentTheme(theme);
})();
