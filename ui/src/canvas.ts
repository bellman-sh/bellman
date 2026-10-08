/**
 * The canvas screen (canvas spec D5 to D8): the surface as cards on a
 * transformed layer, lines between them, and the controls. Read-only: every
 * button here reads again, opens a link through the host, or moves the view.
 */
import { artifactFrame } from "./artifact.js";
import { centerOf, fit, layout, zoomAbout, type Box, type Line, type Transform } from "./canvas-layout.js";
import { el, relative, text } from "./shared.js";
import type { SurfaceItemWire, SurfaceResult, Untrusted } from "./types.js";

export const DASH_ORIGIN = "https://dash.bellman.sh";
/** The room's canvas page in the panel (`roomRoute` in dash's src/router.tsx). */
export const dashRoomUrl = (sessionId: string): string => `${DASH_ORIGIN}/rooms/${encodeURIComponent(sessionId)}`;

export interface CanvasDeps {
  /** The probe's verdict (artifact.ts): whether an html body renders here or opens in dash. */
  nested: boolean;
  onRefresh: () => void;
  onRooms: () => void;
  openLink: (url: string) => void;
}

export interface Canvas {
  root: HTMLElement;
  /** A new result: the status line always; the cards only when the cursor moved (spec D7). */
  update(r: SurfaceResult, now?: number): void;
  transform(): Transform;
}

const ZOOM_STEP = 1.25;
const PAN_STEP = 40;
const SVG = "http://www.w3.org/2000/svg";

