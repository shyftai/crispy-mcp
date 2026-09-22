# Crispy — the LinkedIn MCP server for AI agents

**Full LinkedIn access for any AI agent, via MCP.** Connect Claude, Cursor, Codex, VS Code, JetBrains, n8n, or anything that speaks MCP, and run prospecting, messaging, and campaigns with safe limits built in.

- **Website:** https://crispy.sh
- **MCP endpoint:** `https://crispy.sh/api/mcp` (Streamable HTTP)
- **Auth:** `Authorization: Bearer <your API key>`
- **Local bridge:** `npx crispy-mcp` (stdio, for clients that cannot send headers)
- **Docs & per-client setup:** https://crispy.sh/integrations

Crispy is a hosted service, so there is no LinkedIn logic to run locally. This repository holds the connection config plus `crispy-mcp`, the official stdio bridge: a thin local MCP server that forwards every request to the hosted endpoint with your API key attached.

### Which one do I need?

| Your MCP client | Use this |
| --- | --- |
| Supports remote servers with custom headers (Claude Code, Cursor, VS Code, Windsurf, n8n) | The remote endpoint directly. Fewer moving parts, no local process. |
| Only supports local `command` / `args` servers, or cannot set headers | `npx crispy-mcp`, the stdio bridge below. |

The bridge is a transparent proxy. It does not define its own tools, so every tool Crispy ships is available through it the moment it goes live.

---

## What you can do

One API key gives any AI agent the full LinkedIn surface:

- **Find leads** — search people and companies, run saved searches, enrich profiles.
- **Message** — send connection requests, direct messages, and InMail; triage and reply in your inbox.
- **Run campaigns** — multi-step outreach sequences with human-like pacing.
- **Manage content** — draft, schedule, and analyze posts; track engagement.

Every account gets safe sending limits and warm-up by default, so automation stays sustainable.

---

## Quick start

1. Create an account at https://crispy.sh and connect your LinkedIn.
2. Generate an API key in the dashboard.
3. Add Crispy to your MCP client using one of the configs below. Replace `YOUR_API_KEY` with your key.

### Claude Code

```bash
claude mcp add --transport http crispy https://crispy.sh/api/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

### Claude Desktop

Claude Desktop connects remote servers through the Connectors settings: add a custom connector pointing at `https://crispy.sh/api/mcp` with the `Authorization: Bearer YOUR_API_KEY` header.

If your build cannot set a header, use the stdio bridge instead. `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "crispy": {
      "command": "npx",
      "args": ["-y", "crispy-mcp"],
      "env": {
        "CRISPY_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json`

