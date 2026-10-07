/**
 * The pure rules of a blob (#183): the id and the key, the image allowlist and
 * the signatures behind it, how a claimed type becomes a stored one, the name
 * as a label, and the three stream helpers the route and the stores lean on. The
 * stores and the routes are tested elsewhere; this is the part both ends must
 * agree on.
 */
import { describe, it, expect } from "vitest";
import {
  BLOB_ID, IMAGE_TYPES, MAX_BLOB_BYTES, MAX_BLOB_NAME_CHARS, OCTET_STREAM, SNIFF_BYTES,
  BlobLengthError, attachmentDisposition, blobBytesUsed, blobKey, exactLength, isBlobId,
  newBlobId, normalizeMediaType, readExactly, readHead, sanitizeName, sniffImageType, storedType,
} from "../src/blobs.js";
import { PNG, drain, stream, text } from "./helpers/blob-bytes.js";

const bytes = (...b: number[]) => new Uint8Array(b);
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1);
const GIF = text("GIF89a......");
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50);

describe("the bounds", () => {
  it("are the spec's numbers", () => {
    expect(MAX_BLOB_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_BLOB_NAME_CHARS).toBe(200);
    expect([...IMAGE_TYPES]).toEqual(["image/png", "image/jpeg", "image/gif", "image/webp"]);
    expect(SNIFF_BYTES).toBe(12);
  });
});

describe("the id and the key", () => {
  it("mints 32 hex characters, fresh each time, and the key is the room's prefix", () => {
    const a = newBlobId();
    const b = newBlobId();
    expect(a).toMatch(BLOB_ID);
    expect(a).not.toBe(b);
    expect(isBlobId(a)).toBe(true);
    expect(blobKey("qs_1", a)).toBe(`rooms/qs_1/${a}`);
  });

  it.each(["", "ABCDEF0123456789ABCDEF0123456789", "0123456789abcdef0123456789abcde", "0123456789abcdef0123456789abcdef0", "../x"])(
    "refuses %j as an id", (id) => {
      expect(isBlobId(id)).toBe(false);
    },
  );
});

describe("sniffImageType", () => {
  it("names the four by their first bytes", () => {
    expect(sniffImageType(PNG)).toBe("image/png");
    expect(sniffImageType(JPEG)).toBe("image/jpeg");
    expect(sniffImageType(GIF)).toBe("image/gif");
    expect(sniffImageType(WEBP)).toBe("image/webp");
  });

  it("names nothing for text, for a RIFF that is not WEBP, and for too few bytes", () => {
    expect(sniffImageType(text("<svg xmlns=..."))).toBeNull();
    expect(sniffImageType(bytes(0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x41, 0x56, 0x45))).toBeNull();
    expect(sniffImageType(bytes(0x89, 0x50))).toBeNull();
    expect(sniffImageType(bytes())).toBeNull();
  });
});

describe("storedType (D6)", () => {
  it("keeps an image claim only when the bytes agree", () => {
    expect(storedType("image/png", PNG)).toBe("image/png");
    expect(storedType("image/png", JPEG)).toBe(OCTET_STREAM);
    expect(storedType("image/png", text("not a png at all"))).toBe(OCTET_STREAM);
    expect(storedType("image/jpeg", JPEG)).toBe("image/jpeg");
    expect(storedType("image/svg+xml", text("<svg/>"))).toBe(OCTET_STREAM);
    expect(storedType("image/bmp", bytes(0x42, 0x4d, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0))).toBe(OCTET_STREAM);
  });

  it("keeps a non-image claim as a normalised label, since the download never serves it", () => {
    expect(storedType("text/markdown; charset=utf-8", text("# hi"))).toBe("text/markdown");
    expect(storedType("Application/PDF", text("%PDF"))).toBe("application/pdf");
    expect(storedType("text/html", text("<!doctype html>"))).toBe("text/html");
  });

  it("falls back to an octet-stream for no claim, an empty one, a malformed one, or one too long", () => {
    expect(normalizeMediaType(null)).toBe(OCTET_STREAM);
    expect(normalizeMediaType("")).toBe(OCTET_STREAM);
    expect(normalizeMediaType("text")).toBe(OCTET_STREAM);
    expect(normalizeMediaType("text/plain/extra")).toBe(OCTET_STREAM);
    expect(normalizeMediaType("text/ plain")).toBe(OCTET_STREAM);
    expect(normalizeMediaType(`text/${"x".repeat(100)}`)).toBe(OCTET_STREAM);
  });
});

