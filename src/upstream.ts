/**
 * Minimal Streamable HTTP client for the hosted Crispy MCP endpoint.
 *
 * It is deliberately dumb: whatever JSON-RPC message arrives from the local
 * stdio client is posted upstream untouched, and whatever the upstream returns
 * is handed back untouched. The bridge does not know or care which tools
 * Crispy exposes.
 */

import { API_KEYS_URL, DEFAULT_CRISPY_MCP_URL } from "./config.js";

/**
 * The path of the endpoint we ship. It is a constant of ours, so a message may
 * print it; see endpointForMessage(). Any other path came from CRISPY_MCP_URL.
 */
const DEFAULT_ENDPOINT_PATH = new URL(DEFAULT_CRISPY_MCP_URL).pathname;

/**
 * The request's patience, and the same number twice: it bounds the wait for the
 * response headers, and then it bounds the GAP between the body's chunks. A
 * body that keeps arriving is never cut off however large it is; a body that
 * stops arriving fails closed. See readBounded().
 */
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

/**
 * Subtraction is sound on a string WE originate and never on a string an
 * upstream chooses.
 *
 * Everything below this line is the sink for our own strings: the platform's
 * wording (undici quotes our url back at us) and the url itself. We know what
 * is in them, so removing a secret from them leaves something meaningful.
 *
 * An upstream body gets the opposite treatment -- see detailFrom(). Three
 * rounds of hardening a redactor against attacker-chosen bytes found a new
 * encoding every time, because subtraction inside text somebody else wrote is
 * a game the writer always moves last in. Messages are CONSTRUCTED out of
 * allowed parts instead, so there is nothing left to defeat.
 */

/** What a message is allowed to show of a string we originate. */
const MAX_PLATFORM_REASON = 500;

/**
 * What a message is allowed to show of the one field lifted out of an upstream
 * body. A Crispy error sentence sits well inside this; the cap is here because
 * the field crossed the wire and an upstream can say anything.
 */
const MAX_UPSTREAM_DETAIL = 300;

/**
 * The shortest run of a secret that is worth hiding on its own.
 *
 * F1 and F3 were both "63 characters of a 64-character key reach the message".
 * Checking for the whole key only would hand the same prefix back the moment an
 * upstream echoed a truncated one -- and truncating a credential before logging
 * it is what a careful server does, so this is the likely case, not the exotic
 * one. Sixteen characters is long enough not to fire on a shared key prefix
 * like `sk-live-`, which any body explaining the key format will contain.
 */
const MIN_SECRET_RUN = 16;

/** The reason phrase is bounded by the HTTP grammar. Bound it here too. */
const MAX_STATUS_TEXT = 80;

/** How much of a failed response's body is kept to look for that one field. */
const MAX_DIAGNOSTIC_BYTES = 64 * 1024;

/**
 * Plain printable ascii, minus `%`.
 *
 * What passes this class cannot be a percent escape, a control sequence a
 * terminal will act on, a bidi override, or a homoglyph. That is what makes the
 * secret check in carriesSecret() sound where a redactor was not: inside this
 * class the only reading left for a credential to hide under is form-encoding's
 * `+` for a space, and that is one line to cover rather than an open list.
 *
 * A field that fails the class is dropped whole. It is not sanitised: sanitising
 * is what leaves a remainder, and every bug the last three rounds found lived in
 * a remainder.
 */
const PLAIN_TEXT = /^[ -$&-~]+$/;

const REDACTED = "[redacted]";

/** A half-open range of the original text that must not survive into a message. */
interface Span {
  start: number;
  end: number;
}

const ESCAPE = /^%[0-9A-Fa-f]{2}/;

const UTF8 = new TextDecoder("utf-8", { fatal: false });

const BYTES = new TextEncoder();

