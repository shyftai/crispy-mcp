import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const BIN = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built binary. `stdin` is written verbatim, so tests can speak
 * newline-delimited JSON-RPC at it the way an MCP client would.
 */
function run(
  env: Record<string, string>,
  stdin = "",
  args: string[] = [],
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("the bridge did not exit; it hung"));
    }, 15_000);

    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });

    child.stdin.end(stdin);
  });
}

const KEY = "fake-test-key-cli-only";
/** Port 1 is reserved and closed, so this fails fast with no network. */
const DEAD_URL = "http://127.0.0.1:1/api/mcp";

describe("crispy-mcp binary", () => {
  it("exits non-zero and names both ways to pass a key when none is set", async () => {
    const result = await run({});

    expect(result.code).not.toBe(0);
    expect(result.code).toBeGreaterThan(0);
    expect(result.stderr).toContain("CRISPY_API_KEY");
    expect(result.stderr).toContain("--api-key");
    expect(result.stderr).toContain("https://crispy.sh/dashboard/api-keys");
    expect(result.stdout).toBe("");
  });

  it("exits non-zero when the key is blank", async () => {
    const result = await run({ CRISPY_API_KEY: "  " });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("CRISPY_API_KEY");
  });

  it("answers an unreachable endpoint with a JSON-RPC error and no key in sight", async () => {
    const request = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "0.0.0" },
      },
    })}\n`;

    const result = await run(
      { CRISPY_API_KEY: KEY, CRISPY_MCP_URL: DEAD_URL },
      request,
    );

    const response = JSON.parse(result.stdout.trim().split("\n")[0]) as {
      id: number;
      error: { code: number; message: string };
    };
    expect(response.id).toBe(1);
    expect(response.error.message).toMatch(/could not reach crispy/i);
    expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
  });

  it("takes the key from --api-key without leaking it", async () => {
    const result = await run({ CRISPY_MCP_URL: DEAD_URL }, "", [
      "--api-key",
      KEY,
    ]);

    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(KEY);
  });
});
