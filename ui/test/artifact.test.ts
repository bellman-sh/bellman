// @vitest-environment jsdom
/**
 * The nested frame and the probe (canvas spec D9, D10). What jsdom cannot do
 * is run a frame's script, which is exactly the case the probe must answer
 * "no" to; the "yes" is driven by posting the token the way the frame would.
 */
import { describe, it, expect } from "vitest";
import {
  FRAME_SANDBOX, MAX_FRAME_HEIGHT, MIN_FRAME_HEIGHT, OPAQUE_ORIGIN, REPORT_HEIGHT,
  artifactFrame, clampHeight, fromFrame, probeNestedFrames,
} from "../src/artifact.js";

/** A message as the page's listener sees it: from `source`, with `origin`. */
function post(frame: HTMLIFrameElement, data: unknown, source: unknown = frame.contentWindow, origin = OPAQUE_ORIGIN): void {
  const ev = new MessageEvent("message", { data, origin });
  Object.defineProperty(ev, "source", { value: source });
  window.dispatchEvent(ev);
}

describe("fromFrame", () => {
  it("accepts a message only from the frame's own window with an opaque origin", () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    expect(fromFrame({ source: frame.contentWindow, origin: OPAQUE_ORIGIN }, frame)).toBe(true);
    expect(fromFrame({ source: window, origin: OPAQUE_ORIGIN }, frame)).toBe(false);
    expect(fromFrame({ source: frame.contentWindow, origin: "https://dash.bellman.sh" }, frame)).toBe(false);
    frame.remove();
  });
});

describe("artifactFrame", () => {
  it("is sandboxed with scripts only, sends no referrer, and carries the artifact plus the height report in srcdoc", () => {
    const frame = artifactFrame("<h1>hi</h1>", "Widget");
    expect(frame.getAttribute("sandbox")).toBe(FRAME_SANDBOX);
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.title).toBe("Widget");
    expect(frame.srcdoc).toBe("<h1>hi</h1>" + REPORT_HEIGHT);
    expect(frame.style.height).toBe(`${MIN_FRAME_HEIGHT}px`);
  });

  it("takes a height only from its own window, from the opaque origin, finite, and clamped", () => {
    const frame = artifactFrame("<p>x</p>", "x");
    document.body.append(frame);
    post(frame, { kind: "resize", height: 300 });
    expect(frame.style.height).toBe("300px");
    post(frame, { kind: "resize", height: 5000 });
    expect(frame.style.height).toBe(`${MAX_FRAME_HEIGHT}px`);
    post(frame, { kind: "resize", height: 10 });
    expect(frame.style.height).toBe(`${MIN_FRAME_HEIGHT}px`);
    post(frame, { kind: "resize", height: 400 }, window);
    expect(frame.style.height).toBe(`${MIN_FRAME_HEIGHT}px`);
    post(frame, { kind: "resize", height: 400 }, frame.contentWindow, "https://evil.example");
    expect(frame.style.height).toBe(`${MIN_FRAME_HEIGHT}px`);
    post(frame, { kind: "resize", height: Number.NaN });
    expect(frame.style.height).toBe(`${MIN_FRAME_HEIGHT}px`);
    frame.remove();
  });

  it("clamps", () => {
    expect(clampHeight(0)).toBe(MIN_FRAME_HEIGHT);
    expect(clampHeight(99_999)).toBe(MAX_FRAME_HEIGHT);
    expect(clampHeight(333.4)).toBe(333);
  });
});

describe("probeNestedFrames", () => {
  it("answers no when nothing replies within the window", async () => {
    await expect(probeNestedFrames(20)).resolves.toBe(false);
    expect(document.querySelector("iframe[title=probe]")).toBeNull();
  });

  it("answers yes to its own token from its own frame, and ignores another token", async () => {
    const pending = probeNestedFrames(200);
    const frame = document.querySelector<HTMLIFrameElement>("iframe[title=probe]")!;
    expect(frame.getAttribute("sandbox")).toBe(FRAME_SANDBOX);
    const token = /token:"([0-9a-f]+)"/.exec(frame.srcdoc)![1];
    post(frame, { kind: "probe", token: "not-it" });
    post(frame, { kind: "probe", token }, window);
    post(frame, { kind: "probe", token });
    await expect(pending).resolves.toBe(true);
    expect(document.querySelector("iframe[title=probe]")).toBeNull();
  });
});
