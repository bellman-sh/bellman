/**
 * The world beneath bellman-mod in a kit test: the hooks that stand for the session, its local
 * bridges and their doors. Every kit test starts with `world($, on)`.
 *
 * A test's hooks sit beneath every plugin, so what these answer reaches the mod as the engine's own
 * answer would. Each world is fresh: the fixtures below are copied into it, never shared, so a test
 * may change anything it holds (`w.status.seats = []`, `w.door = ...`).
 *
 * Values come from the bundle under test, never from src/: `npm run test:mod` runs these from a copy
 * that holds only mod/'s files.
 *
 * A test reads the mod's `$.state` as `w.state`: the kit's `$` has no `state` noun, and it refuses a
 * test's own `$.state.get`, so the world keeps each value the kit stored for the mod.
 */
import type { On, PaneOpenArgs, PluginState, PromptOrigin, RenderElement, RenderPropsOf, RenderSurface, SessionAppendInput, UiPane } from "claude-code";
import { mock } from "claude-code/testing";
import type { Engine, MockClock } from "claude-code/testing";
import { DOOR_POLL_MS, PANE_ID, ROOMS_POLL_MS } from "../hooks/register.mjs";
import type { DoorEvent, DoorLog, DoorStatus } from "../types";

/** Where the mocked clock starts, and when the fixtures' events happened. */
export const NOW = Date.parse("2026-10-16T12:00:00.000Z");

/** What the engine draws wherever the mod answers `next(e)`: the world's stand-in beneath every plugin. */
export const ENGINE = { type: "Text", children: ["the engine's own"] };

/** The band above the prompt, nothing holding it, 95 cells across. */
export const BAND: RenderPropsOf["AbovePrompt"] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 95,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
};

/** The mod's pane, docked: `bodyColumns` is what a test sets. */
export const PANE: RenderPropsOf["Pane"] = {
  title: "Bellman",
  isFocused: false,
  bodyColumns: 22,
  placement: "dock",
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
};

/** The mod's pane as `$.ui.panes()` lists it: open, placed and shown. */
export const SHOWN: UiPane = { id: PANE_ID, title: "Bellman", isShown: true, isFocused: false, isPlaced: true };

/** The band on `surface`: on the terminal's main screen, unless `isFullscreen`. */
export const band = ($: Engine, surface: "terminal" | "desktop" = "terminal", isFullscreen = false) =>
  $.ui.mount({ plugin: "bellman-mod", surface, component: "AbovePrompt", props: BAND, viewport: { columns: 100, rows: 40, isFullscreen } });

/** The mod's pane on `surface`, `bodyColumns` across, docked beside a fullscreen transcript. */
export const pane = ($: Engine, bodyColumns: number, surface: "terminal" | "desktop" = "terminal") =>
  $.ui.mount({
    plugin: "bellman-mod",
    surface,
    component: "Pane",
    requestId: PANE_ID,
    props: { ...PANE, bodyColumns },
    viewport: { columns: 160, rows: 40, isFullscreen: true },
  });

/** Every text a tree shows, in order: its strings, each Button's label, each Select option's label. */
function texts(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string") out.push(node);
  if (node === null || typeof node !== "object") return out;
  const { props, children } = node as { props?: { label?: unknown; options?: { value: string; label?: string }[] }; children?: unknown[] };
  if (typeof props?.label === "string") out.push(props.label);
  for (const option of props?.options ?? []) out.push(option.label ?? option.value);
  for (const child of children ?? []) texts(child, out);
  return out;
}

/** What a mounted drawing shows, as one string. */
export const shown = async (ui: { drawn: () => Promise<unknown> }): Promise<string> => texts(await ui.drawn()).join(" ");

/** The door of a bridge in hook delivery, signed in, with one seat, nothing waiting and nothing recent. */
export const STATUS: DoorStatus = {
  version: 1,
  delivery: "hook",
  signed_in: true,
  seats: [{ session_id: "qs_room1", member_id: "m-me", retrying: false }],
  waiting: [],
  recent: [],
};

const member = (member_id: string, label: string, room_role: string, presence: "present" | "stale") => ({
  member_id,
  label,
  room_role,
  presence,
  beat: { asked: false, last_report_at: null, silent_for_seconds: null, silent: false, note: null },
});

/** `bellman_rooms`' rooms (roomSummary in src/projections.ts), with the fields the mod reads. */
export const ROOMS = [
  {
    session_id: "qs_room1",
    status: "active",
    max_members: 8,
    active_members: 4,
    your_member_id: "m-me",
    room: { preset: "swarm", public_name: null as string | null, your_role: "lead", your_verbs: ["send", "request_actions", "respond_actions"] },
    members: [
      member("m-me", "you", "lead", "present"),
      member("m-ada", "ada", "builder", "present"),
      member("m-rook", "rook", "reviewer", "present"),
      member("m-pip", "pip", "builder", "stale"),
    ],
    join_codes: [],
    last_event: { cursor: 1, type: "message", at: new Date(NOW).toISOString() },
  },
];

