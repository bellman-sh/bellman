import { describe, expect, it } from "vitest";
import { SealError, isSealed, seal, unseal } from "../src/oauth/sealed.js";

/**
 * An org's IdP client secret is stored sealed (SSO spec, D14): a registry dump yields nothing
 * without the Worker secret too.
 */

const SECRET = "test-seal-secret";

describe("sealing a secret", () => {
  it("round-trips, an empty string and a long one included, under a fresh nonce each time", async () => {
    for (const plain of ["", "s3cr3t", "x".repeat(200), "ünïcödé ✓"]) {
      const sealed = await seal(SECRET, plain);
      expect(isSealed(sealed)).toBe(true);
      expect(await unseal(SECRET, sealed)).toBe(plain);
      expect(sealed).not.toContain(plain.length > 3 ? plain : "nothing-to-leak");
    }
    const [a, b] = [await seal(SECRET, "same"), await seal(SECRET, "same")];
    expect(a).not.toBe(b);
    expect(await unseal(SECRET, b)).toBe("same");
  });

  it("refuses another secret, a tampered ciphertext, and anything that is not a sealed value", async () => {
    const sealed = await seal(SECRET, "s3cr3t");
    await expect(unseal("another-secret", sealed)).rejects.toBeInstanceOf(SealError);
    const [v, nonce, body] = sealed.split(".");
    const flipped = body[0] === "A" ? "B" : "A";
    await expect(unseal(SECRET, `${v}.${nonce}.${flipped}${body.slice(1)}`)).rejects.toBeInstanceOf(SealError);
    for (const bad of ["plain", "v2.a.b", "v1.a", "v1..b", "v1.!!.??", ""]) {
      expect(isSealed(bad), bad).toBe(false);
      await expect(unseal(SECRET, bad), bad).rejects.toBeInstanceOf(SealError);
    }
  });

  it("names its errors so a route can tell a sealing failure from any other", async () => {
    const err = await unseal(SECRET, "plain").catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(SealError);
    expect((err as Error).name).toBe("SealError");
  });
});
