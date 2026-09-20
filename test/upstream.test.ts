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

/**
 * A fetch whose responses the test settles by hand. `calls` fills synchronously
 * as each send() is issued, so two sends are genuinely in flight at once and
 * the test chooses the order their responses land in.
 */
function gatedFetch() {
  const calls: Array<{
    url: string;
    init: RequestInit;
    resolve: (response: Response) => void;
  }> = [];

  const fetchImpl = ((input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((resolve) => {
      calls.push({ url: String(input), init: init ?? {}, resolve });
    })) as unknown as typeof fetch;

  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function sessionIdOf(init: RequestInit): string | null {
  return new Headers(init.headers as HeadersInit).get("mcp-session-id");
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

  it("clears the session and asks the client to reconnect when the upstream 404s a live session", async () => {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-dead" } },
      ),
      jsonResponse({ error: "session not found" }, { status: 404 }),
      jsonResponse({ jsonrpc: "2.0", id: 7, result: { content: [] } }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe("session");
    expect(error.message).toMatch(/session/i);
    expect(error.message).toMatch(/expired/i);
    expect(error.message).toMatch(/reconnect|initialize/i);

    // The dead id must not be sent again, nor the protocol version tied to it.
    await client.send(TOOL_CALL);
    const retried = new Headers(calls[2].init.headers as HeadersInit);
    expect(retried.get("mcp-session-id")).toBeNull();
    expect(retried.get("mcp-protocol-version")).toBeNull();
  });

  it("leaves a 404 with no session id as a generic http error", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse({ error: "no such endpoint" }, { status: 404 }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("http");
    expect(error.message).toContain("404");
    expect(error.message).toContain("no such endpoint");
  });

  // A replacement session is a new session. rememberProtocolVersion only
  // writes when the version is unset, so a version carried over from the old
  // one would be sent with every later request under the new id.
  it("negotiates the protocol version again when a new session replaces the old", async () => {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-a" } },
      ),
      jsonResponse(
        { jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-03-26" } },
        { headers: { "mcp-session-id": "sess-b" } },
      ),
      jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await client.send({ jsonrpc: "2.0", id: 2, method: "initialize" });
    await client.send(TOOL_CALL);

    const headers = new Headers(calls[2].init.headers as HeadersInit);
    expect(headers.get("mcp-session-id")).toBe("sess-b");
    expect(
      headers.get("mcp-protocol-version"),
      "sess-b must not inherit the version sess-a negotiated",
    ).toBe("2025-03-26");
  });

  // A session only exists if the server accepted the request that created it.
  it("does not install a session id carried by a 500", async () => {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse(
        { error: "boom" },
        { status: 500, headers: { "mcp-session-id": "sess-from-a-500" } },
      ),
      jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;
    expect(error.kind).toBe("http");

    await client.send(TOOL_CALL);
    expect(
      sessionIdOf(calls[1].init),
      "a rejected response must not leave a session behind",
    ).toBeNull();
  });

  it("does not install a session id carried by a 404", async () => {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse(
        { error: "no such endpoint" },
        { status: 404, headers: { "mcp-session-id": "sess-from-a-404" } },
      ),
      jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;
    expect(error.kind).toBe("http");

    await client.send(TOOL_CALL);
    expect(sessionIdOf(calls[1].init)).toBeNull();
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

  it("never puts the api key in an error message when it is in the status line", async () => {
    const { fetchImpl } = recordingFetch(
      new Response(null, { status: 500, statusText: `rejected ${KEY}` }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("http");
    expect(error.message).not.toContain(KEY);
    expect(error.message).toContain("[redacted]");
  });

  // CRISPY_MCP_URL is user-supplied and unrestricted. An endpoint that carries
  // the key in a query component turns every message that names the url into a
  // leak -- onto stderr and into the JSON-RPC error the client is handed.
  // String-matching the key is the wrong shape for a url: a credential can sit
  // in userinfo, or percent-encoded in the query, and match nothing. So the url
  // that reaches a message keeps its origin and path and loses the rest.
  describe("when the endpoint url itself carries the api key", () => {
    const LEAKY_URL = `https://crispy.test/api/mcp?api_key=${KEY}`;

    /** Fails the way an unreachable endpoint does, without touching a socket. */
    const refusingFetch = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;

    async function messageFor(url: string, apiKey: string): Promise<string> {
      const client = new UpstreamClient({
        url,
        apiKey,
        fetchImpl: refusingFetch,
      });
      const error = (await client
        .send(TOOL_CALL)
        .catch((e: unknown) => e)) as UpstreamError;
      expect(error).toBeInstanceOf(UpstreamError);
      return error.message;
    }

    // The literal key never appears in the url, so redact() matches nothing.
    it("strips a percent-encoded key that redaction cannot match", async () => {
      const awkwardKey = "sk live/+key";
      const encoded = encodeURIComponent(awkwardKey);
      expect(encoded).not.toContain(awkwardKey);

      const message = await messageFor(
        `https://crispy.test/api/mcp?api_key=${encoded}`,
        awkwardKey,
      );

      expect(message).not.toContain(encoded);
      expect(message).not.toContain(awkwardKey);
      expect(message).not.toContain("api_key");
      expect(message).toContain("https://crispy.test/api/mcp");
    });

    it("strips userinfo and the fragment as well as the query", async () => {
      const message = await messageFor(
        "https://someone:hunter2@crispy.test/api/mcp?token=abc#frag",
        KEY,
      );

      expect(message).not.toContain("hunter2");
      expect(message).not.toContain("someone");
      expect(message).not.toContain("token=abc");
      expect(message).not.toContain("frag");
      expect(message).toContain("https://crispy.test/api/mcp");
    });

    // Sanitising happens on the error path. It must not become the error.
    it("still reports the failure when the url will not parse", async () => {
      const message = await messageFor("not-a-url", KEY);

      expect(message).toMatch(/could not reach crispy/i);
      // Naming the setting is all the identification an unparseable url gets.
      expect(message).toContain("CRISPY_MCP_URL");
    });

    // The unparseable url is the one case sanitising cannot do anything with:
    // nothing was stripped out of it, so every credential it carries is still
    // in it. Falling back to redact() is no defence -- that is the string
    // match this whole describe block exists because it does not work. And the
    // case is reachable: config.ts only trims CRISPY_MCP_URL, so a url with no
    // scheme reaches the client, new URL() rejects it, and fetch() fails.
    it("never echoes a url that will not parse, key or no key", async () => {
      const awkwardKey = "sk live+key/with=specials";
      const encoded = encodeURIComponent(awkwardKey);
      const unparseable = `crispy.test/api/mcp?api_key=${encoded}`;

      expect(encoded).toBe("sk%20live%2Bkey%2Fwith%3Dspecials");
      expect(() => new globalThis.URL(unparseable)).toThrow();
      // What an operator reading stderr would get back out of the message.
      expect(decodeURIComponent(encoded)).toBe(awkwardKey);

      const message = await messageFor(unparseable, awkwardKey);

      expect(message).toMatch(/could not reach crispy/i);
      expect(message).not.toContain(awkwardKey);
      expect(message).not.toContain(encoded);
      expect(message).not.toContain("api_key");
      expect(message).not.toContain("crispy.test");
      expect(message).toContain("CRISPY_MCP_URL");
    });

    /**
     * Every test above injects a fetch, so the only url that can reach a
     * message is the one this client chose to interpolate -- and that one is
     * sanitised. The platform's own fetch does not play along: undici rejects
     * an unparseable url with "Failed to parse URL from <the raw url>", query
     * and all. That wording becomes the failure *reason*, and the reason is
     * interpolated too. So the url re-enters through a channel
     * endpointForMessage never sees, and redact() cannot catch it because a
     * percent-encoded key shares no substring with the key.
     *
     * No fetch is injected here on purpose: the defect lives in the wording
     * the platform picked, which no fake can reproduce honestly.
     */
    describe("through an error the platform worded for us", () => {
      async function realFetchMessage(
        url: string,
        apiKey: string,
      ): Promise<string> {
        const client = new UpstreamClient({ url, apiKey, timeoutMs: 10_000 });
        const error = (await client
          .send(TOOL_CALL)
          .catch((e: unknown) => e)) as UpstreamError;
        expect(error).toBeInstanceOf(UpstreamError);
        return error.message;
      }

      it("keeps a percent-encoded key out of a platform parse failure", async () => {
        const awkwardKey = "sk live+key/with=specials";
        const encoded = encodeURIComponent(awkwardKey);
        const unparseable = `crispy.test/api/mcp?api_key=${encoded}`;

        expect(encoded).toBe("sk%20live%2Bkey%2Fwith%3Dspecials");
        expect(() => new globalThis.URL(unparseable)).toThrow();

        const message = await realFetchMessage(unparseable, awkwardKey);

        expect(message).toMatch(/could not reach crispy/i);
        expect(message).not.toContain(awkwardKey);
        expect(message).not.toContain(encoded);
        expect(message).not.toContain("api_key");
        expect(message).not.toContain("crispy.test");
        expect(message).toContain("CRISPY_MCP_URL");
      });

      /**
       * The sink removes the url; it must not flatten the message. A url that
       * parses and simply refuses the connection puts nothing derived from the
       * raw url into the reason, so the reason has to come through intact --
       * otherwise an operator cannot tell a refused connection from a dns
       * failure. This is what fails if the sink is applied to the assembled
       * message rather than to the untrusted fragments of it: here the raw url
       * and the safe url are the same string.
       */
      it("leaves a clean platform error alone", async () => {
        const dead = "http://127.0.0.1:1/api/mcp";

        const message = await realFetchMessage(dead, KEY);

        expect(message).toContain(dead);
        expect(message).toMatch(/fetch failed/i);
        expect(message).not.toContain("[redacted]");
      });
    });

    it("keeps the key out of the network-failure message", async () => {
      const fetchImpl = (async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }) as unknown as typeof fetch;
      const client = new UpstreamClient({
        url: LEAKY_URL,
        apiKey: KEY,
        fetchImpl,
      });

      const error = (await client
        .send(TOOL_CALL)
        .catch((e: unknown) => e)) as UpstreamError;

      expect(error.kind).toBe("network");
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("api_key");
      // The endpoint still has to be identifiable, or the error is useless.
      expect(error.message).toContain("https://crispy.test/api/mcp");
    });

    it("keeps the key out of the timeout message", async () => {
      const fetchImpl = (async (
        _input: unknown,
        init?: RequestInit,
      ): Promise<Response> => {
        const signal = init?.signal as AbortSignal | undefined;
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        });
      }) as unknown as typeof fetch;
      const client = new UpstreamClient({
        url: LEAKY_URL,
        apiKey: KEY,
        fetchImpl,
        timeoutMs: 20,
      });

      const error = (await client
        .send(TOOL_CALL)
        .catch((e: unknown) => e)) as UpstreamError;

      expect(error.message).toMatch(/timed out/i);
      expect(error.message).not.toContain(KEY);
      expect(error.message).not.toContain("api_key");
      expect(error.message).toContain("https://crispy.test/api/mcp");
    });
  });
});

describe("UpstreamClient.endSession", () => {
  async function clientWithSession(responses: Response[]) {
    const { fetchImpl, calls } = recordingFetch([
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-live" } },
      ),
      ...responses,
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });
    return { client, calls };
  }

  it("sends DELETE with the session id, the bearer token and the protocol version", async () => {
    const { client, calls } = await clientWithSession([
      new Response(null, { status: 204 }),
    ]);

    await client.endSession();

    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(URL);
    expect(calls[1].init.method).toBe("DELETE");
    const headers = new Headers(calls[1].init.headers as HeadersInit);
    expect(headers.get("mcp-session-id")).toBe("sess-live");
    expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
    // The spec asks for the negotiated version on every request after
    // initialize, and the DELETE is one of them.
    expect(headers.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  it("forgets the session so a second teardown sends nothing", async () => {
    const { client, calls } = await clientWithSession([
      new Response(null, { status: 204 }),
      new Response(null, { status: 204 }),
    ]);

    await client.endSession();
    await client.endSession();

    expect(calls).toHaveLength(2);
  });

  it("sends nothing when there is no session to end", async () => {
    const { fetchImpl, calls } = recordingFetch(
      new Response(null, { status: 204 }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    await expect(client.endSession()).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("swallows a network failure so a dead endpoint cannot block exit", async () => {
    const { fetchImpl, calls } = recordingFetch(
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "sess-live" } },
      ),
    );
    let first = true;
    const failingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (first) {
        first = false;
        return await fetchImpl(input, init);
      }
      calls.push({ url: String(input), init: init ?? {} });
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl: failingFetch,
    });
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    await expect(client.endSession()).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it("accepts a 405 from a server that does not support teardown", async () => {
    const { client, calls } = await clientWithSession([
      new Response("Method Not Allowed", { status: 405 }),
    ]);

    await expect(client.endSession()).resolves.toBeUndefined();

    // Swallowing the 405 is the point -- but it has to be swallowed *after*
    // asking. A teardown that never sends the DELETE also never throws.
    expect(calls).toHaveLength(2);
    expect(calls[1].url).toBe(URL);
    expect(calls[1].init.method).toBe("DELETE");
    expect(sessionIdOf(calls[1].init)).toBe("sess-live");
  });

  it("bounds the teardown so a hung DELETE cannot wedge exit", async () => {
    const { fetchImpl } = recordingFetch(
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: {} },
        { headers: { "mcp-session-id": "sess-live" } },
      ),
    );
    let hangingSignal: AbortSignal | undefined;
    let sawInit = false;
    const hangingFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      if (!sawInit) {
        sawInit = true;
        return await fetchImpl(input, init);
      }
      hangingSignal = init?.signal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        hangingSignal?.addEventListener("abort", () =>
          reject(new DOMException("aborted", "AbortError")),
        );
      });
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl: hangingFetch,
      teardownTimeoutMs: 20,
    });
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    await expect(client.endSession()).resolves.toBeUndefined();
    expect(hangingSignal?.aborted).toBe(true);
  });
});

