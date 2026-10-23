/**
 * The room pane at full width (spec D5): a header, four tabs, and the tab shown. Log is the room's history, newest
 * last; Canvas its surface, drawn by kind; Members each member with role, presence and beat; Approve the action
 * requests waiting on the person, one at a time and the oldest first: who asks, what it asks drawn whole in a frame of
 * its own, every field Claude reads, and Approve and Deny after it. The Log's row of a waiting request leads to it with
 * Review, so a request is approved only where it is seen in full. A request the person approved keeps its place, and
 * reads that it waits on Claude where the buttons were. The tab never replaces what it shows unless the person asks:
 * it keeps the request it drew while that waits, and a notice stands in its place once it does not (`lastDrawn`).
 *
 * Every string a peer controls reaches the screen cleaned: through `cleanText` or `cleanBlock`, through what
 * `pendingRequests`, `kept`, `canvasOf` and `roomLabel` (src/mod/view.ts) cleaned already, and a canvas text's Markdown
 * through `safeLinks` as well. What reaches the model is `approvedText` and `declinedText` and nothing else: fixed
 * text around a room's id and a request's cursor, both server-made, and checked here.
 */
import { read, update } from "claude-code";
import type { Elements, EngineInterface, RenderElement } from "claude-code";
import { cleanBlock, cleanText } from "../../src/door-protocol.js";
import { approvalKey } from "../../src/mod/gate.js";
import { NAME_MAX, PANE_ID, SIDEBAR_COLUMNS, drawingOf, lineOf, memberLine, safeLinks } from "../../src/mod/view.js";
import type { CanvasItem, KeptEvent, PendingRequest, RoomView, Tab } from "../types";
import { decline, readCanvas, seatIn } from "./doors";
import { personActed } from "./person";
import { approved, canvas, doors, logs, pending, request, rooms, tab } from "./state";
import type { Pieces, Shown } from "./view";

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
  return `Your human approved Bellman action request ${cursor} in room ${sessionId}. Carry it out unless you already have, then answer it with bellman_send: type "action_response", ref_id "${cursor}", payload { approved: true, result }.`;
}

/** What Claude is told once the mod has answered a request the person declined. */
export function declinedText(sessionId: string, cursor: number): string {
  serverMade(sessionId, cursor);
  return `Your human declined Bellman action request ${cursor} in room ${sessionId}, and the room has been answered. Do not carry it out.`;
}

export const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The key a request is approved under: the room, and the request's cursor as the `ref_id` an answer carries. */
const keyOf = (r: PendingRequest): string => approvalKey(r.session_id, String(r.cursor));

/** The room and cursor that name a request. */
type Ref = { session_id: string; cursor: number };
const isRef = (a: Ref, b: Ref | null): boolean => b !== null && a.session_id === b.session_id && a.cursor === b.cursor;

/**
 * The request the Approve tab last drew in the room it shows. The tab keeps showing it for as long as it waits,
 * whatever arrives or leaves around it, and draws a notice in its place once it does not, so that no press lands on a
 * request the person never read (R31); only the person's pick (`request`) shows another. A module variable, as
 * `drawings` is, because a render may not write `$.state` and only the render knows what it drew. A reload starts it
 * over: the tab then draws the person's pick if that still waits, else the oldest, a fresh draw with no frame of the
 * old module left for a press to land in.
 */
let lastDrawn: PendingRequest | null = null;

/** The key of the request whose Deny the room last accepted: the log says only that it was answered, and the notice says the person did. */
let lastDenied: string | null = null;

/** What the person is told when they press the buttons of a request that has left. */
const GONE = "Bellman: that request is no longer waiting.";

/**
 * Whether `r` is still listed as waiting, read as a press is handled: the frame the press landed in may be a redraw
 * behind the log read that took the request out, and that frame still draws its buttons.
 */
async function waits($: EngineInterface, r: PendingRequest): Promise<boolean> {
  return ((await read($, pending))[r.session_id] ?? []).some((p) => p.cursor === r.cursor);
}

