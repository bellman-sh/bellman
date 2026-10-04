import type { Duplex } from "node:stream";

/**
 * Make a socket taken from an `'upgrade'` event survive its peer dying.
 *
 * **`http.Server` protects request sockets and NOT this one.** For an ordinary
 * request it installs its own error handler, and a reset becomes a `clientError`
 * the server answers 400 and destroys. When it emits `'upgrade'` it hands the
 * socket over and removes those listeners, so the socket is raw: an `'error'` on
 * it has nowhere to go, and Node raises it as an uncaught exception. Under vitest
 * that is a failed run with every assertion passing — "1 error", exit 1.
 *
 * Which is what CI was doing intermittently. A test server refuses the room
 * socket, the test then `SIGKILL`s the bridge in `afterEach`, and on Linux a
 * process killed with data still unread has its sockets RST by the kernel. The
 * read lands as `ECONNRESET` on the upgrade socket nobody is listening to. It
 * failed `main` and a PR branch within an hour of each other and reproduces on
 * neither macOS nor demand, because whether a poll is in flight at teardown is
 * timing and whether a close becomes a reset is the platform's.
 *
 * Swallowing is right here and would not be elsewhere. The peer is a process the
 * test killed on purpose; there is no outcome to report and nothing to retry. What
 * must not happen is the reverse — a deliberate teardown failing an unrelated
 * suite — so the handler is empty and says why rather than logging noise into
 * every run.
 */
export function ignoreResets<T extends Duplex>(socket: T): T {
  socket.on("error", () => {});
  return socket;
}