```json
{
  "mcpServers": {
    "crispy": {
      "url": "https://crispy.sh/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### VS Code

```json
{
  "servers": {
    "crispy": {
      "url": "https://crispy.sh/api/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### Windsurf

`~/.codeium/windsurf/mcp_config.json`

```json
{
  "mcpServers": {
    "crispy": {
      "serverUrl": "https://crispy.sh/api/mcp",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

### n8n

1. Add an **MCP Client** node to your workflow.
2. Set the Server URL to `https://crispy.sh/api/mcp`.
3. Add a header: `Authorization` = `Bearer YOUR_API_KEY`.
4. The node auto-discovers all available tools.

### Any HTTP client (verify the connection)

```bash
curl -X POST https://crispy.sh/api/mcp \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

Full per-client walkthroughs (including JetBrains, Codex, and more) live at https://crispy.sh/integrations.

---

## The local stdio bridge: `npx crispy-mcp`

Some MCP clients can only launch a local process and cannot attach an `Authorization` header to a remote server. `crispy-mcp` closes that gap. It runs as a local stdio MCP server and proxies every request straight to `https://crispy.sh/api/mcp`, adding your API key on the way out.

```bash
CRISPY_API_KEY=YOUR_API_KEY npx -y crispy-mcp
```

It speaks MCP on stdin and stdout, so you normally let your client start it rather than running it by hand.

### Client config

Any client that takes a `command` and `args` uses the same shape:

```json
{
  "mcpServers": {
    "crispy": {
      "command": "npx",
      "args": ["-y", "crispy-mcp"],
      "env": {
        "CRISPY_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

Claude Code, from the command line:

```bash
claude mcp add crispy --env CRISPY_API_KEY=YOUR_API_KEY -- npx -y crispy-mcp
```

VS Code uses `servers` instead of `mcpServers`, with the same `command`, `args` and `env` keys.

### Options

| Setting | How to pass it | Default |
| --- | --- | --- |
| API key | `CRISPY_API_KEY` env var, or `--api-key <key>` | required, no default |
| Endpoint | `CRISPY_MCP_URL` env var | `https://crispy.sh/api/mcp` |
| Error detail | `CRISPY_MCP_UNSAFE_ERROR_DETAIL` env var, exactly `1` | off — see below |

Requires Node 18 or newer. Start it with no key and it exits non-zero, naming both ways to supply one and pointing at https://crispy.sh/dashboard/api-keys.

Your key is sent to Crispy and nowhere else. It is never written to a log line or into an error message, even if the upstream response happens to echo it back.

### What an error message may contain

When a request fails, the bridge builds the message out of four things and nothing else:

- the numeric HTTP status code,
- the byte length of the response body,
- its own fixed wording,
- the endpoint, reduced to its origin and the *shape* of its path.

So a failed call reads `Crispy returned HTTP 500: <54 bytes, not shown>`.

Not a byte of the response body or the HTTP reason phrase appears, however harmless it looks. Those are strings the server on the other end chooses, and any string can carry a credential in *some* printable encoding — base64, hex, `&#65;` entities. Filtering for the encodings somebody thought of is a game whose other player moves last. The bridge does not play it: these messages go to stderr *and* back to your MCP client as a JSON-RPC error, so it says only what it composed itself.

### `CRISPY_MCP_UNSAFE_ERROR_DETAIL`

That costs you a real diagnostic. `rate limit exceeded` from Crispy's own API becomes a byte count, and a 400 you are trying to debug becomes a number. Set `CRISPY_MCP_UNSAFE_ERROR_DETAIL=1` to get it back:

```json
{
  "mcpServers": {
    "crispy": {
      "command": "npx",
      "args": ["-y", "crispy-mcp"],
      "env": {
        "CRISPY_API_KEY": "YOUR_API_KEY",
        "CRISPY_MCP_UNSAFE_ERROR_DETAIL": "1"
      }
    }
  }
}
```

**`UNSAFE` is not decoration.** With it on, whatever the upstream put in the response body goes onto stderr and into your client's error field. If that server reflects your API key back — a proxy logging the `Authorization` header, a debug build echoing the request — your key lands wherever your client writes its errors. The bridge still subtracts the key from the text on a **best-effort** basis, and best-effort is the honest word for it: it catches a key echoed verbatim and is defeated by any encoding of one. Do not treat it as a safety net.

Only the exact value `1` turns it on. `true`, `yes`, `on` and `0` all leave it off, so it cannot be enabled by a truthy string pasted into a config. It changes nothing else: the endpoint is still reduced, the key is still never in a header dump, and every other bound is unchanged.

### Why it is a proxy and not a reimplementation

The bridge forwards `initialize`, `tools/list`, `tools/call` and every other method untouched, and returns the response untouched. There is no hardcoded tool list to go stale, so new Crispy tools work the day they ship.

---

## Why Crispy

- **Native MCP server, REST API, and CLI** — not a browser extension.
- **Works with any AI agent** — Claude, Cursor, Codex, VS Code, JetBrains, n8n, and anything that speaks MCP or HTTP.
- **Safe sending limits and warm-up built in** — sustainable by default.
- **One flat per-seat price, every tool included** — no add-ons, no per-action metering.
- **150+ LinkedIn tools from one API key.**

---

## Links

- Homepage: https://crispy.sh
- MCP server overview: https://crispy.sh/linkedin-mcp-server
- REST API: https://crispy.sh/linkedin-api
- Integrations & setup guides: https://crispy.sh/integrations
- Outreach benchmarks: https://crispy.sh/linkedin-outreach-benchmarks

## Development

The bridge lives in `src/`, with tests that mock the upstream endpoint and never touch the network.

```bash
npm install
npm run build
npm test
```

Point the bridge at a local test server with `CRISPY_MCP_URL`.

## License

MIT. See [LICENSE](LICENSE). This covers the `crispy-mcp` bridge, the documentation and the configuration in this repository; the Crispy service itself is proprietary.
