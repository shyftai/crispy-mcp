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

/**
 * Upper bound on reading a failed response's body for a diagnostic. By the
 * time that read happens the request timeout has been cleared -- it was
 * cleared the moment the headers arrived -- so nothing else bounds it.
 */
export const DEFAULT_BODY_READ_TIMEOUT_MS = 2_000;

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
  bodyReadTimeoutMs?: number;
}

/** What a message is allowed to show of an untrusted string. */
const MAX_BODY_SNIPPET = 500;

/**
 * How much of an untrusted string is scrubbed before it is cut down to the
 * snippet. Scrubbing has to come first -- see snippet() -- but scrubbing is
 * linear in the text and an upstream body has no size limit. Cutting here is
 * safe only because this bound is so far beyond MAX_BODY_SNIPPET: a credential
 * straddling this cut loses its tail, but the prefix left behind sits 64 KiB
 * into the text and the snippet stops long before it.
 */
const MAX_SCRUB_INPUT = 64 * 1024;

const REDACTED = "[redacted]";

/** A half-open range of the original text that must not survive into a message. */
interface Span {
  start: number;
  end: number;
}

const ESCAPE = /^%[0-9A-Fa-f]{2}/;

const UTF8 = new TextDecoder("utf-8", { fatal: false });

/**
 * Percent-decodes `text` and records, for every character of the result, the
 * span of the original it came from.
 *
 * Enumerating encodings is a losing game. The list this replaces held the
 * literal key, encodeURIComponent, encodeURI and an all-lowercase escape form,
 * and still missed application/x-www-form-urlencoded -- where a space is `+` --
 * and any mixture of escape cases, `%2b` beside `%2F`. Adding two more forms
 * would only move the gap. Decoding the text instead covers every encoding that
 * decodes, including the ones nobody thought to list.
 *
 * `plusAsSpace` is the one thing decoding cannot settle on its own: in a
 * form-encoded string `+` is a space, in an encodeURI'd one it is a plus, and a
 * body carries no hint which. The caller matches under both readings.
 *
 * One pass, not a fixed point: a doubly-encoded credential (`%2573`) is not
 * covered, and reaching one would take an upstream that encodes its own error
 * bodies twice.
 *
 * The span map is what makes any of this usable. A match is found in decoded
 * coordinates and has to be removed from the original, and the two do not line
 * up: `%2B` is three characters standing in for one.
 */
function decodeWithSpans(
  text: string,
  plusAsSpace: boolean,
): { decoded: string; spans: Span[] } {
  let decoded = "";
  const spans: Span[] = [];

  for (let i = 0; i < text.length; ) {
    if (ESCAPE.test(text.slice(i, i + 3))) {
      // A non-ASCII character arrives as several escapes in a row, so decode
      // the whole run at once: `%C3%A9` is one character, not two.
      const start = i;
      const bytes: number[] = [];
      while (ESCAPE.test(text.slice(i, i + 3))) {
        bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
        i += 3;
      }
      const run = UTF8.decode(new Uint8Array(bytes));

      if (run.length === bytes.length) {
        // One escape per character: each maps back to its own three.
        for (let j = 0; j < run.length; j += 1) {
          spans.push({ start: start + j * 3, end: start + j * 3 + 3 });
        }
      } else {
        // Bytes and characters do not line up. Widening is the safe way to be
        // wrong: every character points at the whole run, so a match anywhere
        // in it takes all of it.
        for (let j = 0; j < run.length; j += 1) {
          spans.push({ start, end: i });
        }
      }
      decoded += run;
      continue;
    }

    decoded += plusAsSpace && text[i] === "+" ? " " : text[i];
    spans.push({ start: i, end: i + 1 });
    i += 1;
  }

  return { decoded, spans };
}

/** Every index at which `needle` occurs in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  ) {
    found.push(at);
  }
  return found;
}

/** Merges overlapping and touching spans, then replaces each with REDACTED. */
function redactSpans(text: string, spans: Span[]): string {
  if (spans.length === 0) {
    return text;
  }

  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  let out = "";
  let cursor = 0;
  for (const span of merged) {
    out += text.slice(cursor, span.start) + REDACTED;
    cursor = span.end;
  }
  return out + text.slice(cursor);
}

