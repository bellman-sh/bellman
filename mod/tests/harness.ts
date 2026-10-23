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
import { expect, mock } from "claude-code/testing";
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

/** The door of a bridge in hook delivery, holding a sign-in, with one seat, nothing waiting and nothing recent. */
export const STATUS: DoorStatus = {
  version: 1,
  delivery: "hook",
  has_sign_in: true,
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

/** The rooms a door's `/rooms` serves, as `bellman_rooms` gives them (roomSummary in src/projections.ts), with the fields the mod reads. */
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

/** A local bridge: the MCP server it is registered under, its door, and what the door answers for `/status` and `/rooms`. */
export type Bridge = { server: string; door: string | null; status: DoorStatus; rooms: Room[] };

export type World = {
  /** The door the `bellman` bridge's `bellman_whoami` names: null for a bridge older than the door. */
  door: string | null;
  status: DoorStatus;
  rooms: Room[];
  /** A door's `/rooms/<id>/surface` answer, by room (`bellman_surface`'s, as the bridge relays it); an empty canvas when unset. */
  surface: Record<string, unknown>;
  /** Each room's log, as every door serves it. */
  log: Record<string, DoorLog>;
  /** While true every door refuses, as the socket of a bridge that went away does. */
  doorDown: boolean;
  /** While set, every door's `/status` waits for it: a tick held mid-read. */
  held: Promise<void> | null;
  /** While set, every door's `/rooms` waits for it: a rooms read the server is slow to answer. */
  roomsHeld: Promise<void> | null;
  /** While set, every `bellman_whoami` answer waits for it: a hook of the mod's held mid-ask. */
  asking: Promise<void> | null;
  /** While true every `bellman_whoami` is refused, as a call the bridge cannot answer is. */
  whoamiFails: boolean;
  /** What a well-formed decline is answered: 200 with its cursor, or this status with an error (422 is the server's refusal). */
  declineStatus: number;
  /** Every request a door answered, in order, with the `?after=` it carried, when it carried one. */
  fetched: { socket: string; method: string; path: string; after?: string }[];
  /** Every decline a door answered, well-formed or not, with its body as JSON (or as the text it was, when it is none). */
  declined: { socket: string; room: string; body: unknown }[];
  /** A second local bridge, under another server's name, when a test sets one. */
  second?: Bridge;
  surfaces: RenderSurface[];
  /** While true `$.session.surfaces()` fails, as a call the engine cannot answer does. */
  surfacesDown: boolean;
  panes: UiPane[];
  /** Every `$.mcp.call`, in order: the mod's own are `bellman_whoami` alone (the harness fails any other). */
  calls: { server: string; tool: string; args: Readonly<Record<string, unknown>> }[];
  /** While true every `prompt.submit` rejects once the world has recorded it, as a submit the engine cannot take does. */
  submitFails: boolean;
  /** While true every `prompt.submit` resolves with a `drop` once the world has recorded it, as one a hook refuses does. */
  submitDrops: boolean;
  /** While true a hook refuses every append of a plugin's own: the call resolves with a `deny`, and nothing is stored. */
  appendRefused: boolean;
  /** The text of every prompt submitted. */
  submitted: string[];
  /** Where each of them came from, in the same order: the person's composer, a plugin, a peer. */
  origins: PromptOrigin[];
  toasts: string[];
  statuses: (string | undefined)[];
  /**
   * Every line the mod wrote to the log, in order. A write of the mod's state that the engine refuses, as it does one
   * over its limit on a value, never reaches the state hooks: the mod's line saying it failed is where it shows.
   */
  logged: string[];
  opened: PaneOpenArgs[];
  closed: string[];
  /**
   * In the order they reached the hooks beneath the mod: each `ui.open` and `ui.close`, and each write of the mod's
   * state as `state.set <key>`. The kit cannot tell an asked `ui.open` from an unasked one, which the engine reads
   * from where in the press the call is made (L13), so a test reads the order: a press that opens the pane before its
   * first await shows its `ui.open` ahead of the writes it goes on to make.
   */
  trail: string[];
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

/**
 * A Bellman tool's answer as `$.mcp.call` hands it to a plugin (Claude Code 2.1.302): a text block and `isError`, and
 * no `structuredContent`, which the engine passes on only for a tool that declares an output schema. No Bellman tool
 * declares one, so the JSON is in the text.
 */
const answer = (text: string) => ({ value: { content: [{ type: "text", text }], isError: false } });

const reply = (status: number, body: unknown) => ({
  value: { status, ok: status >= 200 && status < 300, headers: { "content-type": "application/json" }, text: JSON.stringify(body) },
});

/** A decline's body as the door takes it (`refIdOf` in src/door.ts): exactly `{ "ref_id": "<at most fifteen digits>" }`. */
function isDeclineBody(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body) || Object.keys(body).join() !== "ref_id") return false;
  const refId = (body as { ref_id: unknown }).ref_id;
  return typeof refId === "string" && /^\d{1,15}$/.test(refId);
}

