/**
 * Byte fixtures for the blob tests (#183): declared once, here, so the root
 * program's tests, the contract that workerd also runs, and the route and bridge
 * tests all read the same bytes.
 */
export const text = (s: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(s);

/** A body in chunks of `chunk` bytes, the way a request body arrives. */
export const stream = (data: Uint8Array, chunk = 4): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < data.byteLength; i += chunk) c.enqueue(data.subarray(i, i + chunk));
      c.close();
    },
  });

export const drain = async (body: ReadableStream<Uint8Array>): Promise<Uint8Array> =>
  new Uint8Array(await new Response(body).arrayBuffer());

/** The PNG signature, then an IHDR chunk's length and name: enough to be sniffed as a PNG. */
export const PNG: Uint8Array<ArrayBuffer> = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52,
]);
