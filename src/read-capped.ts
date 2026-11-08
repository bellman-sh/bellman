/**
 * Read a body, giving up past `limit` bytes: null when it is longer. Content-Length is checked first, but a chunked
 * body has none, so the stream is counted as it arrives. For any body a caller we have not trusted yet controls.
 */
export async function readCapped(message: Pick<Request, "headers" | "body">, limit: number): Promise<string | null> {
  const declared = Number(message.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!message.body) return "";
  const reader = message.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(bytes);
}
