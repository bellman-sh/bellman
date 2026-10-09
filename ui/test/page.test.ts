// @vitest-environment jsdom
/**
 * The page's wiring (canvas spec D6, D7), with the host's calls faked: which
 * read goes out when, what a late or failed answer may do to the screen, and
 * that the first canvas draw fits a viewport that has a size only once it is in
 * the document. The review of the first cut found all four of these untested.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPage, type Page } from "../src/page.js";
import type { ToolOutcome } from "../src/screen.js";
import { roomsFixture, surfaceFixture } from "./fixtures.js";

type Deferred = { resolve: (r: ToolOutcome) => void; reject: (e: Error) => void };

/** A host whose tool calls the test answers by hand, in order. */
function host() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const pending: Deferred[] = [];
  const root = document.createElement("div");
  document.body.append(root);
  const page = createPage({
    root,
    callTool: (name, args) => {
      calls.push({ name, args });
      return new Promise<ToolOutcome>((resolve, reject) => pending.push({ resolve, reject }));
    },
    sendMessage: () => undefined,
    openLink: () => {},
    nestedFrames: Promise.resolve(true),
    visible: () => true,
  });
  return { page, root, calls, pending, answer: (r: ToolOutcome) => pending.shift()!.resolve(r), fail: (m: string) => pending.shift()!.reject(new Error(m)) };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const scaleOf = (root: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(root.querySelector<HTMLElement>(".layer")!.style.transform)![1]);

let pages: Page[] = [];
afterEach(() => { for (const p of pages.splice(0)) p.stop(); document.body.replaceChildren(); vi.useRealTimers(); });

describe("createPage", () => {
  it("keeps the canvas when a read fails, says so on its status line, and clears it on the next answer", async () => {
    const h = host(); pages.push(h.page);
    h.page.render({ structuredContent: surfaceFixture() });
    await settle();
    expect(h.root.querySelector(".canvas-screen")).not.toBeNull();
    const read = h.page.surface("qs_1");
    h.fail("socket hung up");
    await read;
    expect(h.root.querySelector(".canvas-screen")).not.toBeNull();
    expect(h.root.querySelector("[role=status]")?.textContent).toContain("Refresh failed: socket hung up");
    const again = h.page.surface("qs_1");
    const later = surfaceFixture(); later.surface.cursor = 10;
    h.answer({ structuredContent: later });
    await again; await settle();
    expect(h.root.querySelector(".canvas-screen")?.isConnected).toBe(true);
    expect(h.root.querySelector("[role=status]")?.textContent).not.toContain("Refresh failed");
  });

  it("fits the first draw to the viewport once the canvas is in the document", async () => {
    const sized = { clientWidth: 600, clientHeight: 400 };
    for (const key of ["clientWidth", "clientHeight"] as const) {
      Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get(this: HTMLElement) { return this.classList.contains("viewport") ? sized[key] : 0; } });
    }
    try {
      const h = host(); pages.push(h.page);
      h.page.render({ structuredContent: surfaceFixture() });
      await settle();
      // The grid is four 320 px columns with 40 px gaps: wider than 600 px, so a fit is below 1.
      expect(scaleOf(h.root)).toBeLessThan(1);
      expect(scaleOf(h.root)).toBeGreaterThan(0.1);
    } finally {
      for (const key of ["clientWidth", "clientHeight"]) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
    }
  });

  it("drops a read that was in flight when the person navigated, and starts another room's read at once", async () => {
    const h = host(); pages.push(h.page);
    h.page.render({ structuredContent: surfaceFixture() });
    await settle();
    const late = h.page.surface("qs_1");
    h.page.render({ structuredContent: roomsFixture() });
    expect(h.root.querySelector(".monitor")).not.toBeNull();
    h.answer({ structuredContent: surfaceFixture() });
    await late; await settle();
    expect(h.root.querySelector(".monitor")).not.toBeNull();
    expect(h.root.querySelector(".canvas-screen")).toBeNull();

    const a = h.page.surface("qs_1");
    const b = h.page.surface("qs_2", { user: true });
    expect(h.calls.filter((c) => c.name === "bellman_surface").map((c) => c.args.session_id)).toEqual(["qs_1", "qs_1", "qs_2"]);
    const forA = surfaceFixture();
    h.answer({ structuredContent: forA });
    const forB = surfaceFixture(); forB.session_id = "qs_2"; forB.room.text.data.room = "room-b";
    h.answer({ structuredContent: forB });
    await a; await b; await settle();
    expect(h.root.querySelector("h1")?.textContent).toContain("room-b");
  });

  it("polls the screen that is current, and Rooms takes the canvas back to the monitor", async () => {
    vi.useFakeTimers();
    const h = host(); pages.push(h.page);
    h.page.render({ structuredContent: surfaceFixture() });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.root.querySelector(".canvas-screen")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls.at(-1)).toEqual({ name: "bellman_surface", args: { session_id: "qs_1" } });
    h.answer({ structuredContent: surfaceFixture() });
    [...h.root.querySelectorAll("button")].find((b) => b.textContent === "Rooms")!.click();
    expect(h.calls.at(-1)).toEqual({ name: "bellman_rooms", args: {} });
    h.answer({ structuredContent: roomsFixture() });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.root.querySelector(".monitor")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.calls.at(-1)).toEqual({ name: "bellman_rooms", args: {} });
    [...h.root.querySelectorAll("button")].find((b) => b.textContent === "Surface")!.click();
    expect(h.calls.at(-1)).toEqual({ name: "bellman_surface", args: { session_id: "qs_1" } });
  });
});
