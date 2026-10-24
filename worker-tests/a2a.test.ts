/**
 * The `/a2a` JSON-RPC endpoint through the Worker (A2A, Task 7): the non-blocking methods over the real room objects.
 * Blocking `SendMessage` and the streaming methods are Task 8's.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { ACCESS_TOKEN_TTL_SECONDS, canonicalResource, signJwt } from "../src/oauth/tokens.js";
import { banAsker } from "../src/rooms.js";
import { DurableObjectStore } from "../src/store-do.js";
import type { Identity } from "../src/types.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const SECRET = "test-signing-secret";
const ROOM = "qs_a2a";
const NAME = "a2a-room";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
/** OAuth on, so an access token signs a caller in and a 401 carries the resource-metadata hint. */
const oauthEnv = { ...env, BELLMAN_TOKEN_SECRET: SECRET } as unknown as Parameters<typeof worker.fetch>[1];
const store = () => new DurableObjectStore(env as never);

const person = (userId: string): Identity => ({ userId, orgId: null, plan: "free", role: "member", label: `${userId}@example.dev` });
const tokenFor = (userId: string) => signJwt(
  { iss: ORIGIN, sub: userId, aud: canonicalResource(`${ORIGIN}/mcp`), bellman: person(userId), plan_source: "default" },
  SECRET, ACCESS_TOKEN_TTL_SECONDS,
);

