import { describe, expect, it, vi } from "vitest";
import { INVITE_AUDIENCE, INVITE_FROM, inviteLink, inviteMail, inviteMailer, isMailableAddress, verifyInviteLink } from "../src/invite-mail.js";
import { signJwt } from "../src/oauth/tokens.js";
import { INVITE_TTL_MS } from "../src/orgs.js";
import type { Org, OrgInvite } from "../src/types.js";

const org = { orgId: "org_acme", name: "Acme\r\nBcc: x@y" } as Org;
const invite: OrgInvite = {
  orgId: "org_acme", key: "email:ana@example.com", role: "admin", invitedBy: "u_1",
  invitedAt: 1_000_000, expiresAt: Date.now() + INVITE_TTL_MS,
};
const ISSUER = "https://mcp.test";
const tokenOf = (link: string) => link.slice(`${ISSUER}/invite/`.length);

describe("invite links", () => {
  it("signs a link that verifies to the org, the key and the invite's issue time, and dies with the invite", async () => {
    const link = await inviteLink(ISSUER, "s", invite);
    expect(link.startsWith(`${ISSUER}/invite/`)).toBe(true);
    expect(await verifyInviteLink(tokenOf(link), ISSUER, "s")).toEqual({ orgId: "org_acme", key: "email:ana@example.com", at: 1_000_000 });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(invite.expiresAt + 1000);
    try {
      expect(await verifyInviteLink(tokenOf(link), ISSUER, "s")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses another secret, another audience, and a claim without a key or an issue time", async () => {
    const link = await inviteLink(ISSUER, "s", invite);
    expect(await verifyInviteLink(tokenOf(link), ISSUER, "other")).toBeNull();
    const session = await signJwt(
      { iss: ISSUER, sub: "invite", aud: "bellman:session-state", bellman: { orgId: "org_acme", key: "k" } as never }, "s", 60);
    expect(await verifyInviteLink(session, ISSUER, "s")).toBeNull();
    const keyless = await signJwt({ iss: ISSUER, sub: "invite", aud: INVITE_AUDIENCE, bellman: { orgId: "org_acme" } as never }, "s", 60);
    expect(await verifyInviteLink(keyless, ISSUER, "s")).toBeNull();
    const timeless = await signJwt({ iss: ISSUER, sub: "invite", aud: INVITE_AUDIENCE, bellman: { orgId: "org_acme", key: "k" } as never }, "s", 60);
    expect(await verifyInviteLink(timeless, ISSUER, "s")).toBeNull();
    expect(await verifyInviteLink("not.a.token", ISSUER, "s")).toBeNull();
  });
});

describe("invite mail", () => {
  it("writes the mail from fixed text and the org's drawn name, with no line break from the name, and the link on its own line", () => {
    const m = inviteMail(org, invite, `${ISSUER}/invite/abc`);
    expect(m.subject).toBe("Join AcmeBcc: x@y on Bellman");
    expect(m.subject).not.toMatch(/[\r\n]/);
    expect(m.text).not.toMatch(/\r/);
    expect(m.text).toContain(`\n${ISSUER}/invite/abc\n`);
    expect(m.text).toContain("as an admin");
    expect(inviteMail(org, { ...invite, role: "member" }, "L").text).toContain("as a member");
    expect(m.text).toContain(new Date(invite.expiresAt).toUTCString());
  });

  it("sends through the binding and answers true; answers false, and logs, with no binding or a send that throws", async () => {
    const sent: unknown[] = [];
    expect(await inviteMailer({ send: async (m) => { sent.push(m); } })("ana@example.com", org, invite, "L")).toBe(true);
    expect(sent[0]).toMatchObject({ from: INVITE_FROM, to: "ana@example.com", subject: "Join AcmeBcc: x@y on Bellman" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await inviteMailer(undefined)("ana@example.com", org, invite, "L")).toBe(false);
      const failing = { send: async () => { throw Object.assign(new Error("nope"), { code: "E_SENDER_NOT_VERIFIED" }); } };
      expect(await inviteMailer(failing)("ana@example.com", org, invite, "L")).toBe(false);
      expect(err.mock.calls.map((c) => String(c[0]))).toEqual([
        expect.stringContaining("org_acme"),
        expect.stringContaining("E_SENDER_NOT_VERIFIED"),
      ]);
      // A worker log is not where an invitee's address belongs; the admin has the invite and its link.
      expect(err.mock.calls.flat().join(" ")).not.toContain("ana@example.com");
    } finally {
      err.mockRestore();
    }
  });
});

describe("the address an invite is mailed to (ADR 0036, D1)", () => {
  it("is one plain address: no list, no display name, no space or control character, and a length a mailbox can have", () => {
    for (const ok of ["ana@example.com", "ana.b+tag@sub.example.co"]) expect(isMailableAddress(ok), ok).toBe(true);
    for (const bad of [
      "ana@example.com, eve@evil.test", "ana@example.com;eve@evil.test", "Ana <ana@example.com>", "ana@example.com\r\nBcc: eve@evil.test",
      "ana @example.com", "ana@@example.com", "a@b@example.com", "@example.com", "ana@", "ana@nodot", "\"ana\"@example.com",
      `${"a".repeat(250)}@example.com`,
    ]) expect(isMailableAddress(bad), bad).toBe(false);
  });

  it("logs a failed send by its code alone, since the binding's message may name the recipient", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const failing = { send: async () => { throw Object.assign(new Error("no route to ana@example.com"), { code: "E_DELIVERY" }); } };
      expect(await inviteMailer(failing)("ana@example.com", org, invite, "L")).toBe(false);
      expect(String(err.mock.calls[0][0])).toContain("E_DELIVERY");
      expect(err.mock.calls.flat().join(" ")).not.toContain("ana@example.com");
    } finally {
      err.mockRestore();
    }
  });

  it("is checked by the mailer, which sends nothing to anything else and logs without the address", async () => {
    const send = vi.fn(async () => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await inviteMailer({ send })("ana@example.com, eve@evil.test", org, invite, "L")).toBe(false);
      expect(send).not.toHaveBeenCalled();
      expect(err.mock.calls.flat().join(" ")).not.toContain("eve@evil.test");
    } finally {
      err.mockRestore();
    }
  });
});
