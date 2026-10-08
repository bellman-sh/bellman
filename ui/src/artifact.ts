/**
 * An html artifact inside the app (canvas spec D9, D10): a nested frame,
 * sandboxed, with an opaque origin, that inherits the page's policy and so can
 * reach nothing the page cannot. The page never writes the artifact into its
 * own document: it goes into the frame's srcdoc, followed by one script that
 * reports the document's height, which the page accepts only from that frame's
 * own window. Whether the host allows a nested frame at all is asked once, by
 * the probe, rather than assumed.
 */
import { el } from "./shared.js";

export const FRAME_SANDBOX = "allow-scripts";
/** dash's sandbox-protocol.ts has the same two numbers, so an artifact sized for one surface fits the other. */
export const MIN_FRAME_HEIGHT = 80;
export const MAX_FRAME_HEIGHT = 1200;
export const PROBE_TIMEOUT_MS = 1000;
/** What a sandboxed document reports as its origin: the serialisation of an opaque one. */
export const OPAQUE_ORIGIN = "null";

/** The one script appended to an artifact: its height, posted up once laid out (dash's reportHeight). */
export const REPORT_HEIGHT =
  '<script>addEventListener("load",()=>parent.postMessage({kind:"resize",height:document.documentElement.scrollHeight},"*"))</script>';

export const clampHeight = (h: number): number => Math.min(MAX_FRAME_HEIGHT, Math.max(MIN_FRAME_HEIGHT, Math.round(h)));

/** True only for a message from this frame's own window with an opaque origin. Never by origin alone: every sandboxed frame says "null". */
export const fromFrame = (ev: { source: unknown; origin: string }, frame: HTMLIFrameElement): boolean =>
  ev.origin === OPAQUE_ORIGIN && frame.contentWindow !== null && ev.source === frame.contentWindow;

const sandboxed = (title: string, extra: Record<string, string> = {}): HTMLIFrameElement =>
  el("iframe", { sandbox: FRAME_SANDBOX, referrerpolicy: "no-referrer", title, ...extra });

/** The artifact in its frame. The height listener lives as long as the page; a frame that is gone matches no message. */
export function artifactFrame(html: string, title: string): HTMLIFrameElement {
  const frame = sandboxed(title, { class: "artifact" });
  frame.srcdoc = html + REPORT_HEIGHT;
  frame.style.height = `${MIN_FRAME_HEIGHT}px`;
  window.addEventListener("message", (ev: MessageEvent) => {
    if (!fromFrame(ev, frame)) return;
    const m = ev.data as { kind?: unknown; height?: unknown } | null;
    if (m && typeof m === "object" && m.kind === "resize" && typeof m.height === "number" && Number.isFinite(m.height)) {
      frame.style.height = `${clampHeight(m.height)}px`;
    }
  });
  return frame;
}

const token = (): string => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * Whether this host lets the page open a nested srcdoc frame: a hidden probe
 * whose only script posts a token up; the token back, from that frame's window,
 * within the window of time, is yes. Silence is no, and so is a host whose
 * policy stops the script: either way the artifact is a card.
 */
export function probeNestedFrames(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const expected = token();
    const frame = sandboxed("probe", { hidden: "" });
    frame.srcdoc = `<script>parent.postMessage({kind:"probe",token:"${expected}"},"*")</script>`;
    const done = (ok: boolean) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      frame.remove();
      resolve(ok);
    };
    const onMessage = (ev: MessageEvent) => {
      if (!fromFrame(ev, frame)) return;
      const m = ev.data as { kind?: unknown; token?: unknown } | null;
      if (m && typeof m === "object" && m.kind === "probe" && m.token === expected) done(true);
    };
    window.addEventListener("message", onMessage);
    const timer = window.setTimeout(() => done(false), timeoutMs);
    document.body.append(frame);
  });
}
