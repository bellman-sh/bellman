/**
 * Every module that hands a room's events or briefs to a reader (read_context spec, section 3).
 *
 * A brief reaches a peer only when its author grants `read_context`, and that holds only on
 * the paths that apply the rule (`readableEvent`, `seesBrief`). A path that reads the log or a
 * brief without it leaks every private brief again. So each module that calls `publicEvent`, a
 * store's event read or `getBriefs` is listed here with how many such calls it holds and what
 * they serve. The test compares the modules and each count: a module that gains a call fails
 * until it is listed or its count is raised, and one that loses a call fails until its count is
 * lowered or it is dropped, so whoever changes a path says here whether the call applies the
 * rule. The count moves with a call and says nothing of whether the call is safe; the text
 * beside it is the claim a reviewer holds the call to.
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

/** What a module holds of one kind of call: how many, and what they hand out. */
type Listing = Record<string, { calls: number; serves: string }>;

/** The number of calls that match `call` on lines of code in each module under src/ that has any; the generated UI bundle is not code. */
const callsIn = (call: RegExp): Record<string, number> => {
  const every = new RegExp(call.source, "g");
  const found: Record<string, number> = {};
  for (const path of sources(join(ROOT, "src"))) {
    const module = relative(ROOT, path);
    if (module === "src/ui/assets.ts") continue;
    const calls = readFileSync(path, "utf8").split("\n")
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .reduce((n, line) => n + (line.match(every)?.length ?? 0), 0);
    if (calls > 0) found[module] = calls;
  }
  return found;
};

/** The count each module's listing pins. */
const pinned = (listing: Listing): Record<string, number> =>
  Object.fromEntries(Object.entries(listing).map(([module, { calls }]) => [module, calls]));

/** Each caller of `publicEvent`, and what it hands out. */
const PUBLIC_EVENT: Listing = {
  "src/public-event.ts": { calls: 2, serves: "publicEvent's definition, and publicReadEvent's call of it: the public page's shape, which leaves out every brief" },
  "src/store-do.ts": { calls: 2, serves: "the room socket's frames, on a reconnect's replay and on each append; shared, so a granted brief only" },
  "src/tools/sync.ts": { calls: 1, serves: "bellman_sync, read as the caller's account" },
  "src/http/rooms.ts": { calls: 1, serves: "the dash's Log route, read as the caller's account" },
};

/** Each caller of a store's event read (`eventsAfter`, `waitForEvents`, `recentEvents`, `eventAt`), and what it hands out. */
const EVENT_READS: Listing = {
  "src/store-do.ts": { calls: 4, serves: "the store facade: passes each read on and reads for no one. The socket's own reads in this module are under PUBLIC_EVENT" },
  "src/tools/sync.ts": { calls: 3, serves: "bellman_sync's events, read as the caller's account" },
  "src/http/rooms.ts": { calls: 3, serves: "the dash's Log route, as above" },
  "src/tools/rooms.ts": { calls: 1, serves: "bellman_rooms' last_event, read as the caller's account" },
  "src/http/public.ts": { calls: 2, serves: "the public page, through publicReadEvent" },
  "src/tools/send.ts": { calls: 2, serves: "an action_response's checks, on the request and on an earlier answer: hands out no event, only a refusal that names the earlier answerer" },
  "src/rooms.ts": { calls: 3, serves: "fileRoomReport: reads a reported cursor's event for its sender and hands the caller no event, only filed or refused; it applies the read rule first, as the reporter's account, or as the public for a caller with no handle in a public room or removed from it. requestWindow: the log's tail since a moment, which bellman_sync derives outstanding from, and outstanding is action requests' cursors and labels and no brief. restoreVersion: reads a restored cursor's event for its payload and author and hands the caller no event, only a card written again or a refusal that names the event's type; it applies the read rule first, as the restorer's account, so a brief_update its author keeps reads as no event at that cursor" },
  "src/host-do.ts": { calls: 1, serves: "the hosted seat's read; its transcript holds message and progress replies only (decide)" },
  "src/host-memory.ts": { calls: 1, serves: "the same read, on the Node server" },
};

/** Each caller of `getBriefs`, and whose briefs it hands out. */
const BRIEF_READS: Listing = {
  "src/store-do.ts": { calls: 1, serves: "the store facade: passes the read on" },
  "src/tools/connect.ts": { calls: 1, serves: "the creator's brief in a preview, when the creator grants read_context or the previewer is the creator's account" },
  "src/tools/confirm.ts": { calls: 1, serves: "the briefs a joiner is handed: peers who grant read_context, and the joiner's account's other handles" },
};

describe("the paths a brief can leave by (read_context spec, section 3)", () => {
  it("lists every module that calls publicEvent, and how many times", () => {
    expect(callsIn(/\bpublicEvent\(/)).toEqual(pinned(PUBLIC_EVENT));
  });

  it("lists every module that reads a room's events from the store, and how many times", () => {
    expect(callsIn(/\.(eventsAfter|waitForEvents|recentEvents|eventAt)\(/)).toEqual(pinned(EVENT_READS));
  });

  it("lists every module that reads a member's brief, and how many times", () => {
    expect(callsIn(/\.getBriefs\(/)).toEqual(pinned(BRIEF_READS));
  });
});