/** Dedupes and drops the empty string. Order is irrelevant: spans are merged. */
function secretsOf(...secrets: string[]): readonly string[] {
  return [...new Set(secrets.filter((secret) => secret !== ""))];
}

/**
 * Replaces every secret with REDACTED, matching the text as it arrived *and*
 * both readings of its decoded form. All three passes are needed: the decoded
 * forms catch a credential that was encoded on the way in, and the raw pass
 * catches a secret that itself contains a `%` or a `+`, which decoding rewrites.
 */
function strip(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0 || text === "") {
    return text;
  }

  const readings = [
    decodeWithSpans(text, true),
    decodeWithSpans(text, false),
  ];
  const hits: Span[] = [];

  for (const secret of secrets) {
    for (const at of occurrences(text, secret)) {
      hits.push({ start: at, end: at + secret.length });
    }
    for (const { decoded, spans } of readings) {
      for (const at of occurrences(decoded, secret)) {
        hits.push({
          start: spans[at].start,
          end: spans[at + secret.length - 1].end,
        });
      }
    }
  }

  return redactSpans(text, hits);
}

/**
 * Whether the raw endpoint url is itself a secret.
 *
 * It is, but only when sanitising it actually takes something away. undici
 * quotes the raw url back at us -- "Failed to parse URL from <the raw url>",
 * query and all -- so a url carrying userinfo, a query or a fragment must not
 * reach a message through any channel. A url carrying none of those *is* its
 * own sanitised form, and calling it a secret then redacts the endpoint out of
 * every body that legitimately names it: it destroys the diagnostic to protect
 * nothing. A url that will not parse is the worst case, not the safe one --
 * nothing could be stripped out of it, so all of it is a secret.
 */
function carriesCredential(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.search !== "" ||
      parsed.hash !== ""
    );
  } catch {
    return true;
  }
}

export class UpstreamClient {
  private readonly url: string;
  private readonly apiKey: string;

  /**
   * The endpoint as it is allowed to appear in a message: origin and path,
   * nothing else. CRISPY_MCP_URL is user-supplied and unrestricted, so a
   * credential may well be sitting in a query component or in userinfo -- and
   * these messages go to stderr *and* back to the client as a JSON-RPC error.
   * Nothing may interpolate `url`; interpolate this.
   */
  private readonly safeUrl: string;

  /** The api key alone. Sanitises the url itself; see snippet(). */
  private readonly keySecrets: readonly string[];

