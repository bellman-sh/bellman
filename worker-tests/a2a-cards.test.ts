/**
 * The A2A v1.0 AgentCards (Task 10), through the Worker: a card per public room at
 * `/public/rooms/:id/agent-card.json` and Bellman's own at `/.well-known/agent-card.json`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import { z } from "zod";
import worker from "../src/worker.js";
import { ACCESS_TOKEN_TTL_SECONDS, canonicalResource, signJwt } from "../src/oauth/tokens.js";
import { DurableObjectStore } from "../src/store-do.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const SECRET = "test-signing-secret";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const oauthEnv = { ...env, BELLMAN_TOKEN_SECRET: SECRET } as unknown as Parameters<typeof worker.fetch>[1];
const store = () => new DurableObjectStore(env as never);
const call = (path: string, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`${ORIGIN}${path}`, { headers }), oauthEnv, ctx);
const card = async (path: string) => (await call(path)).json() as Promise<any>;

const NAMED = "qs_card_named";
const NAME = "card-room";
const PLAIN = "qs_card_plain";
const PURPOSE = "Review the v2 migration plan.";

const seed = async (id: string, over: Parameters<typeof session>[0] = {}, name?: string) => {
  await store().createSession(session({
    id, manifest: roomManifest({ public: true, room: "Migration review", purpose: PURPOSE }), members: [member()],
    ...(name ? { publicName: name } : {}), ...over,
  }));
  if (name) expect(await store().claimPublicName(name, { id, at: Date.now() }, null)).toBe(true);
};

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

/** The v1.0 AgentCard, from the spec's proto (`lf.a2a.v1`): only the fields it marks REQUIRED are required here. */
const nonEmpty = z.string().min(1);
const AgentCard = z.object({
  name: nonEmpty,
  description: nonEmpty,
  supportedInterfaces: z.array(z.object({
    url: nonEmpty, protocolBinding: nonEmpty, protocolVersion: nonEmpty, tenant: z.string().optional(),
  })).min(1),
  version: nonEmpty,
  capabilities: z.object({ streaming: z.boolean(), pushNotifications: z.boolean(), extendedAgentCard: z.boolean() }),
  securitySchemes: z.record(z.string(), z.object({
    httpAuthSecurityScheme: z.object({ scheme: nonEmpty }).optional(),
    oauth2SecurityScheme: z.object({
      flows: z.object({
        authorizationCode: z.object({
          authorizationUrl: nonEmpty, tokenUrl: nonEmpty, scopes: z.record(z.string(), z.string()), pkceRequired: z.boolean(),
        }),
      }),
      oauth2MetadataUrl: z.string(),
    }).optional(),
  })),
  securityRequirements: z.array(z.object({ schemes: z.record(z.string(), z.object({ list: z.array(z.string()) })) })),
  defaultInputModes: z.array(nonEmpty).min(1),
  defaultOutputModes: z.array(nonEmpty).min(1),
  skills: z.array(z.object({ id: nonEmpty, name: nonEmpty, description: nonEmpty, tags: z.array(z.string()).min(1) })).min(1),
});

