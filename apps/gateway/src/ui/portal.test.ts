import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPortalHandler,
  renderHandoff,
  renderRepositoryDashboard,
  renderRepositoryList,
} from "./index.js";
import type {
  PortalHandlerDependencies,
  PortalOperation,
  PortalRepositoryDashboard,
  PortalRepositoryList,
  PortalService,
} from "./types.js";

const summary: PortalRepositoryDashboard["repository"] = {
  repositoryId: "123456789",
  fullName: "owner/project",
  installation: "active",
  permission: "maintain",
  instance: { state: "ready", instanceId: "ins_01", retryable: false, reason: null },
  currentImageDigest: "sha256:current-image",
  desiredImageDigest: "sha256:current-image",
  operation: null,
};

const operation: PortalOperation = {
  operationId: "op_01",
  kind: "build",
  state: "failed",
  progressPercent: 73,
  message: "Build stopped before deployment.",
  error: "producer rejected this module selection",
  retryable: true,
};

const dashboard: PortalRepositoryDashboard = {
  repository: summary,
  generation: 4,
  releasePolicy: { kind: "stable" },
  current: {
    releaseId: "rel_01",
    releaseLabel: "Stable 1.2",
    baseImageDigest: "sha256:base-image",
    composedImageDigest: "sha256:current-image",
    resourceProfileId: "balanced",
    requestedModules: ["editor"],
    includedModules: ["editor", "search"],
    resources: {
      cpuMilli: 1000,
      memoryMiB: 2048,
      ephemeralStorageMiB: 1024,
    },
  },
  desired: {
    releaseId: "rel_01",
    releaseLabel: "Stable 1.2",
    baseImageDigest: "sha256:base-image",
    composedImageDigest: "sha256:current-image",
    resourceProfileId: "balanced",
    requestedModules: ["editor"],
    includedModules: ["editor", "search"],
    resources: {
      cpuMilli: 1000,
      memoryMiB: 2048,
      ephemeralStorageMiB: 1024,
    },
  },
  preview: {
    state: "valid",
    releasePolicy: "stable",
    releaseId: "rel_01",
    requestedModules: ["editor"],
    resourceProfileId: "balanced",
    includedModules: ["editor", "search"],
    unsupportedReasons: [],
    resources: {
      cpuMilli: 1000,
      memoryMiB: 2048,
      ephemeralStorageMiB: 1024,
    },
  },
  build: {
    buildId: "build_01",
    buildKey: "sha256:build-key",
    status: "failed",
    stage: "building",
    progressPercent: 73,
    errorCode: "PRODUCER_REJECTED",
    updatedAt: 1_800_000_000_000,
  },
  approvedReleases: [
    {
      releaseId: "rel_01",
      label: "Stable 1.2",
      imageDigest: "sha256:base-image",
    },
  ],
  modules: [
    { moduleId: "editor", label: "Editor", version: "2.0.0", artifactDigest: "sha256:editor" },
    { moduleId: "search", label: "Search", version: "1.4.0", artifactDigest: "sha256:search" },
  ],
  resourceProfiles: [
    {
      profileId: "balanced",
      label: "Balanced",
      resources: {
        cpuMilli: 1000,
        memoryMiB: 2048,
        ephemeralStorageMiB: 1024,
      },
    },
  ],
  resourceLimits: {
    cpuMilli: 4000,
    memoryMiB: 8192,
    ephemeralStorageMiB: 8192,
  },
  operations: [operation],
  canConfigure: true,
};

const repositoryList: PortalRepositoryList = {
  githubApp: { installationState: "active", message: "GitHub App installation is active." },
  repositories: [summary],
};

function readOnlyDashboard(): PortalRepositoryDashboard {
  return {
    ...dashboard,
    repository: { ...summary, permission: "read" },
    canConfigure: false,
  };
}

function sessionDependencies(
  service: PortalService,
  verifyCsrf: (request: Request) => Promise<boolean> = async () => true,
): PortalHandlerDependencies {
  return {
    service,
    authenticate: async () => ({
      ok: true,
      session: { actor: { userId: "user_01" }, csrfToken: "csrf-token-value" },
    }),
    verifyCsrf: async (request) => verifyCsrf(request),
    createToken: () => "token_12345678901234567890",
  };
}

