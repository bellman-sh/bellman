import { base64url, base64urlDecode } from "./tokens.js";

/**
 * Sealing a value the store holds (SSO spec, D14): an org's IdP client secret is written sealed and
 * read back open, so a dump of the registry yields no secret without the Worker secret too.
 *
 * AES-256-GCM under a key derived once per call by HKDF-SHA256 from the seal secret (BELLMAN_SEAL_SECRET,
 * or BELLMAN_TOKEN_SECRET when it is unset), a random 96-bit nonce, the output `v1.<nonce>.<ciphertext>`
 * in base64url. Rotating the seal secret means every org re-enters its secret, which is why it can be
 * kept apart from a token secret rotation.
 */

const VERSION = "v1";
const INFO = "bellman:org-idp-secret";
const encoder = new TextEncoder();

/** Why a value could not be opened: not a sealed value, another secret, or a tampered one. One class, so a route can tell it apart. */
export class SealError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealError";
  }
}

/** Web Crypto wants a plain ArrayBuffer; a Uint8Array view is not one. */
function buffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

async function keyFor(secret: string, usage: KeyUsage): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", buffer(encoder.encode(secret)), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: buffer(encoder.encode(INFO)) },
    material, { name: "AES-GCM", length: 256 }, false, [usage],
  );
}

/** Whether a value has a sealed value's shape: the version, a nonce and a ciphertext, each base64url. */
export function isSealed(value: string): boolean {
  const parts = value.split(".");
  return parts.length === 3 && parts[0] === VERSION && /^[A-Za-z0-9_-]{16}$/.test(parts[1]) && /^[A-Za-z0-9_-]+$/.test(parts[2]);
}

export async function seal(secret: string, plaintext: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, await keyFor(secret, "encrypt"), buffer(encoder.encode(plaintext)));
  return `${VERSION}.${base64url(nonce)}.${base64url(new Uint8Array(ciphertext))}`;
}

export async function unseal(secret: string, sealed: string): Promise<string> {
  if (!isSealed(sealed)) throw new SealError("not a sealed value");
  const [, nonce, ciphertext] = sealed.split(".");
  try {
    const opened = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(base64urlDecode(nonce)) }, await keyFor(secret, "decrypt"), buffer(base64urlDecode(ciphertext)),
    );
    return new TextDecoder().decode(opened);
  } catch {
    // A wrong secret and a tampered ciphertext both fail the GCM tag, as one OperationError that says nothing more.
    throw new SealError("the value could not be opened: another secret, or a tampered value");
  }
}
