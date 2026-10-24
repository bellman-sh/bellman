/**
 * `/a2a`: A2A v1.0 over JSON-RPC (ADR 0033), for a signed-in caller asking a public room. The room is the request's
 * `tenant`, a public name or a room id. Only a room that is public and open answers; every other tenant, a private,
 * unpublished, closed, nonexistent or malformed one, gets the one `NO_ROOM` error, byte for byte.
 *
 * A room that has gone private or closed answers no new ask, but the caller who asked there still reads their own
 * tasks in it, ended, with why (`statusMessage`).
 *
 * `SendMessage` waits for the answer unless `returnImmediately` says not to, and the two streams send each change as it
 * happens; all three follow the task with `follow`, below, and stop at `BLOCK_CAP_MS`.
 *
 * A2A v0.3 has no `tenant`, so a room's own URL, `/a2a/<tenant>`, names it, and is served as 0.3 (Task 12): the 0.3
 * method names, parts and settings are translated onto the same v1.0 handlers, and their answers back into 0.3's
 * shapes. Nothing is decided twice, so every rule above holds there too.
 */
import { BANNED } from "../bans.js";
import { askRoom, cancelOutsideTask, MAX_OPEN_OUTSIDE_TASKS, outsideTask, outsideTasksOf, type AskError } from "../outside.js";
import { MAX_PAYLOAD_CHARS } from "../payload.js";
import { PUBLIC_NAME } from "../public-names.js";
import { isPublic, type BellmanStore } from "../store.js";
import { SUSPENDED } from "../suspension.js";
import { MAX_WAIT_SECONDS } from "../tools/kit.js";
import type { Identity, OutsideTask } from "../types.js";
import { A2A_ERRORS, errorInfo, parseRpc, rpcError, rpcResult, type RpcId } from "./jsonrpc.js";

export type A2aDeps = {
  store: BellmanStore;
  /** Signed in: the Worker answers a request with no caller with its 401 before it gets here. */
  caller: Identity;
  /** Whether the caller's account is suspended, as the Worker's registry cache says. Asked only of a method that reads or writes a room. */
  suspended: () => Promise<boolean>;
  origin: string;
  /** How long a blocking `SendMessage` or a stream follows a task; `BLOCK_CAP_MS` unless a test shortens it. */
  blockCapMs?: number;
  /** One wait on the room; `MAX_WAIT_SECONDS` unless a test shortens it. */
  waitRoundMs?: number;
};

/**
 * The longest a blocking `SendMessage` waits, and a stream stays open, before it hands back the task as it stands
 * (ADR 0033 ruling b): Cloudflare's 400 s idle-connection limit less 5 s. A capped stream is resubscribed.
 */
export const BLOCK_CAP_MS = 395_000;

const ROOMS = "https://bellman.sh/r/";
const NO_TENANT = `Name a public room in \`tenant\`. Public rooms are listed at ${ROOMS}.`;
const NO_ROOM = `No public room answers to that tenant. Public rooms are listed at ${ROOMS}.`;
const NO_TASK = "No task of yours in this room has that id.";
const NO_TEXT = "Rooms read text. Put the question in a text part.";
const TOO_LONG = `The question is too long. Keep it under ${MAX_PAYLOAD_CHARS.toLocaleString("en-US")} characters.`;
const OVER = "That task is already over. Read it with GetTask.";
const PUSH = "Push notifications aren't supported. Read the answer with GetTask.";
const NO_EXTENDED_CARD = "This agent has no extended card.";
const VERSION = "This endpoint speaks A2A 1.0. Send A2A-Version: 1.0. For A2A 0.3, post to the room's own URL, /a2a/<room>, which its card lists.";
const VERSION_03 = "This URL speaks A2A 0.3. For A2A 1.0, post to /a2a and name the room in tenant.";
/** The longest tenant looked up: no room id or public name comes near it, so a longer one is no room without a read. */
const MAX_TENANT_CHARS = 200;

/** A params field of the wrong shape, answered as invalid params with what to change. */
class BadParams extends Error {}