/**
 * The requests of `list` that wait on the person: those whose key is not in `given`, the keys approved. An approved
 * request waits on Claude, and the Approve count (the tab's, the band's and the sidebar's) does not count it.
 */
export const awaitingPerson = (list: readonly PendingRequest[], given: readonly string[]): PendingRequest[] =>
  list.filter((r) => !given.includes(keyOf(r)));

/** A hook's refusal does not reject: an append it refuses resolves with a `deny`, a prompt it drops with a `drop`, and Claude was not told. */
const throwIfRefused = (result: { deny?: string; drop?: string }): void => {
  const reason = result.deny ?? result.drop;
  if (reason !== undefined) throw new Error(reason);
};

/**
 * Approve: the gate passes Claude's `approved: true` answer for this request and no other, and Claude is told once, by
 * a prompt of the mod's own, whether a turn is running or not. A plugin's prompt runs once the session is idle, so a
 * running turn has it next; a row appended to that turn would only be stored, with nothing to make the turn read it.
 * An action request is not idempotent, so a press on one already approved tells Claude nothing more, and neither does
 * a press on one that has left (`waits`): the person is told it no longer waits. When Claude cannot be told, the
 * approval is taken back: the request draws its buttons again, and the gate stays shut for it.
 */
async function approve($: EngineInterface, r: PendingRequest): Promise<void> {
  const text = approvedText(r.session_id, r.cursor);
  if (!(await waits($, r))) {
    $.ui.toast(GONE);
    return;
  }
  const key = keyOf(r);
  // `update` runs again on a lost race, so `first` is what the write that landed saw: of presses made before a redraw, one.
  let first = false;
  await update($, approved, (keys) => {
    first = !keys.includes(key);
    return first ? [...keys, key] : keys;
  });
  if (!first) return;
  try {
    // It resolves once the prompt has entered, or been queued behind the turn that is running. The framing is the
    // plugin's own, never `asUser`.
    throwIfRefused(await $.prompt.submit({ text }));
  } catch (error) {
    $.ui.log(`bellman-mod: the approval was not told to Claude: ${message(error)}`, { to: "debug" });
    try {
      await update($, approved, (keys) => keys.filter((k) => k !== key));
      $.ui.toast("Bellman: the approval did not reach Claude, so the request still waits.");
    } catch (again) {
      $.ui.log(`bellman-mod: the approval was not taken back: ${message(again)}`, { to: "debug" });
    }
  }
}

/**
 * Deny: the mod answers the room itself, `approved: false`, through the door of the bridge that lists the seat
 * (`decline`, doors.ts): no tool call of Claude Code's, which would be refused from a press, and none the gate sees.
 * Claude is told only once the room has been answered, and the person is told when it was not, and when Claude could
 * not be told. A press on a request that has left asks the room nothing (`waits`): the person is told it no longer waits.
 */
async function deny($: EngineInterface, r: PendingRequest): Promise<void> {
  const text = declinedText(r.session_id, r.cursor);
  if (!(await waits($, r))) {
    $.ui.toast(GONE);
    return;
  }
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
  // Answered: it waits on nobody, though the log will not say so until its next read. Before the write, which redraws.
  lastDenied = keyOf(r);
  await update($, pending, (was) => ({ ...was, [r.session_id]: (was[r.session_id] ?? []).filter((p) => p.cursor !== r.cursor) }));
  try {
    throwIfRefused(await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }));
  } catch (error) {
    $.ui.log(`bellman-mod: the decline was not told to Claude: ${message(error)}`, { to: "debug" });
    $.ui.toast("Bellman: the request was declined, but Claude was not told. Tell Claude not to carry it out.");
  }
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

/**
 * One canvas item by its kind, under its title; null for a kind the pane does not draw. `canvasOf` cleaned what a peer
 * wrote as it kept it, and each string is cleaned again here, where it is drawn.
 */
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
 * The longest drawing of a request the Approve tab draws whole. The engine draws the first 100,000 characters of a
 * tree's texts and no Button past them, so a drawing that ran past would take its own buttons with it. The tab shows
 * one request, and the rest of the 100,000 is the header's, the tabs' and the request's own lines and buttons, so a
 * drawing past this is too long to show here whatever else waits, and it can only be denied.
 * ponytail: a fixed share; a picker of hundreds of rooms in the header would leave the request less than it.
 */