describe("agent cards", () => {
  it("a public room's card has the tenant, the public-sentence description, one ask skill and both schemes", async () => {
    await seed(NAMED, {}, NAME);
    const res = await call(`/public/rooms/${NAME}/agent-card.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.json() as any;
    expect(body.name).toBe("Migration review");
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(body.description).toBe(`${PURPOSE} Questions sent here and the room's answers are public on the room's page.`);
    // Only the 1.0 interface: Task 12 adds the 0.3 one.
    expect(body.supportedInterfaces).toEqual([{ url: `${ORIGIN}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: NAME }]);
    expect(body.capabilities).toEqual({ streaming: true, pushNotifications: false, extendedAgentCard: false });
    expect(body.defaultInputModes).toEqual(["text/plain"]);
    expect(body.defaultOutputModes).toEqual(["text/plain"]);
    expect(body.skills).toEqual([{ id: "ask", name: "Ask the room", description: "The room's members discuss your question and answer as one.", tags: ["room"] }]);
    expect(Object.keys(body.securitySchemes).sort()).toEqual(["bearer", "oauth"]);
    expect(body.securitySchemes.bearer).toMatchObject({ httpAuthSecurityScheme: { scheme: "Bearer" } });
    expect(body.securitySchemes.oauth.oauth2SecurityScheme).toMatchObject({
      flows: { authorizationCode: {
        authorizationUrl: `${ORIGIN}/authorize`, tokenUrl: `${ORIGIN}/token`, scopes: { bellman: expect.any(String) }, pkceRequired: true,
      } },
      oauth2MetadataUrl: `${ORIGIN}/.well-known/oauth-authorization-server`,
    });
    expect(body.securityRequirements).toEqual([{ schemes: { bearer: { list: [] } } }, { schemes: { oauth: { list: ["bellman"] } } }]);
  });

  it("the oauth scheme tells a client to ask for the /a2a resource", async () => {
    await seed(NAMED, {}, NAME);
    const body = await card(`/public/rooms/${NAME}/agent-card.json`);
    expect(body.securitySchemes.oauth.oauth2SecurityScheme.description).toContain(`resource=${ORIGIN}/a2a`);
    const bellman = await card("/.well-known/agent-card.json");
    expect(bellman.securitySchemes.oauth.oauth2SecurityScheme.description).toContain(`resource=${ORIGIN}/a2a`);
  });

  it("the card's tenant is the public name, or the room id when it has none, and SendMessage takes either", async () => {
    await seed(NAMED, {}, NAME);
    await seed(PLAIN);
    const jwt = await signJwt(
      { iss: ORIGIN, sub: "u_alice", aud: canonicalResource(`${ORIGIN}/a2a`),
        bellman: { userId: "u_alice", orgId: null, plan: "free", role: "member", label: "u_alice@example.dev" }, plan_source: "default" },
      SECRET, ACCESS_TOKEN_TTL_SECONDS,
    );
    for (const [key, want] of [[NAME, NAME], [NAMED, NAME], [PLAIN, PLAIN]] as const) {
      const { supportedInterfaces: [face] } = await card(`/public/rooms/${key}/agent-card.json`);
      expect(face.tenant).toBe(want);
      const res = await worker.fetch(new Request(face.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${jwt}`, "a2a-version": "1.0" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "SendMessage",
          params: { tenant: face.tenant, message: { messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text: "Hello?" }] }, configuration: { returnImmediately: true } },
        }),
      }), oauthEnv, ctx);
      const rpc = await res.json() as any;
      expect(rpc.error, JSON.stringify(rpc)).toBeUndefined();
      expect(rpc.result.task.status.state).toBe("TASK_STATE_WORKING");
    }
  });

  it("a private room's card is 404", async () => {
    await seed("qs_card_private", { manifest: roomManifest({ public: false }) });
    await seed("qs_card_unpublished", { unpublishedAt: Date.now() }, "card-unpublished");
    await seed("qs_card_closed", { closed: true }, "card-closed");
    const keys = ["qs_card_private", "qs_card_unpublished", "card-unpublished", "qs_card_closed", "card-closed", "qs_card_nope", "no-such-room"];
    const answers = await Promise.all(keys.map(async (key) => {
      const res = await call(`/public/rooms/${key}/agent-card.json`);
      return JSON.stringify([res.status, await res.text(), [...res.headers].sort()]);
    }));
    expect(JSON.parse(answers[0])[0]).toBe(404);
    expect(new Set(answers).size, answers.join("\n")).toBe(1);
  });

  it('the card has no "host" or "seat" text', async () => {
    await seed(NAMED, {}, NAME);
    for (const path of [`/public/rooms/${NAME}/agent-card.json`, `/public/rooms/${NAMED}/agent-card.json`, "/.well-known/agent-card.json"]) {
      expect(await (await call(path)).text(), path).not.toMatch(/host|seat/i);
    }
  });

  it("ETag round-trips to 304", async () => {
    await seed(NAMED, {}, NAME);
    for (const path of [`/public/rooms/${NAME}/agent-card.json`, "/.well-known/agent-card.json"]) {
      const first = await call(path);
      const etag = first.headers.get("etag")!;
      expect(etag, path).toMatch(/^"[0-9a-f]{64}"$/);
      const again = await call(path, { "if-none-match": etag });
      expect(again.status, path).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(again.headers.get("cache-control")).toBe("public, max-age=300");
      expect(await again.text()).toBe("");
      expect((await call(path, { "if-none-match": '"other"' })).status).toBe(200);
    }
    // A changed purpose is a changed tag.
    const before = (await call(`/public/rooms/${NAME}/agent-card.json`)).headers.get("etag");
    await reset();
    await seed(NAMED, { manifest: roomManifest({ public: true, room: "Migration review", purpose: "Something else." }) }, NAME);
    expect((await call(`/public/rooms/${NAME}/agent-card.json`)).headers.get("etag")).not.toBe(before);
  });

  it("/.well-known/agent-card.json has no tenant and points at bellman.sh/r/", async () => {
    const res = await call("/.well-known/agent-card.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const body = await res.json() as any;
    expect(body.name).toBe("Bellman");
    expect(body.supportedInterfaces).toEqual([{ url: `${ORIGIN}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    expect(body.skills).toEqual([{
      id: "ask", name: "Ask the room", tags: ["room"],
      description: "Name a public room in tenant to ask it. Public rooms are listed at https://bellman.sh/r/.",
    }]);
  });

  it("the card parses against the v1.0 AgentCard required fields", async () => {
    await seed(NAMED, {}, NAME);
    await seed(PLAIN);
    for (const path of [`/public/rooms/${NAME}/agent-card.json`, `/public/rooms/${PLAIN}/agent-card.json`, "/.well-known/agent-card.json"]) {
      const parsed = AgentCard.safeParse(await card(path));
      expect(parsed.success, `${path}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    }
    // The schema is not vacuous.
    expect(AgentCard.safeParse({}).success).toBe(false);
  });
});