function actionRequest(fields: Record<string, string>): Request {
  return new Request("https://gateway.example/repositories/123456789/actions", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
}

describe("server-rendered management UI", () => {
  it("escapes repository text and includes installation/access status on the list", async () => {
    const html = await renderRepositoryList(
      {
        ...repositoryList,
        repositories: [{ ...summary, fullName: `<img src=x onerror=alert(1)>` }],
        githubApp: { installationState: "suspended", message: `Paused <script>alert(1)</script>` },
      },
      "csrf-token-value",
    ).text();

    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Paused &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Maintain access");
    expect(html).toContain('name="csrfToken" value="csrf-token-value"');
  });

  it("offers CSRF-protected entry for an accessible unbound repository", async () => {
    const unbound = {
      ...summary,
      permission: "read" as const,
      currentImageDigest: null,
      desiredImageDigest: null,
      instance: { state: "stopped" as const, instanceId: null, retryable: true, reason: null },
    };
    const inaccessible = { ...unbound, repositoryId: "987654321", permission: "none" as const };
    const html = await renderRepositoryList(
      {
        githubApp: { installationState: "active", message: "Installation active." },
        repositories: [unbound, inaccessible],
      },
      "csrf-token-value",
    ).text();

    expect(html).toContain('action="/repositories/123456789/actions"');
    expect(html).toContain('name="action" value="enter"');
    expect(html).toContain('name="csrfToken" value="csrf-token-value"');
    expect(html).toContain("Connect repository");
    expect(html).not.toContain('action="/repositories/987654321/actions"');
    expect(html).not.toContain("Manage repository");
  });

  it("shows current and desired image/module/resource state, preview dependencies and same-image redeploy", async () => {
    const html = await renderRepositoryDashboard(dashboard, {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
    }).text();

    expect(html).toContain("sha256:current-image");
    expect(html).toContain("Requested modules:</strong><br>Editor (2.0.0)");
    expect(html).toContain("Required dependencies:</strong><br>Search (1.4.0)");
    expect(html).toContain(">Failed</span>");
    expect(html).toContain("PRODUCER_REJECTED");
    expect(html).toContain("Ephemeral storage");
    expect(html).toContain("Operator limits");
    expect(html).toContain("even though the image digest is unchanged");
    expect(html).toContain("Open application");
    expect(html).toContain("Preview selection");
  });

  it("renders a responsive management dashboard with CSP-authorized styling and fenced maintainer controls", async () => {
    const response = renderRepositoryDashboard(dashboard, {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
    });
    const html = await response.text();
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
    expect(css).toBeDefined();
    const hash = createHash("sha256").update(css!).digest("base64");
    expect(response.headers.get("Content-Security-Policy")).toContain(`style-src 'sha256-${hash}'`);
    expect(css).toContain("@media (max-width: 760px)");
    expect(html).toContain("Application status");
    expect(html).toContain("Deployment");
    expect(html).toContain("Build and operation progress");
    expect(html).toContain('name="action" value="stop"');
    expect(html).toContain('name="expectedGeneration" value="4"');
    expect(html).toContain('name="csrfToken" value="csrf-token-value"');
    expect(html).toContain('name="idempotencyKey" value="token_12345678901234567890"');
    expect(html).toContain('aria-describedby="save-module-ids-help"');
    expect(html).toContain('aria-describedby="preview-module-ids-help"');

    const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);

    const readOnlyHtml = await renderRepositoryDashboard(readOnlyDashboard(), {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
    }).text();
    expect(readOnlyHtml).not.toContain('name="action" value="stop"');
    expect(readOnlyHtml).toContain("Changes require current repository maintain or admin access.");
  });

  it("guides an unconfigured repository to approved setup instead of offering a start that cannot work", async () => {
    const unconfigured: PortalRepositoryDashboard = {
      ...dashboard,
      repository: {
        ...summary,
        currentImageDigest: null,
        desiredImageDigest: null,
        instance: { state: "stopped", instanceId: "ins_01", retryable: false, reason: null },
      },
      current: null,
      desired: null,
      preview: null,
      build: null,
      operations: [],
    };
    const html = await renderRepositoryDashboard(unconfigured, {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
    }).text();

    expect(html).toContain('href="#configuration">Choose an approved configuration below</a>');
    expect(html).toContain("save it to build and start the application");
    expect(html).not.toContain('name="action" value="enter"');
    expect(html).not.toContain("Wait for the application to become ready");
    expect(html).toContain('id="configuration"');
    expect(html).toContain('name="action" value="configure"');
  });

  it("renders service errors and build failures without claiming a deploy succeeded", async () => {
    const html = await renderRepositoryDashboard(
      {
        ...dashboard,
        operations: [{ ...operation, error: `<script>alert('x')</script>` }],
      },
      {
        csrfToken: "csrf-token-value",
        createIdempotencyKey: () => "token_12345678901234567890",
        errorMessage: `Access denied: <img src=x>`,
      },
    ).text();

    expect(html).toContain("Access denied: &lt;img src=x&gt;");
    expect(html).toContain("&lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt;");
    expect(html).toContain("Current deployment");
    expect(html).toContain("Build stopped before deployment.");
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("Deployment succeeded");
  });

  it("polls the real build status while no operation has been created", async () => {
    const html = await renderRepositoryDashboard(
      {
        ...dashboard,
        operations: [],
        build: { ...dashboard.build!, status: "running", errorCode: null },
      },
      {
        csrfToken: "csrf-token-value",
        createIdempotencyKey: () => "token_12345678901234567890",
        scriptNonce: "nonce_nonce_nonce_01",
      },
    ).text();

    expect(html).toContain(">Building</span>");
    expect(html).toContain('value="73"');
    expect(html).toContain("setTimeout");
    expect(html).toContain("No recent operations.");
  });

  it("keeps read-only controls hidden and relies on the service boundary to deny a crafted write", async () => {
    const execute = vi.fn(async () => ({
      ok: false as const,
      error: {
        code: "FORBIDDEN" as const,
        message: "Current GitHub permission does not allow configuration changes.",
      },
    }));
    const service: PortalService = {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: readOnlyDashboard() }),
      execute,
    };
    const page = await renderRepositoryDashboard(readOnlyDashboard(), {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
    }).text();
    expect(page).not.toContain('name="action" value="configure"');
    expect(page).not.toContain('name="action" value="redeploy"');

    const handler = createPortalHandler(sessionDependencies(service));
    const response = await handler(
      actionRequest({
        csrfToken: "csrf-token-value",
        action: "configure",
        expectedGeneration: "4",
        idempotencyKey: "token_12345678901234567890",
        releasePolicy: "stable",
        releaseId: "rel_01",
        moduleIds: "editor",
        resourceProfileId: "balanced",
      }),
    );
    expect(response.status).toBe(403);
    expect(execute).toHaveBeenCalledOnce();
    const html = await response.text();
    expect(html).toContain("Current GitHub permission does not allow configuration changes.");
    expect(html).not.toContain("Deployment succeeded");
  });

  it("rejects a mutation before service invocation when Gateway CSRF validation fails", async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "operation" as const, operation },
    }));
    const service: PortalService = {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: dashboard }),
      execute,
    };
    const handler = createPortalHandler(sessionDependencies(service, async () => false));
    const response = await handler(
      actionRequest({ csrfToken: "csrf-token-value", action: "enter" }),
    );
    expect(response.status).toBe(403);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects oversized action forms before authentication, CSRF checks, or service calls", async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "operation" as const, operation },
    }));
    const service: PortalService = {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: dashboard }),
      execute,
    };
    const dependencies = sessionDependencies(service);
    const authenticate = vi.fn(dependencies.authenticate);
    const verifyCsrf = vi.fn(dependencies.verifyCsrf);
    const handler = createPortalHandler({ ...dependencies, authenticate, verifyCsrf });
    const largeBody = `csrfToken=csrf-token-value&action=enter&padding=${"x".repeat(65_536)}`;
    const streamed = new Request("https://gateway.example/repositories/123456789/actions", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: largeBody,
    });
    const declaredLarge = new Request("https://gateway.example/repositories/123456789/actions", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Content-Length": "65537",
      },
      body: "csrfToken=csrf-token-value&action=enter",
    });

    const streamedResponse = await handler(streamed);
    const declaredResponse = await handler(declaredLarge);

    expect(streamedResponse.status).toBe(413);
    expect(declaredResponse.status).toBe(413);
    expect(declaredLarge.bodyUsed).toBe(false);
    expect(authenticate).not.toHaveBeenCalled();
    expect(verifyCsrf).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("routes stopped-instance entry through the service and renders its real start operation", async () => {
    const waitingDashboard: PortalRepositoryDashboard = {
      ...dashboard,
      repository: {
        ...summary,
        instance: {
          state: "stopped",
          instanceId: "ins_01",
          retryable: true,
          reason: "Instance is stopped.",
        },
      },
    };
    const startOperation: PortalOperation = {
      ...operation,
      operationId: "op_start_01",
      kind: "start",
      state: "queued",
      progressPercent: null,
      message: "Starting the stopped instance.",
      error: null,
      retryable: false,
    };
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "operation" as const, operation: startOperation },
    }));
    const service: PortalService = {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: waitingDashboard }),
      execute,
    };
    const handler = createPortalHandler(sessionDependencies(service));
    const response = await handler(
      actionRequest({ csrfToken: "csrf-token-value", action: "enter" }),
    );
    const html = await response.text();

    expect(response.status).toBe(202);
    expect(execute).toHaveBeenCalledWith({ userId: "user_01" }, "123456789", { kind: "enter" });
    expect(html).toContain("Start application");
    expect(html).toContain("Starting the stopped instance.");
    expect(html).toContain("sha256:current-image");
  });

  it("routes a CSRF-protected stop form to the current operation status", async () => {
    const stopOperation: PortalOperation = {
      ...operation,
      operationId: "op_stop_01",
      kind: "stop",
      state: "queued",
      progressPercent: null,
      message: "The fenced stop request is queued.",
      error: null,
      retryable: false,
    };
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: { kind: "operation" as const, operation: stopOperation },
    }));
    const service: PortalService = {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: dashboard }),
      execute,
    };
    const handler = createPortalHandler(sessionDependencies(service));
    const response = await handler(
      actionRequest({
        csrfToken: "csrf-token-value",
        action: "stop",
        expectedGeneration: "4",
        idempotencyKey: "stop-key-1234567890123456",
      }),
    );
    const html = await response.text();

    expect(response.status).toBe(202);
    expect(execute).toHaveBeenCalledWith({ userId: "user_01" }, "123456789", {
      kind: "stop",
      expectedGeneration: 4,
      idempotencyKey: "stop-key-1234567890123456",
    });
    expect(html).toContain("The fenced stop request is queued.");
    expect(html).toContain("Stop application");
  });

  it("shows unsupported producer previews and escapes resolver reasons", async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      value: {
        kind: "preview" as const,
        preview: {
          state: "unsupported" as const,
          releasePolicy: "pinned" as const,
          releaseId: "rel_01",
          requestedModules: ["search"],
          resourceProfileId: "balanced",
          includedModules: ["editor", "search"],
          unsupportedReasons: [`Incompatible with <script>release</script>`],
          resources: null,
        },
      },
    }));
    const service: PortalService = {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: dashboard }),
      execute,
    };
    const handler = createPortalHandler(sessionDependencies(service));
    const response = await handler(
      actionRequest({
        csrfToken: "csrf-token-value",
        action: "preview",
        expectedGeneration: "4",
        releasePolicy: "pinned",
        releaseId: "rel_01",
        moduleIds: "search",
        resourceProfileId: "balanced",
      }),
    );
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain("Unsupported module configuration");
    expect(html).toContain("Required dependencies:</dt><dd>Editor (2.0.0)</dd>");
    expect(html).toContain("Incompatible with &lt;script&gt;release&lt;/script&gt;");
    expect(html).toContain('<option value="search" selected>');
    expect(html).toContain('<option value="pinned" selected>');
    expect(html).toContain('name="action" value="configure"');
    expect(html).toContain('class="button" type="submit" disabled>Save configuration and build');
    expect(html).not.toContain("<script>release");
  });

  it("bounds automatic progress refresh and exposes a manual retry after the limit", async () => {
    const running: PortalOperation = {
      ...operation,
      state: "running",
      error: null,
      retryable: false,
    };
    const withProgress = { ...dashboard, operations: [running] };
    const first = await renderRepositoryDashboard(withProgress, {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
      scriptNonce: "token_12345678901234567890",
      pollCount: 0,
    }).text();
    const last = await renderRepositoryDashboard(withProgress, {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
      scriptNonce: "token_12345678901234567890",
      pollCount: 5,
    }).text();

    expect(first).toContain("setTimeout");
    expect(last).toContain("Automatic refresh paused");
    expect(last).not.toContain("<script");
    expect(last).toContain("Refresh status");
  });

  it("keeps handoff codes in a no-store POST body and rejects untrusted destinations", async () => {
    const response = renderHandoff(
      { origin: "https://ins-01.instances.example", code: `raw&<"code`, returnPath: "/" },
      "token_12345678901234567890",
    );
    const html = await response.text();
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "form-action https://ins-01.instances.example",
    );
    expect(html).toContain('action="https://ins-01.instances.example/_platform/handoff"');
    expect(html).toContain('name="code" value="raw&amp;&lt;&quot;code"');
    expect(html).not.toContain("?code=");

    const unsafe = renderHandoff(
      { origin: "https://example.com;script-src 'unsafe-inline'", code: "raw", returnPath: "/" },
      "token_12345678901234567890",
    );
    expect(unsafe.status).toBe(502);
  });
});
