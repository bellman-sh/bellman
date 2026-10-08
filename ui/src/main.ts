import { App, applyDocumentTheme } from "@modelcontextprotocol/ext-apps";
import { probeNestedFrames } from "./artifact.js";
import { createCanvas, type Canvas } from "./canvas.js";
import { renderJoin, verdictMessage } from "./join.js";
import { renderMonitor } from "./monitor.js";
import { pickScreen, type ToolOutcome } from "./screen.js";
import { coalesce, el } from "./shared.js";
import type { SurfaceResult } from "./types.js";

/** How often the monitor re-reads bellman_rooms, and the canvas bellman_surface, while the page is visible. */
const POLL_MS = 15_000;

const root = document.getElementById("root")!;
const app = new App({ name: "Bellman", version: "0.1.0" });
/** session_id to the first last_event cursor this view saw (spec D4). */
const seen = new Map<string, number>();
/** Whether this host opens a nested frame (canvas spec D9): asked once, now, and awaited by the first canvas draw. */
const nestedFrames = probeNestedFrames();
let poll: number | undefined;
/** What the timer re-reads: the monitor, or one room's surface. */
let current: { kind: "monitor" } | { kind: "canvas"; sessionId: string; canvas: Canvas } | null = null;

function show(node: HTMLElement): void {
  root.replaceChildren(node);
}

function failed(err: unknown): void {
  show(el("p", { class: "error" }, `Refresh failed: ${err instanceof Error ? err.message : String(err)}`));
}

function stopPolling(): void {
  if (poll !== undefined) clearInterval(poll);
  poll = undefined;
}

function startPolling(): void {
  stopPolling();
  poll = window.setInterval(() => {
    if (document.visibilityState !== "visible") return;
    if (current?.kind === "canvas") void refreshSurface(current.sessionId);
    else if (current?.kind === "monitor") void refresh();
  }, POLL_MS);
}

/**
 * The monitor's own read. Only ever bellman_rooms (spec D3): through the
 * bridge, a bellman_sync from here would count as the agent having seen the
 * events it returned, and they would never reach it. Coalesced, so the timer
 * and the Refresh button cannot start a second read while one is running.
 */
const refresh = coalesce(async (): Promise<void> => {
  try {
    render(await app.callServerTool({ name: "bellman_rooms", arguments: {} }));
  } catch (err) {
    failed(err);
  }
});

/** The canvas's own read: bellman_surface and nothing else (canvas spec D1, D7). One in flight at a time, as above. */
let surfaceRead: Promise<void> | undefined;
function refreshSurface(sessionId: string): Promise<void> {
  surfaceRead ??= (async () => {
    try {
      render(await app.callServerTool({ name: "bellman_surface", arguments: { session_id: sessionId } }));
    } catch (err) {
      failed(err);
    } finally {
      surfaceRead = undefined;
    }
  })();
  return surfaceRead;
}

async function showCanvas(data: SurfaceResult): Promise<void> {
  const nested = await nestedFrames;
  if (current?.kind === "canvas" && current.sessionId === data.session_id) {
    current.canvas.update(data);
    return;
  }
  const canvas = createCanvas(data, {
    nested,
    onRefresh: () => void refreshSurface(data.session_id),
    onRooms: () => void refresh(),
    openLink: (url) => void app.openLink({ url }),
  });
  current = { kind: "canvas", sessionId: data.session_id, canvas };
  show(canvas.root);
  startPolling();
}

function render(result: ToolOutcome): void {
  const screen = pickScreen(result);
  switch (screen.kind) {
    case "join":
      current = null;
      stopPolling();
      show(renderJoin(screen.data, async (verdict) => {
        // The human's decision, handed to the agent as one user message of
        // identifiers (spec D5, D6). The agent calls bellman_confirm itself.
        // The screen reports "sent" only once the host has accepted it: the
        // answer goes back to the screen, which reads a refusal off isError.
        return app.sendMessage({ role: "user", content: [{ type: "text", text: verdictMessage(verdict) }] });
      }));
      return;
    case "monitor":
      current = { kind: "monitor" };
      show(renderMonitor(screen.data, seen, () => void refresh(), Date.now(), (id) => void refreshSurface(id)));
      startPolling();
      return;
    case "canvas":
      void showCanvas(screen.data);
      return;
    case "error":
      current = null;
      stopPolling();
      show(el("p", { class: "error" }, screen.text));
      return;
    case "none":
      current = null;
      stopPolling();
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
