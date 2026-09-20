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

/**
 * The published semver 2.0.0 grammar, verbatim. The hand-rolled `(\d+)` version
 * of this accepted `01.1.0` and a prerelease of `-01`: both are rejected by
 * semver and neither is a version npm will ever hold, so a test built on that
 * regex was not checking the thing it said it was.
 */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

type Core = [number, number, number];

function isAbove(version: Core, floor: Core): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (version[i] !== floor[i]) {
      return version[i] > floor[i];
    }
  }
  return false;
}

describe("registry manifests", () => {
  it("claims the server name in package.json so the registry can verify npm ownership", () => {
    // Presence first. Two absent fields are not two fields that agree, and
    // `undefined === undefined` passed this while neither manifest named the
    // server at all -- which is the exact state the registry rejects.
    expect(pkg.mcpName, "package.json has no mcpName").toBeTypeOf("string");
    expect(pkg.mcpName, "package.json mcpName is empty").not.toBe("");
    expect(server.name, "server.json has no name").toBeTypeOf("string");
    expect(server.name, "server.json name is empty").not.toBe("");

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
  // only reaches npm in a version that has not been published yet. Rejecting
  // the literal string "1.0.0" is not that property -- "1.0" and "0.9.0" pass
  // it and neither is publishable.
  it("publishes a valid semver above 1.0.0, identical in all three places", () => {
    const match = SEMVER.exec(pkg.version);
    expect(
      match,
      `package.json version ${pkg.version} is not a valid semver`,
    ).not.toBeNull();

    const core = match!.slice(1, 4).map(Number) as [number, number, number];
    expect(
      isAbove(core, [1, 0, 0]),
      `crispy-mcp@1.0.0 is already on npm and immutable; ${pkg.version} must be above it`,
    ).toBe(true);

    expect(server.version).toBe(pkg.version);
    expect(npmPackage?.version).toBe(pkg.version);
  });

  // SEMVER is the whole of the assertion above, so it gets held honest here:
  // a regex that accepts a version npm would refuse proves nothing about
  // publishability, and the previous one accepted two of them.
  it.each([
    "01.1.0",
    "1.01.0",
    "1.1.00",
    "1.1.0-01",
    "1.1",
    "1.1.0-",
    "v1.1.0",
    "",
  ])("does not accept %s as a semver", (version) => {
    expect(SEMVER.test(version), `${version} is not a semver`).toBe(false);
  });

  it.each(["1.1.0", "0.0.4", "1.1.0-rc.1", "1.1.0-0", "1.1.0+build.5", "1.1.0-rc.1+build.5"])(
    "accepts %s as a semver",
    (version) => {
      expect(SEMVER.test(version), `${version} is a semver`).toBe(true);
    },
  );
});
