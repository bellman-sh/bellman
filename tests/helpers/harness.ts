/**
 * In-process MCP harness: a real Client talking to a real McpServer over the
 * SDK's linked in-memory transport, with a store you control.
 *
 * This exercises the actual registered tools — schemas, coercion, annotations
 * and all — without binding a port. The HTTP layer gets its own integration
 * test; everything else runs here.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { resolveIdentity } from "../../src/auth.js";
import { buildServer } from "../../src/server.js";
import { MemoryStore, type BellmanStore } from "../../src/store.js";
import type { Identity } from "../../src/types.js";

export interface Outcome {
  isError: boolean;
  data: Record<string, unknown>;
  text: string;
}

export class Peer {
  constructor(
    readonly identity: Identity,
    private readonly client: Client,
  ) {}

  async call(name: string, args: Record<string, unknown> = {}): Promise<Outcome> {
    const res = await this.client.callTool({ name, arguments: args });
    const content = (res.content as { type: string; text?: string }[]) ?? [];
    return {
      isError: Boolean(res.isError),
      data: (res as { structuredContent?: Record<string, unknown> }).structuredContent ?? {},
      text: content.map((b) => b.text ?? "").join("\n"),
    };
  }

  async listTools() {
    return this.client.listTools();
  }

  serverCapabilities() {
    return this.client.getServerCapabilities();
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export const DEV_KEY = {
  jesse: "qk_dev_jesse",       // team plan, admin, org_codenerd
  peer: "qk_dev_peer",         // free plan, member, org_codenerd
  outsider: "qk_dev_outsider", // free plan, member, no org
} as const;

export class Harness {
  readonly store: BellmanStore;
  private readonly peers: Peer[] = [];

  constructor(store: BellmanStore = new MemoryStore()) {
    this.store = store;
  }

  /** Connect a new client bound to a dev bearer key. */
  async connect(key: string): Promise<Peer> {
    const identity = resolveIdentity(`Bearer ${key}`);
    if (!identity) throw new Error(`unknown dev key: ${key}`);
    return this.connectAs(identity);
  }

  /** Connect a client bound to an arbitrary identity (for plan-matrix tests). */
  async connectAs(identity: Identity): Promise<Peer> {
    const server = buildServer(identity, this.store);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: `test-${identity.userId}`, version: "0.0.1" });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);
    const peer = new Peer(identity, client);
    this.peers.push(peer);
    return peer;
  }

  async close(): Promise<void> {
    await Promise.all(this.peers.map((p) => p.close()));
  }
}

/** An envelope as it appears on the wire. */
export interface Envelope<T = unknown> {
  trust: string;
  origin: { memberId: string; label: string };
  data: T;
}

export function envelopes(value: unknown): Envelope[] {
  return (value ?? []) as Envelope[];
}
