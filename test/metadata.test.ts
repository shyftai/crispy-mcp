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
});
