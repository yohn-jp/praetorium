import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  createPortalHandler,
  renderHandoff,
  renderRepositoryDashboard,
  renderRepositoryList,
} from "./index.js";
import { pollingScript } from "./views/operations.js";
import { applySecurityHeaders } from "../middleware/security-headers.js";
import type {
  PortalHandlerDependencies,
  PortalOperation,
  PortalRepositoryDashboard,
  PortalService,
} from "./types.js";

import { summary, operation, dashboard, repositoryList } from "./portal.fixtures.js";

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

    expect(html).toContain('action="/repositories/123456789/actions?ui=desktop"');
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
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
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
    expect(html).toContain('aria-describedby="configuration-module-ids-help"');

    const configurationSection =
      /<section class="configuration-panel" aria-labelledby="configuration-heading">([\s\S]*?)<\/section>/.exec(
        html,
      )?.[1];
    expect(configurationSection).toBeDefined();
    expect(configurationSection!.match(/<form\b/g)).toHaveLength(1);
    expect(configurationSection).toContain('name="action" value="configure"');
    expect(configurationSection).toContain('name="action" value="preview"');
    for (const field of [
      "csrfToken",
      "idempotencyKey",
      "expectedGeneration",
      "releasePolicy",
      "releaseId",
      "resourceProfileId",
    ]) {
      expect(configurationSection!.match(new RegExp(`name="${field}"`, "g"))).toHaveLength(1);
    }

    expect(configurationSection!.match(/name="moduleIds"/g)).toHaveLength(2);
    expect(configurationSection).toContain(
      'type="checkbox" name="moduleIds" value="editor" checked',
    );
    expect(configurationSection).toContain('type="checkbox" name="moduleIds" value="search">');

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
    expect(html).toContain('id="configuration-heading"');
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
    expect(html).toContain('type="checkbox" name="moduleIds" value="search" checked>');
    expect(html).toContain('<option value="pinned" selected>');
    expect(html).toContain('name="action" value="configure"');
    expect(html).toContain(
      'class="button" type="submit" name="action" value="configure" disabled>Save configuration and build',
    );
    expect(html).not.toContain("<script>release");
  });

  it("shortens digest labels without changing approved option values", async () => {
    const longDigest = `sha256:${"c".repeat(64)}`;
    const html = await renderRepositoryDashboard(
      {
        ...dashboard,
        approvedReleases: [{ releaseId: "rel_01", label: "Stable 1.2", imageDigest: longDigest }],
        modules: [
          { moduleId: "editor", label: "Editor", version: "2.0.0", artifactDigest: longDigest },
        ],
      },
      {
        csrfToken: "csrf-token-value",
        createIdempotencyKey: () => "token_12345678901234567890",
      },
    ).text();

    expect(html).toContain(
      `<option value="rel_01" selected>Stable 1.2 · sha256:${"c".repeat(12)}…</option>`,
    );
    expect(html).toContain(`type="checkbox" name="moduleIds" value="editor" checked><span class="module-option-copy"><strong>Editor</strong>`);
    expect(html).toContain(`2.0.0 · sha256:${"c".repeat(12)}…`);
    expect(html).not.toContain(longDigest);
  });

  it.each(["desktop", "mobile"] as const)("shows catalog module guidance and truthful MCP setup on %s", async (mode) => {
    const mcpDashboard: PortalRepositoryDashboard = {
      ...dashboard,
      current: {
        ...dashboard.current!,
        requestedModules: ["editor", "mcp"],
        includedModules: ["editor", "search", "mcp"],
      },
      desired: {
        ...dashboard.desired!,
        requestedModules: ["editor", "mcp"],
        includedModules: ["editor", "search", "mcp"],
      },
      modules: [
        { moduleId: "editor", label: "Editor", description: "Edit the manuscript.", version: "2.0.0", artifactDigest: "sha256:editor" },
        { moduleId: "search", label: "Search and terminology", description: "Search manuscript text and link terms to references.", version: "1.4.0", artifactDigest: "sha256:search", requires: ["nlp"] },
        { moduleId: "mcp", label: "MCP connections", description: "Connect an authorized MCP client using Praetorium OAuth.", version: "1.0.0", artifactDigest: "sha256:mcp" },
      ],
    };
    const html = await renderRepositoryDashboard(mcpDashboard, {
      presentation: { mode, repositoryId: summary.repositoryId },
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
      scriptNonce: "nonce_nonce_nonce_01",
    }).text();

    expect(html).toContain("Search and terminology");
    expect(html).toContain("Search manuscript text and link terms to references.");
    expect(html).toContain("Requires: nlp");
    expect(html).toContain("<strong>Current:</strong> Included as a selected module");
    expect(html).toContain("<strong>Desired:</strong> Included as a selected module");
    expect(html).toContain("Connect an MCP client");
    expect(html).toContain('value="https://123456789.scriptorium.yohn.jp/mcp"');
    expect(html).toContain('data-copy-mcp-endpoint="https://123456789.scriptorium.yohn.jp/mcp"');
    expect(html).toContain("Authorization Code with PKCE S256 and no client secret");
    expect(html).toContain("Client ID Metadata Documents (CIMD)");
    expect(html).toContain("This page has not tested an MCP connection.");
    expect(html).toContain(`body data-ui="${mode}"`);
    expect(html).not.toContain("Connection successful");
  });

  it("states when a historical approved catalog has no module description", async () => {
    const html = await renderRepositoryDashboard({
      ...dashboard,
      modules: [{ moduleId: "editor", label: "editor", version: "2.0.0", artifactDigest: "sha256:editor" }],
    }, {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
    }).text();
    expect(html).toContain("Description is not included in this approved signed catalog.");
  });

  it("copies the MCP endpoint only after clipboard success and selects it when copying fails", async () => {
    const mcpDashboard: PortalRepositoryDashboard = {
      ...dashboard,
      current: { ...dashboard.current!, requestedModules: ["mcp"], includedModules: ["mcp"] },
      desired: { ...dashboard.desired!, requestedModules: ["mcp"], includedModules: ["mcp"] },
      modules: [{ moduleId: "mcp", label: "MCP connections", description: "Connect an MCP client.", version: "1.0.0", artifactDigest: "sha256:mcp" }],
    };
    const html = await renderRepositoryDashboard(mcpDashboard, {
      csrfToken: "csrf-token-value",
      createIdempotencyKey: () => "token_12345678901234567890",
      scriptNonce: "nonce_nonce_nonce_01",
    }).text();
    const script = /<script nonce="[^"]+">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(script).toBeDefined();
    const endpoint = "https://123456789.scriptorium.yohn.jp/mcp";

    const runCopy = async (writeText: (value: string) => Promise<void>) => {
      const listeners: Record<string, (event: unknown) => unknown> = {};
      const status = { textContent: "" };
      const input = { focus: vi.fn(), select: vi.fn() };
      const button = { dataset: { copyMcpEndpoint: endpoint } };
      runInNewContext(script!, {
        URL,
        location: { href: "https://praetorium.yohn.jp/repositories/123456789?ui=desktop" },
        history: { replaceState: vi.fn() },
        addEventListener: vi.fn(),
        document: {
          querySelector: () => null,
          querySelectorAll: () => [],
          addEventListener: (name: string, listener: (event: unknown) => unknown) => { listeners[name] = listener; },
          getElementById: (id: string) => id === "mcp-endpoint" ? input : id === "mcp-copy-status" ? status : null,
        },
        navigator: { clipboard: { writeText } },
      });
      await listeners.click!({ target: { closest: () => button } });
      return { input, status };
    };

    const copied = vi.fn(async () => undefined);
    const success = await runCopy(copied);
    expect(copied).toHaveBeenCalledWith(endpoint);
    expect(success.status.textContent).toBe("MCP endpoint copied.");
    expect(success.input.select).not.toHaveBeenCalled();

    const failure = await runCopy(vi.fn(async () => { throw new Error("permission denied"); }));
    expect(failure.status.textContent).toContain("Automatic copy is unavailable.");
    expect(failure.input.focus).toHaveBeenCalledOnce();
    expect(failure.input.select).toHaveBeenCalledOnce();
  });

  it("routes preview and save buttons with the shared configuration selection", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true as const,
        value: { kind: "preview" as const, preview: dashboard.preview! },
      })
      .mockResolvedValueOnce({
        ok: true as const,
        value: { kind: "configuration" as const, revisionId: "rev_next", buildId: "build_next" },
      });
    const service: PortalService = {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: dashboard }),
      execute,
    };
    const handler = createPortalHandler(sessionDependencies(service));
    const sharedFields = {
      csrfToken: "csrf-token-value",
      expectedGeneration: "4",
      idempotencyKey: "config-key-1234567890123456",
      releasePolicy: "pinned",
      releaseId: "rel_01",
      moduleIds: "editor",
      resourceProfileId: "balanced",
    };

    const previewResponse = await handler(actionRequest({ ...sharedFields, action: "preview" }));
    const previewHtml = await previewResponse.text();
    expect(previewResponse.status).toBe(200);
    expect(execute).toHaveBeenNthCalledWith(1, { userId: "user_01" }, "123456789", {
      kind: "preview",
      releasePolicy: "pinned",
      releaseId: "rel_01",
      moduleIds: ["editor"],
      resourceProfileId: "balanced",
    });
    expect(previewHtml).toContain("Supported module configuration");

    const configureResponse = await handler(
      actionRequest({ ...sharedFields, action: "configure" }),
    );
    expect(configureResponse.status).toBe(202);
    expect(execute).toHaveBeenNthCalledWith(2, { userId: "user_01" }, "123456789", {
      kind: "configure",
      expectedGeneration: 4,
      idempotencyKey: "config-key-1234567890123456",
      releasePolicy: "pinned",
      releaseId: "rel_01",
      moduleIds: ["editor"],
      resourceProfileId: "balanced",
    });
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
    expect(last).not.toContain("setTimeout");
    expect(first).toContain("dataset.dirty");
    expect(last).toContain("beforeunload");
    expect(last).toContain("Refresh status");
  });

  it("polls the dashboard after an action POST and keeps dirty-form navigation blocked", () => {
    const script = pollingScript("script-nonce", 0).match(
      /<script nonce="[^"]+">([\s\S]*?)<\/script>/u,
    )?.[1];
    expect(script).toBeDefined();

    const run = (dirty: boolean, visibilityState = "visible"): string[] => {
      const replacements: string[] = [];
      runInNewContext(script!, {
        URL,
        location: {
          href: "https://gateway.example/repositories/123456789/actions?ui=desktop#configuration",
          hash: "#configuration",
          replace: (value: string) => replacements.push(value),
        },
        document: { visibilityState, querySelector: () => ({ dataset: { dirty: String(dirty) } }) },
        setTimeout: (callback: () => void) => callback(),
      });
      return replacements;
    };

    expect(run(false)).toEqual([
      "https://gateway.example/repositories/123456789?ui=desktop&poll=1#configuration",
    ]);
    expect(run(true)).toEqual([]);
    expect(run(false, "hidden")).toEqual([]);
  });

  it("keeps handoff codes in a no-store POST body and rejects untrusted destinations", async () => {
    const response = applySecurityHeaders(renderHandoff(
      { origin: "https://ins-01.instances.example", code: `raw&<"code`, returnPath: "/" },
      "token_12345678901234567890",
    ), { isProductionLike: true });
    const html = await response.text();
    expect(response.headers.get("Cache-Control")).toBe("no-store, no-transform");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Referrer-Policy")).toBe("strict-origin");
    expect(html).toContain('<meta name="referrer" content="strict-origin">');
    expect(html).not.toContain('<header class="topbar">');
    expect(html).not.toContain('<footer class="page-footer">');
    expect(html).not.toContain('aria-label="Presentation"');
    expect(html).toContain('<button type="submit">Continue</button>');
    expect(html).toContain('<section class="evidence-ledger evidence-handoff" aria-labelledby="handoff-title">');
    expect(html).toContain('<header class="evidence-intro"><div class="page-heading">');
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

describe("presentation mode boundary", () => {
  function service(): PortalService {
    return {
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: dashboard }),
      execute: async () => ({ ok: true, value: { kind: "preview", preview: dashboard.preview! } }),
    };
  }

  it("selects a direct mode, persists only its enum and preserves local action URLs", async () => {
    const handler = createPortalHandler(sessionDependencies(service()));
    const response = await handler(
      new Request("https://gateway.example/repositories/123456789?ui=mobile"),
    );
    const html = await response.text();
    expect(html).toContain('data-ui="mobile"');
    expect(html).toContain("/repositories/123456789/actions?ui=mobile");
    expect(response.headers.get("Set-Cookie")).toBe(
      "praetorium_ui=mobile; Path=/; SameSite=Lax; Secure",
    );
    const preferred = await handler(
      new Request("https://gateway.example/", { headers: { Cookie: "praetorium_ui=mobile" } }),
    );
    expect(await preferred.text()).toContain('data-ui="mobile"');
  });

  it("offers a touch-device layout choice once, without overriding explicit Desktop/Mobile", async () => {
    const handler = createPortalHandler(sessionDependencies(service()));
    const first = await handler(new Request("https://gateway.example/repositories/123456789"));
    const html = await first.text();
    expect(html).toContain('data-ui="desktop"');
    expect(html).toContain('class="mode-choice"');
    expect(html).toContain('href="/repositories/123456789?ui=mobile"');
    expect(html).toContain('href="/repositories/123456789?ui=desktop"');
    expect(first.headers.get("Set-Cookie")).toBeNull();

    const chosen = await handler(new Request("https://gateway.example/repositories/123456789?ui=desktop"));
    expect(await chosen.text()).not.toContain('class="mode-choice"');
    expect(chosen.headers.get("Set-Cookie")).toContain("praetorium_ui=desktop");
    const retained = await handler(new Request("https://gateway.example/repositories/123456789", {
      headers: { Cookie: "praetorium_ui=desktop" },
    }));
    expect(await retained.text()).not.toContain('class="mode-choice"');
    expect(retained.headers.get("Set-Cookie")).toBeNull();
  });

  it.each(["ui=invalid", "ui=desktop&ui=mobile", "ui=%3Cscript%3E"])(
    "falls back to preference for %s",
    async (query) => {
      const handler = createPortalHandler(sessionDependencies(service()));
      const response = await handler(
        new Request(`https://gateway.example/?${query}`, {
          headers: { Cookie: "praetorium_ui=mobile" },
        }),
      );
      expect(await response.text()).toContain('data-ui="mobile"');
      expect(response.headers.get("Set-Cookie")).toBeNull();
      const fallback = await handler(new Request(`https://gateway.example/?${query}`));
      expect(await fallback.text()).toContain('data-ui="desktop"');
    },
  );

  it("retains mode in preview and authoritative errors without modifying commands", async () => {
    const execute = vi.fn(service().execute);
    const handler = createPortalHandler(sessionDependencies({ ...service(), execute }));
    const original = actionRequest({
      csrfToken: "csrf-token-value",
      action: "preview",
      releasePolicy: "stable",
      releaseId: "rel_01",
      moduleIds: "editor",
      resourceProfileId: "balanced",
    });
    const response = await handler(new Request(original.url + "?ui=mobile", original));
    expect(await response.text()).toContain('data-ui="mobile"');
    expect(execute.mock.calls[0]?.[2]).toEqual({
      kind: "preview",
      releasePolicy: "stable",
      releaseId: "rel_01",
      moduleIds: ["editor"],
      resourceProfileId: "balanced",
    });
    const denied = createPortalHandler(sessionDependencies(service(), async () => false));
    const error = await denied(
      new Request(original.url + "?ui=mobile", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: "action=enter",
      }),
    );
    expect(error.status).toBe(403);
    expect(await error.text()).toContain('data-ui="mobile"');
  });

  it("keeps the stylesheet hash correct in each composition", async () => {
    const handler = createPortalHandler(sessionDependencies(service()));
    for (const mode of ["desktop", "mobile"]) {
      const response = await handler(new Request(`https://gateway.example/?ui=${mode}`));
      const html = await response.text();
      const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
      expect(css).toBeDefined();
      const hash = createHash("sha256").update(css!).digest("base64");
      expect(response.headers.get("Content-Security-Policy")).toContain(
        `style-src 'sha256-${hash}'`,
      );
    }
  });
});

