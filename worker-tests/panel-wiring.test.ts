/**
 * The Worker actually reads BELLMAN_PANEL_ORIGINS.
 *
 * This file exists because of a specific miss. `oauthConfig` is module-private
 * in src/worker.ts, and src/worker.ts is excluded from the Node test program —
 * so nothing in 1374 tests reached the line that hands the parsed panel origins
 * to the authorization server. The whole feature was written, reviewed and
 * committed with that line absent, and every test passed: `panelOrigins` was
 * undefined in production, `sessionCaller` refused every cookie, and the panel
 * could not sign in at all.
 *
 * Unit tests of parsePanelOrigins do not help, because the defect is not in the
 * parser; it is in whether anybody calls it. Only a request through the real
 * `fetch` handler, with the var set, can see that.
 */
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import worker from "../src/worker.js";

const ISSUER = "https://mcp.example.test";
const PANEL = "https://dash.example.test";

/** The env the Worker needs for OAuth to be configured at all. */
function withPanel(origins: string | undefined) {
  return {
    ...env,
    BELLMAN_TOKEN_SECRET: "test-signing-secret",
    GITHUB_CLIENT_ID: "gh-id",
    GITHUB_CLIENT_SECRET: "gh-secret",
    BELLMAN_PANEL_ORIGINS: origins,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

const signin = (origins: string | undefined) =>
  worker.fetch(new Request(`${ISSUER}/auth/signin`), withPanel(origins), {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext);

describe("the Worker reads BELLMAN_PANEL_ORIGINS", () => {
  /**
   * The assertion that would have caught the missing wiring. With the var set,
   * /auth/signin offers a provider; with `panelOrigins` never reaching the
   * config it answers 503 instead, because the sign-in route treats an absent
   * allowlist as "no browser may hold a session".
   */
  it("offers a sign-in when the var names an origin", async () => {
    const res = await signin(PANEL);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/authorize/github?req=");
  });

  it("refuses to start a sign-in when the var is unset", async () => {
    expect((await signin(undefined)).status).toBe(503);
  });

  it("refuses to start a sign-in when the var is empty", async () => {
    expect((await signin("")).status).toBe(503);
  });

  /**
   * The parser is reached, not bypassed: a trailing slash matches no Origin
   * header, and normalising it is the parser's job. A wiring that passed the raw
   * string through would still answer 200 here, so this pins that the value went
   * through parsePanelOrigins rather than merely that something arrived.
   */
  it("normalises the var through the parser, so a trailing slash still works", async () => {
    const res = await signin(`${PANEL}/`);

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("/authorize/github?req=");
  });

  it("drops an unusable entry and keeps the rest", async () => {
    expect((await signin(`not-a-url, ${PANEL}`)).status).toBe(200);
  });

  it("refuses when every entry is unusable", async () => {
    expect((await signin("not-a-url, javascript:x")).status).toBe(503);
  });
});

describe("the Worker reads BELLMAN_PUBLIC_PAGE_ORIGINS", () => {
  const PAGE = "https://bellman.sh";
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  type WorkerEnv = ReturnType<typeof withPanel>;
  const withPage = (page: string | undefined) => ({ ...withPanel(PANEL), BELLMAN_PUBLIC_PAGE_ORIGINS: page }) as WorkerEnv;
  /** The origin a preflight from `origin` is granted on `path`, or null: what the Worker's whole route table answers. */
  const grant = async (env: WorkerEnv, path: string, origin: string) => (await worker.fetch(new Request(`${ISSUER}${path}`, {
    method: "OPTIONS", headers: { origin, "access-control-request-method": "POST" },
  }), env, ctx)).headers.get("access-control-allow-origin");

  // Public rooms on bellman.sh, D7: the Worker hands BELLMAN_PUBLIC_PAGE_ORIGINS to the report route and the sign-in.
  it("grants bellman.sh the report route's preflight while the var names it, and not without it", async () => {
    expect(await grant(withPage(PAGE), "/rooms/qs_any/reports", PAGE)).toBe(PAGE);
    expect(await grant(withPanel(PANEL), "/rooms/qs_any/reports", PAGE)).toBeNull();
  });

  it("seals a sign-in's return to a public room's page while the var names it, and to the panel without it", async () => {
    const sealed = async (env: WorkerEnv) => {
      const chooser = await worker.fetch(new Request(`${ISSUER}/auth/signin?return_to=${encodeURIComponent("https://bellman.sh/r/open-review")}`), env, ctx);
      const state = decodeURIComponent(/href="\/authorize\/github\?req=([^"]+)"/.exec(await chooser.text())![1]).split(".")[1];
      return JSON.parse(atob(state.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(state.length / 4) * 4, "="))).bellman.return_to;
    };
    expect(await sealed(withPage(PAGE))).toBe("https://bellman.sh/r/open-review");
    expect(await sealed(withPanel(PANEL))).toBe(PANEL);
  });

  // The var is the public page's list and not a second panel list: the Worker hands it to the report route and the
  // sign-in return alone, so every other route's preflight still carries no grant for bellman.sh, and the panel's own is served.
  it("grants bellman.sh no preflight on any other route while the var names it, and still serves the panel", async () => {
    const withVar = withPage(PAGE);
    for (const path of [
      "/rooms/qs_any/bans", "/rooms/qs_any", "/account/handle", "/account/bans", "/presets", "/audit/org_any", "/operator/stats", "/operator/accounts", "/auth/session",
    ]) {
      expect(await grant(withVar, path, PAGE), `${path} from bellman.sh`).toBeNull();
      expect(await grant(withVar, path, PANEL), `${path} from the panel`).toBe(PANEL);
    }
    expect(await grant(withVar, "/rooms/qs_any/reports", PANEL)).toBe(PANEL);
  });
});
