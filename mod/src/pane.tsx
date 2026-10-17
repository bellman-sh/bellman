/**
 * The room pane at full width (spec D5): a header, four tabs, and the tab shown. Log is the room's history, newest
 * last; Canvas its surface, drawn by kind; Members each member with role, presence and beat; Approve the action
 * requests waiting on the person, each with Approve and Deny, which the Log's rows carry too.
 *
 * Every string a peer controls reaches the screen cleaned: through `cleanText` or `cleanBlock`, through what
 * `pendingRequests` and `roomLabel` (src/mod/view.ts) cleaned already, and a canvas text's Markdown through
 * `safeLinks` as well. What reaches the model is `approvedText` and `declinedText` and nothing else: fixed text
 * around a room's id and a request's cursor, both server-made, and checked here.
 */
import { read, update } from "claude-code";
import type { Elements, EngineInterface, RenderElement } from "claude-code";
import { cleanBlock, cleanText, eventLine } from "../../src/door-protocol.js";
import { approvalKey } from "../../src/mod/gate.js";
import { NAME_MAX, PANE_ID, SIDEBAR_COLUMNS, memberLine, safeLinks } from "../../src/mod/view.js";
import type { DoorEvent, PendingRequest, RoomView, Tab } from "../types";
import { decline, readCanvas, seatIn } from "./doors";
import { personActed } from "./person";
import { approved, canvas, doors, logs, pending, rooms, tab } from "./state";
import type { Pieces, Shown } from "./view";
import { isTurnRunning } from "./waking";

/** A room's id as the server makes one (`qs_…`), and nothing a peer could slip a line break or an instruction into. */
const ROOM_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Throws unless `sessionId` and `cursor` are what the server makes: they are the only values the model's text carries. */
function serverMade(sessionId: string, cursor: number): void {
  if (!ROOM_ID.test(sessionId) || !Number.isSafeInteger(cursor)) {
    throw new Error("bellman-mod: an action request is named by a room id and a cursor the server made");
  }
}

/** What Claude is told when the person approves a request: fixed text around the room and the request's cursor. */
export function approvedText(sessionId: string, cursor: number): string {
  serverMade(sessionId, cursor);
  return `Your human approved Bellman action request ${cursor} in room ${sessionId}. Carry it out, then answer it with bellman_send: type "action_response", ref_id "${cursor}", payload { approved: true, result }.`;
}

/** What Claude is told once the mod has answered a request the person declined. */
export function declinedText(sessionId: string, cursor: number): string {
  serverMade(sessionId, cursor);
  return `Your human declined Bellman action request ${cursor} in room ${sessionId}, and the room has been answered. Do not carry it out.`;
}

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Approve: the gate passes Claude's `approved: true` answer for this request and no other, and Claude is told: by a
 * row in the turn that is running, or else by a prompt of the mod's own that starts one.
 */
async function approve($: EngineInterface, r: PendingRequest): Promise<void> {
  const text = approvedText(r.session_id, r.cursor);
  const key = approvalKey(r.session_id, String(r.cursor));
  await update($, approved, (keys) => (keys.includes(key) ? keys : [...keys, key]));
  if (isTurnRunning()) {
    await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
    return;
  }
  // Not awaited: it resolves when the turn it queues starts. The framing is the plugin's own, never `asUser`.
  $.prompt.submit({ text }).catch((error: unknown) => {
    $.ui.log(`bellman-mod: the approval was not submitted: ${message(error)}`, { to: "debug" });
  });
}

/**
 * Deny: the mod answers the room itself, `approved: false`, through the door of the bridge that lists the seat
 * (`decline`, doors.ts): no tool call of Claude Code's, which would be refused from a press, and none the gate sees.
 * Claude is told only once the room has been answered, and the person is told when it was not.
 */
async function deny($: EngineInterface, r: PendingRequest): Promise<void> {
  const text = declinedText(r.session_id, r.cursor);
  const socketPath = seatIn(await read($, doors), r.session_id)?.door.socketPath ?? null;
  let answered = false;
  if (socketPath !== null) {
    try {
      await decline($, socketPath, r.session_id, r.cursor);
      answered = true;
    } catch (error) {
      $.ui.log(`bellman-mod: Deny: ${message(error)}`, { to: "debug" });
    }
  }
  if (!answered) {
    $.ui.toast("Bellman: the Deny did not go through, so the request still waits.");
    return;
  }
  // Answered: it waits on nobody, though the log will not say so until its next read.
  await update($, pending, (was) => ({ ...was, [r.session_id]: (was[r.session_id] ?? []).filter((p) => p.cursor !== r.cursor) }));
  await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } });
}