export type Room = (typeof ROOMS)[number];

/** A message from ada in qs_room1, as the door serves it to the seat m-me. */
export const peerEvent = (over: Partial<DoorEvent> = {}): DoorEvent => ({
  session_id: "qs_room1",
  member_id: "m-me",
  cursor: 1,
  type: "message",
  from_member_id: "m-ada",
  from_label: "ada",
  ref_id: null,
  at: new Date(NOW).toISOString(),
  payload: { text: "hello" },
  ...over,
});

/** A local bridge: the MCP server it is registered under, its door, and what the door and `bellman_rooms` answer. */
export type Bridge = { server: string; door: string | null; status: DoorStatus; rooms: Room[] };

export type World = {
  /** The door the `bellman` bridge's `bellman_whoami` names: null for a bridge older than the door. */
  door: string | null;
  status: DoorStatus;
  rooms: Room[];
  /** `bellman_surface`'s answer, by room. */
  surface: Record<string, unknown>;
  /** Each room's log, as every door serves it. */
  log: Record<string, DoorLog>;
  /** While true every door refuses, as the socket of a bridge that went away does. */
  doorDown: boolean;
  /** A second local bridge, under another server's name, when a test sets one. */
  second?: Bridge;
  surfaces: RenderSurface[];
  /** While true `$.session.surfaces()` fails, as a call the engine cannot answer does. */
  surfacesDown: boolean;
  panes: UiPane[];
  /** Every `$.mcp.call`, in order. */
  calls: { server: string; tool: string; args: Readonly<Record<string, unknown>> }[];
  /** The text of every prompt submitted. */
  submitted: string[];
  /** Where each of them came from, in the same order: the person's composer, a plugin, a peer. */
  origins: PromptOrigin[];
  toasts: string[];
  statuses: (string | undefined)[];
  opened: PaneOpenArgs[];
  closed: string[];
  clock: MockClock;
  /** The rows appended to the conversation. */
  readonly rows: readonly SessionAppendInput[];
  /** What the mod holds in `$.state`, by key: each write the kit stored. */
  state: Partial<PluginState["bellman-mod"]>;
  /**
   * Values the mod finds in `$.state` that no write of its own put there, by key: the state a press left, for a
   * test that needs it before the press exists. Read until the mod writes the key itself.
   */
  seed: Partial<PluginState["bellman-mod"]>;
};

/** An MCP tool's answer: its structured result, and the same as text. */
const answer = (structured: unknown) => ({
  value: { content: [{ type: "text", text: JSON.stringify(structured ?? null) }], isError: false, structuredContent: structured },
});

const reply = (status: number, body: unknown) => ({
  value: { status, ok: status >= 200 && status < 300, headers: { "content-type": "application/json" }, text: JSON.stringify(body) },
});

/**
 * Registers, beneath the mod, the hooks that stand for the session, then raises `session.start`.
 * `over` sets what holds before the session starts: `{ door: null }` for a bridge older than the
 * door, `{ second }` for two bridges from the start. Set later, `w.door` is a bridge that restarted:
 * its old socket refuses from then on.
 */
