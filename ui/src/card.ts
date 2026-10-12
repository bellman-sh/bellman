/**
 * The room card: bellman_start's result as a screen (the UI spec deferred it as "a room card on
 * bellman_start"). The room just made, its join code to share, the code as a link, and a public
 * room's page to read. The room's name is the creator's words and lands as text, as every room
 * name on these screens does.
 */
import { countdown, el } from "./shared.js";
import type { StartResult } from "./types.js";

export function renderCard(r: StartResult, openLink: (url: string) => void, now = Date.now()): HTMLElement {
  const open = (which: string, url: string): HTMLElement => {
    const button = el("button", { type: "button", "data-open": which }, "Open");
    button.addEventListener("click", () => openLink(url));
    return button;
  };
  return el("section", { class: "card" },
    el("h2", {}, r.room.text.data.room),
    el("p", {}, "Share this code with whoever you want in the room:"),
    el("p", { class: "code" }, r.join_code),
    el("p", { class: "muted" }, `${countdown(r.join_code_expires_at, now)} to use it. bellman_invite issues a new one.`),
    el("p", {}, "Or share it as a link: ", el("span", { class: "link" }, r.join_url), " ", open("join", r.join_url)),
    r.public_url
      ? el("p", {}, "Anyone with this link can read the room: ", el("span", { class: "link" }, r.public_url), " ", open("public", r.public_url))
      : null,
  );
}
