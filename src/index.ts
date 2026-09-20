#!/usr/bin/env node
/**
 * crispy-mcp: a local stdio MCP server that proxies every request to the
 * hosted Crispy endpoint at https://crispy.sh/api/mcp.
 *
 * For MCP clients that cannot send a custom Authorization header. Clients that
 * can should point straight at the remote endpoint instead.
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { attachBridge } from "./bridge.js";
import { ConfigError, resolveConfig } from "./config.js";
import { createShutdown } from "./shutdown.js";
import { UpstreamClient } from "./upstream.js";

/** Upper bound on the whole shutdown handshake, timer included. */
const SHUTDOWN_TIMEOUT_MS = 5_000;

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  let config;
  try {
    config = resolveConfig(process.argv.slice(2), process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(error.message);
    }
    throw error;
  }

  const upstream = new UpstreamClient({
    url: config.url,
    apiKey: config.apiKey,
  });
  const transport = new StdioServerTransport();

  transport.onerror = (error: Error) => {
    process.stderr.write(`crispy-mcp: ${error.message}\n`);
  };

  attachBridge({ transport, upstream });

  await transport.start();

  // The spec asks a client that is done with a session to say so, but a stuck
  // endpoint must never be the reason this process fails to exit.
  const shutdown = createShutdown({
    endSession: () => upstream.endSession(),
    close: () => transport.close(),
    exit: () => process.exit(0),
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown();
    });
  }
}

main().catch((error: unknown) => {
  fail(`crispy-mcp: ${error instanceof Error ? error.message : String(error)}`);
});