async function turnTo($: EngineInterface, to: Tab): Promise<void> {
  await update($, tab, () => to);
  if (to === "canvas") await readCanvas($);
}

/** An event's time as the person's own clock reads it. */
function clock(at: string): string {
  const d = new Date(at);
  const two = (n: number) => String(n).padStart(2, "0");
  return Number.isNaN(d.getTime()) ? "--:--" : `${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** A member's latest progress note as one line: its payload's `note`, out of the untrusted envelope it came in. */
function noteOf(note: unknown): string {
  const data = (note as { data?: unknown } | null)?.data;
  const said = (data as { note?: unknown } | null)?.note ?? data;
  return typeof said === "string" ? cleanText(said) : said == null ? "" : cleanText(JSON.stringify(said));
}

/** The longest address a `Link` carries (`LinkProps.href`): a longer one would refuse the whole tree, so it is drawn as text. */
const LINK_MAX = 2_048;

/**
 * The body as an http or https address a `Link` carries, or null: a peer's body is not trusted to be one. Cleaned,
 * then as `URL` writes it, which percent-encodes whatever is left that a terminal could read as more than text.
 */
function webHref(body: string): string | null {
  if (body.length > LINK_MAX) return null;
  try {
    const url = new URL(cleanText(body, LINK_MAX));
    return (url.protocol === "http:" || url.protocol === "https:") && url.href.length <= LINK_MAX ? url.href : null;
  } catch {
    return null;
  }
}

/** A blob's size as the panel writes it (`size` in ui/src/canvas.ts). */
const size = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/** The fields of a canvas item the pane reads. A peer wrote them all, so each is checked where it is drawn. */
type CanvasItem = { kind?: unknown; title?: unknown; body?: unknown; blob?: unknown };

/** The items of the door's canvas answer, `bellman_surface`'s (`surfaceItem` in src/projections.ts), each out of its envelope. */
function canvasItems(result: unknown): CanvasItem[] {
  const items = (result as { surface?: { items?: unknown } } | null)?.surface?.items;
  if (!Array.isArray(items)) return [];
  return items.flatMap((envelope: unknown) => {
    const data = (envelope as { data?: unknown } | null)?.data;
    return typeof data === "object" && data !== null ? [data as CanvasItem] : [];
  });
}

/** One canvas item by its kind, under its title; null for a kind the pane does not draw. */
function drawItem(ui: Elements["terminal"], item: CanvasItem): RenderElement | null {
  const { Box, Code, Link, Markdown, Text } = ui;
  const body = typeof item.body === "string" ? item.body : "";
  const blob = (typeof item.blob === "object" && item.blob !== null ? item.blob : {}) as { name?: unknown; bytes?: unknown };
  const name = typeof blob.name === "string" ? cleanText(blob.name, NAME_MAX) : "";
  let drawn: RenderElement;
  switch (item.kind) {
    case "text":
      drawn = <Markdown text={safeLinks(cleanBlock(body))} />;
      break;
    case "link": {
      const href = webHref(body);
      drawn = href !== null ? <Link href={href} /> : <Text wrap="truncate-end">{cleanText(body)}</Text>;
      break;
    }
    case "diagram":
      drawn = <Code source={cleanBlock(body)} language="mermaid" />;
      break;
    case "file":
      drawn = <Text wrap="truncate-end">{`${name || "file"} · ${typeof blob.bytes === "number" ? size(blob.bytes) : "?"}`}</Text>;
      break;
    case "image":
      // ponytail: bellman_surface hands the mod an image's name and size (`BlobRef.bytes` is a count), never the
      // picture, and the door serves no blobs, so the name stands in; an Image the day a read returns the bytes.
      drawn = <Text wrap="truncate-end">{name || "image"}</Text>;
      break;
    case "html":
      drawn = <Text dimColor>html page: open it in the Bellman panel</Text>;
      break;
    default:
      // A connector and a shape are the panel's to draw; a kind this build does not know is drawn nowhere.
      return null;
  }
  const title = typeof item.title === "string" ? cleanText(item.title) : "";
  return (
    <Box flexDirection="column">
      {title !== "" && (
        <Text bold wrap="truncate-end">
          {title}
        </Text>
      )}
      {drawn}
    </Box>
  );
}

/** Rows of the pane that are not the tab's: the header's and the tabs'. */
const CHROME_ROWS = 2;

/**
 * The room pane drawn wide (view.tsx's `Pane` hook, at `COMPACT_BELOW` body columns or more), from what the band
 * and the sidebar show (`s`, `p`) and what the reads keep in `$.state`. Every press is the person's, so each says so
 * first.
 *
 * The header is marked by the word: the engine draws no pane's title while it is the only pane, and one row of the
 * bell read as a dark bar with one gold cell (L11).
 */
export async function drawPane(
  $: EngineInterface,
  ui: Elements["terminal"],
  site: { bodyRows: number; placement: "dock" | "inline" },
  s: Shown,
  p: Pieces,
): Promise<RenderElement> {
  const { Box, Button, Text } = ui;
  const shown = await read($, tab);
  const waiting = (await read($, pending))[s.picked] ?? [];
  const act = (work: () => Promise<unknown>) => () => {
    personActed();
    work().catch((error: unknown) => $.ui.log(`bellman-mod: ${message(error)}`, { to: "debug" }));
  };
  const answers = (r: PendingRequest) => [
    <Button key={`approve-${r.cursor}`} label="Approve" variant="primary" onPress={act(() => approve($, r))} />,
    <Button key={`deny-${r.cursor}`} label="Deny" onPress={act(() => deny($, r))} />,
  ];
  const tabs: [Tab, string][] = [
    ["log", "Log"],
    ["canvas", "Canvas"],
    ["members", "Members"],
    ["approve", `Approve ${waiting.length}`],
  ];

  let body: RenderElement[];
  if (shown === "log") {
    const open = new Map(waiting.map((r) => [r.cursor, r]));
    const log: readonly DoorEvent[] = (await read($, logs))[s.picked] ?? [];
    body =
      log.length === 0
        ? [<Text dimColor>Nothing in the room's log yet.</Text>]
        : log.slice(-Math.max(1, site.bodyRows - CHROME_ROWS)).map((e) => {
            const r = open.get(e.cursor);
            return (
              <Box columnGap={1}>
                <Text wrap="truncate-end">{`${clock(e.at)} ${cleanText(e.from_label, NAME_MAX)} ${eventLine(e)}`}</Text>
                {r !== undefined && answers(r)}
              </Box>
            );
          });
  } else if (shown === "canvas") {
    const result = (await read($, canvas))[s.picked];
    const items = canvasItems(result).flatMap((item) => drawItem(ui, item) ?? []);
    body =
      result === undefined
        ? [<Text dimColor>Reading the canvas…</Text>]
        : items.length === 0
          ? [<Text dimColor>Nothing on the canvas.</Text>]
          : items;
  } else if (shown === "members") {
    const view: RoomView | undefined = (await read($, rooms)).find((r) => r.session_id === s.picked);
    const mine = new Set((await read($, doors)).flatMap((d) => d.status?.seats ?? []).filter((seat) => seat.session_id === s.picked).map((seat) => seat.member_id));
    body = (view?.members ?? []).map((m) => {
      const beat = m.beat.silent && m.beat.silent_for_seconds !== null ? `silent ${Math.round(m.beat.silent_for_seconds / 60)} min` : "";
      const line = [
        memberLine(m),
        mine.has(m.member_id) ? "you" : "",
        beat,
        noteOf(m.beat.note),
      ];
      return <Text wrap="truncate-end">{line.filter((part) => part !== "").join(" · ")}</Text>;
    });
  } else {
    const now = await $.clock.now();
    body =
      waiting.length === 0
        ? [<Text dimColor>Nothing waits on you.</Text>]
        : waiting.map((r) => (
            <Box flexDirection="column">
              <Text>{`${r.from_label} asks: ${r.text}`}</Text>
              <Box columnGap={1}>
                <Text dimColor>{`${Math.max(0, Math.ceil((r.expires_at - now) / 60_000))} min left`}</Text>
                {answers(r)}
              </Box>
            </Box>
          ));
  }

  return (
    <Box flexDirection="column">
      <Box columnGap={1}>
        <Text bold>Bellman</Text>
        {p.picker}
        {p.connection}
        {p.about}
        {site.placement === "dock" ? (
          <Button key="narrow" label="›" onPress={act(() => $.ui.open({ id: PANE_ID, title: "Bellman", columns: SIDEBAR_COLUMNS }))} />
        ) : (
          <Button key="close" label="×" onPress={act(() => $.ui.close({ id: PANE_ID }))} />
        )}
      </Box>
      <Box columnGap={1}>
        {tabs.map(([to, label]) => (
          <Button key={`tab-${to}`} label={label} variant={to === shown ? "primary" : undefined} onPress={act(() => turnTo($, to))} />
        ))}
      </Box>
      {body}
    </Box>
  );
}
