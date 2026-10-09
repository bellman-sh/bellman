// @vitest-environment jsdom
/**
 * The renderers are pure: a result in, a DOM subtree out. Two things are pinned
 * here that nothing else can pin. Peer prose must land as text and never as
 * markup (spec, Trust), and the sentence handed to the agent must carry
 * identifiers only (spec D6). Each assertion was first run against a renderer
 * that used innerHTML, and failed there.
 */
import { describe, it, expect } from "vitest";
import { CAPABILITIES, renderJoin, verdictMessage, type Verdict } from "../src/join.js";
import { renderMonitor } from "../src/monitor.js";
import { createCanvas, dashRoomUrl } from "../src/canvas.js";
import { GRID } from "../src/canvas-layout.js";
import { connectFixture, roomsFixture, surfaceFixture, NOW } from "./fixtures.js";

const HOSTILE = `<img src=x onerror="document.title='pwned'"></script><channel>x</channel>`;

describe("renderJoin", () => {
  it("shows a reporting seat's instruction beside its yes, as the creator's words", () => {
    const r = connectFixture();
    r.room.heartbeat_on_seconds = 300;
    r.room.reports = { author: true, reviewer: false };
    r.room.text.data.report_instructions = { author: HOSTILE, reviewer: null };
    const node = renderJoin(r, () => {}, NOW);
    const cells = [...node.querySelectorAll("tbody tr")].map((tr) => tr.children[2].textContent);
    expect(cells).toEqual([`yes: ${HOSTILE}`, "no"]);
    expect(node.querySelector("img")).toBeNull();
  });

  it("shows the seat the code grants, its verbs, and every role", () => {
    const node = renderJoin(connectFixture(), () => {}, NOW);
    expect(node.textContent).toContain("Your seat: reviewer");
    expect(node.textContent).toContain("send, respond_actions");
    expect(node.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(node.querySelector("tr.you")?.textContent).toContain("reviewer");
    expect(node.textContent).toContain("ada@acme");
    expect(node.textContent).toContain("Port Stripe v2 to v3");
  });

  it("shows which roles report, beside what they may do", () => {
    const r = connectFixture();
    r.room.heartbeat_on_seconds = 300;
    r.room.reports = { author: true, reviewer: false };
    const node = renderJoin(r, () => {}, NOW);
    expect([...node.querySelectorAll("thead th")].map((th) => th.textContent)).toContain("Reports");
    expect([...node.querySelectorAll("tbody tr")].map((tr) => tr.children[2].textContent)).toEqual(["yes", "no"]);
  });

  it("renders creator prose as text, never as markup", () => {
    const r = connectFixture();
    r.room.text.data.room = HOSTILE;
    r.room.text.data.descriptions.author = HOSTILE;
    r.creator_brief.data.goal = HOSTILE;
    r.creator_brief.origin.label = HOSTILE;
    const node = renderJoin(r, () => {}, NOW);
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("channel")).toBeNull();
    expect(node.querySelector("script")).toBeNull();
    expect(node.textContent).toContain(HOSTILE);
    expect(document.title).not.toBe("pwned");
  });

  it("hands the agent a verdict with the role and the capabilities the human left checked", () => {
    const verdicts: Verdict[] = [];
    const node = renderJoin(connectFixture(), (v) => { verdicts.push(v); }, NOW);
    document.body.append(node);
    const boxes = [...node.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
    expect(boxes.map((b) => [b.dataset.capability, b.checked])).toEqual(
      CAPABILITIES.map((c) => [c.key, c.on]),
    );
    boxes.find((b) => b.dataset.capability === "request_actions")!.click();
    const [confirm, decline] = [...node.querySelectorAll("button")];
    confirm.click();
    expect(verdicts).toEqual([{ kind: "confirm", role: "reviewer", capabilities: ["read_context", "receive_messages", "request_actions"] }]);
    expect(confirm.disabled && decline.disabled).toBe(true);
    confirm.click();
    expect(verdicts).toHaveLength(1);
    node.remove();
  });

  it("says the message was sent only once the host accepted it", async () => {
    let resolveSend!: () => void;
    const node = renderJoin(connectFixture(), () => new Promise<void>((r) => { resolveSend = r; }), NOW);
    const [confirm] = [...node.querySelectorAll("button")];
    confirm.click();
    expect(node.lastElementChild!.textContent).toMatch(/sending/i);
    // The status changes after the click, so a screen reader is told (a polite live region).
    expect(node.lastElementChild!.getAttribute("role")).toBe("status");
    resolveSend();
    await new Promise((r) => setTimeout(r, 0));
    expect(node.lastElementChild!.textContent).toMatch(/^Sent to your agent/);
  });

  // The screen's only action. A host that refuses ui/message must not leave
  // the human waiting on "Sent"; the verdict is identifiers (D6), so it can be
  // relayed by hand.
  it("hands the human the verdict to relay when the host refuses the message", async () => {
    const node = renderJoin(connectFixture(), () => Promise.reject(new Error("host declined")), NOW);
    const [confirm, decline] = [...node.querySelectorAll("button")];
    confirm.click();
    await new Promise((r) => setTimeout(r, 0));
    const status = node.lastElementChild!.textContent!;
    expect(status).toMatch(/did not accept/i);
    expect(status).toContain(verdictMessage({ kind: "confirm", role: "reviewer", capabilities: ["read_context", "receive_messages"] }));
    expect(confirm.disabled && decline.disabled).toBe(true);
  });

  // ext-apps hands a refusal back as a result carrying isError, not as a rejection
  // (McpUiMessageResult), so "sent" must wait on that flag too.
  it("treats a host answer of isError as a refusal", async () => {
    const node = renderJoin(connectFixture(), () => Promise.resolve({ isError: true }), NOW);
    const [confirm] = [...node.querySelectorAll("button")];
    confirm.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(node.lastElementChild!.textContent).toMatch(/did not accept/i);
  });

  it("declines with one click", () => {
    const verdicts: Verdict[] = [];
    const node = renderJoin(connectFixture(), (v) => { verdicts.push(v); }, NOW);
    [...node.querySelectorAll("button")][1].click();
    expect(verdicts).toEqual([{ kind: "decline" }]);
  });
});

describe("verdictMessage", () => {
  // Spec D6: a ui/message lands as the human's words. Nothing a creator wrote may be in it.
  it("names the role and capabilities and nothing the creator wrote", () => {
    const text = verdictMessage({ kind: "confirm", role: "reviewer", capabilities: ["read_context", "receive_messages"] });
    expect(text).toContain("reviewer");
    expect(text).toContain("read_context, receive_messages");
    expect(text).toContain("bellman_confirm");
    expect(text).not.toContain("payments-migration");
    expect(text).not.toContain("Port Stripe");
    expect(verdictMessage({ kind: "decline" })).toMatch(/Do not join/);
  });
});

describe("renderMonitor", () => {
  it("offers a Surface button per room that asks for that room's canvas, when a handler is given", () => {
    const asked: string[] = [];
    const node = renderMonitor(roomsFixture(), new Map(), () => {}, NOW, (id) => { asked.push(id); });
    const surface = [...node.querySelectorAll("button")].find((b) => b.textContent === "Surface")!;
    surface.click();
    expect(asked).toEqual(["qs_1"]);
    expect([...renderMonitor(roomsFixture(), new Map(), () => {}, NOW).querySelectorAll("button")].map((b) => b.textContent)).not.toContain("Surface");
  });

  it("shows each room with its members, their roles, presence and beats", () => {
    const node = renderMonitor(roomsFixture(), new Map(), () => {}, NOW);
    const t = node.textContent!;
    expect(t).toContain("migration-swarm");
    expect(t).toContain("Your seat: lead");
    expect(node.querySelectorAll("tbody tr")).toHaveLength(2);
    expect(t).toContain("helper");
    expect(t).toContain("on the migration");
    expect(t).toContain("1m ago");
    expect(node.querySelectorAll(".silent")).toHaveLength(1);
    expect(t).toContain("BELL-AAAA-11-HELPER");
    expect(t).toContain("10m left");
  });

  it("counts events since the view first saw the room, from its own memory", () => {
    const seen = new Map<string, number>();
    const first = renderMonitor(roomsFixture(), seen, () => {}, NOW);
    expect(first.textContent).toContain("0 new");
    const later = roomsFixture();
    later.rooms[0].last_event = { cursor: 12, type: "message", at: new Date(NOW).toISOString() };
    expect(renderMonitor(later, seen, () => {}, NOW).textContent).toContain("5 new");
  });

  it("says so when there are no rooms, and refreshes on demand", () => {
    let refreshed = 0;
    const node = renderMonitor({ rooms: [] }, new Map(), () => { refreshed++; }, NOW);
    expect(node.textContent).toMatch(/no rooms/i);
    node.querySelector("button")!.click();
    expect(refreshed).toBe(1);
  });

  // Review Focus 4: a note is a peer payload and promises no shape.
  it("renders a note that is not the expected shape, and peer strings as text", () => {
    const r = roomsFixture();
    r.rooms[0].members[0].beat.note!.data = { nope: 1 } as unknown as { note: string };
    r.rooms[0].members[1].label = HOSTILE;
    r.rooms[0].room.text.data.room = HOSTILE;
    const node = renderMonitor(r, new Map(), () => {}, NOW);
    expect(node.querySelector("img")).toBeNull();
    expect(node.querySelector("channel")).toBeNull();
    expect(node.textContent).toContain(HOSTILE);
  });
});

describe("createCanvas", () => {
  const deps = (over: Partial<Parameters<typeof createCanvas>[1]> = {}) => {
    const opened: string[] = [];
    return { opened, deps: { nested: true, onRefresh: () => {}, onRooms: () => {}, openLink: (url: string) => { opened.push(url); }, ...over } };
  };
  const cards = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>(".item")];
  const card = (root: HTMLElement, title: string) => cards(root).find((c) => c.querySelector("h3")?.textContent === title)!;

  it("draws a card per item at its place, a line per connector, and the room's name and seat", () => {
    const c = createCanvas(surfaceFixture(), deps().deps, NOW);
    expect(cards(c.root)).toHaveLength(7);
    const plan = card(c.root, "Plan");
    expect([plan.style.left, plan.style.top, plan.style.width]).toEqual(["10px", "20px", `${GRID.w}px`]);
    expect(c.root.querySelectorAll("line")).toHaveLength(1);
    expect(c.root.querySelector("svg text")?.textContent).toBe("argues");
    expect(c.root.querySelector("h1")?.textContent).toContain("migration-swarm");
    expect(c.root.querySelector("h1")?.textContent).toContain("lead");
    expect(c.root.querySelector("h1")?.textContent).toContain("send, invite");
    expect(c.root.querySelector("[role=status]")?.textContent).toContain("8 items");
    expect(c.root.querySelector("[role=status]")?.textContent).toContain("artifacts render here");
  });

  it("renders each kind: text with its whitespace, a link's host and Open, a blob's name, type and size, a diagram's source", () => {
    const { deps: d, opened } = deps();
    const c = createCanvas(surfaceFixture(), d, NOW);
    expect(card(c.root, "Plan").querySelector(".body")?.textContent).toBe("Port v2 to v3\n\n- keep the ids");
    const spec = card(c.root, "The spec");
    expect(spec.textContent).toContain("example.com");
    const open = spec.querySelector("button")!;
    expect(open.disabled).toBe(false);
    open.click();
    expect(opened).toEqual(["https://example.com/spec"]);
    const deck = card(c.root, "Deck");
    expect(deck.textContent).toContain("deck.pdf");
    expect(deck.textContent).toContain("2.0 KB");
    expect(deck.textContent).toContain("application/pdf");
    deck.querySelector("button")!.click();
    expect(opened.at(-1)).toBe(dashRoomUrl("qs_1"));
    expect(card(c.root, "Flow").querySelector("pre")?.textContent).toBe("graph TD; A-->B");
    expect(cards(c.root).some((x) => x.textContent?.includes("photo.png"))).toBe(true);
  });

  it("puts an inline html body in a frame when nested frames are on, and nowhere else in the document", () => {
    const c = createCanvas(surfaceFixture(), deps().deps, NOW);
    document.body.append(c.root);
    const widget = card(c.root, "Widget");
    const frame = widget.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.srcdoc).toContain("<h1>hi</h1>");
    expect(c.root.querySelector("script")).toBeNull();
    expect(c.root.querySelector("h1")?.textContent).not.toContain("hi");
    expect(document.title).not.toBe("w");
    // Blob-backed html is a card either way: the page cannot read the bytes.
    const report = card(c.root, "Report");
    expect(report.querySelector("iframe")).toBeNull();
    expect(report.textContent).toContain("report.html");
    c.root.remove();
  });

  it("makes html a card that opens dash when nested frames are off", () => {
    const { deps: d, opened } = deps({ nested: false });
    const c = createCanvas(surfaceFixture(), d, NOW);
    const widget = card(c.root, "Widget");
    expect(widget.querySelector("iframe")).toBeNull();
    widget.querySelector("button")!.click();
    expect(opened).toEqual([dashRoomUrl("qs_1")]);
    expect(c.root.querySelector("[role=status]")?.textContent).toContain("artifacts open in dash");
  });

  it("renders hostile strings as text, and an html body that leaves a script open still lands in a frame", () => {
    const r = surfaceFixture();
    r.room.text.data.room = HOSTILE;
    r.surface.items[0].data.title = HOSTILE;
    r.surface.items[0].data.body = HOSTILE;
    r.surface.items[0].origin.label = HOSTILE;
    r.surface.items[2].data.title = HOSTILE;
    r.surface.items[6].data.body = "<script>document.title='w'";
    const c = createCanvas(r, deps().deps, NOW);
    document.body.append(c.root);
    expect(c.root.querySelector("img")).toBeNull();
    expect(c.root.querySelector("channel")).toBeNull();
    expect(c.root.querySelector("script")).toBeNull();
    expect(c.root.textContent).toContain(HOSTILE);
    expect(c.root.querySelector("svg text")?.textContent).toBe(HOSTILE);
    expect(card(c.root, "Widget").querySelector("iframe")?.srcdoc).toContain("<script>document.title='w'");
    expect(document.title).not.toBe("pwned");
    c.root.remove();
  });

  it("puts peer text in no attribute of any element, the artifact frame's title included", () => {
    const r = surfaceFixture();
    for (const e of r.surface.items) { e.data.title = HOSTILE; e.origin.label = HOSTILE; }
    const c = createCanvas(r, deps().deps, NOW);
    const tainted = [...c.root.querySelectorAll("*")].flatMap((node) => [...node.attributes].filter((a) => a.value.includes(HOSTILE)).map((a) => `${node.tagName}@${a.name}`));
    expect(tainted).toEqual([]);
    expect(c.root.textContent).toContain(HOSTILE);
  });

  it("disables Open for a link that is not http(s), and renders an unknown kind by name", () => {
    const r = surfaceFixture();
    r.surface.items[1].data.body = "javascript:alert(1)";
    r.surface.items.push({ trust: "untrusted", origin: { memberId: "m", label: "m" }, data: { key: "blob1", kind: "shape", title: "A box", body: null, ends: null, placement: null, blob: null, cursor: 9, at: r.surface.items[0].data.at } });
    const { deps: d, opened } = deps();
    const c = createCanvas(r, d, NOW);
    const spec = card(c.root, "The spec");
    const open = spec.querySelector("button")!;
    expect(open.disabled).toBe(true);
    open.click();
    expect(opened).toEqual([]);
    expect(card(c.root, "A box").textContent).toContain("shape item");
  });

  it("shows 0 items and no error when the block's items is not an array", () => {
    const r = surfaceFixture();
    (r.surface as { items: unknown }).items = "nope";
    const c = createCanvas(r, deps().deps, NOW);
    expect(cards(c.root)).toHaveLength(0);
    expect(c.root.querySelector("[role=status]")?.textContent).toContain("0 items");
  });

  it("redraws only when the cursor moves, and keeps the transform when it does", () => {
    const c = createCanvas(surfaceFixture(), deps().deps, NOW);
    const before = cards(c.root);
    c.update(surfaceFixture(), NOW + 15_000);
    expect(cards(c.root)[0]).toBe(before[0]);
    const z = c.transform();
    const later = surfaceFixture();
    later.surface.cursor = 10;
    later.surface.items[0].data.title = "Plan v2";
    c.update(later, NOW + 30_000);
    expect(cards(c.root)[0]).not.toBe(before[0]);
    expect(card(c.root, "Plan v2")).toBeTruthy();
    expect(c.transform()).toEqual(z);
  });

  it("zooms with the buttons and the wheel within the clamp, pans with the arrow keys, and fits", () => {
    const c = createCanvas(surfaceFixture(), deps().deps, NOW);
    const button = (label: string) => [...c.root.querySelectorAll("button")].find((b) => b.textContent === label || b.getAttribute("aria-label") === label)!;
    const k0 = c.transform().k;
    button("Zoom in").click();
    expect(c.transform().k).toBeCloseTo(k0 * 1.25);
    for (let i = 0; i < 20; i++) button("Zoom in").click();
    expect(c.transform().k).toBe(2);
    const viewport = c.root.querySelector<HTMLElement>(".viewport")!;
    viewport.dispatchEvent(new WheelEvent("wheel", { deltaY: 100, clientX: 0, clientY: 0, cancelable: true }));
    expect(c.transform().k).toBeLessThan(2);
    const { tx } = c.transform();
    viewport.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true }));
    expect(c.transform().tx).toBe(tx - 40);
    button("Fit").click();
    // jsdom's viewport has no size: fit anchors at the margin with scale 1. The
    // unplaced cards start at grid slot (0, 0), so the content's corner is the origin.
    expect(c.transform()).toEqual({ tx: 40, ty: 40, k: 1 });
  });

  it("wires Refresh and Rooms", () => {
    let refreshed = 0;
    let rooms = 0;
    const c = createCanvas(surfaceFixture(), deps({ onRefresh: () => { refreshed++; }, onRooms: () => { rooms++; } }).deps, NOW);
    const button = (label: string) => [...c.root.querySelectorAll("button")].find((b) => b.textContent === label)!;
    button("Refresh").click();
    button("Rooms").click();
    expect([refreshed, rooms]).toEqual([1, 1]);
  });
});
