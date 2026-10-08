import { countdown, duration, el, relative, text } from "./shared.js";
import type { MemberRow, RoomSummary, RoomsResult } from "./types.js";

function memberRow(m: MemberRow, now: number): HTMLTableRowElement {
  const b = m.beat;
  const payload = b.note?.data;
  const note = payload && typeof payload === "object" ? text((payload as { note?: unknown }).note) : text(payload);
  const standing = !b.asked
    ? el("span", { class: "muted" }, "not asked")
    : b.silent
      ? el("span", { class: "silent" }, `silent ${duration(b.silent_for_seconds)}`)
      : el("span", {}, `quiet ${duration(b.silent_for_seconds)}`);
  return el("tr", {},
    el("td", {}, m.label, el("span", { class: "chip" }, m.room_role)),
    el("td", {}, m.presence),
    el("td", {}, relative(b.last_report_at, now), " ", standing),
    el("td", { class: note ? "" : "muted" }, note || "—"),
  );
}

/** The room's canvas, one bellman_surface call away (canvas spec, "The canvas screen"). */
function surfaceButton(sessionId: string, onSurface: (sessionId: string) => void): HTMLElement {
  const button = el("button", {}, "Surface");
  button.addEventListener("click", () => onSurface(sessionId));
  return el("div", { class: "actions" }, button);
}

function roomCard(room: RoomSummary, seen: Map<string, number>, now: number, onSurface?: (sessionId: string) => void): HTMLElement {
  const latest = room.last_event?.cursor ?? 0;
  if (!seen.has(room.session_id)) seen.set(room.session_id, latest);
  const fresh = Math.max(0, latest - seen.get(room.session_id)!);
  const codes = room.join_codes.map((c) =>
    el("li", {},
      el("span", { class: "chip" }, c.role),
      " ",
      c.code ? el("code", {}, c.code) : el("span", { class: "muted" }, "live code"),
      ` · ${countdown(c.expires_at, now)}`),
  );
  return el("article", { class: "card" },
    el("h2", {},
      room.room.text.data.room,
      el("span", { class: "chip" }, room.status),
      el("span", { class: "chip" }, room.room.preset ?? room.room.mode)),
    el("p", { class: "muted" },
      `Your seat: ${room.room.your_role} (${room.room.your_verbs.join(", ") || "read only"}) · ` +
        `${room.active_members} of ${room.max_members} seats · expires ${countdown(room.expires_at, now)} · ` +
        `${fresh} new since you opened this`),
    el("table", {},
      el("thead", {}, el("tr", {}, el("th", {}, "Member"), el("th", {}, "Presence"), el("th", {}, "Last beat"), el("th", {}, "Said"))),
      el("tbody", {}, ...room.members.map((m) => memberRow(m, now)))),
    codes.length > 0 ? el("ul", { class: "codes" }, ...codes) : el("p", { class: "muted" }, "No live join code."),
    onSurface ? surfaceButton(room.session_id, onSurface) : null,
    el("p", { class: "muted" },
      room.last_event ? `Last event: ${room.last_event.type}, ${relative(room.last_event.at, now)}.` : "No events yet."),
  );
}

export function renderMonitor(
  r: RoomsResult,
  seen: Map<string, number>,
  onRefresh: () => void,
  now = Date.now(),
  onSurface?: (sessionId: string) => void,
): HTMLElement {
  const refresh = el("button", {}, "Refresh");
  refresh.addEventListener("click", onRefresh);
  const count = r.rooms.length;
  return el("section", { class: "monitor" },
    el("div", { class: "actions" }, el("h1", {}, `${count} room${count === 1 ? "" : "s"}`), refresh),
    ...(count > 0
      ? r.rooms.map((room) => roomCard(room, seen, now, onSurface))
      : [el("p", { class: "muted" }, "You are in no rooms. Ask your agent to start one, or to join with a code.")]),
  );
}