/**
 * Registers, beneath the mod, the hooks that stand for the session, then raises `session.start`.
 * `over` sets what holds before the session starts: `{ door: null }` for a bridge older than the
 * door, `{ second }` for two bridges from the start. Set later, `w.door` is a bridge that restarted:
 * its old socket refuses from then on.
 */
export async function world($: Engine, on: On, over: Partial<Omit<World, "clock" | "rows" | "state" | "seed" | "trail">> = {}): Promise<World> {
  const clock = mock.clock(on, { now: NOW });
  const session = mock.session(on);
  const w: World = {
    door: "/tmp/bellman-door-1.sock",
    status: structuredClone(STATUS),
    rooms: structuredClone(ROOMS),
    surface: {},
    log: {},
    doorDown: false,
    held: null,
    roomsHeld: null,
    asking: null,
    whoamiFails: false,
    declineStatus: 200,
    fetched: [],
    declined: [],
    surfaces: ["terminal"],
    surfacesDown: false,
    panes: [],
    calls: [],
    submitFails: false,
    submitDrops: false,
    appendRefused: false,
    submitted: [],
    origins: [],
    toasts: [],
    statuses: [],
    logged: [],
    opened: [],
    closed: [],
    trail: [],
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
    if (e.plugin === "bellman-mod") w.trail.push(`state.set ${e.key}`);
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

  on("mcp.call", async ($, e, next) => {
    w.calls.push({ server: e.server, tool: e.tool, args: e.args });
    // Claude Code refuses the mod's own tool call from its timers and presses, and allows it only inside one of the
    // mod's own hooks, so the mod calls bellman_whoami there and nothing else (R15). The kit models no permission
    // check, so this stands in for it: a check that fails here fails the test that made the call.
    if (next.origin.plugin === "bellman-mod") expect(e.tool, `bellman-mod's own $.mcp.call of ${e.tool}`).toBe("bellman_whoami");
    const bridge = bridges().find((b) => b.server === e.server);
    if (!bridge) return { deny: `no MCP server is named ${e.server}` };
    switch (e.tool) {
      case "bellman_whoami": {
        // The bridge's own tool (`describeSelf` in src/bridge.ts), its JSON compact as the live look saw it.
        const door = bridge.door;
        await w.asking;
        if (w.whoamiFails) return { deny: "bellman_whoami failed" };
        return answer(JSON.stringify({ source: "env", label: null, door }));
      }
      case "bellman_send":
        // Another plugin's, through the engine's MCP connection (gate.test.ts), as `ok` writes a send's answer.
        return answer(JSON.stringify({ cursor: 99 }, null, 2));
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

  // The engine's permission verdict, for a person who allowed Claude's own bellman_send (on any server) and Bash, the
  // calls the hook above answers. From 2.1.307 the kit checks a test's `$.tool.call` as a session checks the model's
  // (2.1.305's raised no check there), and an `ask` with nobody to ask is a denial. Only that call is allowed: a real
  // call, which carries a `tool_use_id` where a `$.tool.check` query does not, and which the engine raised
  // (`next.origin`, `engine` for a test's `$`), where a plugin's own `$.tool.call` names the plugin; a check with no
  // `tool_use_id` never reads `next.origin`. Everything else is put to the person, as one no rule allows is. The kit
  // raises no `tool.check` for a plugin's own `$.mcp.call`, where the engine does, so the mod's allow of its own calls
  // (register.tsx) shows only in a real session; here, a test's `$.tool.check`, the engine's own, reaches this and is
  // asked.
  on("tool.check", ($, e, next) =>
    (e.tool === "Bash" || e.tool.endsWith("__bellman_send")) && e.tool_use_id !== undefined && next.origin.plugin === "engine"
      ? { decision: "allow", reason: `the person allowed ${e.tool}` }
      : { decision: "ask", reason: `the person is asked about ${e.tool}` },
  );

  // The engine's own sections, which the mod adds to and never replaces.
  on("prompt.compose", () => ({ sections: [{ id: "intro", text: "You are Claude Code.", scope: "shared" }] }));

  // A door answers on its bridge's socket, its routes as src/door.ts serves them. Any other socket is one nothing
  // listens on, which refuses.
  on("http.fetch", async ($, e) => {
    const socket = e.init?.socketPath;
    const bridge = bridges().find((b) => b.door !== null && b.door === socket);
    if (w.doorDown || !bridge || socket === undefined) return { deny: `connect ECONNREFUSED ${socket ?? e.url}` };
    const method = e.init?.method ?? "GET";
    const url = new URL(e.url);
    const path = url.pathname;
    const after = url.searchParams.get("after");
    w.fetched.push({ socket, method, path, ...(after === null ? {} : { after }) });
    const route = /^\/rooms\/([^/]+)\/(events|surface|decline)$/.exec(path);
    const room = route ? decodeURIComponent(route[1]!) : "";
    const seated = bridge.status.seats.some((s) => s.session_id === room);

    if (method === "POST" && route?.[2] === "decline") {
      const text = e.init?.body ?? "";
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        // Kept as the text it was.
      }
      w.declined.push({ socket, room, body });
      const type = Object.entries(e.init?.headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1];
      if (type?.split(";")[0]?.trim().toLowerCase() !== "application/json" || !isDeclineBody(body)) return reply(400, { error: "bad_request" });
      if (!seated) return reply(404, { error: "not_found" });
      return w.declineStatus === 200 ? reply(200, { cursor: 99 }) : reply(w.declineStatus, { error: "refused" });
    }
    if (method !== "GET") return reply(405, { error: "method_not_allowed" });
    if (path === "/status") {
      await w.held;
      return reply(200, bridge.status);
    }
    // The bridge's own seats' rooms, as bellman_rooms gives them.
    if (path === "/rooms") {
      await w.roomsHeld;
      return reply(200, { rooms: bridge.rooms.filter((r) => bridge.status.seats.some((s) => s.session_id === r.session_id)) });
    }
    if (route?.[2] === "events") {
      // What the room's log holds past `after`, or all of it with none.
      const log = w.log[room] ?? { events: [], cursor: 0 };
      return reply(200, after === null ? log : { events: log.events.filter((e) => e.cursor > Number(after)), cursor: log.cursor });
    }
    if (route?.[2] === "surface" && seated) return reply(200, w.surface[room] ?? { session_id: room, room: {}, surface: { cursor: 0, items: [] } });
    return reply(404, { error: "not_found" });
  });

  on("prompt.submit", ($, e) => {
    w.submitted.push(e.text);
    w.origins.push(e.origin);
    // A hook that throws is skipped, and the call is left with no implementation: it rejects.
    if (w.submitFails) throw new Error("prompt.submit is down");
    if (w.submitDrops) return { drop: "a hook refused the prompt" };
    return { text: e.text, origin: e.origin };
  });
  // Above the kit's own store of the conversation, which keeps every row that reaches it: a refused append never does.
  // The kit's store holds the one hook without a matcher, so this one names the door a plugin's own row comes in by.
  on("session.append", { door: "note" }, ($, e, next) => (w.appendRefused ? { deny: "a hook refused the row" } : next(e)));
  // A turn the test starts and ends, as the engine raises them: a hook that answers `{ turnId }` and `{ text }`.
  on("turn.start", ($, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("ui.toast", ($, e) => {
    w.toasts.push(e.text);
    return { value: undefined };
  });
  on("ui.log", ($, e) => {
    w.logged.push(e.text);
    return { value: undefined };
  });
  on("ui.status", ($, e) => {
    w.statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.open", ($, e) => {
    w.trail.push("ui.open");
    w.opened.push(e);
    return { value: { isPlaced: true } };
  });
  on("ui.close", ($, e) => {
    w.trail.push("ui.close");
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

/** The mod's lines saying a write of its state was refused: none, while every value it keeps is within the engine's limit. */
export const refusedWrites = (w: World): string[] => w.logged.filter((line) => line.includes("$.state.set"));

/** One door poll: the clock moves on by the mod's `DOOR_POLL_MS`. */
export const tick = (w: World): Promise<void> => w.clock.advance(DOOR_POLL_MS);

/** One rooms poll: the clock moves on by the mod's `ROOMS_POLL_MS`. */
export const roomsTick = (w: World): Promise<void> => w.clock.advance(ROOMS_POLL_MS);