type Params = Record<string, unknown>;
const field = <T>(p: Params, name: string, ok: (v: unknown) => v is T, wants: string): T | undefined => {
  const v = p[name];
  if (v === undefined) return undefined;
  if (!ok(v)) throw new BadParams(`\`${name}\` must be ${wants}.`);
  return v;
};
const isString = (v: unknown): v is string => typeof v === "string";
const isCount = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0;
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean";
const historyLengthOf = (p: Params) => field(p, "historyLength", isCount, "a whole number, 0 or more");

/**
 * The room a tenant names, if this caller may read in it: a room that answers (public and open), or one that no longer
 * does, gone private or closed, for a caller who asked there. Every other tenant is undefined, alike. A public name
 * still finds a room that gave it up, as long as its record names it and no other room has claimed it since.
 */
async function readableRoom(store: BellmanStore, tenant: unknown, callerUserId: string) {
  if (typeof tenant !== "string" || tenant === "" || tenant.length > MAX_TENANT_CHARS) return undefined;
  const id = PUBLIC_NAME.test(tenant) ? (await store.publicNameEntry(tenant))?.id : tenant;
  const room = id === undefined ? undefined : await store.getSession(id);
  if (!room || (PUBLIC_NAME.test(tenant) && room.publicName !== tenant)) return undefined;
  if (isPublic(room) && !room.closed) return room;
  return (await outsideTasksOf(store, room.id, callerUserId)).length > 0 ? room : undefined;
}

/** A refusal of this caller, with the reason a program can branch on. */
const refused = (id: RpcId, reason: string, message: string, metadata?: Record<string, string>, headers?: HeadersInit) =>
  rpcError(id, A2A_ERRORS.refused.code, message, [errorInfo(reason, metadata)], headers);

/** How each refusal of an ask is answered. `not_found` and `task_not_found` are the same answers GetTask gives. */
function askRefused(id: RpcId, error: AskError, retryAfter: number | undefined): Response {
  switch (error) {
    case "not_found": return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
    case "task_not_found": return rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK);
    case "banned": return refused(id, "BANNED", BANNED);
    case "suspended": return refused(id, "SUSPENDED", SUSPENDED);
    case "rate_limited": {
      const after = String(retryAfter ?? 60);
      return refused(id, "RATE_LIMITED", `Too many questions in a minute. Try again in ${after} seconds.`,
        { retry_after: after }, { "retry-after": after });
    }
    case "too_many_open":
      return refused(id, "TOO_MANY_OPEN",
        `You have ${MAX_OPEN_OUTSIDE_TASKS} questions open in this room. Wait for an answer, or cancel one with CancelTask.`);
    case "not_input_required":
      return rpcError(id, A2A_ERRORS.unsupportedOperation.code, "That task isn't waiting on you. Leave out taskId to ask something new.");
    case "bad_context":
      return rpcError(id, A2A_ERRORS.invalidParams.code, "That contextId isn't yours in this room. Leave it out and the room uses yours.");
  }
}

type Asked = { cursor: number; text: string };

/** The caller's questions on a task, from the room's log. A question the log no longer holds is left out. */
const askedOn = async (store: BellmanStore, task: OutsideTask): Promise<Asked[]> =>
  (await Promise.all(task.questionCursors.map(async (cursor) => {
    const event = await store.eventAt(task.sessionId, cursor);
    const text = event?.type === "outside_question" ? (event.payload as { text?: unknown }).text : undefined;
    return typeof text === "string" ? [{ cursor, text }] : [];
  }))).flat();

/**
 * A task in A2A v1.0's shape. Its history is the caller's questions (`asked`) and the room's answers, in the room's
 * order, and nothing else the room said; `historyLength` keeps that many of the newest, and 0 leaves it out. The status
 * message is why the task ended, or else the latest answer once there is one to read.
 */
