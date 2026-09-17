import { describe, expect, it } from "vitest";

import {
  ConfigError,
  DEFAULT_CRISPY_MCP_URL,
  resolveConfig,
} from "../src/config";

const KEY = "crispy_test_key_abc123";

describe("resolveConfig", () => {
  it("reads the api key from CRISPY_API_KEY", () => {
    const config = resolveConfig([], { CRISPY_API_KEY: KEY });

    expect(config.apiKey).toBe(KEY);
  });

  it("reads the api key from --api-key <key>", () => {
    const config = resolveConfig(["--api-key", KEY], {});

    expect(config.apiKey).toBe(KEY);
  });

  it("reads the api key from --api-key=<key>", () => {
    const config = resolveConfig([`--api-key=${KEY}`], {});

    expect(config.apiKey).toBe(KEY);
  });

  it("prefers the --api-key flag over the environment variable", () => {
    const config = resolveConfig(["--api-key", KEY], {
      CRISPY_API_KEY: "env_key_should_lose",
    });

    expect(config.apiKey).toBe(KEY);
  });

  it("treats a blank environment variable as missing", () => {
    expect(() => resolveConfig([], { CRISPY_API_KEY: "   " })).toThrow(
      ConfigError,
    );
  });

  it("names CRISPY_API_KEY, --api-key and the dashboard url when the key is missing", () => {
    let message = "";
    try {
      resolveConfig([], {});
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("CRISPY_API_KEY");
    expect(message).toContain("--api-key");
    expect(message).toContain("https://crispy.sh/dashboard/api-keys");
  });

  it("defaults to the production endpoint", () => {
    const config = resolveConfig([], { CRISPY_API_KEY: KEY });

    expect(config.url).toBe(DEFAULT_CRISPY_MCP_URL);
    expect(DEFAULT_CRISPY_MCP_URL).toBe("https://crispy.sh/api/mcp");
  });

  it("honours the CRISPY_MCP_URL override", () => {
    const config = resolveConfig([], {
      CRISPY_API_KEY: KEY,
      CRISPY_MCP_URL: "http://127.0.0.1:9999/api/mcp",
    });

    expect(config.url).toBe("http://127.0.0.1:9999/api/mcp");
  });

  it("rejects --api-key with no value", () => {
    expect(() => resolveConfig(["--api-key"], {})).toThrow(ConfigError);
  });
});
