import { countdown, el } from "./shared.js";
import type { ConnectResult, RoomBlock } from "./types.js";

/** What a joiner may grant peers. The same three the server's CapabilitiesShape accepts, and its defaults. */
export const CAPABILITIES = [
  { key: "read_context", label: "Read my brief", on: true },
  { key: "receive_messages", label: "Send me messages and artifacts", on: true },
  { key: "request_actions", label: "Ask my session to do things (I approve each one)", on: false },
] as const;

export type Verdict =
  | { kind: "confirm"; role: string; capabilities: string[] }
  | { kind: "decline" };

/**
 * The sentence handed to the agent as a user message (spec D5, D6). Identifiers
 * only: the role key the server validated and the capability names the human
 * ticked. Never the room's name, purpose, a description or a brief field: those
 * are the creator's words, and in a user message they would speak as the human.
 */
export function verdictMessage(v: Verdict): string {
  if (v.kind === "decline") {
    return "Do not join the room previewed by bellman_connect. Discard its connect_token.";
  }
  return `Confirm joining the room previewed by bellman_connect as role ${v.role}, with capabilities ${v.capabilities.join(", ")}. ` +
    "Call bellman_confirm with the connect_token from that preview and a brief about this session.";
}

/**
 * A span of seconds as the largest whole unit that holds it exactly, so "90m" stays "90m". Not
 * `duration`, which rounds for a relative time: this is the number the human is agreeing to.
 */
function exact(seconds: number): string {
  for (const [unit, size] of [["d", 86_400], ["h", 3_600], ["m", 60]] as const) {
    if (seconds % size === 0) return `${seconds / size}${unit}`;
  }
  return `${seconds}s`;
}

/**
 * What the room will name its members for (#66), as the one line this screen adds: the consent point has
 * to say that a member of this room is named quiet while it sends nothing, and after how long. Null when
 * the room names nothing, including a block whose every threshold is off.
 */
function housekeepingLine(h: RoomBlock["housekeeping"]): string | null {
  if (!h) return null;
  const named = [
    h.quiet_after_seconds !== null ? `a member quiet after ${exact(h.quiet_after_seconds)} without a send` : null,
    h.answer_within_seconds !== null ? `a request unanswered after ${exact(h.answer_within_seconds)}` : null,
    h.idle_after_seconds !== null ? `the room idle after ${exact(h.idle_after_seconds)}` : null,
  ].filter((part): part is string => part !== null);
  if (named.length === 0) return null;
  const list = named.length > 1 ? `${named.slice(0, -1).join(", ")} and ${named[named.length - 1]}` : named[0];
  const again = h.repeat_after_seconds !== null ? `every ${exact(h.repeat_after_seconds)}` : "after the same time";
  return `Bellman names ${list}, and names each again ${again} while it holds.`;
}

/** What the host answers ui/message with: ext-apps reports a refusal as `isError`, not as a rejection. */
export type Delivery = { isError?: boolean } | void;

/**
 * `onVerdict` is the host's acceptance of the message (spec D5): the screen
 * says "sent" only once it resolves without `isError`. If the host refuses,
 * by rejecting or by answering `isError`, the human is handed the verdict text
 * to relay by hand. That is safe to show because the text is identifiers only (D6).
 */