export function toA2aTask(task: OutsideTask, asked: readonly Asked[], historyLength?: number): object {
  const message = (messageId: string, role: "ROLE_USER" | "ROLE_AGENT", text: string) =>
    ({ messageId, contextId: task.contextId, taskId: task.id, role, parts: [{ text }] });
  const said = [
    ...asked.map((q) => ({ cursor: q.cursor, m: message(`${task.id}:${q.cursor}`, "ROLE_USER", q.text) })),
    ...task.answers.map((a) => ({ cursor: a.cursor, m: message(`${task.id}:${a.cursor}`, "ROLE_AGENT", a.text) })),
  ].sort((a, b) => a.cursor - b.cursor).map((s) => s.m);
  const answer = task.answers.at(-1);
  const status = task.statusMessage !== null
    ? message(`${task.id}:status`, "ROLE_AGENT", task.statusMessage)
    : task.state !== "TASK_STATE_WORKING" && answer ? message(`${task.id}:${answer.cursor}`, "ROLE_AGENT", answer.text) : undefined;
  return {
    id: task.id,
    contextId: task.contextId,
    status: { state: task.state, ...(status ? { message: status } : {}), timestamp: new Date(task.updatedAt).toISOString() },
    ...(historyLength === 0 ? {} : { history: historyLength === undefined ? said : said.slice(-historyLength) }),
  };
}

const a2aTask = async (store: BellmanStore, task: OutsideTask, historyLength?: number) =>
  toA2aTask(task, historyLength === 0 ? [] : await askedOn(store, task), historyLength);

/** A task that has stopped for its caller: ended, or waiting on them (INPUT_REQUIRED). Nothing changes it until they act. */
const settled = (t: OutsideTask) => t.state !== "TASK_STATE_WORKING";

/**
 * Follow a task until it settles, the cap passes, or `signal` aborts (the client went away), and return it as it then
 * stands. `changed` hears each new state. Each round long-polls the room from the end of its log, so any event, an
 * answer or the notice an ending appends, wakes it at once; it then re-reads the task row and reads nothing from the
 * event. A round is never longer than the time left, so no wait on the room outlives the cap, and an abort leaves the
 * one wait in flight to end on its own within a round.
 */
async function follow(
  deps: A2aDeps, start: OutsideTask, signal: AbortSignal, changed: (t: OutsideTask) => void = () => {}, idle: () => void = () => {},
): Promise<OutsideTask> {
  const until = Date.now() + (deps.blockCapMs ?? BLOCK_CAP_MS);
  const round = deps.waitRoundMs ?? MAX_WAIT_SECONDS * 1000;
  const reread = async (t: OutsideTask) => (await outsideTask(deps.store, t.sessionId, t.callerUserId, t.id)) ?? t;
  const gone = new Promise<null>((resolve) => {
    if (signal.aborted) resolve(null);
    signal.addEventListener("abort", () => resolve(null), { once: true });
  });
  // The log's end first, then the row: a change that lands between the two is in the row, and any later one wakes the wait.
  let cursor = (await deps.store.recentEvents(start.sessionId, 1))[0]?.cursor ?? 0;
  let task = await reread(start);
  if (task.state !== start.state) changed(task);
  while (!settled(task) && !signal.aborted) {
    const left = until - Date.now();
    if (left <= 0) break;
    const wait = deps.store.waitForEvents(task.sessionId, cursor, Math.min(round, left), 1);
    wait.catch(() => {}); // still pending after an abort, and nobody left to hear it fail
    const events = await Promise.race([wait, gone]);
    if (events === null) break;
    const last = events.at(-1);
    if (last) cursor = last.cursor;
    else idle();
    const now = await reread(task);
    if (now.state !== task.state) changed(now);
    task = now;
  }
  return task;
}

const SSE = { "content-type": "text/event-stream", "cache-control": "no-store" };

/**
 * A2A's stream (spec 3.1.2, 3.1.6, 9.4.2): the task first, then a `statusUpdate` for each change, each event a JSON-RPC
 * response carrying a `StreamResponse`. It closes after a settled state, at the cap (the client resubscribes), or
 * when the client goes away. A round with no event sends a comment, so a client's read timeout does not cut it.
 */
