/**
 * Build an element. String children become text nodes, so nothing passed here
 * is ever parsed as markup: this is the one way peer prose reaches the DOM
 * (spec, Trust). Attribute values are for class names and data keys the page
 * itself chooses; never put peer text in one.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

/** "45s", "3m", "2h", "5d". */
export function duration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86_400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86_400)}d`;
}

/** "3m ago", "just now", "in 2h", or "never" for null. */
export function relative(iso: string | null, now = Date.now()): string {
  if (iso === null) return "never";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 0) return `in ${duration(-s)}`;
  if (s < 5) return "just now";
  return `${duration(s)} ago`;
}

/** "9m left" or "expired". */
export function countdown(iso: string, now = Date.now()): string {
  const s = Math.round((Date.parse(iso) - now) / 1000);
  return s <= 0 ? "expired" : `${duration(s)} left`;
}

/** A string for display, whatever the wire carried: peer payloads are not guaranteed any shape. */
export function text(value: unknown): string {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : JSON.stringify(value);
}
