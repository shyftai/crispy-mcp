# Crispy — the LinkedIn MCP server for AI agents

**Full LinkedIn access for any AI agent, via MCP.** Connect Claude, Cursor, Codex, VS Code, JetBrains, n8n, or anything that speaks MCP, and run prospecting, messaging, and campaigns with safe limits built in.

- **Website:** https://crispy.sh
- **MCP endpoint:** `https://crispy.sh/api/mcp` (Streamable HTTP)
- **Auth:** `Authorization: Bearer <your API key>`
- **Docs & per-client setup:** https://crispy.sh/integrations

This repository is documentation and connection config only. Crispy is a hosted service — there is nothing to install or run locally beyond pointing your MCP client at the endpoint above.

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

Claude Desktop connects remote servers through the Connectors settings — add a custom connector pointing at `https://crispy.sh/api/mcp` with the `Authorization: Bearer YOUR_API_KEY` header. For header-less clients, bridge with `npx mcp-remote https://crispy.sh/api/mcp --header "Authorization: Bearer YOUR_API_KEY"`.

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

## License

MIT — see [LICENSE](LICENSE). This covers the documentation and configuration in this repository; the Crispy service itself is proprietary.