function stream(id: RpcId, deps: A2aDeps, task: OutsideTask, first: object, signal: AbortSignal): Response {
  const done = new AbortController();
  signal.addEventListener("abort", () => done.abort(), { once: true });
  const bytes = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(out) {
      const send = (text: string) => { if (!done.signal.aborted) out.enqueue(bytes.encode(text)); };
      const event = (result: object) => send(`data: ${JSON.stringify({ jsonrpc: "2.0", id, result })}\n\n`);
      const status = (t: OutsideTask) => (toA2aTask(t, [], 0) as { status: object }).status;
      void (async () => {
        try {
          event({ task: first });
          if (!settled(task)) {
            await follow(deps, task, done.signal,
              (t) => event({ statusUpdate: { taskId: t.id, contextId: t.contextId, status: status(t) } }), () => send(": waiting\n\n"));
          }
        } catch (err) {
          console.error("A2A stream failed:", err);
          send(`data: ${JSON.stringify({ jsonrpc: "2.0", id, error: { code: A2A_ERRORS.internal.code, message: A2A_ERRORS.internal.message } })}\n\n`);
        }
        try { out.close(); } catch { /* already canceled by the client */ }
      })();
    },
    cancel() {
      done.abort();
    },
  }), { headers: SSE });
}

/** Ask the room, or say why not: the task and how the caller wants it, or the response that refuses. */
async function ask(id: RpcId, p: Params, deps: A2aDeps): Promise<Response | { task: OutsideTask; historyLength?: number; immediate: boolean }> {
  const msg = p.message as { parts?: unknown; taskId?: unknown; contextId?: unknown } | undefined;
  if (!msg || typeof msg !== "object" || !Array.isArray(msg.parts)) throw new BadParams("`message` must be a Message with a `parts` list.");
  const taskId = field(msg as Params, "taskId", isString, "a string");
  const contextId = field(msg as Params, "contextId", isString, "a string");
  const historyLength = historyLengthOf(configOf(p));
  const immediate = field(configOf(p), "returnImmediately", isBoolean, "true or false") === true;
  // Text parts are the question; a file or data part is dropped. With no text there is no question, and nothing is stored.
  const text = msg.parts
    .map((part) => (part as { text?: unknown } | null)?.text)
    .filter((t): t is string => typeof t === "string" && t.trim() !== "")
    .join("\n");
  if (text === "") return rpcError(id, A2A_ERRORS.contentTypeNotSupported.code, NO_TEXT);
  if (JSON.stringify({ taskId: crypto.randomUUID(), text }).length > MAX_PAYLOAD_CHARS) {
    return rpcError(id, A2A_ERRORS.invalidParams.code, TOO_LONG);
  }

  if (p.tenant === undefined || p.tenant === "") {
    return rpcResult(id, { message: { messageId: crypto.randomUUID(), role: "ROLE_AGENT", parts: [{ text: NO_TENANT }] } });
  }
  if (typeof p.tenant !== "string" || p.tenant.length > MAX_TENANT_CHARS) return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
  const asked = await askRoom(deps.store, p.tenant, { userId: deps.caller.userId, label: deps.caller.label }, {
    text, ...(taskId === undefined ? {} : { taskId }), ...(contextId === undefined ? {} : { contextId }),
  });
  if (!asked.ok) return askRefused(id, asked.error, asked.retryAfter);
  return { task: asked.task, historyLength, immediate };
}

/** Blocking unless `returnImmediately`: the task once it settles, or as it stands at the cap or when the client leaves. */
async function sendMessage(id: RpcId, p: Params, deps: A2aDeps, signal: AbortSignal): Promise<Response> {
  const asked = await ask(id, p, deps);
  if (asked instanceof Response) return asked;
  const task = asked.immediate ? asked.task : await follow(deps, asked.task, signal);
  return rpcResult(id, { task: await a2aTask(deps.store, task, asked.historyLength) });
}

/** `returnImmediately` does nothing here: a stream always reports as it goes (spec 3.2.2). */
async function sendStreamingMessage(id: RpcId, p: Params, deps: A2aDeps, signal: AbortSignal): Promise<Response> {
  const asked = await ask(id, p, deps);
  if (asked instanceof Response) return asked;
  return stream(id, deps, asked.task, await a2aTask(deps.store, asked.task, asked.historyLength), signal);
}

