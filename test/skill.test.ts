import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
 * A token in SKILL.md that could name a tool is read as a citation of one.
 *
 * One token alone in inline backticks is a citation whenever it looks like a
 * name. Any bare lowercase or hyphenated token in backticks is blocked, so
 * `stdio`, `npx`, `http` and `crispy-mcp` are all citations, and so are
 * `searchPeople` and `LinkedIn_search_people`. That is the safe side. Nothing
 * in src/ registers a tool, so the worst a false positive does is make somebody
 * reword the doc, while a false negative ships a name that answers to nothing
 * and that the agent reading the skill will call anyway. A snake_case word and
 * a camelCase word are citations wherever they turn up, even in prose, for the
 * same reason.
 *
 * A code span with several words in it, or a fenced block, is a command line,
 * and a command line names things that are no tools. Every token in one is
 * read the same way, with the two words an install command prints exempted.
 * `npx` names the runner and `crispy-mcp` names the bridge package, and no
 * tool answers to either of them.
 */
const INLINE_CODE_SPAN = /`([^`\n]+)`/g;
const FENCED_BLOCK = /```[^\n]*\n([\s\S]*?)```/g;
const WORD = /\S+/g;

const BARE_TOOL_NAME = /^[a-z][a-z0-9_-]*$/;
const CAMEL_CASE_NAME = /^[a-z]+(?:[A-Z][a-z0-9]*)+$/;
const SNAKE_CASE_NAME = /^(?![A-Z0-9_]+$)[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*$/;
const SNAKE_CASE_WORD = /\b(?![A-Z0-9_]+\b)[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]*\b/g;
const CAMEL_CASE_WORD = /\b[a-z]+(?:[A-Z][a-z0-9]*)+\b/g;

const RUNNER_WORDS = new Set(["bun", "bunx", "node", "npm", "npx", "pnpm", "yarn"]);

interface PackageJson {
  name: string;
  bin?: Record<string, string>;
}

const manifest = JSON.parse(readRepositoryFile("package.json")) as PackageJson;

const INSTALL_COMMAND_WORDS = new Set([
  ...RUNNER_WORDS,
  manifest.name,
  ...Object.keys(manifest.bin ?? {}),
]);

function tokens(fragment: string): string[] {
  return [...fragment.matchAll(WORD)].map((match) => match[0]);
}

/** The tool shaped tokens of one code span or one fenced block. */
function citedInCommand(fragment: string, standalone: boolean): string[] {
  const cited = new Set<string>();

  for (const token of tokens(fragment)) {
    if (CAMEL_CASE_NAME.test(token) || SNAKE_CASE_NAME.test(token)) {
      cited.add(token);
      continue;
    }
    if (!BARE_TOOL_NAME.test(token)) {
      continue;
    }
    if (standalone || !INSTALL_COMMAND_WORDS.has(token)) {
      cited.add(token);
    }
  }

  return [...cited];
}

function citedToolNames(markdown: string): string[] {
  const cited = new Set<string>();

  for (const match of markdown.matchAll(INLINE_CODE_SPAN)) {
    const span = match[1].trim();
    for (const name of citedInCommand(span, tokens(span).length === 1)) {
      cited.add(name);
    }
  }
  for (const match of markdown.matchAll(FENCED_BLOCK)) {
    for (const name of citedInCommand(match[1], false)) {
      cited.add(name);
    }
  }
  for (const match of markdown.matchAll(SNAKE_CASE_WORD)) {
    cited.add(match[0]);
  }
  for (const match of markdown.matchAll(CAMEL_CASE_WORD)) {
    cited.add(match[0]);
  }

  return [...cited].sort();
}

/**
 * The registration shapes this scan understands.
 *
 * A literal name in `registerTool("x")` or `tool("x")`, the same call with a
 * string constant in that position, and a file that answers
 * `setRequestHandler(ListToolsRequestSchema, ...)` and names its tools in
 * `name:` fields. Comments come out first, so a registration somebody
 * commented away is not a registration. Every file under src/ is read,
 * however deep it is nested. A tool registered in some other shape is not
 * picked up here, which fails the check below loudly once SKILL.md writes the
 * name. That is the safe direction, since the fix is a one line addition to
 * this pattern rather than a stale name in public copy.
 */
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /(^|\s)\/\/[^\n]*/g;

function withoutComments(source: string): string {
  return source.replace(BLOCK_COMMENT, " ").replace(LINE_COMMENT, "$1");
}

const NAME = "[A-Za-z][A-Za-z0-9_-]*";
const STRING_CONSTANT = new RegExp(
  `\\b(?:const|let|var)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*=\\s*["'](${NAME})["']`,
  "g",
);
const TOOL_REGISTRATION = new RegExp(
  `\\b(?:registerTool|tool)\\(\\s*["'](${NAME})["']`,
  "g",
);
const TOOL_REGISTRATION_BY_CONSTANT =
  /\b(?:registerTool|tool)\(\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
const LIST_TOOLS_HANDLER = /setRequestHandler\(\s*ListToolsRequestSchema/;
const TOOL_NAME_FIELD = new RegExp(`\\bname:\\s*["'](${NAME})["']`, "g");
const TOOL_NAME_FIELD_BY_CONSTANT = /\bname:\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;

function toolNamesInSource(source: string): Set<string> {
  const code = withoutComments(source);
  const names = new Set<string>();

  const constants = new Map<string, string>();
  for (const match of code.matchAll(STRING_CONSTANT)) {
    constants.set(match[1], match[2]);
  }

  const addResolved = (reference: string): void => {
    const value = constants.get(reference);
    if (value !== undefined) {
      names.add(value);
    }
  };

  for (const match of code.matchAll(TOOL_REGISTRATION)) {
    names.add(match[1]);
  }
  for (const match of code.matchAll(TOOL_REGISTRATION_BY_CONSTANT)) {
    addResolved(match[1]);
  }

  if (LIST_TOOLS_HANDLER.test(code)) {
    for (const match of code.matchAll(TOOL_NAME_FIELD)) {
      names.add(match[1]);
    }
    for (const match of code.matchAll(TOOL_NAME_FIELD_BY_CONSTANT)) {
      addResolved(match[1]);
    }
  }

  return names;
}

/** Every TypeScript file under `directory`, however deeply it is nested. */
function sourceFiles(directory: URL): URL[] {
  const files: URL[] = [];

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const url = new URL(
      entry.isDirectory() ? `${entry.name}/` : entry.name,
      directory,
    );
    if (entry.isDirectory()) {
      files.push(...sourceFiles(url));
    } else if (entry.name.endsWith(".ts")) {
      files.push(url);
    }
  }

  return files;
}

function registeredToolNames(
  directory: URL = new URL("../src/", import.meta.url),
): Set<string> {
  const names = new Set<string>();

  for (const file of sourceFiles(directory)) {
    for (const name of toolNamesInSource(readFileSync(file, "utf8"))) {
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
    ["call `searchPeople` to find leads", ["searchPeople"]],
    ["call `LinkedIn_search_people` to find leads", ["LinkedIn_search_people"]],
    ["run `send-message --limit 5` for it", ["send-message"]],
    ["```bash\nsend-message --limit 5\n```", ["send-message"]],
    ["the `crispy-mcp` binary", ["crispy-mcp"]],
    ["`tools/list` then `https://crispy.sh/api/mcp`", []],
    ["reads the `CRISPY_API_KEY` env var", []],
    ["run `npx -y crispy-mcp` for it", []],
    ["```bash\nCRISPY_API_KEY=YOUR_API_KEY npx -y crispy-mcp\n```", []],
    ["no code here at all", []],
  ])("finds the tool names in %s", (markdown, expected) => {
    expect(citedToolNames(markdown)).toEqual(expected);
  });

  it.each([
    ['server.registerTool("search_people", handler)', ["search_people"]],
    ["server.tool('send_message', handler)", ["send_message"]],
    [
      'const SEARCH_PEOPLE = "search_people";\n' +
        "server.registerTool(SEARCH_PEOPLE, handler);",
      ["search_people"],
    ],
    [
      'setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: "search_people" }] }));',
      ["search_people"],
    ],
    [
      'const SEARCH_PEOPLE = "search_people";\n' +
        "setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: SEARCH_PEOPLE }] }));",
      ["search_people"],
    ],
    ['// server.registerTool("search_people", handler)', []],
    ["/*\nserver.registerTool(\"search_people\", handler)\n*/", []],
    ["attachBridge({ transport, upstream });", []],
    ["const url = 'https://crispy.sh/api/mcp';", []],
  ])("finds the registered names in %s", (source, expected) => {
    expect([...toolNamesInSource(source)].sort()).toEqual(expected);
  });

  // The scan is only worth anything if it reaches every source file. A
  // directory read that stops at the top level of src/ misses a tool the day
  // one lands in a subdirectory, and the skill then reads as clean while
  // naming it.
  it("reads tool names out of nested source files too", () => {
    const root = mkdtempSync(join(tmpdir(), "crispy-skill-scan-"));
    try {
      mkdirSync(join(root, "tools"));
      writeFileSync(
        join(root, "index.ts"),
        'server.registerTool("send_message", handler);\n',
      );
      writeFileSync(
        join(root, "tools", "search.ts"),
        'server.registerTool("search_people", handler);\n',
      );

      expect([...registeredToolNames(pathToFileURL(`${root}/`))].sort()).toEqual([
        "search_people",
        "send_message",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
      "name must be lowercase letters, digits and single hyphens between them",
    ).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
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

/**
 * A URL is everything from its scheme to the first whitespace, quote, backtick,
 * angle bracket or closing paren. A trailing period or comma is the sentence
 * around the URL and not part of it, so both sides lose one before anything is
 * compared. The comparison is exact set membership against the URLs that
 * README.md, server.json and src/config.ts already state. Substring matching
 * would accept any invented prefix of a real URL, and the scheme is checked
 * too, since an endpoint this repo never spelled with http is still an
 * endpoint somebody made up.
 */
const URL_PATTERN = /https?:\/\/[^\s`"'<>)]+/g;

function urlsIn(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map((match) =>
    match[0].replace(/[.,]$/, ""),
  );
}

const statedUrls = new Set(
  ["README.md", "server.json", "src/config.ts"].flatMap((name) =>
    urlsIn(readRepositoryFile(name)),
  ),
);

function inventedUrls(markdown: string): string[] {
  return urlsIn(markdown).filter((url) => !statedUrls.has(url));
}

function nonHttpsUrls(markdown: string): string[] {
  return urlsIn(markdown).filter((url) => !url.startsWith("https://"));
}

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

  it("cites only https URLs", () => {
    expect(
      nonHttpsUrls(skill),
      `${SKILL} cites a URL that is not https`,
    ).toEqual([]);
  });

  it("invents no endpoint of its own", () => {
    expect(urlsIn(skill), `${SKILL} cites no URL at all`).not.toEqual([]);
    expect(
      inventedUrls(skill),
      `${SKILL} cites URLs that README.md, server.json and src/config.ts do not state`,
    ).toEqual([]);
  });

  // The three ways this check used to be walked past. Each extractor above is
  // the whole of the assertion, so each shape is held honest here rather than
  // by a reviewer who happens to think of it.
  it("rejects an invented URL that is only a prefix of a stated one", () => {
    expect(inventedUrls("Visit https://crispy.sh/dashboard for settings.")).toEqual(
      ["https://crispy.sh/dashboard"],
    );
    expect(inventedUrls("See https://crispy.sh/api/m for the schema.")).toEqual([
      "https://crispy.sh/api/m",
    ]);
  });

  it("rejects an invented URL spelled with http", () => {
    expect(
      nonHttpsUrls("Fallback endpoint is http://evil.example.com/api/mcp."),
    ).toEqual(["http://evil.example.com/api/mcp"]);
  });

  it("does not read the sentence around a URL as part of it", () => {
    expect(urlsIn("The endpoint is https://crispy.sh/api/mcp.")).toEqual([
      "https://crispy.sh/api/mcp",
    ]);
    expect(
      urlsIn("See https://crispy.sh/dashboard/api-keys, then stop."),
    ).toEqual(["https://crispy.sh/dashboard/api-keys"]);
    expect(inventedUrls("Docs at https://crispy.sh/dashboard/api-keys.")).toEqual(
      [],
    );
  });
});

describe("agent skill claims", () => {
  // SKILL.md is product copy. The agent that reads it treats every sentence as
  // a fact about the product, so a claim past what README.md documents is a
  // feature somebody will expect to exist. These are the wordings that stood
  // in the file and were not backed by anything in this repository, held out.
  it.each([
    ["paced sending outside campaigns", /Crispy paces outbound sending/],
    [
      "a campaign stop action that the README does not document",
      /Stop the campaign as soon as the user asks/,
    ],
    [
      "an endpoint and auth scheme that config pins down",
      /fixed by the config/,
    ],
  ])("does not claim %s", (label, claim) => {
    expect(skill, `${SKILL} claims ${label}`).not.toMatch(claim);
  });

  // And the sentences the file has to carry because nothing else says them.
  it.each([
    ["who enforces the safety rules", /instructions for the calling agent/],
    ["what a hidden rate limit looks like", /suppressed by configuration/],
    [
      "that an approved batch is still sent one at a time",
      /Sending is still one at a time/,
    ],
  ])("states %s", (label, note) => {
    expect(skill, `${SKILL} does not state ${label}`).toMatch(note);
  });
});
