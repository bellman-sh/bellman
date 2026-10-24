import { PUBLIC_NAME, roomNamed } from "./public-names.js";
import { STRANGER_KEY_PREFIX, STRANGER_SEND_LIMIT } from "./send-limit.js";
import { verbsOfRole } from "./roles.js";
import { isActiveMember, isHostMember, isPublic, type BellmanStore } from "./store.js";
import type { Member, OutsideCaller, OutsideTask, Session, SessionEvent } from "./types.js";

/** Outside callers (A2A) of a public room: the limits, asking and answering. The task row's type is `OutsideTask`, in types.ts. */

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

/** What `askOutside` is handed: the caller, what they asked, and the handle they sign in under, if any. */
export type AskRequest = { callerUserId: string; handle: string | undefined; text: string; taskId?: string; contextId?: string; now: number };
/** What `askOutside` answers: the task as written, or why it wrote nothing. */
export type AskOutcome = { ok: true; task: OutsideTask } | { ok: false; error: AskError };

/** The rows `decideAsk` reads, which each store reads inside the transaction (or the synchronous turn) that writes. */
export type AskRows = {
  /** Every task of this caller in this room. */
  mine: readonly OutsideTask[];
  /** The caller's standing in this room, if they have asked before. */
  known: OutsideCaller | undefined;
  /** The last visitor number this room handed out. */
  issued: number;
};

export type AskDecision =
  | { ok: false; error: AskError }
  | {
    ok: true;
    /** The task to write, WITHOUT this question's cursor, which the store assigns and appends. */
    task: OutsideTask;
    /** The caller's standing to write, or null when the row it holds is already right. */
    standing: OutsideCaller | null;
    /** The visitor counter to write. */
    issued: number;
    event: Omit<SessionEvent, "cursor" | "at">;
  };

/**
 * The decisions of an ask that depend on rows another ask can change: whether the room is still open, the
 * follow-up rule, the open-task cap, the caller's context and their visitor number. Pure, and shared by both stores,
 * as `decideApproval` is: each runs it over rows it read in the unit that writes the result, so two asks cannot both
 * pass a check the first one's write would have failed.
 */
export function decideAsk(room: Pick<Session, "id" | "closed" | "manifest" | "unpublishedAt">, req: AskRequest, rows: AskRows): AskDecision {
  if (!isPublic(room) || room.closed) return { ok: false, error: "not_found" };
  const named = req.taskId === undefined ? undefined : rows.mine.find((t) => t.id === req.taskId);
  if (req.taskId !== undefined) {
    if (!named) return { ok: false, error: "task_not_found" };
    if (named.state !== "TASK_STATE_INPUT_REQUIRED") return { ok: false, error: "not_input_required" };
  } else if (rows.mine.filter(isOpen).length >= MAX_OPEN_OUTSIDE_TASKS) {
    return { ok: false, error: "too_many_open" };
  }
  const { known } = rows;
  if (req.contextId !== undefined && req.contextId !== known?.contextId) return { ok: false, error: "bad_context" };

  const visitor = req.handle !== undefined ? (known?.visitor ?? null) : known?.visitor ?? rows.issued + 1;
  const issued = visitor !== null && visitor !== known?.visitor ? visitor : rows.issued;
  const contextId = known?.contextId ?? crypto.randomUUID();
  const origin = req.handle ?? `visitor ${visitor}`;
  const task: OutsideTask = named
    ? { ...named, state: "TASK_STATE_WORKING", updatedAt: req.now }
    : {
      id: crypto.randomUUID(), contextId, sessionId: room.id, callerUserId: req.callerUserId, origin,
      state: "TASK_STATE_WORKING", voice: "members", questionCursors: [], answers: [], createdAt: req.now, updatedAt: req.now, seatDeadline: null,
    };
  return {
    ok: true, task, issued,
    standing: known && visitor === known.visitor ? null : { userId: req.callerUserId, contextId, visitor },
    event: { type: "outside_question", fromMemberId: "system", fromUserId: "system", fromLabel: origin, payload: { taskId: task.id, text: req.text }, refId: null },
  };
}

