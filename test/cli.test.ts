import { spawn } from "node:child_process";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
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

/**
 * The whole chain, over a real socket: env var -> resolveConfig ->
 * UpstreamClient -> bridge -> the JSON-RPC error a client actually reads.
 *
 * Unit tests hold each link honest on its own, and every one of them stayed
 * green when index.ts stopped passing config.unsafeErrorDetail into the
 * client. That is the gap this closes: a flag that is read and never wired is
 * indistinguishable from a flag that works, from anywhere but here.
 */
describe("crispy-mcp error detail, end to end", () => {
  const SECRET_SOUNDING_BODY = JSON.stringify({ error: "rate limit exceeded" });

  /** A Crispy that fails every request with a 500 and a JSON error body. */
  function failingCrispy() {
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(500, "Too Many Requests From crispy-42", {
          "content-type": "application/json",
        });
        res.end(SECRET_SOUNDING_BODY);
      });
    });

    return {
      listen: (): Promise<string> =>
        new Promise((resolve) => {
          server.listen(0, "127.0.0.1", () => {
            const { port } = server.address() as AddressInfo;
            resolve(`http://127.0.0.1:${port}/api/mcp`);
          });
        }),
      close: (): Promise<void> =>
        new Promise((resolve) => server.close(() => resolve())),
    };
  }

  const REQUEST = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    },
  })}\n`;

  async function errorFrom(env: Record<string, string>): Promise<string> {
    const crispy = failingCrispy();
    const url = await crispy.listen();
    try {
      const result = await run(
        { CRISPY_API_KEY: KEY, CRISPY_MCP_URL: url, ...env },
        REQUEST,
      );
      const response = JSON.parse(result.stdout.trim().split("\n")[0]) as {
        error: { message: string };
      };
      return response.error.message;
    } finally {
      await crispy.close();
    }
  }

  it("gives a client the status and the byte count and nothing else", async () => {
    const message = await errorFrom({});

    expect(message).toContain("HTTP 500");
    expect(message).toContain(
      `<${Buffer.byteLength(SECRET_SOUNDING_BODY)} bytes, not shown>`,
    );
    expect(message).not.toContain("rate limit exceeded");
    expect(message).not.toContain("Too Many Requests From crispy-42");
  });

  it("gives a client the body when CRISPY_MCP_UNSAFE_ERROR_DETAIL is 1", async () => {
    const message = await errorFrom({ CRISPY_MCP_UNSAFE_ERROR_DETAIL: "1" });

    expect(message).toContain("rate limit exceeded");
  });

  // The reason phrase is upstream-chosen too, so the escape hatch does not buy
  // it back. Only the body detail is behind the flag.
  it("gives a client no reason phrase even with the flag on", async () => {
    const message = await errorFrom({ CRISPY_MCP_UNSAFE_ERROR_DETAIL: "1" });

    expect(message).not.toContain("Too Many Requests From crispy-42");
    expect(message).toContain("HTTP 500");
  });

  it.each(["true", "0", "yes"])(
    "leaves a client with the byte count for %j",
    async (value) => {
      const message = await errorFrom({
        CRISPY_MCP_UNSAFE_ERROR_DETAIL: value,
      });

      expect(message).not.toContain("rate limit exceeded");
      expect(message).toContain("bytes, not shown");
    },
  );
});

/**
 * A stand-in Crispy on loopback. It hands out a session id on initialize and
 * records the DELETE the bridge is expected to send on the way out. Nothing
 * here leaves the machine.
 */
function fakeCrispy(sessionId: string) {
  const deleted: Array<IncomingMessage> = [];
  let onDelete: (() => void) | undefined;

  const server = createServer((req, res) => {
    if (req.method === "DELETE") {
      deleted.push(req);
      res.writeHead(204).end();
      onDelete?.();
      return;
    }

    req.resume();
    req.on("end", () => {
      res.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: { protocolVersion: "2025-06-18" },
        }),
      );
    });
  });

  return {
    deleted,
    listen: (): Promise<string> =>
      new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const { port } = server.address() as AddressInfo;
          resolve(`http://127.0.0.1:${port}/api/mcp`);
        });
      }),
    close: (): Promise<void> =>
      new Promise((resolve) => server.close(() => resolve())),
    waitForDelete: (ms: number): Promise<boolean> =>
      new Promise((resolve) => {
        if (deleted.length > 0) {
          resolve(true);
          return;
        }
        const timer = setTimeout(() => resolve(false), ms);
        onDelete = () => {
          clearTimeout(timer);
          resolve(true);
        };
      }),
  };
}

describe("crispy-mcp shutdown", () => {
  // Both signals are registered, so both are exercised. Ctrl+C is the one a
  // human actually sends, and it is the one that was never covered.
  it.each(["SIGINT", "SIGTERM"] as const)(
    "ends the Crispy session with a DELETE before it exits on %s",
    async (signal) => {
      const crispy = fakeCrispy(`sess-cli-${signal}`);
      const url = await crispy.listen();

      const child = spawn(process.execPath, [BIN], {
        env: {
          PATH: process.env.PATH ?? "",
          CRISPY_API_KEY: KEY,
          CRISPY_MCP_URL: url,
        },
        stdio: ["pipe", "pipe", "pipe"],
      });

      try {
        const initialized = new Promise<void>((resolve) => {
          child.stdout.setEncoding("utf8");
          child.stdout.on("data", (chunk: string) => {
            if (chunk.includes("protocolVersion")) {
              resolve();
            }
          });
        });

        child.stdin.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              clientInfo: { name: "test", version: "0.0.0" },
            },
          })}\n`,
        );
        await initialized;

        const exited = new Promise<void>((resolve) =>
          child.on("close", () => resolve()),
        );
        child.kill(signal);

        expect(await crispy.waitForDelete(10_000)).toBe(true);
        expect(crispy.deleted[0].headers["mcp-session-id"]).toBe(
          `sess-cli-${signal}`,
        );
        expect(crispy.deleted[0].headers.authorization).toBe(`Bearer ${KEY}`);

        await exited;
      } finally {
        child.kill("SIGKILL");
        await crispy.close();
      }
    },
    20_000,
  );
});
