import { describe, expect, it } from "vitest";
import { AccessGrantId, issueAccessGrant, type SigningKey } from "../../../packages/auth/src/index.js";
import { newAccessGrantId } from "../../../packages/domain/src/ids.js";
import type { RuntimeAssignment } from "@praetorium/application/lifecycle";
import { HttpRuntimeAuthAcceptanceProbe } from "../src/runtime-auth-probe.js";

const NOW = Date.parse("2026-10-17T00:00:10.000Z");
const INSTANCE_ID = "ins_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const REPOSITORY_ID = 7001;
const RUNTIME_EPOCH = 12;
const HOSTNAME = "ins-01arz3ndektsv4rrffq69g5fav.hosted.praetorium.test";
const PUBLIC_ORIGIN = `https://${HOSTNAME}`;
const SERVICE_ORIGIN = "http://scriptorium.ins-01arz3ndektsv4rrffq69g5fav.svc.cluster.local:8080";
const CONTROL_PLANE_ORIGIN = "https://control.praetorium.test";
const CONTROL_CREDENTIAL = "provisioner-runtime-auth-secret".padEnd(40, "x");
const VALID_GRANT_PERMISSION = ["read"] as const;

function assignment(): RuntimeAssignment {
  return {
    instanceId: INSTANCE_ID,
    repositoryId: REPOSITORY_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    generation: 7,
    clusterId: "cluster-1",
    reservationId: "reservation-12",
    deployment: {
      revisionId: "revision-12",
      repositoryId: REPOSITORY_ID,
      repositoryLocator: "https://github.com/owner/book.git",
      defaultBranchPolicy: "main",
      imageDigest: `sha256:${"1".repeat(64)}`,
      artifactRef: "registry.praetorium.test/scriptorium@sha256:111",
      platformManifestDigest: `sha256:${"2".repeat(64)}`,
      compositionManifestDigest: `sha256:${"3".repeat(64)}`,
      enabledModuleIds: [],
      credentialBrokerLocator: "praetorium-runtime-git",
      grantPolicy: {
        issuer: "https://gateway.praetorium.test",
        jwksUrl: "https://gateway.praetorium.test/.well-known/jwks.json",
        audience: PUBLIC_ORIGIN,
      },
      controlServicePolicy: {
        issuer: CONTROL_PLANE_ORIGIN,
        jwksUrl: `${CONTROL_PLANE_ORIGIN}/.well-known/control-jwks.json`,
        audience: "praetorium-runtime-control",
      },
      runtimeMetadata: {
        producerRevision: "a".repeat(40),
        listenerPort: 8080,
        livenessPath: "/health/live",
        readinessPath: "/health/ready",
        metadataPath: "/api/platform/v1/metadata",
        shutdownPath: "/api/platform/v1/shutdown",
        statusPath: "/api/platform/v1/status",
        quiescePath: "/api/platform/v1/quiesce",
        resumePath: "/api/platform/v1/resume",
        shutdownTimeoutSeconds: 20,
      },
      hostname: HOSTNAME,
      resourceProfileId: "standard",
      resources: { cpuMilli: 500, memoryMiB: 512, ephemeralStorageMiB: 1_024 },
    },
  };
}

async function makeGrantSet(issuedAt = NOW) {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const signingKey: SigningKey = { kid: "probe-test-key", privateKey: pair.privateKey };
  const common = {
    issuer: "https://gateway.praetorium.test",
    audience: PUBLIC_ORIGIN,
    subjectUserId: "12345",
    audienceInstanceId: INSTANCE_ID,
    runtimeEpoch: RUNTIME_EPOCH,
    permissions: VALID_GRANT_PERMISSION,
    sessionRevision: 0,
    authorizationRevision: 4,
    now: new Date(issuedAt).toISOString(),
    ttlSeconds: 60,
  } as const;
  const make = (repositoryId: number, runtimeEpoch: number) => issueAccessGrant(signingKey, {
    ...common,
    id: AccessGrantId.parse(newAccessGrantId(NOW, crypto.getRandomValues(new Uint8Array(10)))),
    repositoryId,
    runtimeEpoch,
  });
  const [valid, wrongRepository, wrongEpoch] = await Promise.all([
    make(REPOSITORY_ID, RUNTIME_EPOCH),
    make(REPOSITORY_ID + 1, RUNTIME_EPOCH),
    make(REPOSITORY_ID, RUNTIME_EPOCH + 1),
  ]);
  return {
    pair,
    validGrant: valid.token,
    wrongRepositoryGrant: wrongRepository.token,
    wrongEpochGrant: wrongEpoch.token,
    response: {
      issuer: common.issuer,
      jwksUrl: `${common.issuer}/.well-known/jwks.json`,
      origin: PUBLIC_ORIGIN,
      audience: PUBLIC_ORIGIN,
      authorizationRevision: 4,
      grantPolicyMatched: true,
      controlServicePolicyMatched: true,
      validGrant: valid.token,
      wrongRepositoryGrant: wrongRepository.token,
      wrongEpochGrant: wrongEpoch.token,
      permissions: ["read"],
    },
  };
}