/** The stream again, starting with the task as it is now (spec 3.1.6); a task that is over is UnsupportedOperation. */
async function subscribeToTask(id: RpcId, p: Params, deps: A2aDeps, signal: AbortSignal): Promise<Response> {
  const room = await readableRoom(deps.store, p.tenant, deps.caller.userId);
  if (!room) return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
  const taskId = field(p, "id", isString, "a string");
  const task = taskId === undefined ? undefined : await outsideTask(deps.store, room.id, deps.caller.userId, taskId);
  if (!task) return rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK);
  if (settled(task) && task.state !== "TASK_STATE_INPUT_REQUIRED") return rpcError(id, A2A_ERRORS.unsupportedOperation.code, OVER);
  return stream(id, deps, task, await a2aTask(deps.store, task), signal);
}

const configOf = (p: Params): Params => {
  const c = p.configuration;
  if (c === undefined) return {};
  if (!c || typeof c !== "object") throw new BadParams("`configuration` must be an object.");
  return c as Params;
};

async function getTask(id: RpcId, p: Params, deps: A2aDeps): Promise<Response> {
  const room = await readableRoom(deps.store, p.tenant, deps.caller.userId);
  if (!room) return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
  const taskId = field(p, "id", isString, "a string");
  const historyLength = historyLengthOf(p);
  const task = taskId === undefined ? undefined : await outsideTask(deps.store, room.id, deps.caller.userId, taskId);
  return task ? rpcResult(id, await a2aTask(deps.store, task, historyLength)) : rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK);
}

async function listTasks(id: RpcId, p: Params, deps: A2aDeps): Promise<Response> {
  const room = await readableRoom(deps.store, p.tenant, deps.caller.userId);
  if (!room) return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
  const contextId = field(p, "contextId", isString, "a string");
  const state = field(p, "status", isString, "a task state");
  const after = field(p, "statusTimestampAfter", isString, "a timestamp");
  const since = after === undefined ? undefined : Date.parse(after);
  if (Number.isNaN(since)) throw new BadParams("`statusTimestampAfter` must be a timestamp.");
  const pageSize = Math.min(100, Math.max(1, field(p, "pageSize", isCount, "a whole number from 1 to 100") ?? 50));
  const token = field(p, "pageToken", isString, "a token from nextPageToken") ?? "";
  const offset = token === "" ? 0 : Number(token);
  if (!isCount(offset)) throw new BadParams("`pageToken` must be a token from nextPageToken.");
  const historyLength = historyLengthOf(p);

  const matching = (await outsideTasksOf(deps.store, room.id, deps.caller.userId))
    .filter((t) => (contextId === undefined || t.contextId === contextId) && (state === undefined || t.state === state)
      && (since === undefined || t.updatedAt > since))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const page = matching.slice(offset, offset + pageSize);
  return rpcResult(id, {
    tasks: await Promise.all(page.map((t) => a2aTask(deps.store, t, historyLength))),
    nextPageToken: offset + pageSize < matching.length ? String(offset + pageSize) : "",
    pageSize,
    totalSize: matching.length,
  });
}

async function cancelTask(id: RpcId, p: Params, deps: A2aDeps): Promise<Response> {
  const room = await readableRoom(deps.store, p.tenant, deps.caller.userId);
  if (!room) return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
  const taskId = field(p, "id", isString, "a string");
  if (taskId === undefined) return rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK);
  const done = await cancelOutsideTask(deps.store, room.id, deps.caller.userId, taskId);
  if (done.ok) return rpcResult(id, await a2aTask(deps.store, done.task));
  return done.error === "task_not_found"
    ? rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK)
    : rpcError(id, A2A_ERRORS.taskNotCancelable.code, "That task is already over, so there is nothing to cancel.");
}

