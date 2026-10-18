import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * SKILL.md is shipped to agent skill marketplaces and read by agents that then
 * call whatever it names. Nothing in `src/` registers a tool: the bridge
 * forwards `initialize`, `tools/list` and `tools/call` verbatim and adds no
 * tools of its own, so the only true tool list is the one the hosted server
 * returns at runtime. A tool name printed in SKILL.md is therefore a name that
 * may answer to nothing, and the agent that reads it will call it anyway.
 *
 * So the invariant is "every tool name SKILL.md cites is registered in src/".
 * Today that set is empty and SKILL.md names no tools. The failure names the
 * fix, which is to describe the job in prose and let the agent read `tools/list`.
 */
function readRepositoryFile(name: string): string {
  const path = new URL(`../${name}`, import.meta.url);
  return readFileSync(path, "utf8");
}

const SKILL = "skills/crispy-linkedin/SKILL.md";
const SKILL_DIRECTORY = "crispy-linkedin";

/**
 * A tool name in SKILL.md is either a bare inline code span, or any
 * lower snake_case word anywhere in the file. Both spellings are reserved for
 * tool names there. Uppercase env vars, `tools/list`, URLs and multi-word code
 * spans fall outside both patterns, so the file can still quote config.
 */
const INLINE_CODE_SPAN = /`([^`\n]+)`/g;
const BARE_TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const SNAKE_CASE_WORD = /\b[a-z][a-z0-9]*_[a-z0-9_]*\b/g;

function citedToolNames(markdown: string): string[] {
  const cited = new Set<string>();

  for (const match of markdown.matchAll(INLINE_CODE_SPAN)) {
    const token = match[1].trim();
    if (BARE_TOOL_NAME.test(token)) {
      cited.add(token);
    }
  }
  for (const match of markdown.matchAll(SNAKE_CASE_WORD)) {
    cited.add(match[0]);
  }

  return [...cited].sort();
}

/**
 * The registration shapes this scan understands. A tool registered another way
 * is not picked up here, which fails the check below loudly once somebody
 * writes the name in SKILL.md. That is the safe direction, since the fix is a
 * one line addition to this pattern rather than a stale name in public copy.
 */
const TOOL_REGISTRATION = /\b(?:registerTool|tool)\(\s*["']([a-z][a-z0-9_-]*)["']/g;

function toolNamesInSource(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(TOOL_REGISTRATION)) {
    names.add(match[1]);
  }
  return names;
}

function registeredToolNames(): Set<string> {
  const directory = new URL("../src/", import.meta.url);
  const names = new Set<string>();

  for (const entry of readdirSync(directory)) {
    if (!entry.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(new URL(entry, directory), "utf8");
    for (const name of toolNamesInSource(source)) {
      names.add(name);
    }
  }

  return names;
}

const skill = readRepositoryFile(SKILL);

/** The single line `key: value` fields of the YAML frontmatter. */
function parseFrontmatter(markdown: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (block === null) {
    return {};
  }

  const fields: Record<string, string> = {};
  for (const line of block[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key !== "" && value !== "") {
      fields[key] = value;
    }
  }
  return fields;
}

const fields = parseFrontmatter(skill);

interface ServerJson {
  remotes?: Array<{ type: string; url: string }>;
}

const server = JSON.parse(readRepositoryFile("server.json")) as ServerJson;

describe("agent skill tool names", () => {
  // Presence first. An empty citation list and an empty registry agree about
  // nothing, so prove the skill is actually being read before asserting on it.
  it("reads the skill file", () => {
    expect(skill, `${SKILL} is empty`).not.toBe("");
  });

  it("cites only tool names that src/ registers", () => {
    const registered = registeredToolNames();
    const unregistered = citedToolNames(skill).filter(
      (name) => !registered.has(name),
    );

    expect(
      unregistered,
      `${SKILL} names tools that nothing registers. src/ defines no tools at all ` +
        `(it proxies tools/list unchanged), so the file must name none. Describe ` +
        `the job in prose and let the agent read the live tool list.`,
    ).toEqual([]);
  });

  // Each extractor above is the whole of the assertion, so both are held honest
  // here. A pattern that matched nothing would pass the check while a real
  // invented tool name walked into a marketplace listing.
  it.each([
    ["`search_people`", ["search_people"]],
    ["call `send-message` now", ["send-message"]],
    ["runs `linkedin_search_people` for it", ["linkedin_search_people"]],
    ["the send_message tool", ["send_message"]],
    ["`tools/list` then `https://crispy.sh/api/mcp`", []],
    ["reads the `CRISPY_API_KEY` env var", []],
    ["run `npx -y crispy-mcp` for it", []],
    ["no code here at all", []],
  ])("finds the tool names in %s", (markdown, expected) => {
    expect(citedToolNames(markdown)).toEqual(expected);
  });

  it.each([
    ['server.registerTool("search_people", handler)', ["search_people"]],
    ["server.tool('send_message', handler)", ["send_message"]],
    ["attachBridge({ transport, upstream });", []],
    ["const url = 'https://crispy.sh/api/mcp';", []],
  ])("finds the registered names in %s", (source, expected) => {
    expect([...toolNamesInSource(source)].sort()).toEqual(expected);
  });

  it("registers no tools in src/ today, which is why the skill names none", () => {
    expect(
      registeredToolNames().size,
      "src/ now registers tools. Name them in the skill where a workflow needs " +
        "one, then remove this tripwire.",
    ).toBe(0);
  });
});

describe("agent skill frontmatter", () => {
  it.each(["name", "description"])("has a %s field", (key) => {
    expect(fields[key], `${SKILL} has no ${key}`).toBeTypeOf("string");
    expect(fields[key], `${SKILL} has an empty ${key}`).not.toBe("");
  });

  it("names the skill after its directory", () => {
    expect(fields.name).toBe(SKILL_DIRECTORY);
  });

  it("keeps name inside the limits every marketplace enforces", () => {
    expect(fields.name.length, "name is longer than 64 characters").toBeLessThan(
      65,
    );
    expect(
      fields.name,
      "name must be lowercase letters, digits and hyphens",
    ).toMatch(/^[a-z0-9-]+$/);
  });

  it("keeps description inside the limits every marketplace enforces", () => {
    expect(
      fields.description.length,
      "description is longer than 1024 characters",
    ).toBeLessThan(1025);
    expect(
      fields.description,
      "description must say when to use the skill",
    ).toMatch(/\buse when\b/i);
  });
});

describe("agent skill connection details", () => {
  /** Every URL the skill prints must be one this repo already states. */
  const remoteUrls = (server.remotes ?? []).map((entry) => entry.url);

  it("points at the endpoint server.json publishes", () => {
    expect(
      remoteUrls,
      "server.json has no remote endpoint to check the skill against",
    ).not.toEqual([]);
    for (const url of remoteUrls) {
      expect(skill, `${SKILL} does not cite ${url}`).toContain(url);
    }
  });

  it("invents no endpoint of its own", () => {
    const stated = [
      readRepositoryFile("README.md"),
      readRepositoryFile("server.json"),
      readRepositoryFile("src/config.ts"),
    ].join("\n");

    const urls = [...skill.matchAll(/https:\/\/[^\s`"'<>)]+/g)].map(
      (match) => match[0],
    );

    expect(urls, `${SKILL} cites no URL at all`).not.toEqual([]);
    for (const url of urls) {
      expect(
        stated,
        `${SKILL} cites ${url}, which README.md, server.json and src/config.ts do not state`,
      ).toContain(url);
    }
  });
});