  /** Everything that may not appear in a message. See snippet(). */
  private readonly secrets: readonly string[];
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly teardownTimeoutMs: number;
  private readonly bodyReadTimeoutMs: number;

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
    this.keySecrets = secretsOf(options.apiKey);
    this.safeUrl = this.endpointForMessage(options.url);
    this.secrets = secretsOf(
      ...(carriesCredential(options.url) ? [options.url] : []),
      options.apiKey,
    );
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.teardownTimeoutMs =
      options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
    this.bodyReadTimeoutMs =
      options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;
  }

  /**
   * The sink, and the only way an untrusted string may enter a message: a
   * platform error, an upstream body, a status line, a header. It scrubs and
   * then cuts down to a snippet, and that order is the whole of one bug --
   * cutting first split a credential that straddled the boundary, and half a
   * credential matches nothing a whole-key search looks for, so the surviving
   * prefix went to stderr and into the JSON-RPC error. Cutting after scrubbing
   * can only ever land on text that is already safe.
   *
   * Sanitising the url where *we* interpolate it is not enough, because we are
   * not the only one who can put it in a message. undici rejects an
   * unparseable url with "Failed to parse URL from <the raw url>", query and
   * all, and that wording becomes the failure reason we go on to quote. So a
   * url that carries anything is a secret exactly as the key is: nothing
   * derived from it may enter a message. See carriesCredential().
   *
   * This runs on the untrusted fragments, never on the assembled message:
   * safeUrl is the sanitised url and is allowed to stay.
   */
  private snippet(text: string): string {
    const scrubbed = strip(
      text.length > MAX_SCRUB_INPUT ? text.slice(0, MAX_SCRUB_INPUT) : text,
      this.secrets,
    );
    return scrubbed.length > MAX_BODY_SNIPPET
      ? `${scrubbed.slice(0, MAX_BODY_SNIPPET)}...`
      : scrubbed;
  }

  /**
   * Reduces the endpoint to the part that identifies it and drops the parts
   * that can carry a credential. Matching the key as a string is not enough:
   * a key in a query component is percent-encoded, so `?api_key=a%20b` shares
   * no substring with the key `a b` and survives a literal match untouched.
   *
   * Parsing is defensive on purpose. This runs on the error path, so a url the
   * URL parser rejects must produce a worse message, never a thrown one. Worse
   * means less: a url that will not parse is the one this function can strip
   * nothing out of, so echoing it -- even through the sink -- prints back
   * whatever credential it carries. Name the setting instead. That is enough
   * to find the problem, since the default url always parses, so an
   * unparseable one can only have come from CRISPY_MCP_URL.
   */
  private endpointForMessage(url: string): string {
    try {
      const parsed = new URL(url);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return strip(parsed.toString(), this.keySecrets);
    } catch {
      return "the configured endpoint (CRISPY_MCP_URL is not a valid url)";
    }
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

  /**
   * The only exit from this client, and the last place anything can be
   * sanitised. bridge.ts copies whatever comes out of here to stderr and into
   * the JSON-RPC error it hands the client, and bridge.ts holds neither the key
   * nor the url, so it cannot sanitise a thing. dispatch() has unwrapped awaits
   * in it -- `response.text()` on the happy path rejects with a platform error
   * worded by the platform -- and a stray error escaping raw is a leak. An
   * UpstreamError has already been through the sink; anything else has not.
   */
  async send(message: unknown): Promise<unknown | null> {
    try {
      return await this.dispatch(message);
    } catch (error) {
      if (error instanceof UpstreamError) {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(
        `The exchange with Crispy at ${this.safeUrl} failed: ${this.snippet(reason)}`,
        "network",
      );
    }
  }

  private async dispatch(message: unknown): Promise<unknown | null> {
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
          `Crispy did not respond within ${this.timeoutMs}ms: the request to ${this.safeUrl} timed out.`,
          "network",
        );
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new UpstreamError(
        `Could not reach Crispy at ${this.safeUrl}: ${this.snippet(reason)}`,
        "network",
      );
    } finally {
      clearTimeout(timer);
    }

    // A session exists only if the server accepted the request that created
    // it. Adopting before this check let a 500 install an id that no handshake
    // stands behind, and let a 404 install one and invalidate it in the same
    // breath while the caller was told its session had merely expired.
    if (!response.ok) {
      throw await this.httpError(response, sentSessionId, generation);
    }

    const sessionId = response.headers.get("mcp-session-id");
    if (
      sessionId !== null &&
      sessionId !== "" &&
      // Teardown bumps the generation unconditionally -- see endSession -- and
      // the counter only ever climbs, so no request that left before the signal
      // can still match it. That makes this one check the whole fence: a
      // `!this.stopped` term beside it could not fail on its own and no test
      // could hold it honest.
      generation === this.sessionGeneration
    ) {
      generation = this.adoptSession(sessionId);
    }

    const body = await this.readBody(response);
    if (generation === this.sessionGeneration) {
      this.rememberProtocolVersion(body);
    }
    return body;
  }

  /**
   * Records the id the upstream assigned and returns the generation the caller
   * is now in. Adopting an id -- any id, including the first -- moves the
   * session on, so everything still in flight under the old state is fenced
   * off. Bumping only when the id *changed* left the opening case unfenced:
   * two requests that both leave before any session exists snapshot the same
   * generation, and the second would sail through the guard and replace what
   * the first had just adopted.
   */
  private adoptSession(sessionId: string): number {
    if (this.sessionId === sessionId) {
      return this.sessionGeneration;
    }

    // A replacement is a new session, and the protocol version was negotiated
    // with the old one. rememberProtocolVersion only writes into an empty
    // slot, so leaving it behind would pin the new session to the old
    // session's version on every later request.
    if (this.sessionId !== undefined) {
      this.protocolVersion = undefined;
    }

    this.sessionId = sessionId;
    this.sessionGeneration += 1;
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
    // The spec lets the server drop a session whenever it likes and answer
    // anything still carrying that id with a 404. Retrying is not ours to do:
    // only the client can re-run initialize, so drop the dead state and say so.
    //
    // The status and the id we sent are both known the moment the headers
    // arrive, and that is when this has to be decided. Reading the body first
    // meant a 404 whose body stream never closed left the dead session
    // installed for good -- the request timeout was cleared as soon as the
    // headers landed, so nothing was going to interrupt that read, and every
    // later request kept sending an id the server had already dropped. A body
    // is a diagnostic detail; it must never gate a state transition.
    const expired = response.status === 404 && sentSessionId !== undefined;
    if (expired && generation === this.sessionGeneration) {
      this.invalidateSession();
    }

    const body = this.snippet((await this.safeText(response)).trim());

    if (expired) {
      // A wrong CRISPY_MCP_URL, a bad deploy and a genuinely dropped session
      // all look like this. The advice is right for the common case, but the
      // status has to survive or a misrouted endpoint is undiagnosable.
      const status = this.snippet(
        `HTTP ${response.status} ${response.statusText}`.trim(),
      );
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
      this.snippet(
        `Crispy returned HTTP ${response.status} ${response.statusText}`.trim(),
      ) + (body === "" ? "" : `: ${body}`),
      "http",
    );
  }

  /**
   * Tells Crispy the session is finished, per the Streamable HTTP spec's
   * DELETE. Best effort by design: shutdown must not be blocked by a server
   * that is slow, unreachable, or answers 405 because it has no teardown.
   */
  async endSession(): Promise<void> {
    // Teardown fences what is already in flight as well as what comes after
    // it. `stopped` turns away new sends; the unconditional generation bump
    // below fences every response that snapshotted the live generation on its
    // way out, including one that is past the `stopped` check already. Both
    // jobs are needed, and the bump has to happen even when there is no cached
    // id -- returning early without it used to let an initialize that left
    // before the signal come back afterwards and quietly become live state.
    //
    // Such a late id is abandoned, not DELETEd. Deleting it would mean opening
    // a fresh bounded request after the shutdown handshake has already spent
    // its deadline -- the process may be gone before it lands, and the caller
    // would be waiting on a second teardown it never asked for. Abandoning is
    // safe because the id never enters this client: nothing can send under it,
    // and the server reaps an untouched session on its own idle timeout.
    this.stopped = true;

    const sessionId = this.sessionId;
    const headers = this.headers();
    this.invalidateSession();

    if (sessionId === undefined) {
      return;
    }

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

  /**
   * A failed response's body, for a diagnostic and nothing else. Bounded in its
   * own right: the request timeout was cleared the moment the headers arrived,
   * so a body stream that never closes would hang this read for ever. A missing
   * detail makes a worse message; a read that never returns makes no message at
   * all.
   */
  private async safeText(response: Response): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reading = response.text();
      // Past the deadline nobody awaits `reading` any more, so its rejection
      // needs an owner of its own or it surfaces as an unhandled one.
      void reading.catch(() => undefined);

      const deadline = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.bodyReadTimeoutMs);
      });

      const text = await Promise.race([reading, deadline]);
      if (text === null) {
        // Let the socket go; nothing is going to read the rest of it.
        void response.body?.cancel().catch(() => undefined);
        return "";
      }
      return text;
    } catch {
      return "";
    } finally {
      clearTimeout(timer);
    }
  }

  private async readBody(response: Response): Promise<unknown | null> {
    if (response.status === 202 || response.status === 204) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    // Unwrapped on purpose: a torn body rejects here with a platform error, and
    // send() is what makes sure nothing leaves this client unsanitised.
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
        `Crispy returned a response that is not JSON: ${this.snippet(text)}`,
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
