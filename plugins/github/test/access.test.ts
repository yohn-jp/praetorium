import { describe, expect, it } from "vitest";
import { createGitHubAccessProvider } from "../src/access.js";
import type {
  GitHubAccessApi,
  GitHubInstallation,
  GitHubRepository,
  RepositoryBinding,
} from "../src/types.js";

const installation: GitHubInstallation = {
  id: 71,
  appId: 41,
  suspendedAt: null,
  repositorySelection: "selected",
  permissions: { contents: "write" },
};

const repository: GitHubRepository = {
  id: 1001,
  name: "sample",
  fullName: "org/sample",
  owner: "org",
  private: true,
  permissions: { pull: true, push: false, maintain: false, admin: false },
};

const binding: RepositoryBinding = {
  repositoryId: 1001,
  installationId: 71,
  owner: "org",
  name: "sample",
  instanceId: "ins_01",
  runtimeEpoch: 4,
  authorizationRevision: 12,
  bindingEpoch: 3,
  status: "active",
};

function provider(options: {
  readonly token?: string | null;
  readonly installation?: GitHubInstallation;
  readonly installations?: readonly GitHubInstallation[];
  readonly repository?: GitHubRepository;
  readonly binding?: RepositoryBinding | null;
  readonly failApi?: boolean;
  readonly origin?: string;
}) {
  const api: GitHubAccessApi = {
    async listUserInstallations() {
      if (options.failApi) throw new Error("temporary upstream failure");
      return (
        options.installations ?? (options.installation ? [options.installation] : [installation])
      );
    },
    async listInstallationRepositories(_token, installationId) {
      if (options.failApi) throw new Error("temporary upstream failure");
      if (options.installations && installationId !== 71) return [];
      return options.repository ? [options.repository] : [repository];
    },
  };
  return createGitHubAccessProvider({
    appId: 41,
    api,
    userTokens: {
      accessTokenFor: async () => (options.token === undefined ? "user-token" : options.token),
    },
    repositoryBindings: {
      getByRepositoryId: async () => (options.binding === undefined ? binding : options.binding),
    },
    servicePolicy: { allowsRepository: async () => true },
    instanceOriginFor: (instanceId) => options.origin ?? `https://${instanceId}.instances.example`,
    now: () => new Date("2026-10-17T00:00:00.000Z"),
  });
}

describe("GitHub App repository authorization", () => {
  it("intersects current user pull access with the active App installation", async () => {
    const access = provider({});
    const read = await access.authorize("42", 1001, "read");
    const write = await access.authorize("42", 1001, "write");

    expect(read.allowed).toBe(true);
    expect(read.permissions).toEqual(["read"]);
    expect(read.expiresAt - read.checkedAt).toBe(300_000);
    expect(write.allowed).toBe(false);
    expect(write.expiresAt).toBe(write.checkedAt);
  });

  it("denies revoked user authorization and suspended or stale installations", async () => {
    const revoked = await provider({ token: null }).checkBoundAccess(
      "42",
      1001,
      "ins_01",
      4,
      "2026-10-17T00:00:00Z",
    );
    const suspended = await provider({
      installation: { ...installation, suspendedAt: "2026-10-16T00:00:00Z" },
    }).checkBoundAccess("42", 1001, "ins_01", 4, "2026-10-17T00:00:00Z");
    const wrongEpoch = await provider({}).checkBoundAccess(
      "42",
      1001,
      "ins_01",
      5,
      "2026-10-17T00:00:00Z",
    );

    expect(revoked).toEqual({ status: "denied" });
    expect(suspended).toEqual({ status: "denied" });
    expect(wrongEpoch).toEqual({ status: "denied" });
  });

  it("uses numeric repository identity and returns the binding's authorization revision", async () => {
    const access = await provider({}).checkBoundAccess(
      "42",
      1001,
      "ins_01",
      4,
      "2026-10-17T00:00:00Z",
    );
    expect(access).toMatchObject({
      status: "allowed",
      repositoryId: 1001,
      installationId: 71,
      instanceId: "ins_01",
      origin: "https://ins_01.instances.example",
      runtimeEpoch: 4,
      authorizationRevision: 12,
      permissions: ["read"],
      expiresAt: Date.parse("2026-10-17T00:05:00.000Z"),
    });
  });

  it("selects the installation bound to the repository and rejects an invalid trusted origin", async () => {
    const unrelated: GitHubInstallation = {
      ...installation,
      id: 72,
    };
    const selected = await provider({ installations: [unrelated, installation] }).checkBoundAccess(
      "42",
      1001,
      "ins_01",
      4,
      "2026-10-17T00:00:00Z",
    );
    const invalidOrigin = await provider({
      origin: "https://attacker.example.test/path",
    }).checkBoundAccess("42", 1001, "ins_01", 4, "2026-10-17T00:00:00Z");

    expect(selected).toMatchObject({ status: "allowed", installationId: 71 });
    expect(invalidOrigin).toEqual({ status: "denied" });
  });

  it("returns bounded unavailable for upstream errors instead of a stale write decision", async () => {
    const access = await provider({ failApi: true }).checkBoundAccess(
      "42",
      1001,
      "ins_01",
      4,
      "2026-10-17T00:00:00Z",
    );
    expect(access).toEqual({ status: "unavailable" });
  });
});
