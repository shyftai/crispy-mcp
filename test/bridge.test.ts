import { describe, expect, it } from "vitest";

import { attachBridge } from "../src/bridge";
import { UpstreamClient } from "../src/upstream";

const KEY = "fake-test-key-bridge-only";
const URL = "https://crispy.test/api/mcp";

/** Stands in for StdioServerTransport: records everything written back out. */
class FakeTransport {
  onmessage?: (message: unknown) => void;
  readonly sent: unknown[] = [];

  async send(message: unknown): Promise<void> {
    this.sent.push(message);
  }

  /** Simulates a message arriving from the local MCP client. */
  async receive(message: unknown): Promise<void> {
    await this.onmessage?.(message);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function setup(
  makeResponse: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: { url?: string } = {},
) {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(input), init: init ?? {} });
    return await makeResponse(String(input), init ?? {});
  }) as unknown as typeof fetch;

  const transport = new FakeTransport();
  const logs: string[] = [];
  attachBridge({
    transport,
    upstream: new UpstreamClient({
      url: options.url ?? URL,
      apiKey: KEY,
      fetchImpl,
    }),
    log: (line) => logs.push(line),
  });

  return { transport, logs, requests };
}

const TOOL_CALL = {
  jsonrpc: "2.0",
  id: 42,
  method: "tools/call",
  params: { name: "linkedin_send_message", arguments: { text: "hi" } },
};

describe("attachBridge", () => {
  it("forwards a tools/call with the Authorization header from the api key", async () => {
    const { transport, requests } = setup(() =>
      jsonResponse({ jsonrpc: "2.0", id: 42, result: { content: [] } }),
    );

    await transport.receive(TOOL_CALL);

    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe(URL);
    expect(
      new Headers(requests[0].init.headers as HeadersInit).get("authorization"),
    ).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(requests[0].init.body as string)).toEqual(TOOL_CALL);
  });

  it("returns the upstream response body to the stdio client unchanged", async () => {
    const upstreamBody = {
      jsonrpc: "2.0",
      id: 42,
      result: {
        content: [{ type: "text", text: "message sent" }],
        structuredContent: { messageId: "m_1", thread: { id: "t_9" } },
      },
    };
    const { transport } = setup(() => jsonResponse(upstreamBody));

    await transport.receive(TOOL_CALL);

    expect(transport.sent).toEqual([upstreamBody]);
  });

  it("honours the CRISPY_MCP_URL style endpoint override", async () => {
    const override = "http://127.0.0.1:8123/api/mcp";
    const { transport, requests } = setup(
      () => jsonResponse({ jsonrpc: "2.0", id: 42, result: {} }),
      { url: override },
    );

    await transport.receive(TOOL_CALL);

    expect(requests[0].url).toBe(override);
  });

  it("sends nothing back for a notification the upstream accepts", async () => {
    const { transport } = setup(() => new Response(null, { status: 202 }));

    await transport.receive({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(transport.sent).toEqual([]);
  });

  it("turns an upstream 401 into a clear, actionable JSON-RPC error", async () => {
    const { transport } = setup(() =>
      jsonResponse(
        {
          error:
            "Missing API key. Include your key as: Authorization: Bearer ...",
        },
        401,
      ),
    );

    await transport.receive(TOOL_CALL);

    expect(transport.sent).toHaveLength(1);
    const response = transport.sent[0] as {
      jsonrpc: string;
      id: number;
      error: { code: number; message: string };
    };
    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(42);
    expect(response.error.message).toContain("401");
    expect(response.error.message).toMatch(/missing or invalid/i);
    expect(response.error.message).toContain("CRISPY_API_KEY");
    expect(response.error.message).toContain("--api-key");
    expect(response.error.message).toContain(
      "https://crispy.sh/dashboard/api-keys",
    );
  });

  it("answers a network failure with an error instead of leaving the client hanging", async () => {
    const { transport } = setup(() => {
      throw new TypeError("fetch failed");
    });

    await transport.receive(TOOL_CALL);

    expect(transport.sent).toHaveLength(1);
    const response = transport.sent[0] as {
      id: number;
      error: { message: string };
    };
    expect(response.id).toBe(42);
    expect(response.error.message).toMatch(/could not reach crispy/i);
  });

  it("logs a failed notification instead of answering it", async () => {
    const { transport, logs } = setup(() =>
      jsonResponse({ error: "nope" }, 401),
    );

    await transport.receive({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
    });

    expect(transport.sent).toEqual([]);
    expect(logs.join("\n")).toMatch(/missing or invalid/i);
  });

  it("never writes the api key to a log line or an error message", async () => {
    const { transport, logs } = setup(() =>
      // A hostile or careless upstream that echoes the key straight back.
      jsonResponse({ error: `key ${KEY} rejected` }, 401),
    );

    await transport.receive(TOOL_CALL);
    await transport.receive({ jsonrpc: "2.0", method: "notifications/x" });

    const everythingWritten = JSON.stringify(transport.sent) + logs.join("\n");
    expect(everythingWritten).not.toContain(KEY);
    expect(everythingWritten.length).toBeGreaterThan(0);
  });
});