type Handler = (id: RpcId, p: Params, deps: A2aDeps, signal: AbortSignal) => Promise<Response>;
const HANDLERS = new Map<string, Handler>([
  ["SendMessage", sendMessage], ["SendStreamingMessage", sendStreamingMessage], ["SubscribeToTask", subscribeToTask],
  ["GetTask", getTask], ["ListTasks", listTasks], ["CancelTask", cancelTask],
]);
const PUSH_METHODS = new Set([
  "CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig",
]);

/** 0.3's method names (spec 0.3, section 7), as the v1.0 methods that serve them. Only these are methods at a 0.3 URL. */
const V03_METHODS = new Map([
  ["message/send", "SendMessage"], ["message/stream", "SendStreamingMessage"], ["tasks/get", "GetTask"],
  ["tasks/cancel", "CancelTask"], ["tasks/resubscribe", "SubscribeToTask"],
  ["tasks/pushNotificationConfig/set", "CreateTaskPushNotificationConfig"], ["tasks/pushNotificationConfig/get", "GetTaskPushNotificationConfig"],
  ["tasks/pushNotificationConfig/list", "ListTaskPushNotificationConfigs"], ["tasks/pushNotificationConfig/delete", "DeleteTaskPushNotificationConfig"],
  ["agent/getAuthenticatedExtendedCard", "GetExtendedAgentCard"],
]);

/** A room's 0.3 URL: one path segment under `/a2a`, the room's tenant. */
const V03_PATH = /^\/a2a\/([^/]+)$/;
/** Whether a path is `/a2a` or a room's 0.3 URL: one endpoint, and one OAuth resource, `/a2a`. */
export const isA2aPath = (path: string) => path === "/a2a" || V03_PATH.test(path);
/** A room's 0.3 card: where a 0.3 resolver looks, given the room's 0.3 URL. */
const V03_CARD_PATH = /^\/a2a\/([^/]+)\/\.well-known\/agent-card\.json$/;
/** A 0.3 URL's room segment as the tenant it names: decoded, or as it is when it is not percent-encoding (no room has that name). */
function tenantOf(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}
/** The tenant whose 0.3 card a path asks for, read as a 0.3 POST reads its room; undefined for any other path. */
export function v03CardTenant(path: string): string | undefined {
  const segment = V03_CARD_PATH.exec(path)?.[1];
  return segment === undefined ? undefined : tenantOf(segment);
}

/**
 * 0.3 params as v1.0's: the room from the URL (over any `tenant` in the body), a text part as v1.0's and any other kind
 * as a part with no text, so a message with no text part is refused as v1.0 refuses one, and `blocking` as its inverse,
 * `returnImmediately`. `id` and `historyLength` are named alike in both.
 */
function fromV03(p: Params, tenant: string): Params {
  const msg = p.message as { parts?: unknown } | null | undefined;
  const parts = msg && typeof msg === "object" && Array.isArray(msg.parts)
    ? { message: { ...msg, parts: msg.parts.map((part: { kind?: unknown; text?: unknown } | null) => part?.kind === "text" ? { text: part.text } : {}) } }
    : {};
  const config = configOf(p);
  const blocking = field(config, "blocking", isBoolean, "true or false");
  return { ...p, tenant, ...parts, ...(blocking === undefined ? {} : { configuration: { ...config, returnImmediately: !blocking } }) };
}

type V1Message = Record<string, unknown> & { role: string; parts: { text: string }[] };
type V1Status = Record<string, unknown> & { state: string; message?: V1Message };
type V1Task = Record<string, unknown> & { status: V1Status; history?: V1Message[] };

/** `TASK_STATE_INPUT_REQUIRED` as `input-required`. */
const v03State = (state: string) => state.replace(/^TASK_STATE_/, "").toLowerCase().replace(/_/g, "-");
const v03Message = (m: V1Message) =>
  ({ kind: "message", ...m, role: m.role === "ROLE_USER" ? "user" : "agent", parts: m.parts.map((part) => ({ kind: "text", text: part.text })) });
const v03Status = (s: V1Status) => ({ ...s, state: v03State(s.state), ...(s.message ? { message: v03Message(s.message) } : {}) });
const v03Task = (t: V1Task) => ({ kind: "task", ...t, status: v03Status(t.status), ...(t.history ? { history: t.history.map(v03Message) } : {}) });

