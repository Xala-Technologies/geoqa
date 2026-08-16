/**
 * The real Temporal connector — the seam's outside edge, and the ONE place
 * `@temporalio/client` is imported.
 *
 * Its own file so `client.ts` stays fully covered. Every decision about a durable run lives
 * there and is tested against a fake connector; this file only translates the SDK's shape into
 * the structural interface, which is exactly the split `network/auth-probe.ts` and
 * `tenant/usage-probe.ts` already use. Covering it would mean opening a socket.
 *
 * A dynamic import inside the function rather than at the top level: the SDK is heavy and is
 * needed only when somebody actually asks for a durable run, so a static import would put it in
 * the graph of every `geoqa` invocation including `--help`.
 *
 * `worker.ts` is deliberately not imported for its constants — it has an unguarded top-level
 * `main()`, so importing it would start a real worker and block forever. That is why
 * `constants.ts` exists.
 */
import type { TemporalClientLike, TemporalConnector } from "./client.js";

export const nativeConnector: TemporalConnector = {
  async connect({ address, namespace }) {
    const { Client, Connection } = await import("@temporalio/client");
    const connection = await Connection.connect({ address });
    const client = new Client({ connection, namespace });
    return {
      client: client as unknown as TemporalClientLike,
      close: () => connection.close(),
    };
  },
};