describe("sanitizeName (D6)", () => {
  it("keeps a plain name and trims it", () => {
    expect(sanitizeName("notes.md")).toBe("notes.md");
    expect(sanitizeName("  résumé (1).pdf ")).toBe("résumé (1).pdf");
  });

  // Review Focus 4: a path is a label here, never a path.
  it("strips path separators and control characters", () => {
    expect(sanitizeName("../../etc/passwd")).toBe("....etcpasswd");
    expect(sanitizeName("C:\\Users\\me\\x.txt")).toBe("C:Usersmex.txt");
    expect(sanitizeName("a\u0000b\u001fc\u007fd.txt")).toBe("abcd.txt");
    expect(sanitizeName("line\nbreak.txt")).toBe("linebreak.txt");
  });

  // The whole-branch review's fourth finding: C0 and DEL were stripped and C1 and the format characters were not.
  // The right-to-left override is the one that matters: it makes a save dialog draw this name as `reportexe.pdf`.
  it("strips C1 controls and format characters, the bidirectional overrides among them", () => {
    expect(sanitizeName("report\u{202E}fdp.exe")).toBe("reportfdp.exe");
    expect(sanitizeName("a\u0085b\u009Fc.txt")).toBe("abc.txt");
    expect(sanitizeName("\u{2066}isolated\u{2069}.txt")).toBe("isolated.txt");
  });

  // Three format characters are how names are spelled, so they stay: the zero-width non-joiner sits inside Persian
  // and Indic words, the joiner holds an emoji sequence together, and a soft hyphen is a hyphenation hint in text
  // pasted from a typeset page. Stripping them would misspell the name rather than make it safer.
  it("keeps the zero-width non-joiner, the zero-width joiner and the soft hyphen, which spell names", () => {
    expect(sanitizeName("می\u{200C}خواهم.txt")).toBe("می\u{200C}خواهم.txt");
    expect(sanitizeName("👨\u{200D}👩\u{200D}👧.png")).toBe("👨\u{200D}👩\u{200D}👧.png");
    expect(sanitizeName("co\u{AD}operate.txt")).toBe("co\u{AD}operate.txt");
  });

  // Every other format character goes. The tag characters (the U+E0000 block) spell out a string a human reader
  // cannot see and a program can; the zero-width space and the byte-order mark are invisible and mean nothing in
  // a name. Placed inside the name, because trim() takes a leading U+FEFF off whatever the class does.
  it("strips the other format characters: the tag characters, the zero-width space, the byte-order mark", () => {
    expect(sanitizeName("a\u{E0041}b.txt")).toBe("ab.txt");
    expect(sanitizeName("a\u{200B}b.txt")).toBe("ab.txt");
    expect(sanitizeName("not\u{FEFF}es.txt")).toBe("notes.txt");
  });

  it("refuses an absent, empty or over-long name rather than inventing or truncating one", () => {
    expect(sanitizeName(null)).toBeNull();
    expect(sanitizeName("")).toBeNull();
    expect(sanitizeName("///")).toBeNull();
    expect(sanitizeName("   ")).toBeNull();
    expect(sanitizeName("n".repeat(MAX_BLOB_NAME_CHARS))).toBe("n".repeat(MAX_BLOB_NAME_CHARS));
    expect(sanitizeName("n".repeat(MAX_BLOB_NAME_CHARS + 1))).toBeNull();
    // Code units, as every surface bound counts: 100 astral characters is 200 units.
    expect(sanitizeName("𝄞".repeat(100))).toBe("𝄞".repeat(100));
    expect(sanitizeName("𝄞".repeat(101))).toBeNull();
  });
});

describe("attachmentDisposition", () => {
  it("encodes the name as an RFC 8187 ext-value, including the characters encodeURIComponent leaves alone", () => {
    expect(attachmentDisposition("notes.md")).toBe("attachment; filename*=UTF-8''notes.md");
    expect(attachmentDisposition("résumé (1).pdf")).toBe("attachment; filename*=UTF-8''r%C3%A9sum%C3%A9%20%281%29.pdf");
    expect(attachmentDisposition("it's*.txt")).toBe("attachment; filename*=UTF-8''it%27s%2A.txt");
  });
});

