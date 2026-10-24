import { PUBLIC_NAME, roomNamed } from "./public-names.js";
import { STRANGER_KEY_PREFIX, STRANGER_SEND_LIMIT } from "./send-limit.js";
import { isPublic, type BellmanStore } from "./store.js";
import type { OutsideCaller, OutsideTask } from "./types.js";

/** Outside callers (A2A) of a public room: the limits, and asking. The task row's type is `OutsideTask`, in types.ts. */

/** Tasks one caller may hold open in one room. */
export const MAX_OPEN_OUTSIDE_TASKS = 3;
/** How long a task lives with no activity: seven days. */
export const OUTSIDE_TASK_TTL_MS = 7 * 24 * 60 * 60_000;
/** How long a seat may stay silent on an outside question before the question goes to the members. */
export const SEAT_SILENCE_MS = 10 * 60_000;
/** Outside questions a seat answers per day. */
export const SEAT_OUTSIDE_DAILY_CAP = 20;

export type Caller = { userId: string; label: string; suspended?: boolean };
export type AskInput = { text: string; taskId?: string; contextId?: string };
export type AskError = "not_found" | "banned" | "suspended" | "rate_limited" | "too_many_open"
  | "task_not_found" | "not_input_required" | "bad_context";
export type AskResult = { ok: true; task: OutsideTask } | { ok: false; error: AskError; retryAfter?: number };

const refuse = (error: AskError, retryAfter?: number): AskResult => ({ ok: false, error, ...(retryAfter === undefined ? {} : { retryAfter }) });

/** A task of this caller in this room, or undefined for a task that is another's or that does not exist. */
export const outsideTask = (store: BellmanStore, sessionId: string, callerUserId: string, taskId: string): Promise<OutsideTask | undefined> =>
  store.outsideTask(sessionId, callerUserId, taskId);

/** This caller's tasks in this room, newest first. */
export const outsideTasksOf = (store: BellmanStore, sessionId: string, callerUserId: string): Promise<OutsideTask[]> =>
  store.outsideTasksOf(sessionId, callerUserId);

const isOpen = (t: OutsideTask): boolean => t.state === "TASK_STATE_WORKING" || t.state === "TASK_STATE_INPUT_REQUIRED";

/**
 * An outside caller asks a public room (A2A). `roomRef` is a public name or a room id, resolved as `/public` resolves
 * it. A room that is not public and open is "not_found", the same answer as a room that does not exist.
 *
 * The checks run in this order: the room, suspension, a ban (the room's or its creator's), the stranger's minute
 * (`admitSend`, counted per account as a permanent-code stranger's is), the open-task cap or the follow-up rule, then the
 * context. The question and the task row are one `appendEvent`, so neither exists without the other.
 *
 * Every task is answered by the members for now (`voice: "members"`, no `seatDeadline`).
 *
 * ponytail: the cap, a follow-up's state and a first ask's context and visitor number are read, then written, with
 * awaits between. Two asks from one account in the same instant can both pass the cap (at most one extra task, and the
 * minute's limit bounds the rest), mint two contexts, or double a visitor number. The upgrade is to re-check these
 * inside `extraRows`' transaction.
 */
export async function askRoom(
  store: BellmanStore,
  roomRef: string,
  caller: Caller,
  input: AskInput,
  now: number = Date.now(),
): Promise<AskResult> {
  const session = PUBLIC_NAME.test(roomRef) ? await roomNamed(store, roomRef) : await store.getSession(roomRef);
  if (!session || !isPublic(session) || session.closed) return refuse("not_found");
  if (caller.suspended) return refuse("suspended");
  if (await store.isBannedByCreator(session.createdBy, caller.userId) || await store.isBannedFromRoom(session.id, caller.userId)) {
    return refuse("banned");
  }
  const admitted = await store.admitSend(session.id, `${STRANGER_KEY_PREFIX}${caller.userId}`, STRANGER_SEND_LIMIT, now);
  if (!admitted.ok) return refuse("rate_limited", Math.ceil(admitted.retryAfterMs / 1000));

  let task: OutsideTask | undefined;
  if (input.taskId !== undefined) {
    task = await store.outsideTask(session.id, caller.userId, input.taskId);
    if (!task) return refuse("task_not_found");
    if (task.state !== "TASK_STATE_INPUT_REQUIRED") return refuse("not_input_required");
  } else if ((await store.outsideTasksOf(session.id, caller.userId)).filter(isOpen).length >= MAX_OPEN_OUTSIDE_TASKS) {
    return refuse("too_many_open");
  }

  const callers = await store.outsideCallers(session.id);
  const known = callers.find((c) => c.userId === caller.userId);
  if (input.contextId !== undefined && input.contextId !== known?.contextId) return refuse("bad_context");

  const handle = await store.handleOf(caller.userId);
  // A visitor's number is the next one the room has handed out, kept with them from their first ask.
  const visitor = handle !== undefined ? (known?.visitor ?? null)
    : known?.visitor ?? 1 + Math.max(0, ...callers.map((c) => c.visitor ?? 0));
  const origin = handle ?? `visitor ${visitor}`;
  const standing: OutsideCaller = { userId: caller.userId, contextId: known?.contextId ?? crypto.randomUUID(), visitor };
  const asked: OutsideTask = task
    ? { ...task, state: "TASK_STATE_WORKING", updatedAt: now }
    : {
      id: crypto.randomUUID(), contextId: standing.contextId, sessionId: session.id, callerUserId: caller.userId, origin,
      state: "TASK_STATE_WORKING", voice: "members", questionCursors: [], answers: [], createdAt: now, updatedAt: now, seatDeadline: null,
    };

  const event = await store.appendEvent(
    session.id,
    { type: "outside_question", fromMemberId: "system", fromUserId: "system", fromLabel: origin, payload: { taskId: asked.id, text: input.text }, refId: null },
    { outsideTask: asked, ...(known && !(known.visitor === null && handle === undefined) ? {} : { outsideCaller: standing }) },
  );
  // A room that froze since it was read takes no writes.
  if (!event) return refuse("not_found");
  const written = await store.outsideTask(session.id, caller.userId, asked.id);
  if (!written) throw new Error(`Outside task ${asked.id} was not written with its question`);
  return { ok: true, task: written };
}