/**
 * Percent-decodes `text` and records, for every code unit of the result, the
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
 * covered. That used to be a hole because upstream bodies came through here;
 * they do not any more, and nothing we originate encodes itself twice.
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
    if (!ESCAPE.test(text.slice(i, i + 3))) {
      decoded += plusAsSpace && text[i] === "+" ? " " : text[i];
      spans.push({ start: i, end: i + 1 });
      i += 1;
      continue;
    }

    // A non-ascii character arrives as several escapes in a row and only the
    // decoder knows how many, so feed it one byte at a time and attribute what
    // it emits to exactly the escapes consumed since it last emitted anything.
    //
    // Pointing every character of the run at the whole run instead fails
    // closed -- a match anywhere takes all of it -- but it destroys the text
    // around the match: matching `e` in `%61%62%C3%A9%63%64` redacted the
    // encoded `abecd` entire. Losing the diagnostic to protect the part of it
    // that was never at risk is still a loss.
    const decoder = new TextDecoder("utf-8", { fatal: false });
    let pending = i;

    const attribute = (out: string): void => {
      if (out === "") {
        return;
      }
      // One span per code unit, not per code point: a match is found with
      // indexOf, whose indices are code units, and an emoji is two of them.
      for (let unit = 0; unit < out.length; unit += 1) {
        spans.push({ start: pending, end: i });
      }
      decoded += out;
      pending = i;
    };

    while (ESCAPE.test(text.slice(i, i + 3))) {
      const byte = Number.parseInt(text.slice(i + 1, i + 3), 16);
      i += 3;
      attribute(decoder.decode(new Uint8Array([byte]), { stream: true }));
    }
    // An incomplete sequence at the end of the run flushes as U+FFFD.
    attribute(decoder.decode());
  }

  return { decoded, spans };
}

/**
 * Every index at which `needle` occurs in `haystack`, overlaps included.
 *
 * Advancing by the needle's length instead skipped every occurrence that began
 * inside the one before it, so a self-overlapping key left its tail behind:
 * 127 `A`s against a 64-`A` key redacted the first 64 and printed 63. Spans are
 * merged afterwards, so overlapping hits cost nothing.
 */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + 1)
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

/**
 * Every window of `secret` long enough to be worth hiding on its own, so that
 * finding one of them is finding the secret. A secret no longer than the window
 * is its own only window.
 */
function runsOf(secret: string): readonly string[] {
  if (secret.length <= MIN_SECRET_RUN) {
    return [secret];
  }
  const runs: string[] = [];
  for (let at = 0; at + MIN_SECRET_RUN <= secret.length; at += 1) {
    runs.push(secret.slice(at, at + MIN_SECRET_RUN));
  }
  return runs;
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
 *
 * Nothing is cut before this runs. Cutting first is what round 6 found -- a
 * credential straddling the cut lost its tail, and half a credential matches
 * nothing a whole-key search looks for -- and cutting at a bound far past the
 * snippet was no better, because redaction COMPRESSES: 1023 adjacent keys merge
 * into one `[redacted]` and pull the 64-KiB mark back inside the snippet. The
 * only safe order is scrub everything, then cut.
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

/** The one field a message may quote out of a JSON error body, or nothing. */
function errorFieldOf(text: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return undefined;
  }

  // OBSERVED 2026-09-20, POST https://crispy.sh/api/mcp with a bad bearer:
  // {"error":"Invalid API key. ...","retryable":false,"suggestion":"..."}.
  // The same endpoint also speaks JSON-RPC, whose error is an object with a
  // message. Those are the two shapes of one field, not two fields.
  const error = (parsed as { error?: unknown }).error;
  if (typeof error === "string") {
    return error;
  }
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return undefined;
}

/** Joins what was retained of a body. */
function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** What a bounded read of a response body came back with. */
interface BodyRead {
  /** What was retained, decoded. Not necessarily the whole body. */
  text: string;
  /** Byte length of everything that arrived, retained or not. */
  bytes: number;
  /** False if the read hit its deadline or its retention cap. */
  complete: boolean;
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

  /** The api key alone. Sanitises the url itself; see endpointForMessage(). */
  private readonly keySecrets: readonly string[];