it("retains submitted configuration on authoritative stale-generation errors", async () => {
  const execute = vi.fn(async () => ({
    ok: false as const,
    error: { code: "STALE_GENERATION" as const, message: "Refresh the generation before saving." },
  }));
  const handler = createPortalHandler(
    sessionDependencies({
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: true, value: { ...dashboard, generation: 5 } }),
      execute,
    }),
  );
  const response = await handler(
    actionRequest({
      csrfToken: "csrf-token-value",
      action: "configure",
      expectedGeneration: "4",
      idempotencyKey: "stale-config-1234567890",
      releasePolicy: "pinned",
      releaseId: "rel_01",
      moduleIds: "search",
      resourceProfileId: "balanced",
    }),
  );
  const html = await response.text();
  expect(response.status).toBe(409);
  expect(html).toContain("Refresh the generation before saving.");
  expect(html).toContain('value="pinned" selected');
  expect(html).toContain('name="moduleIds" value="search" checked');
  expect(html).toContain('name="moduleIds" value="editor">');
  expect(html).toContain('name="expectedGeneration" value="5"');
  expect(execute).toHaveBeenCalledTimes(1);
});

it("retains unavailable draft choices without presenting an older preview as their validation", async () => {
  const html = await renderRepositoryDashboard(dashboard, {
    csrfToken: "csrf-token-value",
    createIdempotencyKey: () => "token_12345678901234567890",
    selection: {
      releasePolicy: "pinned",
      releaseId: "removed-release",
      moduleIds: ["removed<module>"],
      resourceProfileId: "removed-profile",
    },
    errorMessage: "The approved catalog changed. Review the unavailable selections.",
  }).text();
  expect(html).toContain('value="removed-release" selected>Unavailable selection: removed-release');
  expect(html).toContain('name="moduleIds" value="removed&lt;module&gt;" checked');
  expect(html).toContain('value="removed-profile" selected>Unavailable selection: removed-profile');
  expect(html).toContain('data-dirty="true"');
  expect(html).not.toContain("Supported module configuration");
  expect(html).toContain("No configuration preview is available yet.");
});


