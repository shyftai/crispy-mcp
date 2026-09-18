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

export type UpstreamErrorKind = "auth" | "http" | "network" | "protocol";

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
}

const MAX_BODY_SNIPPET = 500;

export class UpstreamClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  private sessionId: string | undefined;
  private protocolVersion: string | undefined;

  constructor(options: UpstreamOptions) {
    this.url = options.url;
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
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
    if (sessionId !== null && sessionId !== "") {
      this.sessionId = sessionId;
    }

    if (!response.ok) {
      throw await this.httpError(response);
    }

    const body = await this.readBody(response);
    this.rememberProtocolVersion(body);
    return body;
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

  private async httpError(response: Response): Promise<UpstreamError> {
    const body = this.redact((await this.safeText(response)).trim());

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
