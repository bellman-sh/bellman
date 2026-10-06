/**
 * What every AuthStorage implementation must agree on about the registration count (#122).
 *
 * AuthStorage has had no conformance suite the way BellmanStore has, and the header of
 * worker-tests/auth-session.test.ts says why that matters: two hand-written
 * implementations of one interface are where behaviour drifts. Its session methods are
 * held by twin tests, one in each program. This is the first case written once and run
 * against both, MemoryAuthStore under the root program (tests/auth-store.test.ts) and
 * AuthStore over a real AuthDO under workerd (worker-tests/auth-client-count.test.ts).
 *
 * It covers the count and nothing else, and the session twins stay where they are. It
 * exists because the two disagreed and nothing could say so. MemoryAuthStore counts its
 * map, which cannot be off by one. The object keeps a counter it seeds from its keys the
 * first time it is asked, and it stored 2 for the first client registered on a fresh one,
 * so the registration cap closed a client early for good.
 */
import { describe, it, expect } from "vitest";
import type { AuthStorage, RegisteredClient } from "../../src/oauth/storage.js";

const NOW = 1_700_000_000_000;
const IP = "203.0.113.7";

/** Permanent unless told otherwise, so nothing here lapses by accident. */
const client = (id: string, over: Partial<RegisteredClient> = {}): RegisteredClient => ({
  client_id: id,
  client_name: "Test",
  redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
  created_at: NOW,
  expires_at: null,
  ...over,
});

export function describeAuthStoreContract(name: string, makeStore: () => AuthStorage): void {
  describe(`AuthStorage contract: ${name}`, () => {
    describe("the client count", () => {
      /** The report, as measured: one client on a fresh object read back as 2. */
      it("counts one client after one registration on a fresh store", async () => {
        const store = makeStore();

        await store.registerClient(client("c_one"));

        expect(await store.countClients()).toBe(1);
      });

      /** The report's third probe: the extra one stays, so two clients read as 3. */
      it("counts two clients after two registrations", async () => {
        const store = makeStore();

        await store.registerClient(client("c_one"));
        await store.registerClient(client("c_two"));

        expect(await store.countClients()).toBe(2);
      });

      /**
       * The report's control. Asking for the count before the first registration seeds
       * it from no keys, and the count is then right, which is what isolates the order
       * of the write and the seed as the cause.
       */
      it("counts the same when the count was asked for before the first registration", async () => {
        const store = makeStore();
        expect(await store.countClients(), "control: a fresh store holds none").toBe(0);

        await store.registerClient(client("c_one"));

        expect(await store.countClients()).toBe(1);
      });

      /** A registration that replaces a stored one is not a second client. */
      it("counts a client registered twice once", async () => {
        const store = makeStore();

        await store.registerClient(client("c_one"));
        await store.registerClient(client("c_one", { client_name: "Renamed" }));

        expect(await store.countClients()).toBe(1);
      });

      /** The production path: admitRegistration checks the cap, then registers. */
      it("counts a client admitted through admitRegistration once", async () => {
        const store = makeStore();

        expect(await store.admitRegistration(client("c_one"), IP, NOW)).toBe("ok");
        expect(await store.countClients()).toBe(1);
        expect(await store.admitRegistration(client("c_two"), IP, NOW)).toBe("ok");
        expect(await store.countClients()).toBe(2);
      });

      /**
       * A purge takes the lapsed ones out and the count follows. Registered first, so
       * what it is checked against is the count the registrations left, which the
       * first case above is about.
       */
      it("counts what is left after a purge reclaims the lapsed", async () => {
        const store = makeStore();
        await store.registerClient(client("c_kept"));
        await store.registerClient(client("c_lapsed_a", { expires_at: NOW + 1 }));
        await store.registerClient(client("c_lapsed_b", { expires_at: NOW + 2 }));

        expect(await store.purgeStale(NOW + 1_000)).toMatchObject({ clients: 2 });

        expect(await store.countClients()).toBe(1);
      });
    });
  });
}
