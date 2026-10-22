/**
 * What bellman-mod keeps in `$.state`: one atom per key, each declared in the contract
 * (`PluginState["bellman-mod"]` in ../types). The session's, so a hot reload keeps them.
 */
import { atom } from "claude-code";
import type { CanvasItem, DoorView, KeptEvent, Layout, PendingRequest, RoomView, Tab } from "../types";

/** Every local bridge in the session and what its door said, written by each door tick. */
export const doors = atom({ plugin: "bellman-mod", key: "doors" } as const, [] as DoorView[]);
/** The rooms of the doors' seats, as each door's `/rooms` serves them, written by the rooms poll (doors.ts). */
export const rooms = atom({ plugin: "bellman-mod", key: "rooms" } as const, [] as RoomView[]);
/** The room shown, picked each tick or by the person (view.tsx). */
export const room = atom({ plugin: "bellman-mod", key: "room" } as const, null as string | null);
/** By room, the newest cursor looked at for a toast. */
export const seen = atom({ plugin: "bellman-mod", key: "seen" } as const, {} as Record<string, number>);
/** By room, the newest cursor the person has seen in its Log. */
export const openedThrough = atom({ plugin: "bellman-mod", key: "openedThrough" } as const, {} as Record<string, number>);
export const layout = atom({ plugin: "bellman-mod", key: "layout" } as const, "band" as Layout);
export const tab = atom({ plugin: "bellman-mod", key: "tab" } as const, "log" as Tab);
/** Written by the wake; read here for the band's and the sidebar's `paused`. */
export const wake = atom({ plugin: "bellman-mod", key: "wake" } as const, { paused: false });
/** By room, the requests waiting on the person, written by the log reads (doors.ts) and a Deny; read for the Approve count. */
export const pending = atom({ plugin: "bellman-mod", key: "pending" } as const, {} as Record<string, PendingRequest[]>);
/** The request the Approve tab shows, by its room and cursor, written by the person's presses; null for the room's oldest. */
export const request = atom({ plugin: "bellman-mod", key: "request" } as const, null as { session_id: string; cursor: number } | null);
/** `approvalKey`s of the action requests the person approved, written by the room pane: the gate passes Claude's `approved: true` answer for exactly these. */
export const approved = atom({ plugin: "bellman-mod", key: "approved" } as const, [] as string[]);
/** By room, the newest events of its log, trimmed, written by the log reads (doors.ts). */
export const logs = atom({ plugin: "bellman-mod", key: "logs" } as const, {} as Record<string, KeptEvent[]>);
/** The shown room's canvas, by its id, kept from its door's `/rooms/<id>/surface` while the pane shows the Canvas (doors.ts). */
export const canvas = atom({ plugin: "bellman-mod", key: "canvas" } as const, {} as Record<string, CanvasItem[]>);
