/**
 * The page's screens and reads, with the host's calls handed in (canvas spec
 * D6, D7). main.ts gives it the ext-apps App; the tests give it fakes. The
 * first cut kept this inside main.ts, where nothing could test it, and the
 * review found four wiring bugs there: this module is their fix and their test.
 *
 * Reads: the monitor's is only ever bellman_rooms (spec D3): through the
 * bridge, a bellman_sync from here would count as the agent having seen the
 * events it returned, and they would never reach it. The canvas's is only ever
 * bellman_surface (canvas spec D1). One read per key is in flight at a time, so
 * the timer and a button cannot start a second while one is running.
 *
 * Navigation: every result the host delivers, and every read a person starts
 * (Rooms, Surface, Refresh), bumps `generation`; a read that was in flight
 * before the bump drops its answer, so a late poll cannot put back a screen the
 * person just left.
 */
import { createCanvas, type Canvas } from "./canvas.js";
import { renderJoin, verdictMessage, type Delivery } from "./join.js";
import { renderMonitor } from "./monitor.js";
import { pickScreen, type ToolOutcome } from "./screen.js";
import { el } from "./shared.js";
import type { SurfaceResult } from "./types.js";

/** How often the monitor re-reads bellman_rooms, and the canvas bellman_surface, while the page is visible. */
export const POLL_MS = 15_000;

export interface PageDeps {
  root: HTMLElement;
  callTool: (name: string, args: Record<string, unknown>) => Promise<ToolOutcome>;
  /** The human's verdict from the join screen, as one user message (spec D5, D6). */
  sendMessage: (text: string) => Delivery | Promise<Delivery>;
  openLink: (url: string) => void;
  /** The probe's promise (artifact.ts): the first canvas draw waits for it (canvas spec D9). */
  nestedFrames: Promise<boolean>;
  visible?: () => boolean;
  pollMs?: number;
}

export interface Page {
  /** A result the host delivered: a navigation. */
  render(result: ToolOutcome): void;
  /** The monitor, read again. `user` marks a person's click, which outranks a read in flight. */
  rooms(opts?: { user?: boolean }): Promise<void>;
  /** One room's surface, read again. */
  surface(sessionId: string, opts?: { user?: boolean }): Promise<void>;
  stop(): void;
}

type Current = { kind: "monitor" } | { kind: "canvas"; sessionId: string; canvas: Canvas } | null;

export function createPage(deps: PageDeps): Page {
  const { root } = deps;
  /** session_id to the first last_event cursor this view saw (spec D4). */
  const seen = new Map<string, number>();
  const pollMs = deps.pollMs ?? POLL_MS;
  const visible = deps.visible ?? (() => document.visibilityState === "visible");
  let current: Current = null;
  let timer: number | undefined;
  let generation = 0;
  const inFlight = new Map<string, Promise<void>>();

  const show = (node: HTMLElement): void => root.replaceChildren(node);

  /** A failed read keeps the screen: the canvas says so on its status line; the monitor shows the error until its next poll re-renders it. */
  function failed(err: unknown): void {
    const message = `Refresh failed: ${err instanceof Error ? err.message : String(err)}`;
    if (current?.kind === "canvas") current.canvas.error(message);
    else show(el("p", { class: "error" }, message));
  }

  function stopPolling(): void {
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
  }

  function startPolling(): void {
    stopPolling();
    timer = window.setInterval(() => {
      if (!visible()) return;
      if (current?.kind === "canvas") void surface(current.sessionId);
      else if (current?.kind === "monitor") void rooms();
    }, pollMs);
  }

  function read(key: string, name: string, args: Record<string, unknown>, user: boolean): Promise<void> {
    if (user) generation++;
    const mine = generation;
    const pending = inFlight.get(key);
    if (pending && !user) return pending;
    // `let` with a definite assignment: the body refers to `run` after its first await, which TypeScript cannot see.
    let run!: Promise<void>;
    run = (async () => {
      try {
        const result = await deps.callTool(name, args);
        if (mine === generation) render(result, false);
      } catch (err) {
        if (mine === generation) failed(err);
      } finally {
        if (inFlight.get(key) === run) inFlight.delete(key);
      }
    })();
    inFlight.set(key, run);
    return run;
  }

  const rooms = (opts: { user?: boolean } = {}): Promise<void> => read("rooms", "bellman_rooms", {}, opts.user ?? false);
  const surface = (sessionId: string, opts: { user?: boolean } = {}): Promise<void> =>
    read(sessionId, "bellman_surface", { session_id: sessionId }, opts.user ?? false);

  async function showCanvas(data: SurfaceResult, mine: number): Promise<void> {
    const nested = await deps.nestedFrames;
    if (mine !== generation) return;
    if (current?.kind === "canvas" && current.sessionId === data.session_id) {
      current.canvas.update(data);
      if (!current.canvas.root.isConnected) show(current.canvas.root);
      return;
    }
    const canvas = createCanvas(data, {
      nested,
      onRefresh: () => void surface(data.session_id, { user: true }),
      onRooms: () => void rooms({ user: true }),
      openLink: deps.openLink,
    });
    current = { kind: "canvas", sessionId: data.session_id, canvas };
    show(canvas.root);
    // The first draw fits (canvas spec D6): the viewport has a size only now that it is in the document.
    canvas.fit();
    startPolling();
  }

  function render(result: ToolOutcome, navigation: boolean): void {
    if (navigation) generation++;
    const mine = generation;
    const screen = pickScreen(result);
    switch (screen.kind) {
      case "join":
        current = null;
        stopPolling();
        // The human's decision, handed to the agent as one user message of
        // identifiers (spec D5, D6). The agent calls bellman_confirm itself.
        // The screen reports "sent" only once the host has accepted it.
        show(renderJoin(screen.data, (verdict) => deps.sendMessage(verdictMessage(verdict))));
        return;
      case "monitor":
        current = { kind: "monitor" };
        show(renderMonitor(screen.data, seen, () => void rooms({ user: true }), Date.now(), (id) => void surface(id, { user: true })));
        startPolling();
        return;
      case "canvas":
        void showCanvas(screen.data, mine);
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

  return { render: (result) => render(result, true), rooms, surface, stop: stopPolling };
}
