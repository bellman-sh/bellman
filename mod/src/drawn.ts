/**
 * Whether a terminal has drawn the mod's band or pane since this module loaded. The gate reads it: it shuts
 * only where the person can see something of the mod's, and leaves approval in chat everywhere else.
 *
 * Module state on purpose: a reload starts it false again, until the terminal next draws.
 */
let drawn = false;

export function markDrawn(): void {
  drawn = true;
}

export function hasDrawn(): boolean {
  return drawn;
}
