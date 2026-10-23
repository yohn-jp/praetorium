import { describe, expect, it } from "vitest";
import {
  managedLabels,
  parseRuntimeInstanceId,
  parseRuntimeRepositoryId,
  parseRuntimeReleaseId,
} from "../src/index.js";
import { KubernetesApiClient, KubernetesApiError } from "../src/kubernetes/client.js";
import type { KubernetesResource } from "../src/kubernetes/types.js";
import type {
  KubernetesTransport,
  KubernetesTransportRequest,
  KubernetesTransportResponse,
  KubernetesTransportWatchEvent,
} from "../src/kubernetes/client.js";
import { mapKubernetesError } from "../src/kubernetes/error-mapper.js";

const INSTANCE_ID = parseRuntimeInstanceId("ins_00000000000000000000000001");
const RELEASE_ID = parseRuntimeReleaseId("rel_00000000000000000000000001");

const resource: KubernetesResource = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: {
    name: "arcadia-ins-00000000000000000000000001",
    namespace: "arcadia-instances",
    labels: managedLabels({
      instanceId: INSTANCE_ID,
      repositoryId: parseRuntimeRepositoryId(731),
      runtimeEpoch: 1,
      generation: 1,
      releaseId: RELEASE_ID,
    }),
  },
  spec: { replicas: 1 },
};

class FakeTransport implements KubernetesTransport {
  readonly requests: KubernetesTransportRequest[] = [];
  response: KubernetesTransportResponse = {
    statusCode: 200,
    headers: {},
    body: { kind: "Deployment", metadata: { resourceVersion: "10" } },
  };
  watchEvents: KubernetesTransportWatchEvent[] = [];

  async request(request: KubernetesTransportRequest): Promise<KubernetesTransportResponse> {
    this.requests.push(request);
    if (request.method === "GET" && request.path.includes("labelSelector=")) {
      return {
        statusCode: 200,
        headers: {},
        body: { kind: "DeploymentList", items: [], metadata: { resourceVersion: "10" } },
      };
    }
    return this.response;
  }

  async *watch(): AsyncIterable<KubernetesTransportWatchEvent> {
    for (const event of this.watchEvents) yield event;
  }
}

describe("KubernetesApiClient", () => {
  it("uses namespaced standard API paths and non-forced server-side apply", async () => {
    const transport = new FakeTransport();
    const client = new KubernetesApiClient(transport);

    await client.apply(resource, "arcadia-provisioner");
    await client.list("Deployment", "arcadia-instances", "arcadia.io/platform=arcadia-platform");

    expect(transport.requests[0]).toMatchObject({
      method: "PATCH",
      path: "/apis/apps/v1/namespaces/arcadia-instances/deployments/arcadia-ins-00000000000000000000000001?fieldManager=arcadia-provisioner&force=false",
      headers: { "content-type": "application/apply-patch+yaml" },
    });
    expect(transport.requests[1]?.path).toContain(
      "/apis/apps/v1/namespaces/arcadia-instances/deployments?",
    );
    expect(transport.requests[1]?.path).toContain(
      "labelSelector=arcadia.io%2Fplatform%3Darcadia-platform",
    );
  });

  it("keeps forced field transfer opt-in and retains resourceVersion preconditions", async () => {
    const transport = new FakeTransport();
    const client = new KubernetesApiClient(transport);
    await client.applyConditional(resource, "arcadia-provisioner", "10");
    await client.applyConditional(resource, "arcadia-provisioner", "11", undefined, { force: true });
    expect(transport.requests[0]?.path).toContain("force=false");
    expect(transport.requests[1]?.path).toContain("force=true");
    expect(JSON.parse(transport.requests[0]!.body!).metadata.resourceVersion).toBe("10");
    expect(JSON.parse(transport.requests[1]!.body!).metadata.resourceVersion).toBe("11");
  });

  it("keeps API error details structured and bounded", async () => {
    const transport = new FakeTransport();
    transport.response = {
      statusCode: 409,
      headers: {},
      body: {
        kind: "Status",
        code: 409,
        reason: "Conflict",
        message: "secret-value-must-not-escape",
      },
    };
    const client = new KubernetesApiClient(transport);

    await expect(
      client.get({
        kind: "Deployment",
        namespace: "arcadia-instances",
        name: resource.metadata.name,
      }),
    ).rejects.toEqual(expect.objectContaining({ statusCode: 409, reason: "Conflict" }));
  });

  it("turns watch expiration into a reconnectable API error", async () => {
    const transport = new FakeTransport();
    transport.watchEvents = [{ type: "ERROR", object: { kind: "Status", code: 410 } }];
    const client = new KubernetesApiClient(transport);

    const consume = async () => {
      for await (const _event of client.watch(
        "Deployment",
        "arcadia-instances",
        "arcadia.io/platform=arcadia-platform",
        "10",
        new AbortController().signal,
      )) {
        return;
      }
    };

    await expect(consume()).rejects.toEqual(
      expect.objectContaining({ statusCode: 410, reason: "resource_version_expired" }),
    );
  });

  it("normalizes common Kubernetes status classes without leaking messages", () => {
    expect(mapKubernetesError(new KubernetesApiError(403, "Forbidden"))).toMatchObject({
      code: "forbidden",
      classification: "terminal",
      message: "Kubernetes access is forbidden",
    });
    expect(mapKubernetesError(new KubernetesApiError(429, "TooManyRequests"))).toMatchObject({
      code: "capacity",
      classification: "retryable",
    });
    expect(mapKubernetesError(new KubernetesApiError(422, "Invalid"))).toMatchObject({
      code: "invalid_spec",
      classification: "terminal",
    });
    expect(mapKubernetesError(new KubernetesApiError(500, "InternalError"))).toMatchObject({
      code: "unavailable",
      classification: "retryable",
    });
  });
});