type Rpc = { jsonrpc: "2.0"; id: unknown; result?: any; error?: { code: number; message: string; data?: any } };
const post = async (body: unknown, as: string | null, headers: Record<string, string> = { "a2a-version": "1.0" }) => worker.fetch(
  new Request(`${ORIGIN}/a2a`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${await tokenFor(as)}` } : {}), ...headers },
    body: JSON.stringify(body),
  }),
  oauthEnv, ctx,
);
const rpc = async (as: string | null, method: string, params: unknown, headers?: Record<string, string>) =>
  post({ jsonrpc: "2.0", id: 1, method, params }, as, headers);
const json = async (res: Response) => (await res.json()) as Rpc;

const message = (text = "What does this room review?") => ({ messageId: crypto.randomUUID(), role: "ROLE_USER", parts: [{ text }] });
const ask = (tenant: string | undefined, text?: string) =>
  ({ ...(tenant === undefined ? {} : { tenant }), message: message(text), configuration: { returnImmediately: true } });
const send = async (as: string, tenant = NAME, text?: string) => json(await rpc(as, "SendMessage", ask(tenant, text)));
const taskOf = async (as: string, tenant = NAME, text?: string) => {
  const res = await send(as, tenant, text);
  if (!res.result?.task) throw new Error(JSON.stringify(res));
  return res.result.task as { id: string; contextId: string };
};
const questionsIn = async (id: string) => (await store().eventsAfter(id, 0)).filter((e) => e.type === "outside_question");

const seed = async (id: string, over: Parameters<typeof session>[0] = {}, name?: string) => {
  await store().createSession(session({
    id, manifest: roomManifest({ public: true }), members: [member()], ...(name ? { publicName: name } : {}), ...over,
  }));
  if (name) expect(await store().claimPublicName(name, { id, at: Date.now() }, null)).toBe(true);
};
const seedPublic = () => seed(ROOM, {}, NAME);

afterEach(async () => {
  await reset();
  await abortAllDurableObjects();
});

describe("/a2a", () => {
  it("unauthenticated SendMessage is 401 with a resource_metadata hint", async () => {
    await seedPublic();
    const res = await rpc(null, "SendMessage", ask(NAME));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource"`);
    expect(await questionsIn(ROOM)).toEqual([]);
  });

  it("SendMessage with returnImmediately returns a WORKING task with id and contextId", async () => {
    await seedPublic();
    const res = await json(await rpc("u_alice", "SendMessage", ask(NAME, "Is the review open?")));
    expect(res.error).toBeUndefined();
    const task = res.result.task;
    expect(task).toMatchObject({ id: expect.any(String), contextId: expect.any(String), status: { state: "TASK_STATE_WORKING" } });
    expect(task.history).toMatchObject([{ role: "ROLE_USER", parts: [{ text: "Is the review open?" }] }]);
    // The room by its id answers as by its name; no A2A-Version header is read as 1.0.
    const byId = await json(await rpc("u_alice", "GetTask", { tenant: ROOM, id: task.id }, {}));
    expect(byId.result).toMatchObject({ id: task.id, contextId: task.contextId });
  });

  it("GetTask returns the caller's task; another account's GetTask is taskNotFound", async () => {
    await seedPublic();
    const task = await taskOf("u_alice");
    const mine = await json(await rpc("u_alice", "GetTask", { tenant: NAME, id: task.id }));
    expect(mine.result).toMatchObject({ id: task.id, contextId: task.contextId, status: { state: "TASK_STATE_WORKING" } });
    expect((await json(await rpc("u_alice", "GetTask", { tenant: NAME, id: task.id, historyLength: 0 }))).result.history).toBeUndefined();

    const theirs = await (await rpc("u_bob", "GetTask", { tenant: NAME, id: task.id })).text();
    const none = await (await rpc("u_bob", "GetTask", { tenant: NAME, id: crypto.randomUUID() })).text();
    expect(JSON.parse(theirs).error.code).toBe(-32001);
    expect(theirs).toBe(none);
  });

  it("ListTasks lists only the caller's tasks in that tenant", async () => {
    await seedPublic();
    await seed("qs_a2a_other", {}, "other-room");
    const first = await taskOf("u_alice");
    const second = await taskOf("u_alice");
    await taskOf("u_alice", "other-room");
    await taskOf("u_bob");

    const listed = (await json(await rpc("u_alice", "ListTasks", { tenant: NAME }))).result;
    expect(listed.tasks.map((t: { id: string }) => t.id).sort()).toEqual([first.id, second.id].sort());
    expect(listed).toMatchObject({ nextPageToken: "", totalSize: 2 });
  });

  it("CancelTask cancels", async () => {
    await seedPublic();
    const task = await taskOf("u_alice");
    // Another account's cancel reads as a task that does not exist, and leaves the task as it was.
    const theirs = await (await rpc("u_bob", "CancelTask", { tenant: NAME, id: task.id })).text();
    expect(theirs).toBe(await (await rpc("u_bob", "CancelTask", { tenant: NAME, id: crypto.randomUUID() })).text());

    const canceled = await json(await rpc("u_alice", "CancelTask", { tenant: NAME, id: task.id }));
    expect(canceled.result).toMatchObject({
      id: task.id,
      status: { state: "TASK_STATE_CANCELED", message: { role: "ROLE_AGENT", parts: [{ text: "The asker canceled this question." }] } },
    });
    expect((await json(await rpc("u_alice", "CancelTask", { tenant: NAME, id: task.id }))).error?.code).toBe(-32002);
  });

  it("private, unpublished, closed and nonexistent tenants give byte-identical errors", async () => {
    await seed("qs_private", { manifest: roomManifest({ public: false }) });
    await seed("qs_unpublished", { unpublishedAt: Date.now() }, "gone-private");
    await seed("qs_closed", { closed: true }, "closed-room");
    const tenants = ["qs_private", "qs_unpublished", "gone-private", "qs_closed", "closed-room", "qs_nope", "no-such-room", "../x\u0000!!"];
    const id = crypto.randomUUID();
    for (const [method, params] of [
      ["SendMessage", (tenant: string) => ask(tenant)],
      ["GetTask", (tenant: string) => ({ tenant, id })],
      ["ListTasks", (tenant: string) => ({ tenant })],
      ["CancelTask", (tenant: string) => ({ tenant, id })],
    ] as const) {
      const answers = await Promise.all(tenants.map(async (tenant) => {
        const res = await rpc("u_alice", method, params(tenant));
        return `${res.status} ${await res.text()}`;
      }));
      expect(new Set(answers).size, `${method}: ${answers.join("\n")}`).toBe(1);
      expect(JSON.parse(answers[0].slice(4)).error).toEqual({
        code: -32602, message: "No public room answers to that tenant. Public rooms are listed at https://bellman.sh/r/.",
      });
    }
    for (const room of ["qs_private", "qs_unpublished", "qs_closed"]) expect(await questionsIn(room)).toEqual([]);
  });

  it("a SendMessage with malformed params is invalid params and stores nothing", async () => {
    await seedPublic();
    for (const configuration of [{ historyLength: -1 }, "fast"]) {
      const res = await json(await rpc("u_alice", "SendMessage", { tenant: NAME, message: message(), configuration }));
      expect(res.error?.code).toBe(-32602);
    }
    expect(await questionsIn(ROOM)).toEqual([]);
    expect(await store().outsideTasksOf(ROOM, "u_alice")).toEqual([]);
  });

  it("a message with only a file part is contentTypeNotSupported and stores nothing", async () => {
    await seedPublic();
    const file = { url: "https://example.test/diagram.png", mediaType: "image/png", filename: "diagram.png" };
    const res = await json(await rpc("u_alice", "SendMessage", {
      tenant: NAME, message: { messageId: "m1", role: "ROLE_USER", parts: [file] }, configuration: { returnImmediately: true },
    }));
    expect(res.error?.code).toBe(-32005);
    expect(await questionsIn(ROOM)).toEqual([]);
    expect(await store().outsideTasksOf(ROOM, "u_alice")).toEqual([]);

    // A text part beside it is kept, and the file is dropped.
    const mixed = await json(await rpc("u_alice", "SendMessage", {
      tenant: NAME, message: { messageId: "m2", role: "ROLE_USER", parts: [file, { text: "See the diagram." }] },
      configuration: { returnImmediately: true },
    }));
    expect(mixed.result.task.status.state).toBe("TASK_STATE_WORKING");
    expect((await questionsIn(ROOM)).map((e) => (e.payload as { text: string }).text)).toEqual(["See the diagram."]);
  });

  it("push-config methods and GetExtendedAgentCard return their not-supported errors", async () => {
    await seedPublic();
    for (const method of [
      "CreateTaskPushNotificationConfig", "GetTaskPushNotificationConfig",
      "ListTaskPushNotificationConfigs", "DeleteTaskPushNotificationConfig",
    ]) {
      expect((await json(await rpc("u_alice", method, { tenant: NAME }))).error?.code, method).toBe(-32003);
    }
    expect((await json(await rpc("u_alice", "GetExtendedAgentCard", {}))).error?.code).toBe(-32007);
  });

  it("streaming methods are unsupportedOperation until blocking and streaming land", async () => {
    await seedPublic();
    expect((await json(await rpc("u_alice", "SendStreamingMessage", ask(NAME)))).error?.code).toBe(-32004);
    expect((await json(await rpc("u_alice", "SubscribeToTask", { tenant: NAME, id: "t" }))).error?.code).toBe(-32004);
    expect(await questionsIn(ROOM)).toEqual([]);
  });

  it("no tenant returns a Message pointing at bellman.sh/r/", async () => {
    const res = await json(await rpc("u_alice", "SendMessage", ask(undefined)));
    expect(res.result.message).toMatchObject({
      messageId: expect.any(String),
      role: "ROLE_AGENT",
      parts: [{ text: "Name a public room in `tenant`. Public rooms are listed at https://bellman.sh/r/." }],
    });
  });

  // ADR 0033 ruling (a): an absent or empty A2A-Version is 0.3, for the compat handler (Task 12); until it lands, 1.0.
  it.skip("empty A2A-Version is versionNotSupported", async () => {
    await seedPublic();
    expect((await json(await rpc("u_alice", "SendMessage", ask(NAME), { "a2a-version": "" }))).error?.code).toBe(-32009);
  });

  it("an explicit unsupported A2A-Version is versionNotSupported", async () => {
    await seedPublic();
    expect((await json(await rpc("u_alice", "SendMessage", ask(NAME), { "a2a-version": "0.9" }))).error?.code).toBe(-32009);
    expect(await questionsIn(ROOM)).toEqual([]);
  });

  it("a banned caller and a suspended one get the exact refusal text, and store nothing", async () => {
    await seedPublic();
    await taskOf("u_alice");
    const [question] = await questionsIn(ROOM);
    expect(await banAsker(store(), person("u_jesse"), ROOM, question.cursor, "room")).toMatchObject({ ok: true });
    const banned = await json(await rpc("u_alice", "SendMessage", ask(NAME)));
    expect(banned.error).toMatchObject({ message: "You can't join this room.", data: [{ reason: "BANNED" }] });

    await store().suspend("u_carol", { note: "test", by: "u_operator", at: Date.now() });
    const suspended = await json(await rpc("u_carol", "GetTask", { tenant: NAME, id: "t" }));
    expect(suspended.error).toMatchObject({ message: "This account is suspended.", data: [{ reason: "SUSPENDED" }] });
    expect(await questionsIn(ROOM)).toHaveLength(1);
  });

  it("the seventh SendMessage in a minute carries retry_after", async () => {
    await seedPublic();
    const six = [];
    for (let i = 0; i < 6; i++) six.push(await send("u_alice"));
    expect(six.map((r) => r.error?.data?.[0]?.reason ?? "ok")).not.toContain("RATE_LIMITED");
    const seventh = await rpc("u_alice", "SendMessage", ask(NAME));
    const body = await json(seventh);
    expect(body.error?.data?.[0]).toMatchObject({ reason: "RATE_LIMITED", metadata: { retry_after: expect.stringMatching(/^[1-9]\d*$/) } });
    expect(seventh.headers.get("retry-after")).toBe(body.error?.data?.[0].metadata.retry_after);
  });
});
