import { describe, expect, it, vi } from "vitest";
import { INVITE_AUDIENCE, INVITE_FROM, inviteLink, inviteMail, inviteMailer, verifyInviteLink } from "../src/invite-mail.js";
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
  it("signs a link that verifies to the org and the key, and dies with the invite", async () => {
    const link = await inviteLink(ISSUER, "s", invite);
    expect(link.startsWith(`${ISSUER}/invite/`)).toBe(true);
    expect(await verifyInviteLink(tokenOf(link), ISSUER, "s")).toEqual({ orgId: "org_acme", key: "email:ana@example.com" });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(invite.expiresAt + 1000);
    try {
      expect(await verifyInviteLink(tokenOf(link), ISSUER, "s")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses another secret, another audience, and a claim without a key", async () => {
    const link = await inviteLink(ISSUER, "s", invite);
    expect(await verifyInviteLink(tokenOf(link), ISSUER, "other")).toBeNull();
    const session = await signJwt(
      { iss: ISSUER, sub: "invite", aud: "bellman:session-state", bellman: { orgId: "org_acme", key: "k" } as never }, "s", 60);
    expect(await verifyInviteLink(session, ISSUER, "s")).toBeNull();
    const keyless = await signJwt({ iss: ISSUER, sub: "invite", aud: INVITE_AUDIENCE, bellman: { orgId: "org_acme" } as never }, "s", 60);
    expect(await verifyInviteLink(keyless, ISSUER, "s")).toBeNull();
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
    } finally {
      err.mockRestore();
    }
  });
});
