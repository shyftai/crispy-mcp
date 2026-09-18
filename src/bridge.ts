/**
 * Wires a local MCP transport (stdio) to the hosted Crispy endpoint.
 *
 * Every message the local client sends is forwarded verbatim and every
 * upstream reply is returned verbatim. The bridge adds nothing to the
 * protocol; it only translates a transport failure into a JSON-RPC error so
 * the client gets an answer rather than silence.
 */

import { UpstreamError, type UpstreamClient } from "./upstream.js";

/** JSON-RPC implementation-defined server errors. */
export const AUTH_ERROR_CODE = -32001;
export const UPSTREAM_ERROR_CODE = -32000;

/** The part of the SDK transport interface the bridge needs. */
export interface BridgeTransport {
  onmessage?: (message: never) => void;
  send(message: never, options?: unknown): Promise<void>;
}

export interface BridgeOptions {
  transport: BridgeTransport;
  upstream: UpstreamClient;
  /** Receives human-readable diagnostics. Defaults to stderr. */
  log?: (line: string) => void;
}

function idOf(message: unknown): string | number | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function codeFor(error: unknown): number {
  return error instanceof UpstreamError && error.kind === "auth"
    ? AUTH_ERROR_CODE
    : UPSTREAM_ERROR_CODE;
}

export function attachBridge(options: BridgeOptions): void {
  const { transport, upstream } = options;
  const log =
    options.log ?? ((line: string) => process.stderr.write(`${line}\n`));

  const send = (message: unknown): Promise<void> =>
    transport.send(message as never);

  transport.onmessage = ((message: unknown) => {
    void (async () => {
      try {
        const response = await upstream.send(message);
        if (response !== null && response !== undefined) {
          await send(response);
        }
      } catch (error) {
        const detail =
          error instanceof Error ? error.message : String(error);
        const id = idOf(message);

        if (id === null) {
          log(`crispy-mcp: ${detail}`);
          return;
        }

        log(`crispy-mcp: ${detail}`);
        try {
          await send({
            jsonrpc: "2.0",
            id,
            error: { code: codeFor(error), message: detail },
          });
        } catch (sendError) {
          log(
            `crispy-mcp: could not write the error back to the client: ${
              sendError instanceof Error ? sendError.message : String(sendError)
            }`,
          );
        }
      }
    })();
  }) as (message: never) => void;
}