export function renderJoin(
  r: ConnectResult,
  onVerdict: (v: Verdict) => Delivery | Promise<Delivery>,
  now = Date.now(),
): HTMLElement {
  const brief = r.creator_brief.data;
  const prose = r.room.text.data;
  const byline = `Written by ${r.creator_brief.origin.label}. Not verified by Bellman.`;

  const roleRows = Object.entries(r.room.roles).map(([role, verbs]) =>
    el("tr", { class: role === r.room.your_role ? "you" : "" },
      el("td", {}, role),
      el("td", {}, verbs.length > 0 ? verbs.join(", ") : "read only"),
      el("td", {}, r.room.reports[role] ? "yes" : "no"),
      el("td", { class: "muted" }, prose.descriptions[role] ?? "")),
  );

  const boxes = CAPABILITIES.map((c) => {
    const input = el("input", { type: "checkbox", "data-capability": c.key });
    input.checked = c.on;
    return el("label", {}, input, ` ${c.label}`);
  });

  const confirm = el("button", { class: "primary" }, `Join as ${r.room.your_role}`);
  const decline = el("button", {}, "Decline");
  // A live region: the text below changes after the click, and a screen reader is told.
  const status = el("p", { class: "muted", role: "status" });
  let settled = false;
  const settle = (v: Verdict) => {
    if (settled) return;
    settled = true;
    confirm.disabled = true;
    decline.disabled = true;
    status.textContent = "Sending to your agent…";
    const sent = () => {
      status.textContent = v.kind === "confirm"
        ? "Sent to your agent. It will call bellman_confirm with its brief."
        : "Sent to your agent. It will not join.";
    };
    const refused = () => {
      status.textContent = `Your host did not accept the message. Tell your agent: ${verdictMessage(v)}`;
    };
    let outcome: Promise<Delivery>;
    try {
      outcome = Promise.resolve(onVerdict(v));
    } catch (err) {
      outcome = Promise.reject(err);
    }
    outcome.then((answer) => (answer && answer.isError ? refused() : sent()), refused);
  };
  confirm.addEventListener("click", () => settle({
    kind: "confirm",
    role: r.room.your_role,
    capabilities: boxes
      .map((label) => label.querySelector("input")!)
      .filter((input) => input.checked)
      .map((input) => input.dataset.capability!),
  }));
  decline.addEventListener("click", () => settle({ kind: "decline" }));

  const seat = `You may: ${r.room.your_verbs.length > 0 ? r.room.your_verbs.join(", ") : "read only"}.` +
    (r.room.you_report && r.room.heartbeat_on_seconds !== null
      ? ` You must report every ${r.room.heartbeat_on_seconds}s.`
      : "");

  const naming = housekeepingLine(r.room.housekeeping);

  return el("section", { class: "join" },
    el("h1", {}, "Join a Bellman room"),
    // The server's fact, not the creator's words: outside the untrusted box, before the seat is chosen (public rooms spec D5).
    r.room.public
      ? el("p", {}, el("strong", {}, "Public room."), " Anyone with this room's link can read its surface and its log.")
      : null,
    el("div", { class: "untrusted" },
      el("p", { class: "caption" }, byline),
      el("h2", {}, prose.room),
      prose.purpose ? el("p", {}, prose.purpose) : null,
      el("dl", {},
        el("dt", {}, "Goal"), el("dd", {}, brief.goal),
        el("dt", {}, "State"), el("dd", {}, brief.state),
        el("dt", {}, "Constraints"), el("dd", {}, brief.constraints.join("; ") || "none"),
        el("dt", {}, "Open questions"), el("dd", {}, brief.open_questions.join("; ") || "none"),
        el("dt", {}, "Agent"), el("dd", {}, `${brief.agent.provider} ${brief.agent.model} via ${brief.agent.client}`)),
    ),
    el("h2", {}, `Your seat: ${r.room.your_role}`),
    el("p", {}, seat),
    naming ? el("p", {}, naming) : null,
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Role"), el("th", {}, "May"), el("th", {}, "Reports"), el("th", {}, "Description (creator's words)"))),
      el("tbody", {}, ...roleRows)),
    el("p", { class: "muted" },
      `${r.session.active_members} of ${r.session.max_members} seats taken, ${r.session.mode} room` +
        (r.session.org_only ? ", the creator's org only" : "") +
        `. This preview expires: ${countdown(r.connect_token_expires_at, now)}.`),
    el("fieldset", {}, el("legend", {}, "Peers may"), ...boxes),
    el("div", { class: "actions" }, confirm, decline),
    status,
  );
}
