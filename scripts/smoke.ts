/**
 * Bellman end-to-end smoke test.
 * Simulates a Claude Code session (jesse, team admin) pairing with a
 * ChatGPT session (peer, free plan) — the cross-provider case — plus the
 * failure paths: org-restricted join, plan gating, capability gating.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Defaults to the local Node server; point BELLMAN_URL at a wrangler dev
// instance or the deployed Worker to run the same proof against those.
const URL_ = new URL(process.env.BELLMAN_URL ?? "http://localhost:3900/mcp");

function makeClient(key: string): Client {
  return new Client({ name: `smoke-${key}`, version: "0.0.1" });
}

async function connect(key: string): Promise<Client> {
  const client = makeClient(key);
  const transport = new StreamableHTTPClientTransport(URL_, {
    requestInit: { headers: { Authorization: `Bearer ${key}` } },
  });
  await client.connect(transport);
  return client;
}

interface CallOutcome { isError: boolean; data: Record<string, unknown>; text: string }

async function call(c: Client, name: string, args: Record<string, unknown>): Promise<CallOutcome> {
  const res = await c.callTool({ name, arguments: args });
  const content = (res.content as { type: string; text?: string }[]) ?? [];
  const text = content.map((b) => b.text ?? "").join("\n");
  const sc = (res as { structuredContent?: Record<string, unknown> }).structuredContent;
  return { isError: Boolean(res.isError), data: sc ?? {}, text };
}

function assert(cond: boolean, label: string): void {
  console.log(`${cond ? "✅" : "❌"} ${label}`);
  if (!cond) process.exitCode = 1;
}

const jesseBrief = {
  goal: "Debug flaky invoice reconciliation job in the entity service",
  state: "Job fails ~5% of runs; suspect a race in the Stripe webhook handler",
  constraints: ["Rails 7.1", "no schema changes this sprint"],
  open_questions: ["Has anyone seen idempotency-key collisions under retry storms?"],
  agent: { provider: "anthropic", model: "claude-fable-5", client: "claude-code" },
};

const peerBrief = {
  goal: "Pair on the reconciliation bug from the consumer side",
  state: "Fresh session, has access to the payments dashboard",
  constraints: [],
  open_questions: [],
  agent: { provider: "openai", model: "gpt-5", client: "chatgpt" },
};

async function main(): Promise<void> {
  const jesse = await connect("qk_dev_jesse");
  const peer = await connect("qk_dev_peer");
  const outsider = await connect("qk_dev_outsider");

  console.log("\n— tool discovery —");
  const tools = await jesse.listTools();
  assert(tools.tools.length === 8, `8 tools registered (${tools.tools.map((t) => t.name).join(", ")})`);

  console.log("\n— session creation + entitlements —");
  const started = await call(jesse, "bellman_start", {
    manifest: { room: "smoke", preset: "pair" }, brief: jesseBrief, org_only: true,
    capabilities: ["read_context", "receive_messages", "request_actions"],
  });
  assert(!started.isError, "team admin starts org-only pair session");
  const joinCode = String(started.data.join_code);
  const jSession = String(started.data.session_id);
  const jMember = String(started.data.member_id);
  console.log(`   join code: ${joinCode}`);

  const gated = await call(peer, "bellman_start", { manifest: { room: "smoke", preset: "swarm" }, brief: peerBrief });
  assert(gated.isError && gated.text.includes("pro or team"), "free plan blocked from swarm (create-side gating)");

  console.log("\n— join flow: preview → confirm —");
  const blocked = await call(outsider, "bellman_connect", { join_code: joinCode });
  assert(blocked.isError && blocked.text.includes("org-restricted"), "outsider blocked by org_only");

  const preview = await call(peer, "bellman_connect", { join_code: joinCode });
  assert(!preview.isError, "peer previews session (free plan CAN join — the asymmetry)");
  assert(preview.text.includes("UNTRUSTED"), "preview wraps creator brief in untrusted envelope");
  const previewBrief = preview.data.creator_brief as { data: { goal: string } };
  assert(previewBrief.data.goal === jesseBrief.goal, "preview shows creator goal before peer ships anything");

  const confirmed = await call(peer, "bellman_confirm", {
    connect_token: String(preview.data.connect_token),
    brief: peerBrief,
    capabilities: ["read_context", "receive_messages", "request_actions"],
  });
  assert(!confirmed.isError, "peer confirms with own brief");
  const pMember = String(confirmed.data.member_id);
  let pCursor = Number(confirmed.data.cursor);

  const reused = await call(outsider, "bellman_connect", { join_code: joinCode });
  assert(reused.isError, "join code consumed once pair fills (single-use)");

  console.log("\n— brief exchange visible to creator —");
  const jSync1 = await call(jesse, "bellman_sync", {
    session_id: jSession, member_id: jMember, since_cursor: 0,
  });
  let jCursor = Number(jSync1.data.cursor);
  const joinEvents = (jSync1.data.events as { data: { type: string } }[]);
  assert(joinEvents.some((e) => e.data.type === "member_joined"), "creator sees member_joined with peer brief");

  console.log("\n— long-poll message delivery —");
  const syncPromise = call(jesse, "bellman_sync", {
    session_id: jSession, member_id: jMember, since_cursor: jCursor, wait_seconds: 10,
  });
  await new Promise((r) => setTimeout(r, 1200)); // prove the request is held open
  const t0 = Date.now();
  await call(peer, "bellman_send", {
    session_id: jSession, member_id: pMember, type: "message",
    payload: { text: "Dashboard shows retry storms cluster at 02:00 UTC — matches your 5%" },
  });
  const jSync2 = await syncPromise;
  const heldMs = Date.now() - t0;
  const msgs = (jSync2.data.events as { data: { type: string } }[]);
  assert(msgs.some((e) => e.data.type === "message"), `long-poll resolved on send (+${heldMs}ms after send, not 10s timeout)`);
  jCursor = Number(jSync2.data.cursor);

  // --------------------------------------------------------------- /ws (#99)
  // Only a Workers deployment serves /ws; the Node server has no such route.
  // /healthz says which of the two BELLMAN_URL points at.
  const runtime = await fetch(new URL("/healthz", URL_))
    .then((r) => r.json() as Promise<{ runtime?: string }>)
    .then((h) => h.runtime, () => undefined);
  if (runtime !== "workers") {
    console.log("\n— /ws delivery across eviction — skipped: needs Durable Objects (wrangler dev or a deployment)");
  } else {
    console.log("\n— /ws delivery across eviction —");
    const wsBase = new URL(URL_.toString());
    wsBase.protocol = wsBase.protocol === "https:" ? "wss:" : "ws:";
    wsBase.pathname = "/ws";

    // `headers` is an undici extension to the WebSocket constructor, not part
    // of the standard type, so the options are cast at the call.
    const openSocket = (key: string, session: string, cursor: number): WebSocket =>
      new WebSocket(`${wsBase}?session=${session}&cursor=${cursor}`, {
        headers: { authorization: `Bearer ${key}` },
      } as never);

    const opens = (sock: WebSocket): Promise<boolean> =>
      new Promise((resolve) => {
        sock.addEventListener("open", () => resolve(true), { once: true });
        sock.addEventListener("error", () => resolve(false), { once: true });
      });

    const nextFrame = (sock: WebSocket, ms: number): Promise<{ payload?: { text?: string } } | undefined> =>
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(undefined), ms);
        sock.addEventListener("message", (e) => {
          clearTimeout(t);
          resolve(JSON.parse(String((e as MessageEvent).data)));
        }, { once: true });
      });

    // A bad bearer is refused at the handshake; no socket opens.
    const bad = openSocket("qk_not_a_real_key", jSession, 0);
    const badOpened = await opens(bad);
    if (badOpened) bad.close();
    assert(!badOpened, "/ws refuses a bad bearer");

    // Opened at the cursor jesse has read to, so nothing is replayed.
    const ws = openSocket("qk_dev_jesse", jSession, jCursor);
    const opened = await opens(ws);
    assert(opened, "/ws upgrades a member");

    if (opened) {
      // Past the idle eviction, so the object that delivers below is a
      // different instance from the one that accepted this socket. The workerd
      // test (worker-tests/ws-delivery.test.ts) proves the mechanism; this
      // proves it against a real deployment.
      //
      // 30 s, not the ~10 s production evicts at. Under `wrangler dev` an idle
      // object was still the same instance after 15 s (its constructor ran
      // once, counted from the log) and a new one after 25 s and after 30 s, so
      // 15 s would pass here without any eviction having happened.
      await new Promise((r) => setTimeout(r, 30_000));

      const arriving = nextFrame(ws, 10_000);
      await call(peer, "bellman_send", {
        session_id: jSession, member_id: pMember, type: "message",
        payload: { text: "after eviction" },
      });
      const frame = await arriving;
      const delivered = frame?.payload?.text === "after eviction";
      assert(delivered, "/ws delivers after the object was evicted and revived");
      if (!delivered) console.log(`   got: ${frame ? JSON.stringify(frame) : "no frame within 10s"}`);
      ws.close();
    }
  }

  console.log("\n— action request / human-approval loop —");
  const actionReq = await call(jesse, "bellman_send", {
    session_id: jSession, member_id: jMember, type: "action_request",
    payload: { ask: "Pull the last 50 failed webhook deliveries and share the idempotency keys" },
  });
  assert(!actionReq.isError, "action_request allowed (peer granted request_actions)");
  const reqCursor = String(actionReq.data.cursor);

  const pSync = await call(peer, "bellman_sync", {
    session_id: jSession, member_id: pMember, since_cursor: pCursor,
  });
  pCursor = Number(pSync.data.cursor);
  assert((pSync.data.events as unknown[]).length > 0, "peer sees action_request via sync");

  const actionRes = await call(peer, "bellman_send", {
    session_id: jSession, member_id: pMember, type: "action_response",
    ref_id: reqCursor,
    payload: { approved: true, result: "Keys attached — 12 duplicates found" },
  });
  assert(!actionRes.isError, "action_response with ref_id accepted");

  console.log("\n— enterprise audit —");
  const auditDenied = await call(peer, "bellman_audit", {});
  assert(auditDenied.isError, "free member denied audit access");
  const auditOk = await call(jesse, "bellman_audit", { limit: 100 });
  const entries = (auditOk.data.entries as { action: string }[]);
  const actions = new Set(entries.map((e) => e.action));
  assert(!auditOk.isError && entries.length >= 6, `org admin reads audit log (${entries.length} entries)`);
  assert(
    ["session_created", "brief_exchanged", "sent_message", "sent_action_request"].every((a) => actions.has(a)),
    `audit captures the crossings: ${[...actions].join(", ")}`
  );

  console.log("\n— leave —");
  const left = await call(peer, "bellman_leave", { session_id: jSession, member_id: pMember });
  assert(!left.isError, "peer leaves cleanly");
  const jSync3 = await call(jesse, "bellman_sync", {
    session_id: jSession, member_id: jMember, since_cursor: jCursor,
  });
  assert(
    (jSync3.data.events as { data: { type: string } }[]).some((e) => e.data.type === "member_left"),
    "creator sees departure event"
  );

  await Promise.all([jesse.close(), peer.close(), outsider.close()]);
  console.log(process.exitCode ? "\nSMOKE FAILED" : "\nALL SMOKE CHECKS PASSED");
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
