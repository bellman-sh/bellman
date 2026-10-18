/**
 * Every module that hands a room's events or briefs to a reader (read_context spec, section 3).
 *
 * A brief reaches a peer only when its author grants `read_context`, and that holds only on
 * the paths that apply the rule (`readableEvent`, `seesBrief`). A path that reads the log or a
 * brief without it leaks every private brief again. So each module that calls `publicEvent`, a
 * store's event read or `getBriefs` is listed here with what it serves. A module that gains such
 * a call fails its test until it is listed: whoever adds a path says here whether it applies the
 * rule. A module that loses its last such call fails it too, so no list names a path that is gone.
 *
 * A call is found on a line of code, not of a comment: a JSDoc line starts with `*` and a line
 * comment with `//`, and several modules name `publicEvent(e)` in prose.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const sources = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  if (statSync(path).isDirectory()) return sources(path);
  return path.endsWith(".ts") ? [path] : [];
});

/** The modules under src/ with a line of code that matches `call`; the generated UI bundle is not code. */
const callers = (call: RegExp): string[] =>
  sources(join(ROOT, "src"))
    .map((path) => relative(ROOT, path))
    .filter((path) => path !== "src/ui/assets.ts")
    .filter((path) => readFileSync(join(ROOT, path), "utf8").split("\n").some((line) => !/^\s*(\*|\/\/|\/\*)/.test(line) && call.test(line)))
    .sort();

/** Each caller of `publicEvent`, and what it hands out. */
const PUBLIC_EVENT: Record<string, string> = {
  "src/public-event.ts": "publicReadEvent, the public page's shape, which leaves out every brief",
  "src/store-do.ts": "the room socket's frames, on a reconnect's replay and on each append; shared, so a granted brief only",
  "src/tools/sync.ts": "bellman_sync, read as the caller's account",
  "src/http/rooms.ts": "the dash's Log route, read as the caller's account",
};

/** Each caller of a store's event read (`eventsAfter`, `waitForEvents`, `recentEvents`, `eventAt`), and what it hands out. */
const EVENT_READS: Record<string, string> = {
  "src/store-do.ts": "the store facade: passes each read on and reads for no one. The socket's own reads in this module are under PUBLIC_EVENT",
  "src/tools/sync.ts": "bellman_sync's events, read as the caller's account; and outstanding, which is action requests' cursors and labels and no brief",
  "src/http/rooms.ts": "the dash's Log route, as above",
  "src/tools/rooms.ts": "bellman_rooms' last_event, read as the caller's account",
  "src/http/public.ts": "the public page, through publicReadEvent",
  "src/tools/send.ts": "an action_response's checks, on the request and on an earlier answer: hands out no event, only a refusal that names the earlier answerer",
  "src/rooms.ts": "fileRoomReport: reads a reported cursor's event for its sender and hands the caller no event, only filed or refused",
  "src/host-do.ts": "the hosted seat's read; its transcript holds message and progress replies only (decide)",
  "src/host-memory.ts": "the same read, on the Node server",
};

/** Each caller of `getBriefs`, and whose briefs it hands out. */
const BRIEF_READS: Record<string, string> = {
  "src/store-do.ts": "the store facade: passes the read on",
  "src/tools/connect.ts": "the creator's brief in a preview, when the creator grants read_context or the previewer is the creator's account",
  "src/tools/confirm.ts": "the briefs a joiner is handed: peers who grant read_context, and the joiner's account's other handles",
};

describe("the paths a brief can leave by (read_context spec, section 3)", () => {
  it("lists every module that calls publicEvent", () => {
    expect(callers(/\bpublicEvent\(/)).toEqual(Object.keys(PUBLIC_EVENT).sort());
  });

  it("lists every module that reads a room's events from the store", () => {
    expect(callers(/\.(eventsAfter|waitForEvents|recentEvents|eventAt)\(/)).toEqual(Object.keys(EVENT_READS).sort());
  });

  it("lists every module that reads a member's brief", () => {
    expect(callers(/\.getBriefs\(/)).toEqual(Object.keys(BRIEF_READS).sort());
  });
});
