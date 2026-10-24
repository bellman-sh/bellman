/**
 * A2A v0.3 at a room's own URL, `/a2a/<tenant>` (Task 12, ADR 0033): 0.3 has no `tenant`, so the path names the room.
 * The 0.3 method names, parts and enum strings are translated onto the v1.0 handlers and back, so every v1.0 rule
 * holds here too: the same not-found for any room that does not answer, text only, the asker's own tasks after the
 * room goes private, and `/a2a` as the OAuth resource.
 */
import { afterEach, describe, expect, it } from "vitest";
import { env, reset, abortAllDurableObjects } from "cloudflare:test";
import worker from "../src/worker.js";
import { answerQuestion } from "../src/outside.js";
import { ACCESS_TOKEN_TTL_SECONDS, canonicalResource, signJwt } from "../src/oauth/tokens.js";
import { DurableObjectStore } from "../src/store-do.js";
import type { Identity } from "../src/types.js";
import { member, roomManifest, session } from "../tests/helpers/fixtures.js";

const ORIGIN = "https://mcp.example.test";
const SECRET = "test-signing-secret";
const ROOM = "qs_a2a_v03";
const NAME = "v03-room";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
const oauthEnv = { ...env, BELLMAN_TOKEN_SECRET: SECRET } as unknown as Parameters<typeof worker.fetch>[1];
const store = () => new DurableObjectStore(env as never);

const person = (userId: string): Identity => ({ userId, orgId: null, plan: "free", role: "member", label: `${userId}@example.dev` });
const tokenFor = (userId: string, resource = "/a2a") => signJwt(
  { iss: ORIGIN, sub: userId, aud: canonicalResource(`${ORIGIN}${resource}`), bellman: person(userId), plan_source: "default" },
  SECRET, ACCESS_TOKEN_TTL_SECONDS,
);

