/**
 * The person's own input to the mod: a press on one of its buttons or a pick in its room picker. The wake
 * subscribes (spec D7: a press counts as the person, so waking resumes).
 */
const listeners: (() => void)[] = [];

/** Runs `fn` on every input of the person's to the mod. */
export function onPerson(fn: () => void): void {
  listeners.push(fn);
}

/** Every press and pick calls this first. */
export function personActed(): void {
  // Each on its own: a listener that throws must not stop the press it rides on.
  for (const fn of listeners) {
    try {
      fn();
    } catch {
      // Nothing to tell: the listener's own work failed, not the press.
    }
  }
}