/**
 * An outside caller asks a public room (A2A). `roomRef` is a public name or a room id, resolved as `/public` resolves
 * it. A room that is not public and open is "not_found", the same answer as a room that does not exist.
 *
 * The checks here, in order: the room, suspension, a ban (the room's or its creator's), the stranger's minute
 * (`admitSend`, counted per account as a permanent-code stranger's is). Then `store.askOutside` decides the rest (the
 * follow-up rule or the open-task cap, the context, the visitor number) and writes the question and the task row, all in
 * the one transaction, so concurrent asks see each other and neither the question nor the row exists without the other.
 *
 * Every task is answered by the members for now (`voice: "members"`, no `seatDeadline`).
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

  const done = await store.askOutside(session.id, {
    callerUserId: caller.userId, handle: await store.handleOf(caller.userId), text: input.text,
    ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    ...(input.contextId === undefined ? {} : { contextId: input.contextId }),
    now,
  });
  return done.ok ? done : refuse(done.error);
}

export type AnswerInput = { refId: number; text: string; needsInput?: boolean };
export type AnswerError = "not_a_question" | "not_the_voice" | "already_answered" | "task_closed";
export type AnswerResult = { ok: true; task: OutsideTask } | { ok: false; error: AnswerError };

/** What `answerOutside` is handed: the question answered, the task it belongs to, and who answers with what. */
export type AnswerRequest = { taskId: string; refId: number; memberId: string; text: string; needsInput: boolean; now: number };

/**
 * Whether this member is the voice that answers this task, at this moment:
 * - a `seat` task is answered by the host seat alone;
 * - otherwise by the current members whose role holds `answer`;
 * - and where no role does, by the creator's seat, while the creator is still in the room.
 * Read when the answer arrives, so a member who gained `answer` since the question was asked qualifies.
 */
export function isVoice(session: Pick<Session, "members" | "manifest" | "creator">, task: Pick<OutsideTask, "voice">, memberId: string): boolean {
  const me = session.members.find((m) => m.memberId === memberId);
  if (!me || !isActiveMember(me)) return false;
  if (task.voice === "seat") return isHostMember(me);
  const holders = session.members.filter((m) => isActiveMember(m) && verbsOfRole(session.manifest, m.roomRole).includes("answer"));
  return holders.length > 0 ? holders.includes(me) : me.memberId === session.creator.memberId;
}

export type AnswerDecision =
  | { ok: false; error: AnswerError }
  | { ok: true; task: OutsideTask; event: Omit<SessionEvent, "cursor" | "at"> };

/**
 * The decisions of an answer that depend on rows another answer can change: who the voice is, and whether the question
 * is still open. Pure and shared by both stores, as `decideAsk` is, each running it over the room and the task row it
 * read in the unit that writes the result, so two answers cannot both find the question open. The order of the errors
 * is the order of what a non-voice may learn: nothing about the task.
 *
 * The task is answerable while WORKING and `refId` is its latest question; an earlier question, or a task already
 * COMPLETED or waiting on INPUT_REQUIRED, is "already_answered". The returned task lacks the answer's own entry, which
 * `taskWithEvent` adds once the event is numbered.
 */
export function decideAnswer(room: Pick<Session, "members" | "manifest" | "creator">, task: OutsideTask | undefined, req: AnswerRequest): AnswerDecision {
  if (!task) return { ok: false, error: "task_closed" };
  if (!isVoice(room, task, req.memberId)) return { ok: false, error: "not_the_voice" };
  if (task.state === "TASK_STATE_FAILED" || task.state === "TASK_STATE_CANCELED") return { ok: false, error: "task_closed" };
  if (task.state !== "TASK_STATE_WORKING" || task.questionCursors.at(-1) !== req.refId) return { ok: false, error: "already_answered" };
  const me = room.members.find((m) => m.memberId === req.memberId) as Member;
  return {
    ok: true,
    task: { ...task, state: req.needsInput ? "TASK_STATE_INPUT_REQUIRED" : "TASK_STATE_COMPLETED", updatedAt: req.now },
    event: {
      type: "outside_answer", fromMemberId: me.memberId, fromUserId: me.userId, fromLabel: me.label,
      payload: { taskId: task.id, text: req.text, needsInput: req.needsInput }, refId: String(req.refId),
    },
  };
}

/**
 * A member answers an outside question (A2A). `refId` is the `outside_question`'s cursor: an event that is not one is
 * "not_a_question", decided here because events never change. Who may answer and whether the question is still open
 * change, so `store.answerOutside` decides them where it writes, and appends the `outside_answer` and the task row as
 * one unit: of two answers at once, one lands.
 */
export async function answerQuestion(
  store: BellmanStore,
  sessionId: string,
  member: Pick<Member, "memberId">,
  input: AnswerInput,
  now: number = Date.now(),
): Promise<AnswerResult> {
  const asked = await store.eventAt(sessionId, input.refId);
  const taskId = asked?.type === "outside_question" ? (asked.payload as { taskId?: unknown }).taskId : undefined;
  if (typeof taskId !== "string") return { ok: false, error: "not_a_question" };
  return store.answerOutside(sessionId, { taskId, refId: input.refId, memberId: member.memberId, text: input.text, needsInput: input.needsInput === true, now });
}