describe("UpstreamClient session fencing", () => {
  const INIT = { jsonrpc: "2.0", id: 1, method: "initialize" };

  /** Establishes `id` as the live session and returns the gate for later calls. */
  async function connected(id: string) {
    const { fetchImpl, calls } = gatedFetch();
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const init = client.send(INIT);
    calls[0].resolve(
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": id } },
      ),
    );
    await init;

    return { client, calls };
  }

  // Nothing has a session yet, so nothing has an id to compare against: both
  // requests snapshot the same generation on the way out. Fencing only on a
  // *changed* id leaves this case wide open.
  it("keeps the first session when two concurrent requests each open one", async () => {
    const { fetchImpl, calls } = gatedFetch();
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const first = client.send(INIT);
    const second = client.send(TOOL_CALL);
    expect(calls).toHaveLength(2);
    expect(sessionIdOf(calls[0].init)).toBeNull();
    expect(sessionIdOf(calls[1].init)).toBeNull();

    calls[0].resolve(
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-a" } },
      ),
    );
    await first;

    // The second answer names a different session. It left before sess-a
    // existed, so it knows nothing about the session it would be replacing.
    calls[1].resolve(
      jsonResponse(
        { jsonrpc: "2.0", id: 7, result: { content: [] } },
        { headers: { "mcp-session-id": "sess-b" } },
      ),
    );
    await second;

    const next = client.send(TOOL_CALL);
    expect(
      sessionIdOf(calls[2].init),
      "the second response must not abandon the session the first adopted",
    ).toBe("sess-a");
    calls[2].resolve(jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }));
    await next;
  });

  it("does not let a slow response resurrect a session a concurrent 404 just killed", async () => {
    const { client, calls } = await connected("sess-a");

    // Two calls leave together, both carrying sess-a.
    const slow = client.send(TOOL_CALL);
    const fast = client.send(TOOL_CALL);
    expect(calls).toHaveLength(3);
    expect(sessionIdOf(calls[1].init)).toBe("sess-a");
    expect(sessionIdOf(calls[2].init)).toBe("sess-a");

    // The second one comes back first: the session is gone.
    calls[2].resolve(jsonResponse({ error: "session not found" }, { status: 404 }));
    expect(((await fast.catch((e: unknown) => e)) as UpstreamError).kind).toBe(
      "session",
    );

    // The first lands late, still echoing the id that is now dead -- and
    // carrying a protocol version, so the stale body has something to write
    // back with as well as an id.
    calls[1].resolve(
      jsonResponse(
        {
          jsonrpc: "2.0",
          id: 7,
          result: { content: [], protocolVersion: "1999-01-01" },
        },
        { headers: { "mcp-session-id": "sess-a" } },
      ),
    );
    await slow;

    // Neither the dead id nor the version that came back with it may survive.
    const next = client.send(TOOL_CALL);
    const headers = new Headers(calls[3].init.headers as HeadersInit);
    expect(headers.get("mcp-session-id")).toBeNull();
    expect(headers.get("mcp-protocol-version")).toBeNull();
    calls[3].resolve(jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }));
    await next;
  });

  it("does not let a late 404 from a dead session clear the session that replaced it", async () => {
    const { client, calls } = await connected("sess-a");

    // Two calls leave together under sess-a.
    const late = client.send(TOOL_CALL);
    const first = client.send(TOOL_CALL);

    // One 404s, so sess-a is dropped.
    calls[2].resolve(jsonResponse({ error: "session not found" }, { status: 404 }));
    expect(((await first.catch((e: unknown) => e)) as UpstreamError).kind).toBe(
      "session",
    );

    // The client reconnects and the upstream hands out a fresh session.
    const reinit = client.send({ jsonrpc: "2.0", id: 2, method: "initialize" });
    expect(sessionIdOf(calls[3].init)).toBeNull();
    calls[3].resolve(
      jsonResponse(
        { jsonrpc: "2.0", id: 2, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-b" } },
      ),
    );
    await reinit;

    // Only now does the old generation's 404 land. It still fails its own
    // request, but it must not touch the healthy session that replaced it.
    calls[1].resolve(jsonResponse({ error: "session not found" }, { status: 404 }));
    expect(((await late.catch((e: unknown) => e)) as UpstreamError).kind).toBe(
      "session",
    );

    const next = client.send(TOOL_CALL);
    expect(sessionIdOf(calls[4].init)).toBe("sess-b");
    calls[4].resolve(jsonResponse({ jsonrpc: "2.0", id: 7, result: {} }));
    await next;
  });

  it("keeps the http status in the session error so a misrouted endpoint stays diagnosable", async () => {
    const { fetchImpl } = recordingFetch([
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-live" } },
      ),
      new Response(JSON.stringify({ error: "no such route" }), {
        status: 404,
        statusText: "Not Found",
        headers: { "content-type": "application/json" },
      }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });
    await client.send(INIT);

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("session");
    expect(error.message).toMatch(/expired/i);
    // A wrong CRISPY_MCP_URL 404s exactly like an expired session. The advice
    // stays, but the status has to survive or the misroute is invisible.
    expect(error.message).toContain("404");
    expect(error.message).toContain("Not Found");
  });
});

