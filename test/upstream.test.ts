import { describe, expect, it } from "vitest";

import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_BODY_MS,
  DEFAULT_TIMEOUT_MS,
  UpstreamClient,
  UpstreamError,
} from "../src/upstream";

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

  // ACCEPTED 1 took the body out of this message. What the upstream said used
  // to be quoted here; now the status and the byte count are the message.
  it("reports other http failures with the status and the body's size", async () => {
    const body = JSON.stringify({ error: "upstream exploded" });
    const { fetchImpl } = recordingFetch(
      new Response(body, {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("http");
    expect(error.message).toContain("HTTP 502");
    expect(error.message).toContain(`<${Buffer.byteLength(body)} bytes, not shown>`);
    expect(error.message).not.toContain("upstream exploded");
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
    // ACCEPTED 1: the body's content is gone, its size is not.
    expect(error.message).not.toContain("no such endpoint");
    expect(error.message).toContain("bytes, not shown");
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

  // RETIRED in round 7: this asserted the status line came back REDACTED.
  // ACCEPTED 1 character-classes the status line and drops it whole instead, so
  // there is no "[redacted]" to find. See "the status line" under
  // describe("UpstreamClient message construction").

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
       * What this proves, and no more: the sink is applied to the untrusted
       * FRAGMENT and not to the assembled message, so a reason with nothing to
       * remove comes through intact and an operator can still tell a refused
       * connection from a dns failure.
       *
       * What it does NOT prove, though it used to claim to: that the url is
       * treated as a secret only when it carries one. undici answers a refused
       * connection with "fetch failed" and never quotes the url, so forcing
       * every url to be a secret leaves this green. That claim needs a reason
       * that contains the url -- see "leaves a platform error that quotes a
       * clean url alone" under describe("UpstreamClient endpoint
       * identification"), which is the same assertion with a reason that bites.
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
    // ACCEPTED 1 retired the reason phrase: an upstream picks its text, so it
    // is the same class as the body. The numeric code carries the diagnosis.
    expect(error.message).not.toContain("Not Found");
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

/*
 * RETIRED in round 7, all of describe("UpstreamClient redaction"):
 *
 *   - "when a credential straddles the snippet boundary" (3 tests). Subject was
 *     the scrub-then-cut order of a body SNIPPET. ACCEPTED 1 deleted the
 *     snippet: no raw body text reaches a message, so there is no boundary for
 *     a credential to straddle. The ordering lesson survives where it still
 *     applies -- see "checks the whole field before capping it" and "scrubs the
 *     whole reason before cutting it down".
 *
 *   - "whatever encoding a credential arrives wearing" (15 tests). Subject was
 *     subtracting a credential out of an upstream body and an upstream status
 *     line. ACCEPTED 1 deleted both: the body contributes one allowlisted field
 *     or a byte count, and the status line is character-classed. The FORMS
 *     table moved rather than died -- it now drives "the construction does not
 *     care what encoding a credential wears" and the platform-error sink, which
 *     is the one place subtraction still happens.
 *
 *   - "when the endpoint carries no credential at all" (4 tests). Subject was
 *     which parts of the url make it a secret, probed through a BODY that names
 *     the url. Bodies no longer reach messages; ACCEPTED 2 replaced the
 *     predicate with "the raw url is a secret iff the safe url is not the raw
 *     url", and it is probed through the platform-error channel instead, in
 *     describe("UpstreamClient endpoint identification").
 */

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

/**
 * Round 7's design change. Three rounds hardened a redactor that subtracts
 * secrets out of upstream bytes, and each round found the next encoding that
 * defeated it: truncation before scrubbing, then compression before
 * truncation; single encoding, then double encoding; then a self-overlapping
 * key. Subtraction inside attacker-chosen text cannot be finished.
 *
 * So no raw upstream body text reaches a message any more. A message is
 * constructed out of parts we allow: the status code, a character-classed
 * status line, and ONE field lifted out of a JSON body. Everything else is a
 * byte count. There is no redactor left to defeat on this path because nothing
 * untrusted reaches the message.
 */
/**
 * The encodings the old redactor enumerated, kept because they are still the
 * sharpest probe there is -- of the construction below, which does not have to
 * know them, and of the platform-error sink further down, which still does.
 */
const AWKWARD_KEY = "sk live+key/with=specials";

const hex = (text: string): string =>
  [...text]
    .map(
      (character) =>
        `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
    )
    .join("");

const FORMS: Array<[string, string]> = [
  ["the literal key", AWKWARD_KEY],
  ["encodeURIComponent", encodeURIComponent(AWKWARD_KEY)],
  // Leaves `+`, `/` and `=` alone, so `+` here is a plus, not a space.
  ["encodeURI", encodeURI(AWKWARD_KEY)],
  [
    "all-lowercase escapes",
    encodeURIComponent(AWKWARD_KEY).replace(/%[0-9A-F]{2}/g, (escape) =>
      escape.toLowerCase(),
    ),
  ],
  ["mixed-case escapes", "sk%20live%2Bkey%2fwith%3dspecials"],
  ["form-urlencoded, where a space is +", "sk+live%2Bkey%2Fwith%3Dspecials"],
  ["every character escaped", hex(AWKWARD_KEY)],
];

describe("UpstreamClient message construction", () => {
  async function messageFor(
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
   * ACCEPTED 1, round 8. This used to be "the one field a JSON error body is
   * allowed to contribute", and the field was admitted by a character class.
   * Base64, hex and `&#65;` all pass a plain-printable-ascii class, so the
   * class admitted the key in three encodings nobody had listed. There is no
   * admitted field any more. A body contributes its size.
   *
   * Retired with the field, each named where it is now answered:
   *   - "quotes the error field the Crispy API actually returns" and "quotes
   *     error.message out of a JSON-RPC error object": the quoting is the
   *     finding. See "does not quote even a harmless error field" above, and
   *     CRISPY_MCP_UNSAFE_ERROR_DETAIL for buying the diagnostic back.
   *   - "keeps a field that merely names the key's format": that field is
   *     dropped now too. The run check it exercised is gone.
   *   - "checks the whole field before capping it" and "caps a clean but
   *     over-long field": no field is kept, so there is no cap to get wrong.
   */
  describe("what a failed body contributes: its size and nothing else", () => {
    it("shows only a byte count when the body is not JSON", async () => {
      const message = await messageFor(
        new Response("<html>gateway down</html>", { status: 502 }),
      );

      expect(message).toContain("<25 bytes, not shown>");
      expect(message).not.toContain("gateway down");
    });

    it("counts bytes rather than characters", async () => {
      // Four characters, ten bytes. A character count would say 4.
      const message = await messageFor(
        new Response("néé\u{1F600}", { status: 500 }),
      );

      expect(message).toContain("<9 bytes, not shown>");
    });

    /**
     * Replaces "keeps no part of a straddling key out of a not-JSON error",
     * retired with the rest of describe("UpstreamClient redaction"): a 2xx body
     * that is not JSON was quoted through the snippet, and now it is not quoted
     * at all.
     */
    it("shows only a byte count for a 2xx body that is not JSON", async () => {
      const key = "sk-live-0123456789abcdef";
      const message = await messageFor(
        new Response(`${"y".repeat(480)}${key} and more`, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
        { apiKey: key },
      );

      expect(message).toMatch(/not JSON/i);
      expect(message).not.toContain("sk-live");
      expect(message).toContain("<513 bytes, not shown>");
    });

    /**
     * One code path answers every one of these, which is the whole claim: the
     * message never looks at the body, so what the body contains cannot matter.
     * They are a table rather than a paragraph each because the reason they all
     * pass is now the same reason, and writing them as eight independent
     * arguments would suggest eight defences where there is one absence.
     *
     * Each was a separate defence once. The percent escape, the control
     * character and the non-ascii text were what the character class caught;
     * the key, the truncated key and the `+`-for-space key were what the run
     * check caught; the html entities and the base64 are what neither caught.
     */
    it.each([
      ["a plain sentence", "something went wrong"],
      ["a percent escape", "rejected %73%65%63"],
      ["a control sequence", "rejected\u001b[2Jcleared"],
      ["non-ascii text", "rejected ‮rossim"],
      ["the api key", `key ${KEY} is revoked`],
      ["a truncated api key", `key ${KEY.slice(0, 20)} is revoked`],
      ["html numeric refs", "AAAA&#65;AAAA"],
      ["base64", `token ${Buffer.from(KEY, "utf8").toString("base64")}`],
    ])("quotes nothing of a body carrying %s", async (_shape, text) => {
      const body = JSON.stringify({ error: text });
      const message = await messageFor(
        new Response(body, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );

      // Bytes, not code units: the non-ascii case is two of them apart.
      expect(message).toBe(
        `Crispy returned HTTP 500: <${Buffer.byteLength(body)} bytes, not shown>`,
      );
    });

    it("quotes nothing of a JSON body with no error field either", async () => {
      const body = JSON.stringify({ detail: "something went wrong" });
      const message = await messageFor(
        new Response(body, {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
      );

      expect(message).not.toContain("something went wrong");
      expect(message).toContain(`<${Buffer.byteLength(body)} bytes, not shown>`);
    });

    it("drops a whole body whose key arrives with + for its spaces", async () => {
      const message = await messageFor(
        new Response(JSON.stringify({ error: "key sk+live+key is revoked" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
        { apiKey: "sk live key" },
      );

      expect(message).not.toContain("sk+live+key");
      expect(message).toContain("bytes, not shown");
    });
  });

  /**
   * The old sink answered this table by decoding the text and matching the
   * decoded form, and round 7 found the double encoding that beat it. Round 7's
   * class answered it by refusing anything with a `%` in it, and round 8 found
   * three encodings with no `%` in them. Neither the body nor the status line
   * reads a byte of any of it now, so the table proves an absence rather than a
   * filter -- which is why it can no longer be out-encoded.
   */
  describe("the construction does not care what encoding a credential wears", () => {
    it.each(FORMS)("drops a body field carrying %s", async (_form, encoded) => {
      const message = await messageFor(
        jsonResponse({ error: `upstream said: ${encoded}` }, { status: 500 }),
        { apiKey: AWKWARD_KEY },
      );

      expect(message).not.toContain(encoded);
      expect(message).not.toContain(AWKWARD_KEY);
      expect(message).toContain("bytes, not shown");
    });

    it.each(FORMS)("drops a status line carrying %s", async (_form, encoded) => {
      const message = await messageFor(
        new Response(null, { status: 500, statusText: `rejected ${encoded}` }),
        { apiKey: AWKWARD_KEY },
      );

      expect(message).not.toContain(encoded);
      expect(message).not.toContain(AWKWARD_KEY);
      expect(message).toContain("HTTP 500");
    });
  });

  /**
   * ACCEPTED 1 again. statusText crosses the wire and an upstream picks its
   * text, so it is the body's class, not the status code's. R6 showed the cost
   * of pretending otherwise: two 15-character halves, one in the phrase and one
   * in the body field, reassembled a 30-character key across the `: ` joining
   * them, with neither half long enough to trip a 16-character window.
   *
   * ACCEPTED 4 deleted "caps an over-long reason phrase" from here. It passed
   * whether the phrase was capped or discarded entirely -- it asserted neither
   * the retained prefix nor the ellipsis -- and ACCEPTED 1 retired the code it
   * was written for, so there is no cap left for a sharper version to test.
   */
  describe("the status line", () => {
    it.each([
      ["a standard phrase", "Bad Gateway"],
      ["the api key", `rejected ${KEY}`],
      ["a percent escape", "rejected %73%65%63"],
      ["an over-long phrase", "w".repeat(400)],
      ["html numeric refs", "AAAA&#65;AAAA"],
    ])("keeps nothing of %s", async (_shape, phrase) => {
      const message = await messageFor(
        new Response(null, { status: 500, statusText: phrase }),
      );

      expect(message).toBe("Crispy returned HTTP 500");
    });

    it("keeps the status code, which is a number we read", async () => {
      const message = await messageFor(
        new Response(null, { status: 502, statusText: "Bad Gateway" }),
      );

      expect(message).toContain("HTTP 502");
    });
  });

  describe("the findings this design retires", () => {
    it("F1: a key repeated past the old 64-KiB scrub bound leaks nothing", async () => {
      const key = "k".repeat(64);
      const message = await messageFor(
        new Response(`x${key.repeat(1024)}`, { status: 500 }),
        { apiKey: key },
      );

      expect(message).not.toContain("k".repeat(63));
      expect(message).toContain("<65537 bytes, not shown>");
    });

    it("F2: a double-encoded key leaks nothing", async () => {
      const key = "sk live+key";
      const doubled = encodeURIComponent(encodeURIComponent(key));
      const message = await messageFor(
        jsonResponse({ error: `upstream said: ${doubled}` }, { status: 500 }),
        { apiKey: key },
      );

      expect(message).not.toContain(doubled);
      expect(message).not.toContain(key);
      expect(message).toContain("bytes, not shown");
    });

    it("F3: a self-overlapping key leaks no tail", async () => {
      const key = "A".repeat(64);
      const message = await messageFor(
        new Response("A".repeat(127), { status: 500 }),
        { apiKey: key },
      );

      expect(message).not.toContain("A".repeat(63));
      expect(message).toContain("<127 bytes, not shown>");
    });
  });
});

/**
 * F4. carriesCredential() looked at userinfo, query and fragment, and
 * endpointForMessage() kept the whole pathname -- so a credential in a path
 * segment of CRISPY_MCP_URL went straight into a diagnostic. CRISPY_MCP_URL is
 * unrestricted and a path segment can be anything, so a message gets the origin
 * and, at most, the SHAPE of the path.
 */
describe("UpstreamClient endpoint identification", () => {
  const refusingFetch = (async () => {
    throw new TypeError("fetch failed: ECONNREFUSED");
  }) as unknown as typeof fetch;

  async function messageFor(
    url: string,
    apiKey = KEY,
    fetchImpl: typeof fetch = refusingFetch,
  ): Promise<string> {
    const client = new UpstreamClient({ url, apiKey, fetchImpl });
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    return error.message;
  }

  it("F4: never prints a credential sitting in a path segment", async () => {
    const message = await messageFor(
      "https://crispy.test/token/hunter2/api/mcp",
      "an-unrelated-bearer-key",
    );

    expect(message).not.toContain("hunter2");
    expect(message).not.toContain("/token/");
    expect(message).toContain("https://crispy.test");
    expect(message).toContain("4 path segments");
  });

  it("prints the default endpoint's path in full", async () => {
    const message = await messageFor("https://crispy.test/api/mcp");

    expect(message).toContain("https://crispy.test/api/mcp");
    expect(message).not.toContain("path segment");
  });

  it("says nothing of a path when there is none", async () => {
    const message = await messageFor("https://crispy.test/");

    expect(message).toContain("https://crispy.test");
    expect(message).not.toContain("path segment");
  });

  it("counts a single segment in the singular", async () => {
    const message = await messageFor("https://crispy.test/mcp");

    expect(message).toContain("1 path segment");
    expect(message).not.toContain("/mcp");
  });

  /**
   * The raw url is a secret exactly when the safe url is not the raw url:
   * undici quotes the raw url back at us in its own wording, so anything the
   * reduction above dropped would re-enter through the platform's message.
   * One rule, and it is the reduction's own rule rather than a second
   * predicate that can drift away from it.
   */
  it("keeps a path credential out of the platform's own wording too", async () => {
    const url = "https://crispy.test/token/hunter2/api/mcp";
    const quoting = (async () => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    }) as unknown as typeof fetch;

    const message = await messageFor(url, "an-unrelated-bearer-key", quoting);

    expect(message).not.toContain("hunter2");
    expect(message).toContain("[redacted]");
  });

  /**
   * ...and it must not flatten a clean one. A url that is its own safe form is
   * not a secret, so the platform's wording comes through intact. This is what
   * :563 could not tell apart: its platform error never contained the url, so
   * forcing every url to be a secret left it green.
   */
  it("leaves a platform error that quotes a clean url alone", async () => {
    const url = "https://crispy.test/api/mcp";
    const quoting = (async () => {
      throw new TypeError(`Failed to parse URL from ${url}`);
    }) as unknown as typeof fetch;

    const message = await messageFor(url, KEY, quoting);

    expect(message).toContain(`Failed to parse URL from ${url}`);
    expect(message).not.toContain("[redacted]");
  });
});

/**
 * ACCEPTED 3 and 4. A 2xx whose body hangs never settled: readBody had no
 * deadline and the request timer was cleared at headers. That is the same
 * wedge class this branch exists to fix, reached through a different door.
 */
describe("UpstreamClient body reading", () => {
  /** A body that opens, emits what it is given, and closes when told. */
  function scriptedBody(): {
    body: ReadableStream<Uint8Array>;
    push: (text: string) => void;
    close: () => void;
    cancelled: () => boolean;
  } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      body,
      push: (text) => controller.enqueue(new TextEncoder().encode(text)),
      close: () => controller.close(),
      cancelled: () => cancelled,
    };
  }

  it("fails closed when a 2xx body stops arriving, rather than hanging", async () => {
    const stalled = scriptedBody();
    const { fetchImpl } = recordingFetch(
      new Response(stalled.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      timeoutMs: 30,
    });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/stopped sending/i);
    expect(error.message).toContain("https://crispy.test/api/mcp");
    expect(stalled.cancelled(), "the stalled body was not cancelled").toBe(true);
  });

  /**
   * The bound is on the gap between chunks, not on the whole read. A total
   * bound generous enough for a large slow tool result would be too generous to
   * bound a wedge; a gap bound is both.
   *
   * ACCEPTED 4. This sent about fifty bytes and called them "a large response",
   * so a one-kilobyte retention cap would have kept it green and it proved only
   * that the gap bound rearms. It now carries a megabyte, over twenty chunks,
   * taking five times the gap bound in total: it bites on the retention cap and
   * on the byte ceiling as well as on the gap bound.
   */
  it("does not cut off a megabyte arriving over many gap windows", async () => {
    const slow = scriptedBody();
    const { fetchImpl } = recordingFetch(
      new Response(slow.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      timeoutMs: 40,
    });

    const pending = client.send(TOOL_CALL);
    const filler = "z".repeat(1024 * 1024);
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true, filler },
    });
    const chunk = Math.ceil(payload.length / 20);
    for (let at = 0; at < payload.length; at += chunk) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      slow.push(payload.slice(at, at + chunk));
    }
    slow.close();

    const body = (await pending) as {
      result: { ok: boolean; filler: string };
    };
    expect(body.result.ok).toBe(true);
    expect(body.result.filler).toHaveLength(1024 * 1024);
    expect(payload.length).toBeGreaterThan(1024 * 1024);
  });

  it("cancels the stream of an error body that never finishes", async () => {
    const stalled = scriptedBody();
    const { fetchImpl } = recordingFetch(
      new Response(stalled.body, { status: 500, statusText: "Server Error" }),
    );
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      bodyReadTimeoutMs: 20,
    });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.message).toContain("HTTP 500");
    expect(
      stalled.cancelled(),
      "response.text() locks the body, so cancelling the locked body rejects and the read runs on",
    ).toBe(true);
  });
});

