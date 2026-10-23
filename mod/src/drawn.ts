/**
 * What a terminal has drawn of the mod since this module loaded: whether it drew the band or the pane at all, which
 * the gate reads (it shuts only where the person can see something of the mod's, and leaves approval in chat
 * everywhere else), and whether the pane last drew at full width, as the room pane, which `shownTab` reads.
 *
 * Module state on purpose: a reload starts it over, until the terminal next draws.
 */
import { read } from "claude-code";
import type { EngineInterface } from "claude-code";
import { PANE_ID } from "../../src/mod/view.js";
import type { Tab } from "../types";
import { tab } from "./state";

let drawn = false;
let wide = false;

export function markDrawn(): void {
  drawn = true;
}

export function hasDrawn(): boolean {
  return drawn;
}

/** Each draw of the pane says which form it drew: the room pane (`true`) or the sidebar. */
export function markPaneWide(isWide: boolean): void {
  wide = isWide;
}

/**
 * The tab the room pane shows the person now, or null: it is open, placed, shown rather than a tab behind another
 * plugin's pane, and last drew at full width. The sidebar shows no tab. Every read made "while the pane shows" a
 * tab, and the toast that the open Log keeps away, ask this.
 */
export async function shownTab($: EngineInterface): Promise<Tab | null> {
  if (!wide) return null;
  const pane = (await $.ui.panes()).find((p) => p.id === PANE_ID);
  return pane?.isPlaced && pane.isShown ? read($, tab) : null;
}