const DRAWINGS_MAX = 90_000;

/**
 * What each request asks as the Approve tab draws it, by its room and cursor: made once from its event, since
 * `drawingOf` is the work of a whole payload, and let go once the request no longer waits. Null for one too long to
 * draw whole here.
 * ponytail: an entry for each waiting request the tab has shown; the shown one's alone, the day memory says so.
 */
const drawings = new Map<string, string | null>();

/**
 * What `r` asks, whole, from its event in the room's log (`log`), or null: it would not fit in `DRAWINGS_MAX`, or its
 * payload was let go to keep `logs` within bounds (`fitLogs`, src/mod/view.ts), and either way it can only be denied.
 */
function drawingFor(r: PendingRequest, log: readonly KeptEvent[]): string | null {
  const e = log.find((x) => x.cursor === r.cursor);
  if (e === undefined || e.line !== undefined) return null;
  const key = keyOf(r);
  if (!drawings.has(key)) {
    const { drawing, cut } = drawingOf(e.payload);
    drawings.set(key, !cut && drawing.length <= DRAWINGS_MAX ? drawing : null);
  }
  return drawings.get(key) ?? null;
}

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
  const held = await read($, pending);
  const waiting = held[s.picked] ?? [];
  const given = await read($, approved);
  const live = new Set(Object.values(held).flatMap((list) => list.map(keyOf)));
  for (const key of drawings.keys()) if (!live.has(key)) drawings.delete(key);
  const act = (work: () => Promise<unknown>) => () => {
    personActed();
    work().catch((error: unknown) => $.ui.log(`bellman-mod: ${message(error)}`, { to: "debug" }));
  };
  // A request the person approved waits on Claude, and has no button to press again: not Approve, which would tell
  // Claude twice, and not Deny, which could tell the room "declined" after Claude carried it out.
  const waitsOnClaude = (r: PendingRequest) => given.includes(keyOf(r));
  const onClaude = () => <Text dimColor>approved · waiting for Claude</Text>;
  const denyIt = (r: PendingRequest) => <Button key={`deny-${r.cursor}`} label="Deny" onPress={act(() => deny($, r))} />;
  const review = (r: PendingRequest) =>
    act(() => Promise.all([update($, request, () => ({ session_id: r.session_id, cursor: r.cursor })), update($, tab, () => "approve" as const)]));
  const tabs: [Tab, string][] = [
    ["log", "Log"],
    ["canvas", "Canvas"],
    ["members", "Members"],
    ["approve", `Approve ${awaitingPerson(waiting, given).length}`],
  ];

  let body: RenderElement[];
  if (shown === "log") {
    const open = new Map(waiting.map((r) => [r.cursor, r]));
    const log: readonly KeptEvent[] = (await read($, logs))[s.picked] ?? [];
    body =
      log.length === 0
        ? [<Text dimColor>Nothing in the room's log yet.</Text>]
        : log.slice(-Math.max(1, site.bodyRows - CHROME_ROWS)).map((e) => {
            const r = open.get(e.cursor);
            // A row says only a line of what a request asks, so it is answered on the Approve tab, where all of it shows.
            return (
              <Box columnGap={1}>
                <Text wrap="truncate-end">{`${clock(e.at)} ${cleanText(e.from_label, NAME_MAX)} ${cleanText(lineOf(e))}`}</Text>
                {r !== undefined && (waitsOnClaude(r) ? onClaude() : <Button key={`review-${r.cursor}`} label="Review" onPress={review(r)} />)}
              </Box>
            );
          });
  } else if (shown === "canvas") {
    const listed = (await read($, canvas))[s.picked];
    const items = (listed ?? []).flatMap((item) => drawItem(ui, item) ?? []);
    body =
      listed === undefined
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
        cleanText(m.beat.note),
      ];
      return <Text wrap="truncate-end">{line.filter((part) => part !== "").join(" · ")}</Text>;
    });
    // `rooms` keeps a room's first members (`MEMBERS_KEPT`, doors.ts): the rest are counted, so the list does not pass for all.
    const more = (view?.active_members ?? 0) - (view?.members.length ?? 0);
    if (more > 0) body.push(<Text dimColor>{`and ${more} more`}</Text>);
  } else {
    const now = await $.clock.now();
    const chosen = await read($, request);
    const log: readonly KeptEvent[] = (await read($, logs))[s.picked] ?? [];
    // The request the person turned to, while it waits; else the one last drawn here, while it waits; else the oldest,
    // the first time. When the one last drawn has left it stays the subject, and a notice stands where it was: nothing
    // that arrives or leaves shows another request, only a pick does (‹, ›, the notice's button, a Log row's Review).
    const last = lastDrawn?.session_id === s.picked ? lastDrawn : null;
    const r = waiting.find((w) => isRef(w, chosen)) ?? (last === null ? waiting[0] : waiting.find((w) => isRef(w, last)));
    if (r !== undefined) lastDrawn = r;
    else if (last === null) lastDrawn = null;
    const at = r === undefined ? 0 : waiting.indexOf(r);
    const next = waiting[0];
    const pickRequest = (to: PendingRequest) => act(() => update($, request, () => ({ session_id: to.session_id, cursor: to.cursor })));
    // ‹ and › go round from the request shown, which is the frame the person pressed in.
    const step = (by: number) => pickRequest(waiting[(at + by + waiting.length) % waiting.length]!);
    // Where a request was, once it has left: whose it was and that it no longer waits, with the reason when the mod knows
    // it (the person's own Deny, an answer in the room's log, or its time), and a button to the oldest still waiting. It
    // draws no Approve or Deny, and its button is keyed apart from both, so that no press meant for the request that left
    // can reach the next.
    const gone = (g: PendingRequest) => {
      const answered = log.some((e) => e.type === "action_response" && e.ref_id === String(g.cursor));
      const why = lastDenied === keyOf(g) ? "you denied it" : answered ? "it was answered" : now >= g.expires_at ? "it expired" : "";
      return (
        <Box flexDirection="column">
          <Text wrap="truncate-end">{`${g.from_label}'s request is no longer waiting${why === "" ? "" : `: ${why}`}.`}</Text>
          {next !== undefined && (
            <Box>
              <Button key={`show-${next.cursor}`} label="Show next request" onPress={pickRequest(next)} />
            </Box>
          )}
        </Box>
      );
    };
    // Drawn as plain text and not Markdown, since what is drawn is what Claude reads, and in a frame, so that no line of
    // what a peer wrote can read as the tab's own or as another request. One too long to draw whole is drawn for its
    // Deny alone.
    const drawing = r === undefined ? null : drawingFor(r, log);
    body =
      r === undefined
        ? [...(last === null ? [] : [gone(last)]), ...(next === undefined ? [<Text dimColor>Nothing waits on you.</Text>] : [])]
        : [
            <Box flexDirection="column">
              {waiting.length > 1 && (
                <Box columnGap={1}>
                  <Text>{`request ${at + 1} of ${waiting.length}`}</Text>
                  <Button key="approve-prev" label="‹" onPress={step(-1)} />
                  <Button key="approve-next" label="›" onPress={step(1)} />
                </Box>
              )}
              <Text wrap="truncate-end">{`${r.from_label} asks · ${Math.max(0, Math.ceil((r.expires_at - now) / 60_000))} min left`}</Text>
              {drawing !== null && (
                <Box borderStyle="round" flexDirection="column">
                  <Text wrap="wrap">{drawing}</Text>
                </Box>
              )}
              <Box columnGap={1}>
                {waitsOnClaude(r)
                  ? onClaude()
                  : drawing !== null
                    ? [<Button key={`approve-${r.cursor}`} label="Approve" variant="primary" onPress={act(() => approve($, r))} />, denyIt(r)]
                    : [<Text dimColor>too long to show in full here, so it can only be denied</Text>, denyIt(r)]}
              </Box>
            </Box>,
          ];
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
          p.close
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