it("distinguishes missing Release and Profile prerequisites without offering a mutation", async () => {
  for (const [releases, profiles] of [[[], dashboard.resourceProfiles], [dashboard.approvedReleases, []], [[], []]] as const) {
    const html = await renderRepositoryDashboard({ ...dashboard, approvedReleases: releases, resourceProfiles: profiles }, {
      csrfToken: "fixture", createIdempotencyKey: () => "fixture-key",
    }).text();
    expect(html.includes("<strong>No approved release.</strong>")).toBe(releases.length === 0);
    expect(html.includes("<strong>No resource profile.</strong>")).toBe(profiles.length === 0);
    expect(html).toContain("platform operator");
    expect(html).not.toContain('name="action" value="configure"');
  }
});

it("retains accepted configuration and operation identifiers when subsequent status reads fail", async () => {
  for (const value of [
    { kind: "configuration" as const, revisionId: "revision-accepted", buildId: "build-accepted" },
    { kind: "operation" as const, operation: { ...operation, operationId: "operation-accepted", state: "queued" as const } },
  ]) {
    const handler = createPortalHandler(sessionDependencies({
      listRepositories: async () => ({ ok: true, value: repositoryList }),
      getRepository: async () => ({ ok: false, error: { code: "UNAVAILABLE", message: "Status read interrupted" } }),
      execute: async () => ({ ok: true, value }),
    }));
    const response = await handler(actionRequest({ action: value.kind === "configuration" ? "configure" : "stop",
      expectedGeneration: "4", idempotencyKey: "accepted-key-1234567890123456", releasePolicy: "stable", releaseId: "rel_01", resourceProfileId: "balanced" }));
    const html = await response.text();
    expect(response.status).toBe(202);
    expect(html).toContain("Request accepted; result unknown");
    expect(html).toContain(value.kind === "configuration" ? "build-accepted" : "operation-accepted");
    expect(html).toContain("Check existing request");
    expect(html).not.toContain('method="post"');
  }
});

