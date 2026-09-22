/**
 * Resolves the runtime configuration for the Crispy stdio bridge.
 *
 * The API key is never logged, never echoed back in an error, and never
 * written anywhere other than the outgoing Authorization header.
 */

export const DEFAULT_CRISPY_MCP_URL = "https://crispy.sh/api/mcp";

export const API_KEYS_URL = "https://crispy.sh/dashboard/api-keys";

/**
 * Opts a message back into showing what a failed response's body said.
 *
 * Off by default, and off for every value but exactly `1`. A flag that any
 * truthy string enables is a flag that gets enabled by a `false` somebody typed
 * as a string, or by a `0` that reads as "off" everywhere else. The default is
 * the safe one, so the only value that may move off it is the one value nobody
 * types by accident.
 *
 * The name is the documentation: turning it on lets an upstream put whatever it
 * likes -- a credential it reflected back included -- onto stderr and into the
 * JSON-RPC error the client is handed. See the README.
 */
export const UNSAFE_ERROR_DETAIL_VAR = "CRISPY_MCP_UNSAFE_ERROR_DETAIL";

export const MISSING_KEY_MESSAGE = [
  "Crispy API key not found.",
  "",
  "Provide it in one of two ways:",
  "  1. Set the CRISPY_API_KEY environment variable.",
  "  2. Pass --api-key <key> on the command line.",
  "",
  `Create or copy a key at ${API_KEYS_URL}`,
].join("\n");

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface BridgeConfig {
  /** The Crispy API key, sent as `Authorization: Bearer <key>`. */
  apiKey: string;
  /** The upstream Streamable HTTP endpoint. */
  url: string;
  /** Whether a message may quote a failed response's body. See above. */
  unsafeErrorDetail: boolean;
}

type Env = Record<string, string | undefined>;

function apiKeyFromArgv(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--api-key") {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ConfigError(
          `--api-key requires a value.\n\n${MISSING_KEY_MESSAGE}`,
        );
      }
      return value;
    }

    if (arg.startsWith("--api-key=")) {
      return arg.slice("--api-key=".length);
    }
  }

  return undefined;
}

export function resolveConfig(
  argv: readonly string[],
  env: Env,
): BridgeConfig {
  const fromArgv = apiKeyFromArgv(argv);
  const apiKey = (fromArgv ?? env.CRISPY_API_KEY ?? "").trim();

  if (apiKey === "") {
    throw new ConfigError(MISSING_KEY_MESSAGE);
  }

  const url = (env.CRISPY_MCP_URL ?? "").trim() || DEFAULT_CRISPY_MCP_URL;

  const unsafeErrorDetail =
    (env[UNSAFE_ERROR_DETAIL_VAR] ?? "").trim() === "1";

  return { apiKey, url, unsafeErrorDetail };
}
