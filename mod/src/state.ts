/**
 * What bellman-mod keeps in `$.state`: one atom per key, each declared in the contract
 * (`PluginState["bellman-mod"]` in ../types). The session's, so a hot reload keeps them.
 */
import { atom } from "claude-code";
import type { DoorView } from "../types";

/** Every local bridge in the session and what its door said, written by each door tick. */
export const doors = atom({ plugin: "bellman-mod", key: "doors" } as const, [] as DoorView[]);
