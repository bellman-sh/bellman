import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RoomRefShape, fail, ok, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { publicNameRefusal, roomNamed } from "../public-names.js";
import { namePublicRoom } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerPublicName(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_public_name",
    {
      title: "Check or set a public room's name",
      description: `A public room's page is dash.bellman.sh/r/<name> once it has a name, and dash.bellman.sh/r/<session_id> until then. Names are first come, first served, and free again when their room closes or is made private.

Args:
  - name: 3 to 40 lowercase letters, digits and single hyphens, starting and ending with a letter or digit.
  - session_id (or room_id): your public room. Without it the name is only checked. With it the name is set: you must be the room's creator, the room must be public and open, and the name it held before is free at once.

Returns: { name, free } when checking; { name, public_url } when setting.
Errors: "public name "...": use 3 to 40 lowercase letters..." (the rule), "public name "..." is taken" (choose another), "no such room, or no member of yours in it", "only the room's creator may name it", "only a public room has a public name", "the room is closed".`,
      inputSchema: { name: z.string().max(200), ...RoomRefShape },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const bad = publicNameRefusal(args.name);
      if (bad) return fail(`${bad}.`);
      const room = roomIdOf(args);
      if (room === undefined) return ok({ name: args.name, free: (await roomNamed(s, args.name)) === undefined });
      const r = await namePublicRoom(s, identity, room, args.name);
      return r.ok ? ok({ name: r.value.name, public_url: r.value.publicUrl }) : fail(r.reason);
    },
  );
}
