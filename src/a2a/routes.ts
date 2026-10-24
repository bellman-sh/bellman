/**
 * `/a2a`: A2A v1.0 over JSON-RPC (ADR 0033), for a signed-in caller asking a public room. The room is the request's
 * `tenant`, a public name or a room id. Only a room that is public and open answers; every other tenant, a private,
 * unpublished, closed, nonexistent or malformed one, gets the one `NO_ROOM` error, byte for byte.
 *
 * The non-blocking methods only (Task 7): `SendMessage` answers with the task as it stands, WORKING, whatever
 * `returnImmediately` says, and the streaming methods are not supported. Task 8 replaces both.
 */
import { BANNED } from "../bans.js";
import { askRoom, cancelOutsideTask, MAX_OPEN_OUTSIDE_TASKS, outsideTask, outsideTasksOf, type AskError } from "../outside.js";
import { MAX_PAYLOAD_CHARS } from "../payload.js";
import { PUBLIC_NAME, roomNamed } from "../public-names.js";
import { isPublic, type BellmanStore } from "../store.js";
import { SUSPENDED } from "../suspension.js";
import type { Identity, OutsideTask } from "../types.js";
import { A2A_ERRORS, errorInfo, parseRpc, rpcError, rpcResult, type RpcId } from "./jsonrpc.js";

export type A2aDeps = {
  store: BellmanStore;
  /** Signed in: the Worker answers a request with no caller with its 401 before it gets here. */
  caller: Identity;
  /** Whether the caller's account is suspended, as the Worker's registry cache says. Asked only of a method that reads or writes a room. */
  suspended: () => Promise<boolean>;
  origin: string;
};

const ROOMS = "https://bellman.sh/r/";
const NO_TENANT = `Name a public room in \`tenant\`. Public rooms are listed at ${ROOMS}.`;
const NO_ROOM = `No public room answers to that tenant. Public rooms are listed at ${ROOMS}.`;
const NO_TASK = "No task of yours in this room has that id.";
const NO_TEXT = "Rooms read text. Put the question in a text part.";
const TOO_LONG = `The question is too long. Keep it under ${MAX_PAYLOAD_CHARS.toLocaleString("en-US")} characters.`;
const STREAMING = "Streaming isn't available yet. Send with SendMessage and read the answer with GetTask.";
const PUSH = "Push notifications aren't supported. Read the answer with GetTask.";
const NO_EXTENDED_CARD = "This agent has no extended card.";
const VERSION = "This endpoint speaks A2A 1.0. Send A2A-Version: 1.0.";
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
const historyLengthOf = (p: Params) => field(p, "historyLength", isCount, "a whole number, 0 or more");

/** The room a tenant names, when it is one that answers: public and open. Every other tenant is undefined, alike. */
async function answeringRoom(store: BellmanStore, tenant: unknown) {
  if (typeof tenant !== "string" || tenant === "" || tenant.length > MAX_TENANT_CHARS) return undefined;
  const room = PUBLIC_NAME.test(tenant) ? await roomNamed(store, tenant) : await store.getSession(tenant);
  return room && isPublic(room) && !room.closed ? room : undefined;
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

async function sendMessage(id: RpcId, p: Params, deps: A2aDeps): Promise<Response> {
  const msg = p.message as { parts?: unknown; taskId?: unknown; contextId?: unknown } | undefined;
  if (!msg || typeof msg !== "object" || !Array.isArray(msg.parts)) throw new BadParams("`message` must be a Message with a `parts` list.");
  const taskId = field(msg as Params, "taskId", isString, "a string");
  const contextId = field(msg as Params, "contextId", isString, "a string");
  const historyLength = historyLengthOf(configOf(p));
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
  return rpcResult(id, { task: await a2aTask(deps.store, asked.task, historyLength) });
}

const configOf = (p: Params): Params => {
  const c = p.configuration;
  if (c === undefined) return {};
  if (!c || typeof c !== "object") throw new BadParams("`configuration` must be an object.");
  return c as Params;
};

async function getTask(id: RpcId, p: Params, deps: A2aDeps): Promise<Response> {
  const room = await answeringRoom(deps.store, p.tenant);
  if (!room) return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
  const taskId = field(p, "id", isString, "a string");
  const historyLength = historyLengthOf(p);
  const task = taskId === undefined ? undefined : await outsideTask(deps.store, room.id, deps.caller.userId, taskId);
  return task ? rpcResult(id, await a2aTask(deps.store, task, historyLength)) : rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK);
}

async function listTasks(id: RpcId, p: Params, deps: A2aDeps): Promise<Response> {
  const room = await answeringRoom(deps.store, p.tenant);
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
  const room = await answeringRoom(deps.store, p.tenant);
  if (!room) return rpcError(id, A2A_ERRORS.invalidParams.code, NO_ROOM);
  const taskId = field(p, "id", isString, "a string");
  if (taskId === undefined) return rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK);
  const done = await cancelOutsideTask(deps.store, room.id, deps.caller.userId, taskId);
  if (done.ok) return rpcResult(id, await a2aTask(deps.store, done.task));
  return done.error === "task_not_found"
    ? rpcError(id, A2A_ERRORS.taskNotFound.code, NO_TASK)
    : rpcError(id, A2A_ERRORS.taskNotCancelable.code, "That task is already over, so there is nothing to cancel.");
}

const HANDLERS = new Map([["SendMessage", sendMessage], ["GetTask", getTask], ["ListTasks", listTasks], ["CancelTask", cancelTask]]);
const PUSH_METHODS = new Set([
  "CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig", "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig",
]);

export async function a2aRoutes(request: Request, deps: A2aDeps): Promise<Response | null> {
  if (new URL(request.url).pathname !== "/a2a") return null;
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return rpcError(null, A2A_ERRORS.parseError.code, A2A_ERRORS.parseError.message);
  }
  const req = parseRpc(body);
  if ("error" in req) return rpcError(req.error.id, req.error.code, req.error.message);
  const { id, method } = req;

  // ADR 0033: an absent or empty A2A-Version is to go to the 0.3 handler (Task 12); until it lands, it is read as 1.0.
  const version = request.headers.get("a2a-version")?.trim() ?? "";
  if (version !== "" && version !== "1.0") return rpcError(id, A2A_ERRORS.versionNotSupported.code, VERSION);

  if (PUSH_METHODS.has(method)) return rpcError(id, A2A_ERRORS.pushNotSupported.code, PUSH);
  if (method === "GetExtendedAgentCard") return rpcError(id, A2A_ERRORS.extendedCardNotConfigured.code, NO_EXTENDED_CARD);
  if (method === "SendStreamingMessage" || method === "SubscribeToTask") return rpcError(id, A2A_ERRORS.unsupportedOperation.code, STREAMING);
  const handler = HANDLERS.get(method);
  if (!handler) return rpcError(id, A2A_ERRORS.methodNotFound.code, A2A_ERRORS.methodNotFound.message);

  const params = req.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return rpcError(id, A2A_ERRORS.invalidParams.code, "`params` must be an object.");
  }
  try {
    if (await deps.suspended()) return refused(id, "SUSPENDED", SUSPENDED);
    return await handler(id, params as Params, deps);
  } catch (err) {
    if (err instanceof BadParams) return rpcError(id, A2A_ERRORS.invalidParams.code, err.message);
    console.error(`A2A ${method} failed:`, err);
    return rpcError(id, A2A_ERRORS.internal.code, A2A_ERRORS.internal.message);
  }
}
