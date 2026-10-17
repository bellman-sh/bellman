/**
 * The wake (spec D7): a peer's message wakes a session nobody is typing into.
 *
 * In hook delivery the bridge queues a peer's events and the Stop hook hands them over when a turn ends, so an idle
 * session never hears its room. Each door tick tells this file how many interrupting events wait (the door's counts,
 * which take nothing from the inbox), and `stepWake` (src/mod/wake.ts) decides: submit a prompt to start a turn in an
 * idle session, append a row to the turn that is running, or leave it alone. Three wakes in a row with nothing from
 * the person pause waking until they send a prompt (in the composer, or through Remote Control) or press one of the
 * mod's buttons. When a turn runs and when the person types, this file learns from the hooks register.tsx owns (they
 * look for the doors as well), which call `turnStarted`, `turnEnded` and `promptSubmitted`.
 *
 * What the model is handed is `WAKE_TEXT` and nothing else. Nothing a peer wrote reaches `$.prompt.submit` or
 * `$.session.append`: not a label, a room's name or a message. The model reads the events through the bridge's own
 * tools, which wrap them as untrusted.
 */
import { update } from "claude-code";
import type { EngineInterface } from "claude-code";
import { IDLE_WAKE, WAKE_TEXT, isPaused, stepWake } from "../../src/mod/wake.js";
import type { WakeState } from "../../src/mod/wake.js";
import type { DoorView } from "../types";
import { onPerson } from "./person";
import { wake } from "./state";

/**
 * `stepWake`'s state: whether the batch now waiting has been woken for, and how many wakes the person has not
 * answered. A module variable, so a reload starts the count over; the next tick writes `wake` to match.
 */
let state: WakeState = IDLE_WAKE;

/** Whether the session's own turn is running. A subagent's turn is not: it neither makes the session busy nor ends its turn. */
let turnRunning = false;

/** The same, for the room pane's Approve: a running turn is told by an appended row, an idle session by a prompt. */
export const isTurnRunning = (): boolean => turnRunning;

const person = (): void => {
  state = stepWake(state, { kind: "person" }).state;
};

/** At `turn.start`: the session's own turn is running. */
export function turnStarted(e: { agentId?: string }): void {
  if (e.agentId === undefined) turnRunning = true;
}

/** At `turn.complete`: the session's own turn has ended. */
export function turnEnded(e: { agentId?: string }): void {
  if (e.agentId === undefined) turnRunning = false;
}

/**
 * At `prompt.submit`: the person's own prompt is the person, typed in the composer or sent through Remote Control
 * (`bridge`: a phone or web client, R13). A peer's message, another plugin's prompt (the wake's own included) and a
 * task's notification are prompts, but not input from the person.
 */
export function promptSubmitted(e: { origin: { kind: string } }): void {
  if (e.origin.kind === "composer" || e.origin.kind === "bridge") person();
}

/** A press on one of the mod's buttons or a pick in its room picker is the person too. */
export function registerWake(): void {
  onPerson(person);
}

/** After each door tick (register.tsx subscribes it): the interrupting events waiting in hook delivery, stepped. */
export async function wakeTick($: EngineInterface, list: readonly DoorView[]): Promise<void> {
  // A bridge in channel delivery pushes each event and starts a turn with it; it keeps no inbox to wake for.
  const interrupting = list.reduce(
    (sum, door) => (door.status?.delivery === "hook" ? sum + door.status.waiting.reduce((n, room) => n + room.interrupting, 0) : sum),
    0,
  );
  const step = stepWake(state, { kind: "tick", interrupting, turnRunning });
  state = step.state;
  await update($, wake, () => ({ paused: isPaused(state) }));

  if (step.act === "submit") {
    // Not awaited: the call resolves when the turn it queues starts. This only submits to a session it believes idle,
    // but a turn it did not see begin (the engine replaced this module mid-turn) would hold the tick, and every
    // other subscriber of it, until that turn ended. The framing is the plugin's own: never `asUser`, which would
    // read as the person's words.
    $.prompt.submit({ text: WAKE_TEXT }).catch((error: unknown) => {
      $.ui.log(`bellman-mod: the wake was not submitted: ${error instanceof Error ? error.message : String(error)}`, { to: "debug" });
    });
  } else if (step.act === "append") {
    await $.session.append({ message: { type: "user", content: [{ type: "text", text: WAKE_TEXT }] } });
  }
}
