/**
 * What bellman-mod keeps in `$.state`: one atom per key, each declared in the contract
 * (`PluginState["bellman-mod"]` in ../types). The session's, so a hot reload keeps them.
 */
import { atom } from "claude-code";
import type { DoorEvent, DoorView, Layout, PendingRequest, RoomView, Tab } from "../types";

/** Every local bridge in the session and what its door said, written by each door tick. */
export const doors = atom({ plugin: "bellman-mod", key: "doors" } as const, [] as DoorView[]);
/** The rooms of the doors' seats, written by the rooms poll (doors.ts). */
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
/** Written by the room pane; read here for the Approve count. */
export const pending = atom({ plugin: "bellman-mod", key: "pending" } as const, {} as Record<string, PendingRequest[]>);
/** `approvalKey`s of the action requests the person approved, written by the room pane: the gate passes Claude's `approved: true` answer for exactly these. */
export const approved = atom({ plugin: "bellman-mod", key: "approved" } as const, [] as string[]);
/** `approvalKey`s of the requests the person declined while the mod's own `approved: false` answer is in flight, written by the room pane: the gate passes that answer and no other. */
export const denying = atom({ plugin: "bellman-mod", key: "denying" } as const, [] as string[]);
/** By room, the newest events of its log, written by the log reads (doors.ts). */
export const logs = atom({ plugin: "bellman-mod", key: "logs" } as const, {} as Record<string, DoorEvent[]>);
/** By room, `bellman_surface`'s result, written while the pane shows the Canvas (doors.ts). */
export const canvas = atom({ plugin: "bellman-mod", key: "canvas" } as const, {} as Record<string, unknown>);
