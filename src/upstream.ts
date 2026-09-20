/**
 * Minimal Streamable HTTP client for the hosted Crispy MCP endpoint.
 *
 * It is deliberately dumb: whatever JSON-RPC message arrives from the local
 * stdio client is posted upstream untouched, and whatever the upstream returns
 * is handed back untouched. The bridge does not know or care which tools
 * Crispy exposes.
 */

import { API_KEYS_URL } from "./config.js";

export const DEFAULT_TIMEOUT_MS = 120_000;

/** Teardown happens on the way out, so it gets a far shorter leash. */
export const DEFAULT_TEARDOWN_TIMEOUT_MS = 5_000;

export type UpstreamErrorKind =
  | "auth"
  | "http"
  | "network"
  | "protocol"
  | "session"
  | "shutdown";

export class UpstreamError extends Error {
  readonly kind: UpstreamErrorKind;

  constructor(message: string, kind: UpstreamErrorKind) {
    super(message);
    this.name = "UpstreamError";
    this.kind = kind;
  }
}

export interface UpstreamOptions {
  url: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  teardownTimeoutMs?: number;
}

const MAX_BODY_SNIPPET = 500;

export class UpstreamClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly teardownTimeoutMs: number;

  private sessionId: string | undefined;
  private protocolVersion: string | undefined;

  /**
   * Bumped every time the session is invalidated or replaced. The bridge
   * dispatches messages concurrently, so several requests are normally in
   * flight at once: each one snapshots this counter on its way out, and a
   * response whose snapshot has since moved on belongs to a session that no
   * longer exists. It must not write anything back into this client -- neither
   * to resurrect a dead id nor to clear the live one that replaced it.
   */
  private sessionGeneration = 0;

  /** Set the moment teardown starts. From then on nothing is forwarded. */
  private stopped = false;

  constructor(options: UpstreamOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.teardownTimeoutMs =
      options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
  }

  /** Strips the api key out of anything on its way to a log or an error. */
  private redact(text: string): string {
    if (this.apiKey === "") {
      return text;
    }
    return text.split(this.apiKey).join("[redacted]");
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };

    if (this.sessionId !== undefined) {
      headers["mcp-session-id"] = this.sessionId;
    }
    if (this.protocolVersion !== undefined) {
      headers["mcp-protocol-version"] = this.protocolVersion;
    }

    return headers;
  }

  async send(message: unknown): Promise<unknown | null> {
    // Teardown drops the session id and then awaits the DELETE. The local
    // transport is still accepting messages while that is in flight, and a
    // buffered initialize forwarded here would open a new session that
    // nothing ever deletes. Fail closed instead.
    if (this.stopped) {
      throw new UpstreamError(
        "crispy-mcp is shutting down: the Crispy session is closed, so this request was not sent.",
        "shutdown",
      );
    }

    const sentSessionId = this.sessionId;
    // Advances only if this very request is the one that moves the session on.
    let generation = this.sessionGeneration;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
    }, this.timeoutMs);

    let response: Response;
    try {
      response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(message),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new UpstreamError(
          `Crispy did not respond within ${this.timeoutMs}ms: the request to ${this.url} timed out.`,
          "network",
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(
        `Could not reach Crispy at ${this.url}: ${this.redact(reason)}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (
      sessionId !== null &&
      sessionId !== "" &&
      generation === this.sessionGeneration
    ) {
      generation = this.adoptSession(sessionId);
    }

    if (!response.ok) {
      throw await this.httpError(response, sentSessionId, generation);
    }

    const body = await this.readBody(response);
    if (generation === this.sessionGeneration) {
      this.rememberProtocolVersion(body);
    }
    return body;
  }

  /**
   * Records the id the upstream assigned and returns the generation the caller
   * is now in. A *different* id means the previous session is finished, so
   * anything still in flight under it gets fenced off.
   */
  private adoptSession(sessionId: string): number {
    if (this.sessionId !== undefined && this.sessionId !== sessionId) {
      this.sessionGeneration += 1;
    }
    this.sessionId = sessionId;
    return this.sessionGeneration;
  }

  /** Drops the session and fences every request still in flight under it. */
  private invalidateSession(): void {
    this.sessionId = undefined;
    this.protocolVersion = undefined;
    this.sessionGeneration += 1;
  }

  /**
   * The MCP spec asks clients to echo the negotiated protocol version on every
   * HTTP request after initialize, so pick it out of the initialize result.
   */
  private rememberProtocolVersion(body: unknown): void {
    if (this.protocolVersion !== undefined || body === null) {
      return;
    }
    const result = (body as { result?: { protocolVersion?: unknown } }).result;
    if (result !== undefined && typeof result.protocolVersion === "string") {
      this.protocolVersion = result.protocolVersion;
    }
  }

  private async httpError(
    response: Response,
    sentSessionId: string | undefined,
    generation: number,
  ): Promise<UpstreamError> {
    const body = this.redact((await this.safeText(response)).trim());

    // The spec lets the server drop a session whenever it likes and answer
    // anything still carrying that id with a 404. Retrying is not ours to do:
    // only the client can re-run initialize, so drop the dead state and say so.
    if (response.status === 404 && sentSessionId !== undefined) {
      if (generation === this.sessionGeneration) {
        this.invalidateSession();
      }
      // A wrong CRISPY_MCP_URL, a bad deploy and a genuinely dropped session
      // all look like this. The advice is right for the common case, but the
      // status has to survive or a misrouted endpoint is undiagnosable.
      const status = `HTTP ${response.status} ${response.statusText}`.trim();
      return new UpstreamError(
        [
          `The Crispy session expired: ${status} -- the server no longer recognises this session id.`,
          "Reconnect your MCP client so it runs initialize again.",
          body === "" ? "" : `Upstream said: ${body}`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
        "session",
      );
    }

    if (response.status === 401 || response.status === 403) {
      return new UpstreamError(
        [
          `Crispy rejected the request with HTTP ${response.status}: your API key is missing or invalid.`,
          `Check the CRISPY_API_KEY environment variable or the --api-key flag, then create or copy a key at ${API_KEYS_URL}.`,
          body === "" ? "" : `Upstream said: ${body}`,
        ]
          .filter((line) => line !== "")
          .join("\n"),
        "auth",
      );
    }

    return new UpstreamError(
      `Crispy returned HTTP ${response.status} ${response.statusText}`.trim() +
        (body === "" ? "" : `: ${body}`),
      "http",
    );
  }

  /**
   * Tells Crispy the session is finished, per the Streamable HTTP spec's
   * DELETE. Best effort by design: shutdown must not be blocked by a server
   * that is slow, unreachable, or answers 405 because it has no teardown.
   */
  async endSession(): Promise<void> {
    this.stopped = true;

    const sessionId = this.sessionId;
    if (sessionId === undefined) {
      return;
    }

    const headers = this.headers();
    this.invalidateSession();

    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error("timeout"));
    }, this.teardownTimeoutMs);

    try {
      await this.fetchImpl(this.url, {
        method: "DELETE",
        headers,
        signal: controller.signal,
      });
    } catch {
      // Nothing to do and nobody to tell: the process is on its way out.
    } finally {
      clearTimeout(timer);
    }
  }

  private async safeText(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text.length > MAX_BODY_SNIPPET
        ? `${text.slice(0, MAX_BODY_SNIPPET)}...`
        : text;
    } catch {
      return "";
    }
  }

  private async readBody(response: Response): Promise<unknown | null> {
    if (response.status === 202 || response.status === 204) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();

    if (text.trim() === "") {
      return null;
    }

    if (contentType.includes("text/event-stream")) {
      const message = parseEventStream(text);
      if (message === null) {
        throw new UpstreamError(
          "Crispy returned an event stream with no JSON-RPC message in it.",
          "protocol",
        );
      }
      return message;
    }

    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new UpstreamError(
        `Crispy returned a response that is not JSON: ${this.redact(
          text.slice(0, MAX_BODY_SNIPPET),
        )}`,
        "protocol",
      );
    }
  }
}

/** Returns the first JSON-RPC payload carried by an SSE body. */
export function parseEventStream(text: string): unknown | null {
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .join("\n");

    if (data === "") {
      continue;
    }

    try {
      return JSON.parse(data) as unknown;
    } catch {
      continue;
    }
  }

  return null;
}