describe("UpstreamClient shutdown", () => {
  const INIT = { jsonrpc: "2.0", id: 1, method: "initialize" };

  it("refuses a message that arrives while the session is being torn down", async () => {
    const { fetchImpl, calls } = gatedFetch();
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const init = client.send(INIT);
    calls[0].resolve(
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-live" } },
      ),
    );
    await init;

    // Teardown is under way: the DELETE is out but has not come back yet.
    const ending = client.endSession();
    expect(calls).toHaveLength(2);
    expect(calls[1].init.method).toBe("DELETE");

    // A buffered initialize turns up mid-teardown. Forwarding it would open a
    // brand new session that nothing will ever delete.
    const error = (await client.send(INIT).catch((e: unknown) => e)) as UpstreamError;

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe("shutdown");
    expect(error.message).toMatch(/shutting down/i);
    expect(calls, "nothing may be forwarded after teardown starts").toHaveLength(2);

    calls[1].resolve(new Response(null, { status: 204 }));
    await ending;
  });

  // Teardown has to fence what is already in flight, not only what comes
  // after it. An initialize that left before the signal arrived is not
  // fenced by `stopped` -- it is already past that check.
  it("does not adopt a session from an initialize that lands mid-teardown", async () => {
    const { fetchImpl, calls } = gatedFetch();
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const init = client.send(INIT);
    expect(calls).toHaveLength(1);

    // The signal arrives before the upstream has answered. There is no session
    // yet, so teardown has no DELETE to send.
    await client.endSession();
    expect(calls).toHaveLength(1);

    // Only now does the answer land, handing out a brand new session.
    calls[0].resolve(
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-too-late" } },
      ),
    );
    await init;

    // Had that id been adopted it would now be live client state -- and a
    // second teardown would find it and DELETE it. There must be nothing to
    // find: the id was abandoned, never owned. (Not awaited first: a DELETE
    // is issued synchronously, so the count is checked before a teardown that
    // should not be happening gets a chance to block on its gate.)
    const again = client.endSession();
    expect(
      calls,
      "a session adopted after teardown began is state nobody owns",
    ).toHaveLength(1);
    await again;
  });

  it("keeps refusing after the teardown has finished", async () => {
    const { fetchImpl, calls } = recordingFetch(new Response(null, { status: 204 }));
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    // No session was ever established, so there is no DELETE to send -- but
    // the door still has to be shut.
    await client.endSession();
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("shutdown");
    expect(calls).toHaveLength(0);
  });
});

