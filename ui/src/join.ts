import { countdown, el } from "./shared.js";
import type { ConnectResult } from "./types.js";

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

export function renderJoin(r: ConnectResult, onVerdict: (v: Verdict) => void, now = Date.now()): HTMLElement {
  const brief = r.creator_brief.data;
  const prose = r.room.text.data;
  const byline = `Written by ${r.creator_brief.origin.label}. Not verified by Bellman.`;

  const roleRows = Object.entries(r.room.roles).map(([role, verbs]) =>
    el("tr", { class: role === r.room.your_role ? "you" : "" },
      el("td", {}, role),
      el("td", {}, verbs.length > 0 ? verbs.join(", ") : "read only"),
      el("td", { class: "muted" }, prose.descriptions[role] ?? "")),
  );

  const boxes = CAPABILITIES.map((c) => {
    const input = el("input", { type: "checkbox", "data-capability": c.key });
    input.checked = c.on;
    return el("label", {}, input, ` ${c.label}`);
  });

  const confirm = el("button", { class: "primary" }, `Join as ${r.room.your_role}`);
  const decline = el("button", {}, "Decline");
  const status = el("p", { class: "muted" });
  let settled = false;
  const settle = (v: Verdict) => {
    if (settled) return;
    settled = true;
    confirm.disabled = true;
    decline.disabled = true;
    status.textContent = v.kind === "confirm"
      ? "Sent to your agent. It will call bellman_confirm with its brief."
      : "Sent to your agent. It will not join.";
    onVerdict(v);
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

  return el("section", { class: "join" },
    el("h1", {}, "Join a Bellman room"),
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
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Role"), el("th", {}, "May"), el("th", {}, "Description (creator's words)"))),
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