export async function world($: Engine, on: On, over: Partial<Omit<World, "clock" | "rows" | "state" | "seed">> = {}): Promise<World> {
  const clock = mock.clock(on, { now: NOW });
  const session = mock.session(on);
  const w: World = {
    door: "/tmp/bellman-door-1.sock",
    status: structuredClone(STATUS),
    rooms: structuredClone(ROOMS),
    surface: {},
    log: {},
    doorDown: false,
    surfaces: ["terminal"],
    surfacesDown: false,
    panes: [],
    calls: [],
    submitted: [],
    origins: [],
    toasts: [],
    statuses: [],
    opened: [],
    closed: [],
    clock,
    get rows() {
      return session.appended();
    },
    state: {},
    seed: {},
    ...over,
  };
  const bridges = (): Bridge[] => [{ server: "bellman", door: w.door, status: w.status, rooms: w.rooms }, ...(w.second ? [w.second] : [])];

  on("session.start", ($, e) => ({ cwd: e.cwd }));
  on("session.surfaces", () => {
    // A hook that throws is skipped, and the call is left with no implementation: it rejects.
    if (w.surfacesDown) throw new Error("session.surfaces is down");
    return { value: w.surfaces };
  });

  // Beneath the mod and above the kit's own store: a write that landed is the value a read would get.
  on("state.set", async ($, e, next) => {
    const set = await next(e);
    if (e.plugin === "bellman-mod" && set.value?.isSet) (w.state as Record<string, unknown>)[e.key] = e.value;
    return set;
  });
  // A seeded value reads at version 0, a value never written, so the mod's own first write of it still lands.
  on("state.get", ($, e, next) => {
    const seeded = e.plugin === "bellman-mod" && !(e.key in w.state) ? (w.seed as Record<string, unknown>)[e.key] : undefined;
    return seeded === undefined ? next(e) : { value: { value: seeded, version: 0 } };
  });

  // Each bridge lists its own tools; the connector lists bellman_send and no bellman_whoami.
  on("tool.list", () => ({
    value: [
      { name: "Bash", description: "Runs a command.", mcp: false },
      ...bridges().flatMap(({ server }) => [
        { name: `mcp__${server}__bellman_send`, description: "Sends to the room.", mcp: true },
        { name: `mcp__${server}__bellman_whoami`, description: "Says who you are.", mcp: true },
      ]),
      { name: "mcp__claude_ai_Bellman_sh__bellman_send", description: "Sends to the room.", mcp: true },
    ],
  }));

  on("mcp.call", ($, e) => {
    w.calls.push({ server: e.server, tool: e.tool, args: e.args });
    const bridge = bridges().find((b) => b.server === e.server);
    if (!bridge) return { deny: `no MCP server is named ${e.server}` };
    switch (e.tool) {
      case "bellman_whoami":
        return answer({ source: "env", label: null, door: bridge.door });
      case "bellman_rooms":
        return answer({ rooms: bridge.rooms });
      case "bellman_surface":
        return answer(w.surface[String(e.args.session_id)]);
      case "bellman_send":
        return answer({ cursor: 99 });
      default:
        return { deny: `the world answers no ${e.tool}` };
    }
  });

  // Claude's bellman_send, on any bridge's server, and its Bash run and succeed: a call nothing answers would
  // fail, and the gate's tests would read that as the gate's refusal.
  on("tool.call", ($, e, next) =>
    bridges().some((b) => e.tool === `mcp__${b.server}__bellman_send`)
      ? { result: { content: [{ type: "text", text: '{"cursor":99}' }], structuredContent: { cursor: 99 } } }
      : e.tool === "Bash"
        ? { result: { content: [{ type: "text", text: "ran" }] } }
        : next(e),
  );

  // The engine's own sections, which the mod adds to and never replaces.
  on("prompt.compose", () => ({ sections: [{ id: "intro", text: "You are Claude Code.", scope: "shared" }] }));

  // A door answers on its bridge's socket. Any other socket is one nothing listens on, which refuses.
  on("http.fetch", ($, e) => {
    const socket = e.init?.socketPath;
    const bridge = bridges().find((b) => b.door !== null && b.door === socket);
    if (w.doorDown || !bridge) return { deny: `connect ECONNREFUSED ${socket ?? e.url}` };
    const path = new URL(e.url).pathname;
    if (path === "/status") return reply(200, bridge.status);
    const room = /^\/rooms\/([^/]+)\/events$/.exec(path)?.[1];
    if (room !== undefined) return reply(200, w.log[decodeURIComponent(room)] ?? { events: [], cursor: 0 });
    return reply(404, { error: "not_found" });
  });

  on("prompt.submit", ($, e) => {
    w.submitted.push(e.text);
    w.origins.push(e.origin);
    return { text: e.text, origin: e.origin };
  });
  // A turn the test starts and ends, as the engine raises them: a hook that answers `{ turnId }` and `{ text }`.
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.toast", ($, e) => {
    w.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.status", ($, e) => {
    w.statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.open", ($, e) => {
    w.opened.push(e);
    return { value: { isPlaced: true } };
  });
  on("ui.close", ($, e) => {
    w.closed.push(e.id);
    return { value: undefined };
  });
  on("ui.panes", () => ({ value: w.panes }));
  // Beneath every plugin, as the engine's own drawing is: the kit refuses a mount that nothing answers.
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return h(Text, null, ...ENGINE.children) as RenderElement;
  });

  await $.session.start({ cwd: "/work", surface: w.surfaces[0] ?? null, isInteractive: true });
  return w;
}

/** One door poll: the clock moves on by the mod's `DOOR_POLL_MS`. */
export const tick = (w: World): Promise<void> => w.clock.advance(DOOR_POLL_MS);

/** One rooms poll: the clock moves on by the mod's `ROOMS_POLL_MS`. */
export const roomsTick = (w: World): Promise<void> => w.clock.advance(ROOMS_POLL_MS);