/**
 * ACCEPTED 5. strip() survives for the strings we originate -- the platform's
 * wording and the url itself. Subtraction is sound there and only there. Its
 * span map has to be exact: mapping every character of a multibyte escape run
 * to the whole run redacts unrelated text around the match. That fails closed,
 * so it is not a leak, but it destroys the diagnostic the sink exists to keep.
 */
describe("UpstreamClient platform-error sanitising", () => {
  async function messageFor(reason: string, apiKey: string): Promise<string> {
    const fetchImpl = (async () => {
      throw new TypeError(reason);
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({ url: URL, apiKey, fetchImpl });
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;
    return error.message;
  }

  // A one-character secret is the sharpest probe of the span map: what is under
  // test is which escapes a match maps back to, not the match itself.
  it("redacts only the escapes the match came from", async () => {
    const message = await messageFor("before %61%62%C3%A9%63%64 after", "é");

    expect(message).toContain("%61%62");
    expect(message).toContain("%63%64");
    expect(message).toContain("[redacted]");
    expect(message).toContain("before");
    expect(message).toContain("after");
  });

  // Subtraction lives on here and only here, so the encoding table lives on
  // here too: what the construction can decline to read, the sink has to match.
  it.each(FORMS)("redacts %s out of a platform error", async (_form, encoded) => {
    const message = await messageFor(
      `fetch failed for ${encoded}`,
      AWKWARD_KEY,
    );

    expect(message).not.toContain(encoded);
    expect(message).not.toContain(AWKWARD_KEY);
    expect(message).toContain("[redacted]");
    // Surgical: the rest of the platform's wording is the diagnostic.
    expect(message).toContain("fetch failed for");
  });

  it("still redacts a key that overlaps itself", async () => {
    const key = "A".repeat(64);
    const message = await messageFor(`refused ${"A".repeat(127)} refused`, key);

    expect(message).not.toContain("A".repeat(63));
  });

  /**
   * A `%` that begins no escape is a literal, and the span map has to keep
   * counting through it -- otherwise every span after it is off by one and the
   * redaction lands on the wrong text. A secret sitting between a malformed
   * escape and a trailing lone `%` is what makes this depend on the map at all:
   * with nothing to redact, strip() returns the text untouched and any mapping
   * at all would pass.
   */
  it("keeps counting through a malformed escape and a trailing percent", async () => {
    const message = await messageFor("at 50%% load %zz %41 %", "A");

    expect(message).toContain("at 50%% load %zz [redacted] %");
  });

  it("scrubs the whole reason before cutting it down", async () => {
    const key = "sk-live-0123456789abcdef";
    const message = await messageFor(`${"x".repeat(480)}${key} and more`, key);

    expect(message).not.toContain("sk-live");
    expect(message).toContain("[redacted]");
  });
});

/**
 * Round 8. Round 7 replaced subtraction with an allowlist: a JSON `error` field
 * was admitted if it matched a plain-printable-ascii class and carried no
 * 16-character run of a secret. That killed percent-encoding and nothing else.
 *
 * Reproduced against the built dist at ca061db, every one of these put the key
 * into `error.message` in a form one `base64 -d` recovers:
 *
 *   R1 html numeric refs  AAAAAAAAAAAAAAA&#65;AAAAAAAAAAAAAAA...
 *   R2 base64             token QUFBQUFBQUFBQUFB...
 *   R3 hex                token 41414141414141...
 *   R4 realistic key      auth failed for c2stbGl2ZS03ZjNhOWMyZThiMWQ0ZjZhMGM1ZTJiOWQ=
 *   R6 split              HTTP 500 AAAAAAAAAAAAAAA: BBBBBBBBBBBBBBB
 *
 * Base64, hex and `&#65;` are all plain printable ascii, and `&#65;` splitting a
 * run into 15-character pieces defeats a 16-character window. That is the fifth
 * distinct encoding to beat the same check in five rounds. A character class is
 * a blacklist in different clothes: any string an upstream chooses can encode a
 * credential in SOME printable form, and that set cannot be enumerated.
 *
 * So the rule is now positional, not lexical. No string whose CONTENT an
 * upstream chooses appears in a message at all -- not the body, not one field
 * lifted out of it, not the reason phrase. A message is built from the numeric
 * status, the byte length, our own wording, and the reduced endpoint. There is
 * no filter to out-encode because there is no admitted string.
 */
describe("no upstream-chosen bytes reach a message", () => {
  const KEY_A = "A".repeat(64);

  async function messageFor(
    response: Response,
    options: { apiKey?: string; unsafeErrorDetail?: boolean } = {},
  ): Promise<string> {
    const { fetchImpl } = recordingFetch(response);
    const client = new UpstreamClient({
      url: URL,
      apiKey: options.apiKey ?? KEY,
      fetchImpl,
      unsafeErrorDetail: options.unsafeErrorDetail,
    });
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    return error.message;
  }

  /** Everything a message may contain, and there is nothing else. */
  function assertBuiltOnlyFromTrustedParts(
    message: string,
    status: number,
    bytes: number,
  ): void {
    expect(message).toContain(`HTTP ${status}`);
    expect(message).toContain(`<${bytes} bytes, not shown>`);
  }

  const bodyOf = (payload: unknown): string => JSON.stringify(payload);

  it("R1: drops a body field that smuggles the key through html numeric refs", async () => {
    const smuggled = [...KEY_A]
      .map((c, i) => (i > 0 && i % 15 === 0 ? `&#${c.charCodeAt(0)};` : c))
      .join("");
    const body = bodyOf({ error: smuggled });

    const message = await messageFor(
      new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
      { apiKey: KEY_A },
    );

    // Decoding the entities is what round 7 shipped: `&#65;` is an `A`.
    const decoded = message.replace(/&#(\d+);/g, (_, d: string) =>
      String.fromCharCode(Number(d)),
    );
    expect(decoded).not.toContain(KEY_A);
    expect(message).not.toContain("&#65;");
    assertBuiltOnlyFromTrustedParts(message, 500, Buffer.byteLength(body));
  });

  it("R2: drops a body field that smuggles the key through base64", async () => {
    const encoded = Buffer.from(KEY_A, "utf8").toString("base64");
    const body = bodyOf({ error: `token ${encoded}` });

    const message = await messageFor(
      new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
      { apiKey: KEY_A },
    );

    expect(message).not.toContain(encoded);
    assertBuiltOnlyFromTrustedParts(message, 500, Buffer.byteLength(body));
  });

  it("R3: drops a body field that smuggles the key through hex", async () => {
    const encoded = Buffer.from(KEY_A, "utf8").toString("hex");
    const body = bodyOf({ error: `token ${encoded}` });

    const message = await messageFor(
      new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
      { apiKey: KEY_A },
    );

    expect(message).not.toContain(encoded);
    assertBuiltOnlyFromTrustedParts(message, 500, Buffer.byteLength(body));
  });

  // A real key, not a run of As: the round-7 check would not have fired on this
  // one even in its literal form once base64 had rewritten every character.
  it("R4: drops a body field that base64s a realistic key", async () => {
    const key = "sk-live-7f3a9c2e8b1d4f6a0c5e2b9d";
    const encoded = Buffer.from(key, "utf8").toString("base64");
    const body = bodyOf({ error: `auth failed for ${encoded}` });

    const message = await messageFor(
      new Response(body, { status: 500, headers: { "content-type": "application/json" } }),
      { apiKey: key },
    );

    expect(message).not.toContain(encoded);
    expect(message).not.toContain(key);
    assertBuiltOnlyFromTrustedParts(message, 500, Buffer.byteLength(body));
  });

  /**
   * R6. Two 15-character halves, neither long enough to trip a 16-character
   * window, one carried by the reason phrase and one by the body field. The
   * message reassembled the key with a `: ` between the halves. ACCEPTED 1
   * retires this as a side effect: neither half has anywhere left to ride.
   */
  it("R6: neither the reason phrase nor the body can carry half a key", async () => {
    const key = `${"A".repeat(15)}${"B".repeat(15)}`;
    const body = bodyOf({ error: key.slice(15) });

    const message = await messageFor(
      new Response(body, {
        status: 500,
        statusText: key.slice(0, 15),
        headers: { "content-type": "application/json" },
      }),
      { apiKey: key },
    );

    expect(message.replace(/[^A-Za-z0-9]/g, "")).not.toContain(key);
    expect(message).not.toContain(key.slice(0, 15));
    expect(message).not.toContain(key.slice(15));
    assertBuiltOnlyFromTrustedParts(message, 500, Buffer.byteLength(body));
  });

  /**
   * The finding, stated without an attack. A clean, harmless, obviously useful
   * sentence is dropped too -- because whether a string is safe is exactly the
   * question five rounds of filters got wrong, so the message stops asking it.
   */
  it("does not quote even a harmless error field", async () => {
    const body = bodyOf({ error: "rate limit exceeded" });

    const message = await messageFor(
      new Response(body, { status: 429, headers: { "content-type": "application/json" } }),
    );

    expect(message).not.toContain("rate limit exceeded");
    assertBuiltOnlyFromTrustedParts(message, 429, Buffer.byteLength(body));
  });

  it("does not quote a JSON-RPC error.message either", async () => {
    const body = bodyOf({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32600, message: "bad request" },
    });

    const message = await messageFor(
      new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
    );

    expect(message).not.toContain("bad request");
    assertBuiltOnlyFromTrustedParts(message, 400, Buffer.byteLength(body));
  });

  // statusText crosses the wire and an upstream picks it, so it is the same
  // class as the body. Being benign is not a property the message can check.
  it("does not quote even a standard reason phrase", async () => {
    const message = await messageFor(
      new Response(null, { status: 502, statusText: "Bad Gateway" }),
    );

    expect(message).not.toContain("Bad Gateway");
    expect(message).toContain("HTTP 502");
  });

  it("quotes nothing of the body on the auth path either", async () => {
    const body = bodyOf({ error: "Invalid API key. The key is unknown." });
    const message = await messageFor(
      new Response(body, {
        status: 401,
        statusText: "Unauthorized by Crispy",
        headers: { "content-type": "application/json" },
      }),
    );

    expect(message).not.toContain("Unauthorized by Crispy");
    expect(message).not.toContain("The key is unknown");
    assertBuiltOnlyFromTrustedParts(message, 401, Buffer.byteLength(body));
  });

  it("keeps no reason phrase on the expired-session path either", async () => {
    const { fetchImpl } = recordingFetch([
      jsonResponse(
        { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
        { headers: { "mcp-session-id": "sess-live" } },
      ),
      new Response(null, { status: 404, statusText: "Gone From crispy-42" }),
    ]);
    const client = new UpstreamClient({ url: URL, apiKey: KEY, fetchImpl });
    await client.send({ jsonrpc: "2.0", id: 1, method: "initialize" });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.kind).toBe("session");
    expect(error.message).not.toContain("Gone From crispy-42");
    expect(error.message).toContain("HTTP 404");
  });
});

/**
 * ACCEPTED 2. The cost of dropping every upstream-chosen string is real: a 400
 * now reads as a number. CRISPY_MCP_UNSAFE_ERROR_DETAIL=1 buys it back, and the
 * name is the documentation. It is off unless the value is exactly `1`, so it
 * cannot be turned on by a truthy string somebody pasted into a config.
 */
describe("CRISPY_MCP_UNSAFE_ERROR_DETAIL", () => {
  async function messageFor(
    response: Response,
    options: { apiKey?: string; unsafeErrorDetail?: boolean } = {},
  ): Promise<string> {
    const { fetchImpl } = recordingFetch(response);
    const client = new UpstreamClient({
      url: URL,
      apiKey: options.apiKey ?? KEY,
      fetchImpl,
      unsafeErrorDetail: options.unsafeErrorDetail,
    });
    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;
    expect(error).toBeInstanceOf(UpstreamError);
    return error.message;
  }

  it("restores the lost diagnostic when it is on", async () => {
    const message = await messageFor(
      new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
      { unsafeErrorDetail: true },
    );

    expect(message).toContain("rate limit exceeded");
  });

  it("shows a body that is not JSON at all when it is on", async () => {
    const message = await messageFor(
      new Response("<html>gateway down</html>", { status: 502 }),
      { unsafeErrorDetail: true },
    );

    expect(message).toContain("gateway down");
  });

  it("is off by default", async () => {
    const message = await messageFor(
      new Response(JSON.stringify({ error: "rate limit exceeded" }), {
        status: 429,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(message).not.toContain("rate limit exceeded");
  });

  /**
   * Best effort, and the word is chosen. Subtracting the key out of a body the
   * upstream wrote is exactly the game rounds 4 through 7 kept losing; it is
   * kept here because it costs nothing and catches the careless case, not
   * because it is sound. The README says so too.
   */
  it("still subtracts a literal key from the detail it shows", async () => {
    const message = await messageFor(
      new Response(JSON.stringify({ error: `key ${KEY} is revoked` }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      { unsafeErrorDetail: true },
    );

    expect(message).not.toContain(KEY);
    expect(message).toContain("is revoked");
  });

  it("caps the detail it shows", async () => {
    const message = await messageFor(
      new Response(JSON.stringify({ error: "q".repeat(8_000) }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
      { unsafeErrorDetail: true },
    );

    expect(message).toContain("...");
    expect(message.length).toBeLessThan(2_000);
  });

  it("does not weaken the endpoint reduction", async () => {
    const leaky = `https://crispy.test/token/hunter2/api/mcp`;
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    }) as unknown as typeof fetch;
    const client = new UpstreamClient({
      url: leaky,
      apiKey: KEY,
      fetchImpl,
      unsafeErrorDetail: true,
    });

    const error = (await client
      .send(TOOL_CALL)
      .catch((e: unknown) => e)) as UpstreamError;

    expect(error.message).not.toContain("hunter2");
  });
});

/**
 * ACCEPTED 3. readBounded's deadline rearms on every chunk, so a server that
 * drips one byte inside every gap window keeps send() pending for as long as it
 * likes while the body piles up in memory. The gap bound detects a stall; it
 * does not bound a wedge. Both absolute ceilings fail closed with their own
 * wording, so a diagnostic says which one bit.
 */
describe("UpstreamClient absolute body bounds", () => {
  function scriptedBody(): {
    body: ReadableStream<Uint8Array>;
    push: (text: string) => void;
    close: () => void;
    cancelled: () => boolean;
  } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
      cancel() {
        cancelled = true;
      },
    });
    return {
      body,
      push: (text) => controller.enqueue(new TextEncoder().encode(text)),
      close: () => controller.close(),
      cancelled: () => cancelled,
    };
  }

  it("cuts off a body that drips inside every gap window for ever", async () => {
    const dripping = scriptedBody();
    const { fetchImpl } = recordingFetch(
      new Response(dripping.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      // A drip every 5ms rearms a 40ms gap bound for ever. 60ms of total
      // patience is what ends it.
      timeoutMs: 40,
      maxBodyMs: 60,
    });

    const pending = client.send(TOOL_CALL);
    let drips = 0;
    const drip = setInterval(() => {
      drips += 1;
      dripping.push("x");
    }, 5);

    const error = (await pending.catch((e: unknown) => e)) as UpstreamError;
    clearInterval(drip);

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/did not finish within 60ms/);
    // Proves the gap bound never fired: it was rearmed every 5ms.
    expect(drips, "the body stopped dripping on its own").toBeGreaterThan(4);
    expect(dripping.cancelled(), "the dripping body was not cancelled").toBe(
      true,
    );
  });

  it("cuts off a body that floods past the total-bytes ceiling", async () => {
    const flooding = scriptedBody();
    const { fetchImpl } = recordingFetch(
      new Response(flooding.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      timeoutMs: 1_000,
      maxBodyBytes: 1_000,
    });

    const settled = client.send(TOOL_CALL).catch((e: unknown) => e);
    // Two chunks, neither over the ceiling on its own. The ceiling counts the
    // total, so it is the second one that trips it -- which is the case a
    // per-chunk check would miss.
    await new Promise((resolve) => setTimeout(resolve, 1));
    flooding.push("y".repeat(600));
    await new Promise((resolve) => setTimeout(resolve, 1));
    expect(flooding.cancelled(), "600 bytes is under the ceiling").toBe(false);
    flooding.push("y".repeat(600));

    const error = (await settled) as UpstreamError;

    expect(error).toBeInstanceOf(UpstreamError);
    expect(error.kind).toBe("network");
    expect(error.message).toMatch(/grew past 1000 bytes/);
    expect(flooding.cancelled(), "the flooding body was not cancelled").toBe(
      true,
    );
  });

  /**
   * The ceiling counts what ARRIVED, not what was kept. On the error path only
   * 64 KiB is retained, so a ceiling on the retained count can never fire above
   * that -- and a flood is exactly the case that gets above it. The mutation
   * `retained > this.maxBodyBytes` passed every other test in this file.
   *
   * Timing is the observable, so the margin is wide: the read's own deadline is
   * three seconds away and the ceiling has to bite inside one tick.
   */
  it("counts a flood by what arrived, not by what it kept", async () => {
    const flooding = scriptedBody();
    const { fetchImpl } = recordingFetch(
      new Response(flooding.body, { status: 500 }),
    );
    const client = new UpstreamClient({
      url: URL,
      apiKey: KEY,
      fetchImpl,
      // Above the 64 KiB the error path retains, so only a count of everything
      // that arrived can reach it.
      maxBodyBytes: 100_000,
      bodyReadTimeoutMs: 3_000,
    });

    const settled = client.send(TOOL_CALL).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 1));
    flooding.push("y".repeat(150_000));
    await new Promise((resolve) => setTimeout(resolve, 20));

    // The body never closes. Only the ceiling can have ended this read, and it
    // has to have ended it already rather than at the three-second deadline.
    expect(
      flooding.cancelled(),
      "the flood was still being drained 20ms in",
    ).toBe(true);

    const error = (await settled) as UpstreamError;
    expect(error.message).toContain("HTTP 500");
    expect(error.message).toContain("<150000 bytes, not shown>");
  });

  it("says nothing of the body it abandoned but its size", async () => {
    const flooding = scriptedBody();
    const secret = "sk-live-0123456789abcdef";
    const { fetchImpl } = recordingFetch(
      new Response(flooding.body, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = new UpstreamClient({
      url: URL,
      apiKey: secret,
      fetchImpl,
      timeoutMs: 1_000,
      maxBodyBytes: 100,
    });

    const settled = client.send(TOOL_CALL).catch((e: unknown) => e);
    await new Promise((resolve) => setTimeout(resolve, 1));
    flooding.push(`${secret} `.repeat(20));

    const error = (await settled) as UpstreamError;

    expect(error.message).not.toContain(secret);
    expect(error.message).not.toContain("sk-live");
  });

  /**
   * The ceilings must not be reachable by anything Crispy legitimately sends.
   * A tool result is JSON destined for a model's context window; these leave
   * three orders of magnitude of headroom over the largest of them.
   */
  it("ships ceilings far above any legitimate response", async () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(64 * 1024 * 1024);
    expect(DEFAULT_MAX_BODY_MS).toBe(600_000);
    expect(DEFAULT_MAX_BODY_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });
});
