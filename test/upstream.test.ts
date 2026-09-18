import { describe, expect, it } from "vitest";

import { UpstreamClient, UpstreamError } from "../src/upstream";

const KEY = "fake-test-key-do-not-leak";
const URL = "https://crispy.test/api/mcp";

interface Call {
  url: string;
  init: RequestInit;
}

function recordingFetch(responses: Response[] | Response) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Call[] = [];

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0];
    return next;
  };

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const TOOL_CALL = {
  jsonrpc: "2.0",
  id: 7,
  method: "tools/call",
  params: { name: "linkedin_search_people", arguments: { query: "cto" } },
};

describe("UpstreamClient.send", () => {
  it("forwards the request to the configured url with the bearer token", async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse({ jsonrpc: "2.0", id: 7, result: { content: [] } }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    await client.send(TOOL_CALL);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(URL);
    expect(calls[0].init.method).toBe("POST");
    const headers = new Headers(calls[0].init.headers as HeadersInit);
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("forwards the request body unchanged", async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse({ jsonrpc: "2.0", id: 7, result: { content: [] } }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    await client.send(TOOL_CALL);

    expect(JSON.parse(calls[0].init.body as string)).toEqual(TOOL_CALL);
  });

  it("returns the upstream response body unchanged", async () => {
    const upstreamBody = {
      jsonrpc: "2.0",
      id: 7,
      result: {
        content: [{ type: "text", text: "3 leads found" }],
        isError: false,
        _meta: { crispyRequestId: "req_123", nested: { deep: [1, 2, 3] } },
      },
    };
    const { fetchImpl } = recordingFetch(jsonResponse(upstreamBody));
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const response = await client.send(TOOL_CALL);

    expect(response).toEqual(upstreamBody);
  });

  it("parses a text/event-stream response", async () => {
    const body = { jsonrpc: "2.0", id: 7, result: { content: [] } };
    const sse = new Response(
      `event: message\ndata: ${JSON.stringify(body)}\n\n`,
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
    const { fetchImpl } = recordingFetch(sse);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    expect(await client.send(TOOL_CALL)).toEqual(body);
  });

  it("returns null when the upstream accepts a notification with no body", async () => {
    const { fetchImpl } = recordingFetch(new Response(null, { status: 202 }));
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const response = await client.send({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    expect(response).toBeNull();
  });

  it("turns a 401 into an actionable auth error", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(
        { error: "Missing API key. Include your key as: Authorization: Bearer ..." },
        { status: 401 },
      ),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = await client.send(TOOL_CALL).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UpstreamError);
    const upstreamError = error as UpstreamError;
    expect(upstreamError.kind).toBe("auth");
    expect(upstreamError.message).toContain("401");
    expect(upstreamError.message).toMatch(/missing or invalid/i);
    expect(upstreamError.message).toContain("CRISPY_API_KEY");
    expect(upstreamError.message).toContain(
      "https://crispy.sh/dashboard/api-keys",
    );
  });

  it("treats a 403 as an auth error too", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({ error: "forbidden" }, { status: 403 }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("auth");
  });

  it("reports other http failures with the status and body", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({ error: "upstream exploded" }, { status: 502 }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("http");
    expect(error.message).toContain("502");
    expect(error.message).toContain("upstream exploded");
  });

  it("surfaces a network failure instead of hanging", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe("network");
    expect(error.message).toContain(URL);
  });

  it("aborts the request after the configured timeout", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (async (
      _input: unknown,
      init?: RequestInit,
    ): Promise<Response> => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        seenSignal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      timeoutMs: 20,
    });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/timed out/i);
  });

  it("reuses the session id the upstream assigns on initialize", async () => {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-abc" } },
      ),
      jsonResponse({ jsonrpc: "2.0", id: 7, result: { content: [] } }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await client.send(TOOL_CALL);

    expect(new Headers(calls[0].init.headers as HeadersInit).get("mcp-session-id")).toBeNull();
    expect(
      new Headers(calls[1].init.headers as HeadersInit).get("mcp-session-id"),
    ).toBe("sess-abc");
  });

  it("sends the negotiated protocol version on requests after initialize", async () => {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18" },
      }),
      jsonResponse({ jsonrpc: "2.0", id: 7, result: { content: [] } }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await client.send(TOOL_CALL);

    expect(
      new Headers(calls[1].init.headers as HeadersInit).get(
        "mcp-protocol-version",
      ),
    ).toBe("2025-06-18");
  });

  it("never puts the api key in an error message, even if the upstream echoes it", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({ error: `key ${KEY} is revoked` }, { status: 500 }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.message).not.toContain(KEY);
  });
});
