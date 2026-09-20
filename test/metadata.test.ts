import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The MCP Registry proves npm ownership by matching package.json's `mcpName`
 * against server.json's `name`. Nothing else in the build reads either file,
 * so without these assertions a drift between the two manifests only surfaces
 * as a rejected publish.
 */
function readManifest<T>(name: string): T {
  const path = new URL(`../${name}`, import.meta.url);
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

interface PackageJson {
  name: string;
  version: string;
  mcpName?: string;
}

interface ServerJson {
  name: string;
  version: string;
  packages?: Array<{
    registryType: string;
    identifier: string;
    version: string;
  }>;
}

const pkg = readManifest<PackageJson>("package.json");
const server = readManifest<ServerJson>("server.json");

const npmPackage = server.packages?.find(
  (entry) => entry.registryType === "npm",
);

describe("registry manifests", () => {
  it("claims the server name in package.json so the registry can verify npm ownership", () => {
    expect(
      pkg.mcpName,
      "package.json mcpName must equal server.json name, or the MCP Registry rejects the npm package as unverified",
    ).toBe(server.name);
  });

  it("points the server.json npm entry at this package", () => {
    expect(npmPackage, "server.json has no npm package entry").toBeDefined();
    expect(
      npmPackage?.identifier,
      "server.json npm identifier must equal package.json name",
    ).toBe(pkg.name);
  });

  it("keeps the server.json npm version in step with package.json", () => {
    expect(
      npmPackage?.version,
      "server.json npm package version is stale: bump it with package.json version",
    ).toBe(pkg.version);
  });

  it("keeps the server.json record version in step with package.json", () => {
    expect(
      server.version,
      "server.json version is the registry record version: bump it with package.json version",
    ).toBe(pkg.version);
  });

  // npm versions are immutable. 1.0.0 shipped on 2026-09-17 without `mcpName`,
  // so the registry can never verify ownership from that tarball: the marker
  // only reaches npm in a version that has not been published yet.
  it("is past the 1.0.0 that shipped without the mcpName marker", () => {
    expect(
      pkg.version,
      "crispy-mcp@1.0.0 is already on npm and immutable; mcpName needs a new version",
    ).not.toBe("1.0.0");
  });
});