describe("blobBytesUsed", () => {
  it("reads 0 off a record that was never charged, and the number off one that was", () => {
    const record = { blobBytes: undefined } as unknown as Parameters<typeof blobBytesUsed>[0];
    const charged = { ...record, blobBytes: 1234 };
    expect(blobBytesUsed(record)).toBe(0);
    expect(blobBytesUsed(charged)).toBe(1234);
  });
});

describe("readHead", () => {
  it("hands back the first n bytes and a stream that still carries all of them", async () => {
    const data = text("abcdefghijklmnopqrstuvwxyz");
    const { head, rest } = await readHead(stream(data, 5), 12);
    expect(new TextDecoder().decode(head)).toBe("abcdefghijkl");
    expect(await drain(rest)).toEqual(data);
  });

  it("hands back what there is when the body is shorter than n, and an empty head for an empty body", async () => {
    const short = await readHead(stream(text("abc")), 12);
    expect(new TextDecoder().decode(short.head)).toBe("abc");
    expect(await drain(short.rest)).toEqual(text("abc"));
    const empty = await readHead(stream(text("")), 12);
    expect(empty.head.byteLength).toBe(0);
    expect(await drain(empty.rest)).toEqual(text(""));
  });
});

describe("readExactly", () => {
  it("reads a stream or a buffer of exactly the declared length", async () => {
    expect(await readExactly(stream(text("hello")), 5)).toEqual(text("hello"));
    expect(await readExactly(text("hello").buffer as ArrayBuffer, 5)).toEqual(text("hello"));
  });

  // Review Focus 1: a body that ends short or runs long is refused, not stored short.
  it("refuses a body that ends short, and one that runs long", async () => {
    await expect(readExactly(stream(text("hell")), 5)).rejects.toBeInstanceOf(BlobLengthError);
    await expect(readExactly(stream(text("hello!")), 5)).rejects.toBeInstanceOf(BlobLengthError);
    await expect(readExactly(text("hello!").buffer as ArrayBuffer, 5)).rejects.toBeInstanceOf(BlobLengthError);
  });
});

// The rule once, for both stores: readExactly reads through it, and R2BlobStore (Task 5) pipes through it.
describe("exactLength", () => {
  it("hands every chunk through unchanged when the body is the declared length", async () => {
    const data = text("exactly this");
    expect(await drain(exactLength(stream(data, 5), data.byteLength))).toEqual(data);
  });

  it("errors with BlobLengthError, naming both numbers, when the body ends short and when it runs long", async () => {
    const short = drain(exactLength(stream(text("hell")), 5));
    await expect(short).rejects.toBeInstanceOf(BlobLengthError);
    await expect(short).rejects.toMatchObject({ expected: 5, got: 4 });
    const long = drain(exactLength(stream(text("hello!")), 5));
    await expect(long).rejects.toMatchObject({ expected: 5, got: 6 });
  });

  it("takes an empty body for zero bytes and refuses it for any more", async () => {
    expect(await drain(exactLength(stream(text("")), 0))).toEqual(text(""));
    await expect(drain(exactLength(stream(text("")), 1))).rejects.toBeInstanceOf(BlobLengthError);
  });

  // The refusal comes at the chunk that overshoots, not when the body ends. The source has six
  // chunks to give, so a refusal that waited for the end would have asked for all of them.
  // `highWaterMark: 0` makes `pull` run only when the pipe asks for a chunk: a default source
  // reads one ahead, so even with the guard in place its count at this refusal is 4, not 3.
  it("refuses at the chunk that overshoots, and asks the source for nothing after it", async () => {
    let pulled = 0;
    const source = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 1;
          if (pulled > 6) controller.close();
          else controller.enqueue(text("abcd"));
        },
      },
      { highWaterMark: 0 },
    );
    // Ten bytes declared, four to a chunk: the third chunk takes it to twelve.
    const error = await drain(exactLength(source, 10)).then(() => null, (e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 0)); // a pull that came late would still count
    expect(error).toBeInstanceOf(BlobLengthError);
    expect(pulled).toBe(3);
  });
});
