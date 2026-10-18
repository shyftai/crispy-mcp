---
name: crispy-linkedin
description: Run LinkedIn work through Crispy, the hosted LinkedIn MCP server. Use when the user wants to find leads, search people or companies, read a profile, send a connection request or a message, run an outreach campaign, handle replies, or manage posts on LinkedIn. Also use when the user asks to connect, configure or troubleshoot the Crispy MCP server in an agent.
license: MIT
---

# Crispy for LinkedIn

Crispy gives an agent full LinkedIn access over MCP. It is a hosted service, so
nothing about LinkedIn runs locally. This skill covers how you connect, how you
pick the right tool, and the limits you work inside.

## Connect

The MCP endpoint is `https://crispy.sh/api/mcp`. It speaks streamable HTTP.

Send the API key as a bearer token. The header is `Authorization`, and its value
is `Bearer YOUR_API_KEY`. Replace the placeholder with a real key.

Create or copy a key at `https://crispy.sh/dashboard/api-keys`.

Some MCP clients cannot attach a header to a remote server. For those, run the
local stdio bridge and let the client start it.

```bash
CRISPY_API_KEY=YOUR_API_KEY npx -y crispy-mcp
```

Set `CRISPY_API_KEY` in its environment. `CRISPY_MCP_URL` overrides the endpoint
the bridge forwards to, and you do not need it in normal use.

This server is published as `sh.crispy/crispy`.

## Pick the tool before you call it

Crispy publishes its tools from the server, not from this file. Read them first.

1. Ask the server for its tool list with `tools/list`.
2. Match the job to a tool by name and by the schema that comes back with it.
3. Check the arguments against that schema before you send anything.
4. If no tool does the job, stop and say so.

This file names no tools on purpose. The bridge forwards `tools/list` unchanged,
so only the live list is accurate. Never guess a tool name and never invent an
argument.

## Workflows

### Find leads

Search for the people and companies the user asked for. Show them the search
before you widen it. Say who you matched and how many, then ask what to do next.

### Read profiles

Read a profile when the user asks who someone is, or before you write to them.
Report what the profile says. Do not fill gaps with guesses.

### Send connection requests and messages

Draft the note first. Show the draft. Wait for the user to say yes. Send only
after they approve it, and send one at a time.

Crispy paces outbound sending. Do not try to work around the pacing.

### Run campaigns

A campaign is a multi-step outreach sequence with paced sending. Show the user
the steps and the audience before you start one. Get approval for the whole
sequence, then run it. Stop the campaign as soon as the user asks.

### Handle replies and posts

Triage the inbox and draft replies for approval before you send them. Draft,
schedule and analyse posts the same way. Show the draft before it goes out.

## Safety rules

- Stay inside the activity limits your account shows. Stop when you reach one,
  and tell the user which one you hit.
- Never mass-send. No bulk connection requests and no bulk messages. Ask for
  approval for each batch, and name the count and the audience when you ask.
- Draft first for anything that leaves the account.
- Keep the API key out of logs, files, messages and answers.
- Do not change the endpoint or the auth scheme. Both are fixed by the config in
  this repository.
- Leave `CRISPY_MCP_UNSAFE_ERROR_DETAIL` off. With it on, the text of a failed
  response lands in the error the user sees, and that text is not ours. Turn it
  on only if the user asks for it and understands the risk.