/** The body as an http(s) URL, or null: a peer's body is not trusted to be one. */
export function httpUrl(body: string | null): string | null {
  try {
    const url = new URL(body ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const blobLine = (blob: NonNullable<SurfaceItemWire["blob"]>): HTMLElement =>
  el("p", { class: "muted" }, `${blob.name} · ${size(blob.bytes)} · ${blob.type}`);

function openInDash(sessionId: string, deps: CanvasDeps): HTMLButtonElement {
  const button = el("button", {}, "Open in dash");
  button.addEventListener("click", () => deps.openLink(dashRoomUrl(sessionId)));
  return button;
}

/** A class name from the kind, for a kind the server validated; anything else is "other". No peer text in an attribute. */
const kindClass = (kind: string): string => (/^[a-z]{1,16}$/.test(kind) ? kind : "other");

/** One card. The header is the envelope's, never the body's (spec, Trust). */
function renderCard(e: Untrusted<SurfaceItemWire>, box: Box, sessionId: string, deps: CanvasDeps, now: number): HTMLElement {
  const item = e.data;
  const card = el("article", { class: `item kind-${kindClass(item.kind)}` });
  card.style.left = `${box.x}px`;
  card.style.top = `${box.y}px`;
  card.style.width = `${box.w}px`;
  card.style.minHeight = `${box.h}px`;
  card.append(el("header", { class: "muted" }, el("span", { class: "by" }, text(e.origin.label)), " · ", el("span", { title: item.at }, relative(item.at, now))));
  if (item.title) card.append(el("h3", {}, text(item.title)));
  switch (item.kind) {
    case "text":
      card.append(el("p", { class: "body" }, text(item.body)));
      break;
    case "link": {
      const url = httpUrl(item.body);
      const open = el("button", {}, "Open");
      open.disabled = url === null;
      if (url) open.addEventListener("click", () => deps.openLink(url));
      card.append(el("p", { class: "muted" }, url ? new URL(url).host : "not a web address"), open);
      break;
    }
    case "file":
    case "image":
      if (item.blob) card.append(blobLine(item.blob));
      card.append(openInDash(sessionId, deps));
      break;
    case "diagram":
      card.append(el("pre", {}, text(item.body)), openInDash(sessionId, deps));
      break;
    case "html":
      if (item.body !== null && deps.nested) {
        card.append(artifactFrame(item.body, item.title ?? "artifact"));
      } else {
        if (item.blob) card.append(blobLine(item.blob));
        card.append(
          el("p", { class: "muted" }, item.body !== null ? "This host does not render artifacts here." : "Stored as a file; the page cannot read it here."),
          openInDash(sessionId, deps),
        );
      }
      break;
    default:
      card.append(el("p", { class: "muted" }, `${text(item.kind)} item`));
  }
  return card;
}

function renderLines(lines: readonly Line[]): SVGSVGElement {
  const svg = document.createElementNS(SVG, "svg");
  svg.setAttribute("class", "lines");
  svg.setAttribute("overflow", "visible");
  for (const l of lines) {
    const a = centerOf(l.from);
    const b = centerOf(l.to);
    const line = document.createElementNS(SVG, "line");
    line.setAttribute("x1", String(a.x));
    line.setAttribute("y1", String(a.y));
    line.setAttribute("x2", String(b.x));
    line.setAttribute("y2", String(b.y));
    svg.append(line);
    if (l.label) {
      const label = document.createElementNS(SVG, "text");
      label.setAttribute("x", String((a.x + b.x) / 2));
      label.setAttribute("y", String((a.y + b.y) / 2 - 6));
      label.textContent = l.label;
      svg.append(label);
    }
  }
  return svg;
}

export function createCanvas(first: SurfaceResult, deps: CanvasDeps, now = Date.now()): Canvas {
  let t: Transform = { tx: 0, ty: 0, k: 1 };
  let drawn: number | null = null;
  let boxes: Box[] = [];
  const layer = el("div", { class: "layer" });
  const viewport = el("div", { class: "viewport", tabindex: "0", "aria-label": "Surface canvas" }, layer);
  const status = el("p", { class: "muted", role: "status" });
  const title = el("h1", {});

  const dims = () => ({ w: viewport.clientWidth, h: viewport.clientHeight });
  const setT = (next: Transform) => {
    t = next;
    layer.style.transform = `translate(${t.tx}px, ${t.ty}px) scale(${t.k})`;
  };
  const centre = () => ({ x: dims().w / 2, y: dims().h / 2 });

  const rooms = el("button", {}, "Rooms");
  rooms.addEventListener("click", () => deps.onRooms());
  const refresh = el("button", {}, "Refresh");
  refresh.addEventListener("click", () => deps.onRefresh());
  const fitButton = el("button", {}, "Fit");
  fitButton.addEventListener("click", () => setT(fit(boxes, dims())));
  const zoomIn = el("button", { "aria-label": "Zoom in" }, "+");
  zoomIn.addEventListener("click", () => setT(zoomAbout(t, t.k * ZOOM_STEP, centre())));
  const zoomOut = el("button", { "aria-label": "Zoom out" }, "−");
  zoomOut.addEventListener("click", () => setT(zoomAbout(t, t.k / ZOOM_STEP, centre())));

  viewport.addEventListener("wheel", (ev) => {
    ev.preventDefault();
    const r = viewport.getBoundingClientRect();
    setT(zoomAbout(t, t.k * Math.exp(-ev.deltaY * 0.001), { x: ev.clientX - r.left, y: ev.clientY - r.top }));
  }, { passive: false });

  // A drag that starts on the background pans; one that starts on a card is the card's (text selection, a button).
  let drag: { x: number; y: number } | null = null;
  viewport.addEventListener("pointerdown", (ev) => {
    if ((ev.target as Element).closest(".item")) return;
    drag = { x: ev.clientX, y: ev.clientY };
    viewport.setPointerCapture?.(ev.pointerId);
  });
  viewport.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    setT({ ...t, tx: t.tx + ev.clientX - drag.x, ty: t.ty + ev.clientY - drag.y });
    drag = { x: ev.clientX, y: ev.clientY };
  });
  const endDrag = () => { drag = null; };
  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);

  const steps: Record<string, [number, number]> = { ArrowLeft: [PAN_STEP, 0], ArrowRight: [-PAN_STEP, 0], ArrowUp: [0, PAN_STEP], ArrowDown: [0, -PAN_STEP] };
  viewport.addEventListener("keydown", (ev) => {
    const d = steps[ev.key];
    if (!d) return;
    ev.preventDefault();
    setT({ ...t, tx: t.tx + d[0], ty: t.ty + d[1] });
  });

  const update = (r: SurfaceResult, at = Date.now()): void => {
    const items = Array.isArray(r.surface?.items) ? r.surface.items : [];
    const n = items.length;
    status.textContent = `${n} item${n === 1 ? "" : "s"} · read at ${new Date(at).toLocaleTimeString()} · ${deps.nested ? "artifacts render here" : "artifacts open in dash"}`;
    title.replaceChildren(
      text(r.room?.text?.data?.room),
      el("span", { class: "chip" }, text(r.room?.your_role)),
      el("span", { class: "muted" }, ` ${(r.room?.your_verbs ?? []).join(", ") || "read only"}`),
    );
    const cursor = typeof r.surface?.cursor === "number" ? r.surface.cursor : null;
    if (cursor !== null && cursor === drawn) return;
    const had = boxes.length;
    const { boxes: next, lines } = layout(items);
    boxes = next;
    const byKey = new Map(items.map((e) => [e.data.key, e] as const));
    layer.replaceChildren(renderLines(lines), ...boxes.map((b) => renderCard(byKey.get(b.key)!, b, r.session_id, deps, at)));
    drawn = cursor;
    if (had === 0) setT(fit(boxes, dims()));
  };

  const root = el("section", { class: "canvas-screen" },
    el("div", { class: "actions" }, title, rooms, refresh, fitButton, zoomIn, zoomOut),
    status,
    viewport,
  );
  update(first, now);
  return { root, update, transform: () => t };
}