it("discloses mutation impact and requires native acknowledgement while preserving safety fields", async () => {
  const html = await renderRepositoryDashboard(dashboard, { csrfToken: "fixture", createIdempotencyKey: () => "fixture-key" }).text();
  expect(html).toContain("Review impact: Stop application");
  expect(html).toContain("unpublished checkpoints");
  expect(html).toContain('type="checkbox" required');
  expect(html).toContain('name="expectedGeneration" value="4"');
});


it("distinguishes authorized search zero results from an empty inventory and retains the query across modes", async () => {
  const handler = createPortalHandler(sessionDependencies({
    listRepositories: async () => ({ok:true,value:repositoryList}),
    getRepository: async () => ({ok:true,value:dashboard}),
    execute: async () => ({ok:false,error:{code:"UNAVAILABLE",message:"unused"}}),
  }));
  const response = await handler(new Request("https://gateway.example/?ui=desktop&q=no-match"));
  const html = await response.text();
  expect(html).toContain("No matching repositories");
  expect(html).not.toContain("No repositories available");
  expect(html).toContain('href="/?ui=mobile&amp;q=no-match"');
  expect(html).toContain('value="no-match"');
});

it("retains an unavailable request pointer on GET without asserting acceptance or changing authorization", async () => {
  for (const code of ["UNAVAILABLE", "FORBIDDEN"] as const) {
    const handler = createPortalHandler(sessionDependencies({
      listRepositories: async () => ({ok:true,value:repositoryList}),
      getRepository: async () => ({ok:false,error:{code,message:"Not available"}}),
      execute: async () => ({ok:false,error:{code:"UNAVAILABLE",message:"unused"}}),
    }));
    const response = await handler(new Request("https://gateway.example/repositories/123456789?requestId=existing-operation"));
    const html = await response.text();
    expect(response.status).toBe(code === "FORBIDDEN" ? 403 : 503);
    expect(html.includes("existing-operation")).toBe(code === "UNAVAILABLE");
    expect(html).not.toContain("Request accepted;");
  }
});


it("keeps the requested operation distinct from the latest operation after navigation", async () => {
  const html=await renderRepositoryDashboard(dashboard,{csrfToken:"fixture",createIdempotencyKey:()=>"fixture",requestId:"older-operation"}).text();
  expect(html).toContain("Checking request <code>older-operation</code>");
  expect(html).toContain("not included in the current status response; no completion is inferred");
  expect(html).toContain("&amp;requestId=older-operation");
});