/**
 * A v1.0 result in 0.3's shape: 0.3 sends the task or message itself, not wrapped, and a status change as a
 * `status-update` that says whether it is the last (the stream closes on any state but working).
 */
function v03Result(result: Record<string, unknown>): object {
  if (result.task) return v03Task(result.task as V1Task);
  if (result.message) return v03Message(result.message as V1Message);
  const update = result.statusUpdate as { taskId: string; contextId: string; status: V1Status } | undefined;
  if (!update) return v03Task(result as V1Task); // GetTask and CancelTask answer with the task itself
  const status = v03Status(update.status);
  return { kind: "status-update", taskId: update.taskId, contextId: update.contextId, status, final: status.state !== "working" };
}
const v03Rpc = (body: { result?: Record<string, unknown> }) => (body.result ? { ...body, result: v03Result(body.result) } : body);

/** A v1.0 handler's answer in 0.3's shapes: the JSON-RPC body, or each event of a stream. Errors pass as they are. */
async function toV03(res: Response): Promise<Response> {
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (!res.headers.get("content-type")?.startsWith("text/event-stream") || !res.body) {
    return new Response(JSON.stringify(v03Rpc(await res.json())), { status: res.status, headers });
  }
  const text = new TextDecoder();
  const bytes = new TextEncoder();
  let held = "";
  return new Response(res.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      held += text.decode(chunk, { stream: true });
      const events = held.split("\n\n");
      held = events.pop() ?? "";
      for (const e of events) out.enqueue(bytes.encode(`${e.startsWith("data: ") ? `data: ${JSON.stringify(v03Rpc(JSON.parse(e.slice(6))))}` : e}\n\n`));
    },
  })), { status: res.status, headers });
}

export async function a2aRoutes(request: Request, deps: A2aDeps): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const room03 = V03_PATH.exec(path)?.[1];
  if (path !== "/a2a" && room03 === undefined) return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, A2A_ERRORS.parseError.code, A2A_ERRORS.parseError.message);
  }
  const req = parseRpc(body);
  if ("error" in req) return rpcError(req.error.id, req.error.code, req.error.message);
  const { id } = req;

  // ADR 0033: an absent or empty A2A-Version is 0.3, served only at a room's own URL; /a2a speaks 1.0 alone.
  const version = request.headers.get("a2a-version")?.trim() ?? "";
  if (room03 === undefined ? version !== "1.0" : version !== "" && version !== "0.3") {
    return rpcError(id, A2A_ERRORS.versionNotSupported.code, room03 === undefined ? VERSION : VERSION_03);
  }
  const method = room03 === undefined ? req.method : V03_METHODS.get(req.method);
  if (method === undefined) return rpcError(id, A2A_ERRORS.methodNotFound.code, A2A_ERRORS.methodNotFound.message);

  if (PUSH_METHODS.has(method)) return rpcError(id, A2A_ERRORS.pushNotSupported.code, PUSH);
  if (method === "GetExtendedAgentCard") return rpcError(id, A2A_ERRORS.extendedCardNotConfigured.code, NO_EXTENDED_CARD);
  const handler = HANDLERS.get(method);
  if (!handler) return rpcError(id, A2A_ERRORS.methodNotFound.code, A2A_ERRORS.methodNotFound.message);

  const params = req.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return rpcError(id, A2A_ERRORS.invalidParams.code, "`params` must be an object.");
  }
  try {
    if (await deps.suspended()) return refused(id, "SUSPENDED", SUSPENDED);
    if (room03 === undefined) return await handler(id, params as Params, deps, request.signal);
    return await toV03(await handler(id, fromV03(params as Params, tenantOf(room03)), deps, request.signal));
  } catch (err) {
    if (err instanceof BadParams) return rpcError(id, A2A_ERRORS.invalidParams.code, err.message);
    console.error(`A2A ${method} failed:`, err);
    return rpcError(id, A2A_ERRORS.internal.code, A2A_ERRORS.internal.message);
  }
}