/**
 * Every string this client did not author itself goes through one sink before a
 * message can quote it, and these are the ways that sink was getting it wrong:
 * it cut the text down before it scrubbed it, it matched a hand-written list of
 * encodings, and it treated the endpoint url as a secret even when the url held
 * nothing worth hiding.
 */
describe("UpstreamClient redaction", () => {
  async function messageFrom(
    response: Response,
    options: { url?: string; apiKey?: string } = {},
  ): Promise<string> {
    const { fetchImpl } = recordingFetch(response);
    const client = new UpstreamClient({
      url: options.url ?? URL,
      apiKey: options.apiKey ?? KEY,
      fetchImpl,
    });
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    return error.message;
  }

  /**
   * A body is cut down to a snippet before a message shows it. Cutting first
   * splits a credential that straddles the boundary, and half a credential
   * matches nothing a whole-key search is looking for -- so the surviving
   * prefix went to stderr and into the JSON-RPC error the client is handed.
   * Scrub, then cut: in that order the cut can only ever land on text that is
   * already safe.
   */
  describe("when a credential straddles the snippet boundary", () => {
    const LONG_KEY = "sk-live-0123456789abcdef0123456789ab";

    it("keeps no part of a straddling key out of an http error", async () => {
      const message = await messageFrom(
        new Response(`${"x".repeat(480)}${LONG_KEY} and more`, { status: 500 }),
        { apiKey: LONG_KEY },
      );

      expect(message).toContain("[redacted]");
      expect(message).not.toContain(LONG_KEY);
      // The prefix the old cut-then-scrub order left behind.
      expect(message).not.toContain(LONG_KEY.slice(0, 20));
      expect(message).not.toContain("sk-live");
    });

    it("keeps no part of a straddling key out of a not-JSON error", async () => {
      const message = await messageFrom(
        new Response(`${"y".repeat(480)}${LONG_KEY} and more`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        { apiKey: LONG_KEY },
      );

      expect(message).toMatch(/not JSON/i);
      expect(message).not.toContain(LONG_KEY.slice(0, 20));
      expect(message).not.toContain("sk-live");
    });

    // Scrubbing first must not turn the bound off: an upstream body has no size
    // limit and a message is read by a human.
    it("still cuts an over-long body down to a snippet", async () => {
      const message = await messageFrom(
        new Response("z".repeat(4_000), { status: 500 }),
      );

      expect(message).toContain("...");
      expect(message.length).toBeLessThan(700);
    });
  });

  /**
   * Enumerating encodings is a losing game. The list that was here covered the
   * literal, encodeURIComponent, encodeURI and an all-lowercase escape form,
   * and still missed application/x-www-form-urlencoded -- where a space is `+`
   * -- and any mixture of escape cases. So the text is decoded and the match is
   * made against the decoded form, which covers the encodings nobody listed.
   */
  describe("whatever encoding a credential arrives wearing", () => {
    const AWKWARD = "sk live+key/with=specials";

    const hex = (text: string): string =>
      [...text]
        .map(
          (character) =>
            `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
        )
        .join("");

    const FORMS: Array<[string, string]> = [
      ["the literal key", AWKWARD],
      ["encodeURIComponent", encodeURIComponent(AWKWARD)],
      // Leaves `+`, `/` and `=` alone, so `+` here is a plus, not a space.
      ["encodeURI", encodeURI(AWKWARD)],
      [
        "all-lowercase escapes",
        encodeURIComponent(AWKWARD).replace(/%[0-9A-F]{2}/g, (escape) =>
          escape.toLowerCase(),
        ),
      ],
      ["mixed-case escapes", "sk%20live%2Bkey%2fwith%3dspecials"],
      ["form-urlencoded, where a space is +", "sk+live%2Bkey%2Fwith%3Dspecials"],
      ["every character escaped", hex(AWKWARD)],
    ];

    it.each(FORMS)("redacts %s out of a body", async (_form, encoded) => {
      const message = await messageFrom(
        new Response(`upstream said: ${encoded}`, { status: 500 }),
        { apiKey: AWKWARD },
      );

      expect(message).not.toContain(encoded);
      expect(message).not.toContain(AWKWARD);
      expect(message).toContain("[redacted]");
      // The redaction has to be surgical: the rest of the body is the diagnostic.
      expect(message).toContain("upstream said:");
    });

    it.each(FORMS)("redacts %s out of the status line", async (_form, encoded) => {
      const message = await messageFrom(
        new Response(null, { status: 500, statusText: `rejected ${encoded}` }),
        { apiKey: AWKWARD },
      );

      expect(message).not.toContain(encoded);
      expect(message).not.toContain(AWKWARD);
      expect(message).toContain("[redacted]");
    });

    // A body is not a url. `+` in an encodeURI'd string is a literal plus and
    // in a form-encoded one it is a space, and the sink cannot know which, so
    // it has to redact under either reading.
    it("does not need to know which reading of + a body meant", async () => {
      const plussed = await messageFrom(
        new Response("upstream said: sk+live+key", { status: 500 }),
        { apiKey: "sk live key" },
      );
      expect(plussed).not.toContain("sk+live+key");

      const literal = await messageFrom(
        new Response("upstream said: sk+live+key", { status: 500 }),
        { apiKey: "sk+live+key" },
      );
      expect(literal).not.toContain("sk+live+key");
    });
  });

  /**
   * The raw url is a secret because undici quotes it back at us, query and all.
   * That is only true of a url that carries something: strip userinfo, query
   * and fragment from an endpoint that has none of them and the result is the
   * url itself, so treating it as a secret redacts the endpoint out of every
   * body that legitimately names it and destroys the diagnostic to protect
   * nothing.
   */
  describe("when the endpoint carries no credential at all", () => {
    it("lets a body name the endpoint", async () => {
      const message = await messageFrom(
        new Response(`route ${URL} is disabled`, { status: 500 }),
      );

      expect(message).toContain(`route ${URL} is disabled`);
      expect(message).not.toContain("[redacted]");
    });

    it("still hides an endpoint that carries a query", async () => {
      const leaky = `${URL}?api_key=${KEY}`;
      const message = await messageFrom(
        new Response(`route ${leaky} is disabled`, { status: 500 }),
        { url: leaky },
      );

      expect(message).not.toContain(KEY);
      expect(message).not.toContain("api_key");
      expect(message).toContain("[redacted]");
    });

    it("still hides an endpoint that carries userinfo", async () => {
      const leaky = "https://someone:hunter2@crispy.test/api/mcp";
      const message = await messageFrom(
        new Response(`route ${leaky} refused`, { status: 500 }),
        { url: leaky },
      );

      expect(message).not.toContain("hunter2");
      expect(message).toContain("[redacted]");
    });

    it("still hides an endpoint that carries a fragment", async () => {
      const leaky = `${URL}#token-${KEY}`;
      const message = await messageFrom(
        new Response(`route ${leaky} refused`, { status: 500 }),
        { url: leaky },
      );

      expect(message).not.toContain(KEY);
      expect(message).toContain("[redacted]");
    });
  });
});

