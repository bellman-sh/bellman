import { createHash } from "node:crypto";

/**
 * Just enough of RFC 6455 for a fake server to speak to Node's real WebSocket
 * client: the handshake answer, unmasked frames going out, masked frames coming
 * in. It is deliberately not a WebSocket library. It does what a Durable Object's
 * socket does for a bridge (sends text frames, answers a close, drops a
 * connection) and refuses to do anything else, so a client bug that depends on
 * some feature this lacks cannot hide behind it.
 *
 * It lives apart from fake-bellman.ts because it is protocol, not Bellman: that
 * file decides who may upgrade and what a room sends, this one only knows how
 * the bytes are laid out.
 */

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** RFC 6455 section 4.2.2: the answer to the client's Sec-WebSocket-Key. */
export function acceptFor(key: string): string {
  return createHash("sha1").update(key + GUID).digest("base64");
}

/** The 101 a server writes to complete an upgrade. No extension is offered, so no frame is ever compressed. */
export function handshake(key: string): string {
  return [
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${acceptFor(key)}`,
    "",
    "",
  ].join("\r\n");
}

/** One server-to-client frame. Servers never mask (RFC 6455 section 5.1). */
export function encode(opcode: number, payload: Buffer = Buffer.alloc(0), fin = true): Buffer {
  const first = (fin ? 0x80 : 0) | opcode;
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([first, length]);
  } else if (length < 0x10000) {
    header = Buffer.alloc(4);
    header[0] = first;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = first;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

export const textFrame = (text: string): Buffer => encode(OPCODE.text, Buffer.from(text, "utf8"));

export const binaryFrame = (bytes: Buffer): Buffer => encode(OPCODE.binary, bytes);

/** A close frame. With no code it carries no body, which a client reads as 1005. */
export function closeFrame(code?: number, reason = ""): Buffer {
  if (code === undefined) return encode(OPCODE.close);
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return encode(OPCODE.close, body);
}

export interface ClientFrame {
  opcode: number;
  payload: Buffer;
}

/**
 * Reads what a client sends: masked frames, arriving in whatever chunks the
 * network chose. A frame that is not masked is a protocol error from a client
 * (RFC 6455 section 5.1) and throws, as does a fragmented one: nothing a bridge
 * sends is either, so meeting one means the client is not doing what it should.
 */
export class ClientFrames {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): ClientFrame[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const frames: ClientFrame[] = [];
    for (;;) {
      const buffer = this.#buffer;
      if (buffer.length < 2) return frames;
      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return frames;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return frames;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked) throw new Error("a client frame that is not masked");
      if (!fin) throw new Error("a fragmented client frame");
      if (buffer.length < offset + 4 + length) return frames;
      const key = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4];
      frames.push({ opcode, payload });
      this.#buffer = buffer.subarray(offset + 4 + length);
    }
  }
}

/** The code in a close frame's body, or undefined when it has none. */
export function closeCodeOf(payload: Buffer): number | undefined {
  return payload.length >= 2 ? payload.readUInt16BE(0) : undefined;
}
