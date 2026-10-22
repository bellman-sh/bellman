import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { RoomRefShape, fail, ok, roomIdOf } from "./kit.js";
import type { ToolResult } from "./kit.js";
import type { Identity } from "../types.js";
import { nameFree, publicNameRefusal } from "../public-names.js";
import { namePublicRoom } from "../rooms.js";
import type { BellmanStore } from "../store.js";

export function registerPublicName(server: McpServer, identity: Identity, s: BellmanStore): void {
  server.registerTool(
    "bellman_public_name",
    {
      title: "Check or set a public room's name",
      description: `Check or set the name in a public room's link, bellman.sh/r/<name>, which until then is bellman.sh/r/<session_id>. First come, first served; free again when its room closes or is made private.

Args: name (3 to 40 lowercase letters, digits and single hyphens); session_id or room_id to set it on your public, open room, as its creator, freeing its previous name. Without one, the name is only checked.
Returns: { name, free } when checking; { name, public_url } when setting.
Errors: the name rule, "is taken", "no such room, or no member of yours in it", "only the room's creator may name it", "only a public room has a public name", "the room is closed".`,
      inputSchema: { name: z.string().max(200), ...RoomRefShape },
      annotations: {
        readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false,
      },
    },
    async (args): Promise<ToolResult> => {
      const bad = publicNameRefusal(args.name);
      if (bad) return fail(`${bad}.`);
      const room = roomIdOf(args);
      if (room === undefined) return ok({ name: args.name, free: await nameFree(s, args.name) });
      const r = await namePublicRoom(s, identity, room, args.name);
      return r.ok ? ok({ name: r.value.name, public_url: r.value.publicUrl }) : fail(r.reason);
    },
  );
}