  /** Everything that may not appear in a message. */
  private readonly secrets: readonly string[];

  /** The runs of those secrets that carriesSecret() rejects a string for. */
  private readonly secretRuns: readonly string[];
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
    // The raw url is a secret exactly when the safe url is not the raw url.
    //
    // undici quotes the raw url back at us -- "Failed to parse URL from <the
    // raw url>" -- so anything endpointForMessage() dropped would walk back in
    // through the platform's own wording. Deriving that from the reduction
    // itself, rather than from a second predicate listing the parts that can
    // carry a credential, is what closes the gap: the old predicate knew about
    // userinfo, query and fragment and did not know a path segment can be a
    // credential too. A url that is already its own safe form is not a secret,
    // so a message that legitimately names it is not flattened.
    this.secrets = secretsOf(
      ...(this.safeUrl === options.url ? [] : [options.url]),
      options.apiKey,
    );
    this.secretRuns = this.secrets.flatMap((secret) => runsOf(secret));
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.teardownTimeoutMs =
      options.teardownTimeoutMs ?? DEFAULT_TEARDOWN_TIMEOUT_MS;
    this.bodyReadTimeoutMs =
      options.bodyReadTimeoutMs ?? DEFAULT_BODY_READ_TIMEOUT_MS;
  }

  /**
   * The sink for a string the PLATFORM worded for us, and the only one left.
   *
   * Sanitising the url where *we* interpolate it is not enough, because we are
   * not the only one who can put it in a message: undici rejects an unparseable
   * url with "Failed to parse URL from <the raw url>", query and all, and that
   * wording becomes the failure reason we go on to quote. bridge.ts copies
   * whatever comes out of here to stderr and into the JSON-RPC error, and
   * bridge.ts holds neither the key nor the url, so it cannot sanitise a thing.
   *
   * Scrub the whole string, then cut. Never the other way round: a credential
   * straddling the cut loses its tail, and half a credential matches nothing a
   * whole-key search looks for. There is no pre-cut here at all now -- the only
   * strings that reach this are ours, bounded by the url we were configured
   * with, so there is nothing to bound that scrubbing them would not already.
   *
   * This runs on the untrusted fragment, never on the assembled message:
   * safeUrl is the sanitised url and is allowed to stay.
   */
  private platformReason(text: string): string {
    const scrubbed = strip(text, this.secrets);
    return scrubbed.length > MAX_PLATFORM_REASON
      ? `${scrubbed.slice(0, MAX_PLATFORM_REASON)}...`
      : scrubbed;
  }

  /**
   * Whether a string that has already passed PLAIN_TEXT carries a secret.
   *
   * This is a rejection, not a subtraction: the caller drops the whole string.
   * That is the difference from the redactor this replaces -- a redactor keeps
   * a remainder and every round found a new way to get something into it,
   * whereas there is no remainder here to get wrong. The class check has ruled
   * out percent escapes already, so the only reading left that a credential
   * could hide under is form-encoding's `+` for a space.
   *
   * A long enough RUN of a secret is treated as the secret; see MIN_SECRET_RUN.
   */
  private carriesSecret(text: string): boolean {
    const readings = [text, text.replaceAll("+", " ")];
    return this.secretRuns.some((run) =>
      readings.some((reading) => reading.includes(run)),
    );
  }

  /**
   * The ONLY thing an upstream body may contribute to a message.
   *
   * No raw body text reaches a message. One field is lifted out of a JSON body
   * -- see errorFieldOf() -- and it is kept only if it parses, only if it is
   * plain printable text, and only if it carries no secret. Anything else is a
   * byte count and nothing more: unparseable, wrong shape, binary, truncated,
   * over-long.
   *
   * The checks run on the WHOLE field and the cut comes last. Capping first and
   * checking the cap is round 6's bug wearing a new hat: a key straddling the
   * cap would lose its tail and the prefix would sail through the check.
   */
  private detailFrom(read: BodyRead): string {
    if (read.bytes === 0) {
      return "";
    }

    const unshown = `<${read.bytes} bytes, not shown>`;
    if (!read.complete) {
      return unshown;
    }

    const field = errorFieldOf(read.text.trim())?.trim();
    if (
      field === undefined ||
      !PLAIN_TEXT.test(field) ||
      this.carriesSecret(field)
    ) {
      return unshown;
    }

    return field.length > MAX_UPSTREAM_DETAIL
      ? `${field.slice(0, MAX_UPSTREAM_DETAIL)}...`
      : field;
  }

  /**
   * `HTTP <code>`, plus the reason phrase when the wire sent one we are willing
   * to repeat. The code is a number and it is ours; the phrase crossed the wire,
   * so it gets the same class check and the same all-or-nothing drop the body
   * field gets. A misrouted endpoint is undiagnosable without the code, so the
   * code survives whatever happens to the phrase.
   */
  private statusLine(response: Response): string {
    const phrase = response.statusText.trim();
    const shown =
      phrase === "" || !PLAIN_TEXT.test(phrase) || this.carriesSecret(phrase)
        ? ""
        : phrase.length > MAX_STATUS_TEXT
          ? `${phrase.slice(0, MAX_STATUS_TEXT)}...`
          : phrase;

    return shown === ""
      ? `HTTP ${response.status}`
      : `HTTP ${response.status} ${shown}`;
  }

  /**
   * The endpoint as a message is allowed to name it: the origin, plus at most
   * the SHAPE of the path.
   *
   * The rule, in full:
   *   - userinfo, query and fragment: never.
   *   - the path: printed only when it is the default endpoint's path, which
   *     is a constant of ours and therefore carries nothing. Any other path is
   *     reduced to its segment count.
   *   - a url that will not parse: not printed at all. Name the setting.
   *
   * CRISPY_MCP_URL is user-supplied and unrestricted, and a path segment can be
   * a credential as easily as a query component can:
   * `https://crispy.test/token/hunter2/api/mcp` put `hunter2` into a diagnostic
   * that goes to stderr AND back to the client as a JSON-RPC error. Matching
   * the api key as a string is no defence -- a path credential need not be the
   * api key at all -- so no arbitrary path segment is printed, ever.
   *
   * Parsing is defensive on purpose. This runs on the error path, so a url the
   * URL parser rejects must produce a worse message, never a thrown one. Worse
   * means less: a url that will not parse is the one this function can strip
   * nothing out of, so echoing it prints back whatever credential it carries.
   * Naming the setting is enough to find the problem, since the default url
   * always parses -- an unparseable one can only have come from CRISPY_MCP_URL.
   */
  private endpointForMessage(url: string): string {
    const unnameable =
      "the configured endpoint (CRISPY_MCP_URL is not a valid url)";

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return unnameable;
    }

    // A scheme with no origin of its own identifies nothing, and "null" would
    // read as a hostname called null.
    if (parsed.origin === "null" || parsed.origin === "") {
      return unnameable;
    }

    const segments = parsed.pathname.split("/").filter((part) => part !== "");
    const shape =
      segments.length === 0
        ? ""
        : parsed.pathname === DEFAULT_ENDPOINT_PATH
          ? parsed.pathname
          : `/<${segments.length} path segment${segments.length === 1 ? "" : "s"}>`;

    return strip(`${parsed.origin}${shape}`, this.keySecrets);
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
        `The exchange with Crispy at ${this.safeUrl} failed: ${this.platformReason(reason)}`,
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
        `Could not reach Crispy at ${this.safeUrl}: ${this.platformReason(reason)}`,
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

    const body = this.detailFrom(await this.safeRead(response));
    const status = this.statusLine(response);

    if (expired) {
      // A wrong CRISPY_MCP_URL, a bad deploy and a genuinely dropped session
      // all look like this. The advice is right for the common case, but the
      // status has to survive or a misrouted endpoint is undiagnosable.
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
      `Crispy returned ${status}${body === "" ? "" : `: ${body}`}`,
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
   * Reads a response body under a bound of its own, owning the stream reader.
   *
   * Owning the reader is the point. `response.text()` locks the body, so the
   * `response.body.cancel()` that used to run at the deadline rejected on a
   * locked stream, the rejection was swallowed, and the original read carried
   * on holding the socket. Cancelling through a reader we hold actually
   * cancels: the pending read resolves done and the stream is released.
   *
   * `perChunk` chooses what the deadline measures. On the happy path it is the
   * GAP between chunks, because a total bound generous enough for a large slow
   * tool result would be far too generous to bound a wedge, while a gap bound
   * is both: a response that keeps arriving is never cut off, and one that
   * stops arriving is. On the error path it is the whole read, because that
   * body is a diagnostic nicety and no caller waiting for an answer should pay
   * more than a moment for one.
   */
  private async readBounded(
    response: Response,
    bound: { ms: number; perChunk: boolean },
    retainBytes = Number.POSITIVE_INFINITY,
  ): Promise<BodyRead> {
    const stream = response.body;
    if (stream === null) {
      // Nothing to read from and nothing to bound: a bodyless response.
      const text = await response.text();
      return { text, bytes: BYTES.encode(text).length, complete: true };
    }

    const reader = stream.getReader();
    let expired = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        expired = true;
        void reader.cancel().catch(() => undefined);
      }, bound.ms);
    };

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    let retained = 0;

    arm();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        if (value !== undefined) {
          bytes += value.byteLength;
          if (retained < retainBytes) {
            const room = retainBytes - retained;
            const kept =
              value.byteLength <= room ? value : value.subarray(0, room);
            chunks.push(kept);
            retained += kept.byteLength;
          }
          if (bound.perChunk) {
            arm();
          }
        }
      }
    } finally {
      clearTimeout(timer);
    }

    return {
      text: UTF8.decode(concatenate(chunks, retained)),
      bytes,
      complete: !expired && retained === bytes,
    };
  }

  /**
   * A failed response's body, for a diagnostic and nothing else. Bounded in its
   * own right: the request timeout was cleared the moment the headers arrived,
   * so a body stream that never closes would hang this read for ever. A missing
   * detail makes a worse message; a read that never returns makes no message at
   * all. Retention is bounded too -- past MAX_DIAGNOSTIC_BYTES there is no
   * error field worth finding, and the message falls back to the byte count.
   */
  private async safeRead(response: Response): Promise<BodyRead> {
    try {
      return await this.readBounded(
        response,
        { ms: this.bodyReadTimeoutMs, perChunk: false },
        MAX_DIAGNOSTIC_BYTES,
      );
    } catch {
      return { text: "", bytes: 0, complete: false };
    }
  }

  private async readBody(response: Response): Promise<unknown | null> {
    if (response.status === 202 || response.status === 204) {
      return null;
    }

    const contentType = response.headers.get("content-type") ?? "";
    // Unwrapped on purpose: a torn body rejects here with a platform error, and
    // send() is what makes sure nothing leaves this client unsanitised.
    const read = await this.readBounded(response, {
      ms: this.timeoutMs,
      perChunk: true,
    });

    // A 2xx whose body hangs used to never settle: this read had no deadline of
    // its own and the request timer was cleared when the headers arrived. That
    // is the wedge an expired session used to cause, reached through a
    // different door, and shipping a wedge inside the fix for a wedge is not
    // acceptable.
    if (!read.complete) {
      throw new UpstreamError(
        `Crispy stopped sending the response: the body from ${this.safeUrl} went quiet for ${this.timeoutMs}ms, so the read was abandoned.`,
        "network",
      );
    }

    const text = read.text;

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
      // Constructed, not scrubbed: this is an upstream body, so nothing of it
      // enters the message but its size. See detailFrom().
      throw new UpstreamError(
        `Crispy returned a response that is not JSON: <${read.bytes} bytes, not shown>`,
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