type Rpc = { jsonrpc: "2.0"; id: unknown; result?: any; error?: { code: number; message: string; data?: any } };
/** A raw body to a path, as an A2A client sends it; `a2a-sdk` 0.3 sends no A2A-Version header. */
const postRaw = async (path: string, body: string, as: string | null, headers: Record<string, string> = {}) => worker.fetch(
  new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${await tokenFor(as)}` } : {}), ...headers },
    body,
  }),
  oauthEnv, ctx,
);
/** A 0.3 call at a room's 0.3 URL. */
const v03 = (as: string | null, method: string, params: unknown, tenant = NAME, headers?: Record<string, string>) =>
  postRaw(`/a2a/${tenant}`, JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), as, headers);
/** A v1.0 call at `/a2a`. */
const v10 = (as: string, method: string, params: unknown) =>
  postRaw("/a2a", JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), as, { "a2a-version": "1.0" });
const json = async (res: Response) => (await res.json()) as Rpc;

const message = (text = "What does this room review?") =>
  ({ kind: "message", messageId: crypto.randomUUID(), role: "user", parts: [{ kind: "text", text }] });
const ask = (text?: string) => ({ message: message(text), configuration: { blocking: false } });
const questionsIn = async (id: string) => (await store().eventsAfter(id, 0)).filter((e) => e.type === "outside_question");
const asked = async (id = ROOM) => {
  for (;;) {
    const [question] = await questionsIn(id);
    if (question) {
      await new Promise((r) => setTimeout(r, 100));
      return question;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
};
const answer = (refId: number, text: string, needsInput = false) =>
  answerQuestion(store(), ROOM, { memberId: "m_creator" }, { refId, text, needsInput });
const streamed = async (res: Response) => (await res.text()).split("\n\n")
  .filter((chunk) => chunk.startsWith("data: ")).map((chunk) => JSON.parse(chunk.slice(6)) as Rpc);

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

describe("/a2a/<tenant>, A2A v0.3", () => {
  it("a 0.3 message/send creates the same task as v1.0 SendMessage", async () => {
    await seedPublic();
    const sent = await json(await v03("u_alice", "message/send", ask("Is the review open?")));
    expect(sent.error).toBeUndefined();
    // The same task, read through v1.0, in v1.0's shape; 0.3 gave it back in 0.3's.
    const same = (await json(await v10("u_alice", "GetTask", { tenant: NAME, id: sent.result.id }))).result;
    expect(same.status.state).toBe("TASK_STATE_WORKING");
    const [said] = same.history;
    expect(sent.result).toEqual({
      kind: "task",
      id: same.id,
      contextId: same.contextId,
      status: { state: "working", timestamp: same.status.timestamp },
      history: [{
        kind: "message", messageId: said.messageId, contextId: same.contextId, taskId: same.id, role: "user",
        parts: [{ kind: "text", text: "Is the review open?" }],
      }],
    });
    expect((await questionsIn(ROOM)).map((e) => (e.payload as { text: string }).text)).toEqual(["Is the review open?"]);
    // The room by its id answers as by its name, and A2A-Version: 0.3 is read as no header is.
    const byId = await json(await v03("u_alice", "tasks/get", { id: same.id }, ROOM, { "a2a-version": "0.3" }));
    expect(byId.result).toMatchObject({ kind: "task", id: same.id, contextId: same.contextId });
  });

  it("a 0.3 tasks/get returns 0.3 enum strings", async () => {
    await seedPublic();
    const task = (await json(await v03("u_alice", "message/send", ask()))).result;
    const [question] = await questionsIn(ROOM);
    await answer(question.cursor, "Which review?", true);
    const waiting = (await json(await v03("u_alice", "tasks/get", { id: task.id }))).result;
    expect(waiting.status).toMatchObject({ state: "input-required", message: { kind: "message", role: "agent", parts: [{ kind: "text", text: "Which review?" }] } });
    expect(waiting.history.map((m: { role: string }) => m.role)).toEqual(["user", "agent"]);

    const canceled = (await json(await v03("u_alice", "tasks/cancel", { id: task.id }))).result;
    expect(canceled).toMatchObject({ kind: "task", id: task.id, status: { state: "canceled" } });
    expect(JSON.stringify(canceled)).not.toContain("TASK_STATE_");
    expect(JSON.stringify(canceled)).not.toContain("ROLE_");
  });

  it("replays the A2A 0.3 spec's message/send example, byte for byte, and gets a completed 0.3 task", async () => {
    // No client capture exists (ADR 0033 records none), so this is the 0.3 specification's own example request,
    // section 9.1 "Basic Execution": no A2A-Version header and no configuration, so it blocks for the answer.
    const SPEC_EXAMPLE = `{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "message/send",
  "params": {
    "message": {
      "role": "user",
      "parts": [
        {
          "kind": "text",
          "text": "tell me a joke"
        }
      ],
      "messageId": "9229e770-767c-417b-a0b0-f0741243c589"
    },
    "metadata": {}
  }
}`;
    await seedPublic();
    const pending = postRaw(`/a2a/${NAME}`, SPEC_EXAMPLE, "u_alice");
    const question = await asked();
    await answer(question.cursor, "Why did the chicken cross the road?");
    const res = await json(await pending);
    expect(res).toMatchObject({
      jsonrpc: "2.0", id: 1,
      result: {
        kind: "task", id: expect.any(String), contextId: expect.any(String),
        status: { state: "completed", message: { kind: "message", role: "agent", parts: [{ kind: "text", text: "Why did the chicken cross the road?" }] } },
        history: [
          { kind: "message", role: "user", parts: [{ kind: "text", text: "tell me a joke" }] },
          { kind: "message", role: "agent", parts: [{ kind: "text", text: "Why did the chicken cross the road?" }] },
        ],
      },
    });
  });

  it("a 0.3 message/stream emits the task then a final status-update", async () => {
    await seedPublic();
    const res = await v03("u_alice", "message/stream", { message: message() });
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const question = await asked();
    await answer(question.cursor, "Yes.");
    const events = await streamed(res);
    expect(events).toHaveLength(2);
    const task = events[0].result;
    expect(task).toMatchObject({ kind: "task", status: { state: "working" } });
    expect(events[1].result).toEqual({
      kind: "status-update", taskId: task.id, contextId: task.contextId, final: true,
      status: { state: "completed", timestamp: expect.any(String), message: expect.objectContaining({ kind: "message", role: "agent", parts: [{ kind: "text", text: "Yes." }] }) },
    });
    // Over now, so tasks/resubscribe is the spec's unsupported-operation error.
    expect((await json(await v03("u_alice", "tasks/resubscribe", { id: task.id }))).error?.code).toBe(-32004);
  });

  it("only 0.3 names are methods at a room's 0.3 URL, and only the bare /a2a speaks 1.0", async () => {
    await seedPublic();
    expect((await json(await v03("u_alice", "SendMessage", { message: message() }))).error?.code).toBe(-32601);
    expect((await json(await v03("u_alice", "message/send", ask(), NAME, { "a2a-version": "1.0" }))).error?.code).toBe(-32009);
    expect((await json(await v03("u_alice", "tasks/pushNotificationConfig/set", { taskId: "t" }))).error?.code).toBe(-32003);
    expect((await json(await v03("u_alice", "agent/getAuthenticatedExtendedCard", {}))).error?.code).toBe(-32007);
    expect(await questionsIn(ROOM)).toEqual([]);
  });

  it("private, unpublished, closed and nonexistent rooms at the 0.3 URL give byte-identical errors", async () => {
    await seed("qs_private", { manifest: roomManifest({ public: false }) });
    await seed("qs_unpublished", { unpublishedAt: Date.now() }, "gone-private");
    await seed("qs_closed", { closed: true }, "closed-room");
    const tenants = ["qs_private", "qs_unpublished", "gone-private", "qs_closed", "closed-room", "qs_nope", "no-such-room", "%ZZ", "..%2Fx%00"];
    const id = crypto.randomUUID();
    for (const [method, params] of [
      ["message/send", ask()], ["tasks/get", { id }], ["tasks/cancel", { id }], ["tasks/resubscribe", { id }],
    ] as const) {
      const answers = await Promise.all(tenants.map(async (tenant) => {
        const res = await v03("u_alice", method, params, tenant);
        return `${res.status} ${await res.text()}`;
      }));
      expect(new Set(answers).size, `${method}: ${answers.join("\n")}`).toBe(1);
      expect(JSON.parse(answers[0].slice(4)).error).toEqual({
        code: -32602, message: "No public room answers to that tenant. Public rooms are listed at https://bellman.sh/r/.",
      });
    }
    for (const room of ["qs_private", "qs_unpublished", "qs_closed"]) expect(await questionsIn(room)).toEqual([]);
  });

  it("a 0.3 message with only file and data parts is refused and stores nothing", async () => {
    await seedPublic();
    const parts = [
      { kind: "file", file: { uri: "https://example.test/diagram.png", mimeType: "image/png", name: "diagram.png" } },
      { kind: "data", data: { text: "not a text part" } },
      { kind: "file", text: "a file part is not text, whatever it carries" },
    ];
    const res = await json(await v03("u_alice", "message/send", {
      message: { kind: "message", messageId: "m1", role: "user", parts }, configuration: { blocking: false },
    }));
    expect(res.error?.code).toBe(-32005);
    expect(await questionsIn(ROOM)).toEqual([]);
    expect(await store().outsideTasksOf(ROOM, "u_alice")).toEqual([]);
  });

  it("the asker still reads their own 0.3 task after the room goes private; anyone else gets no room", async () => {
    await seedPublic();
    const task = (await json(await v03("u_alice", "message/send", ask()))).result;
    await store().unpublishSession(ROOM, Date.now());
    for (const tenant of [NAME, ROOM]) {
      expect((await json(await v03("u_alice", "tasks/get", { id: task.id }, tenant))).result.status).toMatchObject({
        state: "canceled", message: { role: "agent", parts: [{ kind: "text", text: "The room went private." }] },
      });
    }
    const none = await (await v03("u_bob", "tasks/get", { id: task.id }, "no-such-room")).text();
    expect(await (await v03("u_bob", "tasks/get", { id: task.id })).text()).toBe(none);
    expect((await json(await v03("u_alice", "message/send", ask()))).error?.code).toBe(-32602);
  });

  it("the 0.3 URL is the /a2a resource: no credential is a 401 with /a2a's hint, and an /mcp token is refused", async () => {
    await seedPublic();
    const hint = `Bearer resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/a2a"`;
    const anonymous = await v03(null, "message/send", ask());
    expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([401, hint]);
    const mcp = await v03(null, "message/send", ask(), NAME, { authorization: `Bearer ${await tokenFor("u_alice", "/mcp")}` });
    expect([mcp.status, mcp.headers.get("www-authenticate")]).toEqual([401, hint]);
    expect(await questionsIn(ROOM)).toEqual([]);
  });
});