describe("HttpRuntimeAuthAcceptanceProbe internal Service transport", () => {
  it("accepts grants minted during the authority request and probes routes before public activation", async () => {
    const grantIssueTime = NOW + 1_500;
    const grants = await makeGrantSet(grantIssueTime);
    let clock = NOW;
    const runtimeRequests: { url: URL; headers: Headers }[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = input instanceof URL ? input : new URL(input.toString());
      if (url.origin === CONTROL_PLANE_ORIGIN) {
        expect(url.pathname).toBe("/internal/provisioner/operations/op-auth-probe/auth-probe");
        clock = grantIssueTime;
        return Response.json(grants.response, { headers: { "Cache-Control": "no-store" } });
      }
      // No public route exists yet during a fresh start. A successful sample
      // must reach the provider-owned Service DNS address directly.
      expect(url.origin).toBe(SERVICE_ORIGIN);
      const headers = new Headers(init?.headers);
      runtimeRequests.push({ url, headers });
      clock += 1_000;
      expect(headers.get("Origin")).toBe(PUBLIC_ORIGIN);
      expect(headers.get("X-Forwarded-Proto")).toBe("https");

      if (url.pathname === "/") {
        expect(headers.get("Cookie")).toBe(`__Host-praetorium_access=${encodeURIComponent(grants.validGrant)}`);
        return new Response("<!doctype html><html></html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }
      if (url.pathname === "/api/session") {
        return Response.json({ authenticated: true, authorScope: "hosted:12345", permissions: ["read"] });
      }
      if (url.pathname === "/api/projects") {
        const token = headers.get("Authorization")?.replace(/^Bearer /u, "");
        return token === grants.validGrant
          ? Response.json([{ id: "project-12", url: "https://github.com/owner/book.git" }])
          : Response.json({ error: "denied" }, { status: 403 });
      }
      if (url.pathname === "/api/projects/project-12/snapshot") {
        return Response.json({
          snapshot: { repository: { url: "https://github.com/owner/book.git" }, remoteCommit: "c".repeat(40) },
          files: [{ path: "chapter.md" }],
        });
      }
      if (url.pathname === "/api/projects/project-12/modules/mcp/streamable") {
        return Response.json({ error: "not selected" }, { status: 404 });
      }
      if (url.pathname === "/api/platform/v1/status") {
        expect(headers.get("Authorization")).toContain("invalid-runtime-control-probe-credential");
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      return Response.json({ error: "not found" }, { status: 404 });
    };
    const probe = new HttpRuntimeAuthAcceptanceProbe({
      controlPlaneUrl: CONTROL_PLANE_ORIGIN,
      provisionerCredential: CONTROL_CREDENTIAL,
      workerId: "provisioner-1",
      clusterId: "cluster-1",
      fetch: fetcher,
      now: () => clock,
      timeoutMs: 1_000,
      scope: () => ({ mode: "observed", operationId: "op-auth-probe" }),
    }).withEndpointResolver(async () => SERVICE_ORIGIN);

    const evidence = await probe.verify(assignment());

    expect(evidence.validGrantAccepted).toBe(true);
    expect(evidence.wrongRepositoryGrantRejected).toBe(true);
    expect(evidence.wrongEpochGrantRejected).toBe(true);
    expect(evidence.invalidServiceCredentialRejected).toBe(true);
    expect(evidence.uiApiMcpProbeId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(evidence.persistenceProbeId).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(evidence.observedAt).toBe(new Date(grantIssueTime + runtimeRequests.length * 1_000).toISOString());
    expect(runtimeRequests.map(({ url }) => url.pathname)).toEqual([
      "/",
      "/api/session",
      "/api/projects",
      "/api/projects/project-12/snapshot",
      "/api/projects/project-12/modules/mcp/streamable",
      "/api/projects",
      "/api/projects",
      "/api/platform/v1/status",
    ]);
  });

  it("does not issue or probe grants without a provider-owned endpoint", async () => {
    let calls = 0;
    const probe = new HttpRuntimeAuthAcceptanceProbe({
      controlPlaneUrl: CONTROL_PLANE_ORIGIN,
      provisionerCredential: CONTROL_CREDENTIAL,
      workerId: "provisioner-1",
      clusterId: "cluster-1",
      fetch: async () => {
        calls += 1;
        throw new Error("no public route exists before activation");
      },
      now: () => NOW,
      scope: () => ({ mode: "observed", operationId: "op-auth-probe" }),
    });
    await expect(probe.verify(assignment())).rejects.toThrow("runtime_auth_probe_internal_endpoint_unavailable");
    expect(calls).toBe(0);
    await expect(probe.withEndpointResolver(async () => PUBLIC_ORIGIN).verify(assignment()))
      .rejects.toThrow("provider-owned in-cluster Service endpoint");
    expect(calls).toBe(0);
  });

  it.each([
    { name: "future at receipt", issuedAt: NOW + 2_500, receivedAt: NOW + 1_500 },
    { name: "expired at receipt", issuedAt: NOW, receivedAt: NOW + 61_000 },
  ])("rejects grants that are $name", async ({ issuedAt, receivedAt }) => {
    const grants = await makeGrantSet(issuedAt);
    let clock = NOW;
    let runtimeRequests = 0;
    const probe = new HttpRuntimeAuthAcceptanceProbe({
      controlPlaneUrl: CONTROL_PLANE_ORIGIN,
      provisionerCredential: CONTROL_CREDENTIAL,
      workerId: "provisioner-1",
      clusterId: "cluster-1",
      fetch: async (input) => {
        const url = input instanceof URL ? input : new URL(input.toString());
        if (url.origin === CONTROL_PLANE_ORIGIN) {
          clock = receivedAt;
          return Response.json(grants.response, { headers: { "Cache-Control": "no-store" } });
        }
        runtimeRequests += 1;
        return Response.json({ error: "unexpected runtime request" }, { status: 500 });
      },
      now: () => clock,
      scope: () => ({ mode: "observed", operationId: "op-auth-probe" }),
    }).withEndpointResolver(async () => SERVICE_ORIGIN);

    await expect(probe.verify(assignment())).rejects.toThrow("runtime auth probe grant binding is invalid");
    expect(runtimeRequests).toBe(0);
  });
});