/**
 * A response body is a diagnostic detail and nothing more. It must not gate a
 * state transition, and reading it must not be able to outlive the request:
 * the request timeout was cleared the moment the headers arrived, so nothing
 * else is bounding this.
 */
describe("UpstreamClient when a response body never finishes", () => {
  const INIT = { jsonrpc: "2.0", id: 1, method: "initialize" };

  const SESSION_RESPONSE = (): Response =>
    jsonResponse(
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
      { headers: { "mcp-session-id": "sess-live" } },
    );

  /** A body that opens and then produces nothing until the test says so. */
  function heldBody(): { body: ReadableStream; release: () => void } {
    let release = (): void => undefined;
    const body = new ReadableStream({
      start(controller) {
        release = () => controller.close();
      },
    });
    return { body, release };
  }

  /** Lets every pending microtask run. */
  const settle = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve));

  it("drops the dead session when the 404 header lands, not when its body does", async () => {
    const held = heldBody();
    const { fetchImpl, calls } = recordingFetch([
      SESSION_RESPONSE(),
      new Response(held.body, { status: 404, statusText: "Not Found" }),
      jsonResponse({ jsonrpc: "2.0", id: 8, result: {} }),
    ]);
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      // Long enough that the deadline plays no part in this test: the
      // invalidation has to happen without waiting for the body at all.
      bodyReadTimeoutMs: 60_000,
    });

    await client.send(INIT);
    expect(sessionIdOf(calls[0].init)).toBeNull();

    const failing = client.send(TOOL_CALL).catch((e: unknown) => e);
    await settle();

    // The 404's own error is still waiting on a body that has not arrived. The
    // session it killed is already gone, so the next request must not carry it.
    await client.send({ ...TOOL_CALL, id: 8 });
    expect(
      sessionIdOf(calls[2].init),
      "a session the upstream 404'd must not be sent again",
    ).toBeNull();

    held.release();
    const error = (await failing) as UpstreamError;
    expect(error.kind).toBe("session");
  });

  it("bounds the diagnostic read so a 404 that never finishes still answers", async () => {
    const { fetchImpl } = recordingFetch([
      SESSION_RESPONSE(),
      new Response(new ReadableStream({ start: () => undefined }), {
        status: 404,
        statusText: "Not Found",
      }),
    ]);
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      bodyReadTimeoutMs: 20,
    });

    await client.send(INIT);
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("session");
    expect(error.message).toMatch(/HTTP 404/);
    // The detail is what was given up to get an answer at all.
    expect(error.message).not.toMatch(/upstream said/i);
  });

  /**
   * readBody's `await response.text()` is on the happy path, and a 2xx whose
   * body tears mid-read rejects it with a platform error worded by the
   * platform. bridge.ts copies that message to stderr and into the JSON-RPC
   * error, and bridge.ts holds neither the key nor the url, so it cannot
   * sanitise anything: the containment has to be here.
   */
  it("turns a torn body on a 2xx into a scrubbed UpstreamError", async () => {
    const leaky = `${URL}?api_key=${KEY}`;
    const torn = new ReadableStream({
      start(controller) {
        controller.error(new TypeError(`terminated while reading ${leaky}`));
      },
    });
    const { fetchImpl } = recordingFetch(
      new Response(torn, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new UpstreamClient({ url: leaky, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(
      error,
      "a raw platform error reaches stderr and the client unsanitised",
    ).toBeInstanceOf(UpstreamError);
    expect(error.message).not.toContain(KEY);
    expect(error.message).not.toContain("api_key");
    // Still diagnosable: the safe endpoint and the platform's own wording.
    expect(error.message).toContain("https://crispy.test/api/mcp");
    expect(error.message).toMatch(/terminated/);
  });
});
