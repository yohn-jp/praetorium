import { describe, expect, it } from "vitest";
import type { OperationService } from "@praetorium/application/operations";
import { OperationServiceHttpClient } from "../../provisioner/src/operation-client.js";
import { createProvisionerRoutes } from "../src/provisioner-routes.js";

const SERVER_NOW = 1_797_000_000_123;
const CLIENT_REPORTED_AT = "2026-10-18T13:24:08.123Z";
const LEASE_TOKEN = "l".repeat(40);

function observation(extra: Record<string, unknown> = {}) {
  return {
    instanceId: "ins_report",
    repositoryId: 7345,
    generation: 2,
    runtimeEpoch: 3,
    sequence: 9,
    observedState: "ready",
    observedArtifactDigest: `sha256:${"a".repeat(64)}`,
    observedRevisionId: "rev_report",
    reportedAt: CLIENT_REPORTED_AT,
    ...extra,
  };
}

function makeHarness() {
  let received: unknown;
  const app = createProvisionerRoutes({
    operations: {
      async report(input) {
        received = input;
        return {
          operation: {
            id: "op_report",
            instanceId: "ins_report",
            repositoryId: 7345,
            generation: 2,
            runtimeEpoch: 3,
            kind: "start",
            status: "running",
            attempt: 1,
            leaseEpoch: 4,
            leaseToken: LEASE_TOKEN,
            leaseExpiresAt: SERVER_NOW + 30_000,
            reportSequence: input.sequence,
            phase: "starting-target",
            checkpointSequence: 7,
            checkpoint: null,
            clusterId: "cluster-test",
            reservationId: null,
            deploymentRevisionId: "rev_report",
            buildId: null,
            prerequisiteBuildId: null,
          },
          applied: true,
          duplicate: false,
        };
      },
    } as unknown as OperationService,
    workerId: "worker-test",
    clusterId: "cluster-test",
    now: () => SERVER_NOW,
    resolveRuntimeContext: async () => ({}),
  });
  return { app, received: () => received };
}

describe("Provisioner observation report wire compatibility", () => {
  it("accepts the canonical HTTP client payload and stores the server timestamp", async () => {
    const { app, received } = makeHarness();
    const service = new OperationServiceHttpClient({
      baseUrl: "https://control.example.test",
      credential: "provisioner-service-secret",
      fetch: async (input, init) => {
        expect(new URL(String(input)).pathname).toBe("/internal/provisioner/report");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer provisioner-service-secret",
        );
        return app.request("/report", init);
      },
    });

    const result = await service.report({
      operationId: "op_report",
      workerId: "worker-test",
      leaseToken: LEASE_TOKEN,
      leaseEpoch: 4,
      sequence: 9,
      observation: observation(),
      terminal: "succeeded",
    });

    expect(result.applied).toBe(true);
    expect(received()).toMatchObject({
      operationId: "op_report",
      sequence: 9,
      terminal: "succeeded",
      observation: { reportedAt: SERVER_NOW },
    });
    expect(received()).not.toMatchObject({ observation: { reportedAt: CLIENT_REPORTED_AT } });
  });

  it("continues rejecting unknown observation fields", async () => {
    const { app, received } = makeHarness();
    const response = await app.request("/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operationId: "op_report",
        workerId: "worker-test",
        leaseToken: LEASE_TOKEN,
        leaseEpoch: 4,
        sequence: 9,
        observation: observation({ unexpected: "reject" }),
        terminal: "succeeded",
      }),
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(received()).toBeUndefined();
  });
});
