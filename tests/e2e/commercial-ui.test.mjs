/** Local UI acceptance: real portal handler/renderers, explicitly synthetic service/session. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { build } from "esbuild";
import { chromium, webkit } from "@playwright/test";

const browserRuntime = process.env.PRAETORIUM_UI_PLAYWRIGHT_PACKAGE
  ? createRequire(import.meta.url)(process.env.PRAETORIUM_UI_PLAYWRIGHT_PACKAGE)
  : { chromium, webkit };

const output = resolve(
  process.env.PRAETORIUM_UI_EVIDENCE_DIR ?? "/tmp/praetorium-commercial-ui-evidence",
);
await mkdir(output, { recursive: true });
const bundle = await build({
  stdin: {
    contents: `export { createPortalHandler } from './apps/gateway/src/ui/handler.ts'; export { dashboard, summary, operation } from './apps/gateway/src/ui/portal.fixtures.ts';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { createPortalHandler, dashboard, summary, operation } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const commands = [];
let scenario = "populated";
const fullDigest = `sha256:${"f".repeat(64)}`;
function repository(id = "123456789") {
  const blocked = id === "2" || scenario === "blocked";
  const readonly = scenario === "readonly";
  const current = blocked
    ? null
    : { ...dashboard.current, baseImageDigest: fullDigest, composedImageDigest: fullDigest };
  const desired = blocked ? null : { ...dashboard.desired, composedImageDigest: null };
  return {
    ...structuredClone(dashboard),
    repository: {
      ...summary,
      repositoryId: id,
      fullName:
        scenario === "long"
          ? `owner/${"long-repository-name-".repeat(12)}<script>`
          : id === "2"
            ? "example/field-notes"
            : "example/the-winter-atlas",
      permission: readonly ? "read" : "maintain",
      instance: {
        ...summary.instance,
        state: blocked ? "blocked" : "ready",
        reason: blocked
          ? "Choose an approved configuration before starting."
          : scenario === "long"
            ? "Waiting for authoritative state. ".repeat(12)
            : null,
      },
    },
    current,
    desired,
    preview: blocked ? null : dashboard.preview,
    canConfigure: !readonly,
    build: blocked
      ? null
      : scenario === "running"
        ? { ...dashboard.build, status: "running", progressPercent: null }
        : {
            ...dashboard.build,
            status: scenario === "failure" ? "failed" : "succeeded",
            progressPercent: scenario === "failure" ? 73 : 100,
            errorCode: scenario === "failure" ? dashboard.build.errorCode : null,
          },
    operations: blocked
      ? []
      : [
          {
            ...operation,
            state:
              scenario === "running" ? "running" : scenario === "failure" ? "failed" : "succeeded",
            progressPercent: scenario === "running" ? null : 73,
            retryable: scenario === "failure",
            error: scenario === "failure" ? operation.error : null,
          },
        ],
  };
}
const service = {
  listRepositories: async () => ({
    ok: true,
    value: {
      githubApp: {
        installationState: scenario === "unavailable" ? "unknown" : "active",
        message:
          scenario === "unavailable"
            ? "GitHub connection is temporarily unavailable."
            : "GitHub App installation is active.",
      },
      repositories:
        scenario === "empty" ? [] : [repository().repository, repository("2").repository],
    },
  }),
  getRepository: async (_actor, id) => ({ ok: true, value: repository(id) }),
  execute: async (_actor, id, command) => {
    commands.push(structuredClone(command));
    if (scenario === "error")
      return {
        ok: false,
        error: {
          code: "STALE_GENERATION",
          message: "The configuration changed. Review your selections and try again.",
        },
      };
    if (command.kind === "preview")
      return {
        ok: true,
        value: {
          kind: "preview",
          preview: {
            ...dashboard.preview,
            state: scenario === "unsupported" ? "unsupported" : "valid",
            unsupportedReasons:
              scenario === "unsupported"
                ? ["Incompatible selection <script>not executable</script>"]
                : [],
            releasePolicy: command.releasePolicy,
            releaseId: command.releaseId,
            resourceProfileId: command.resourceProfileId,
            requestedModules: command.moduleIds,
            includedModules: [...new Set([...command.moduleIds, "search"])],
          },
        },
      };
    if (command.kind === "configure")
      return {
        ok: true,
        value: { kind: "configuration", revisionId: "fixture-revision", buildId: "fixture-build" },
      };
    return {
      ok: true,
      value: {
        kind: "operation",
        operation: {
          ...operation,
          operationId: `fixture-${commands.length}`,
          kind: command.kind === "enter" ? "start" : command.kind,
          state: "queued",
          progressPercent: null,
          retryable: false,
          error: null,
          message: "Owned synthetic command accepted.",
        },
      },
    };
  },
};
let origin;
const handler = createPortalHandler({
  service,
  authenticate: async () => ({
    ok: true,
    session: { actor: { userId: "owned-local-ui-fixture" }, csrfToken: "owned-fixture-csrf" },
  }),
  verifyCsrf: async (request, _session, form) =>
    request.headers.get("Origin") === origin && form.get("csrfToken") === "owned-fixture-csrf",
  createToken: () => randomBytes(24).toString("base64url"),
});
const server = createServer(async (incoming, outgoing) => {
  try {
    const chunks = [];
    for await (const chunk of incoming) chunks.push(chunk);
    const request = new Request(new URL(incoming.url, origin), {
      method: incoming.method,
      headers: incoming.headers,
      ...(incoming.method === "POST" ? { body: Buffer.concat(chunks) } : {}),
    });
    const response = await handler(request);
    if (response.status >= 400)
      console.log("fixture HTTP", response.status, incoming.headers.origin, incoming.url);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    outgoing.writeHead(500);
    outgoing.end(String(error));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
origin = `http://127.0.0.1:${server.address().port}`;

function measureContrast() {
  const rgb = (value) =>
    value
      .match(/[0-9.]+/g)
      .slice(0, 3)
      .map(Number)
      .map((v) => {
        v /= 255;
        return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
  const luminance = (value) => {
    const [r, g, b] = rgb(value);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const canvas = getComputedStyle(document.documentElement).backgroundColor;
  return [
    document.body,
    document.querySelector("main a"),
    ...document.querySelectorAll(".status-badge"),
    document.querySelector(".field-help"),
    ...document.querySelectorAll("button:not(:disabled)"),
  ]
    .filter(Boolean)
    .map((element) => {
      const style = getComputedStyle(element);
      const foreground = luminance(style.color);
      const background = luminance(
        style.backgroundColor === "rgba(0, 0, 0, 0)" ? canvas : style.backgroundColor,
      );
      return {
        role: element.className || element.tagName,
        ratio:
          (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      };
    });
}

const results = [];
const engines = (process.env.PRAETORIUM_UI_BROWSERS ?? "chromium,webkit").split(",");
try {
  for (const name of engines) {
    const env =
      name === "chromium" && process.env.PRAETORIUM_UI_CHROMIUM_ENV
        ? JSON.parse(await readFile(process.env.PRAETORIUM_UI_CHROMIUM_ENV, "utf8"))
        : null;
    const browser = await (
      name === "webkit" ? browserRuntime.webkit : browserRuntime.chromium
    ).launch({
      headless: true,
      ...(env
        ? {
            executablePath: env.executablePath,
            env: { ...process.env, LD_LIBRARY_PATH: env.LD_LIBRARY_PATH },
          }
        : {}),
      ...(name === "chromium" ? { args: ["--no-sandbox"] } : {}),
    });
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      const errors = [];
      const contrast = new Map();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(() => {
        window.cspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) =>
          window.cspViolations.push(event.violatedDirective),
        );
      });
      async function visit(
        path,
        mode,
        state = "populated",
        width = mode === "mobile" ? 390 : 1440,
        height = mode === "mobile" ? 844 : 900,
      ) {
        scenario = state;
        await page.setViewportSize({ width, height });
        const discard = (dialog) => dialog.accept();
        page.on("dialog", discard);
        const response = await page.goto(`${origin}${path}?ui=${mode}`);
        page.off("dialog", discard);
        assert.equal(response.status(), 200);
        assert.equal(await page.locator("body").getAttribute("data-ui"), mode);
        if (!(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))) {
          console.log(
            "Overflow diagnostics",
            await page.evaluate(() => ({
              viewport: innerWidth,
              doc: document.documentElement.scrollWidth,
              elements: [...document.querySelectorAll("body *")]
                .filter(
                  (e) =>
                    e.getBoundingClientRect().right > innerWidth ||
                    e.scrollWidth > e.clientWidth + 1,
                )
                .map((e) => [
                  e.tagName,
                  e.className + ":" + (e.getAttribute("for") ?? ""),
                  e.tagName === "LABEL" ? e.outerHTML : "",
                  e.getBoundingClientRect().right,
                  e.clientWidth,
                  e.scrollWidth,
                ])
                .slice(0, 30),
            })),
          );
          await page.screenshot({ path: `${output}/${name}-overflow.png`, fullPage: true });
        }
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
          `${name}/${mode}/${state}/${width} overflow`,
        );
        assert.deepEqual(
          await page.evaluate(() => {
            const ids = [...document.querySelectorAll("[id]")].map((e) => e.id);
            return ids.filter((id, index) => ids.indexOf(id) !== index);
          }),
          [],
        );
        assert.deepEqual(
          await page.evaluate(() => window.cspViolations),
          [],
          "renderer obeys actual HTTP CSP",
        );
        const css = await page.locator("style").textContent();
        assert.ok(
          response
            .headers()
            [
              "content-security-policy"
            ].includes(`sha256-${createHash("sha256").update(css).digest("base64")}`),
        );
        const pairs = await page.evaluate(measureContrast);
        assert.ok(
          pairs.every((pair) => pair.ratio >= 4.5),
          JSON.stringify(pairs),
        );
        for (const pair of pairs)
          contrast.set(pair.role, Math.min(contrast.get(pair.role) ?? Infinity, pair.ratio));
        if (mode === "mobile")
          assert.ok(
            await page
              .locator("main button")
              .evaluateAll((elements) =>
                elements.every((e) => e.getBoundingClientRect().height >= 44),
              ),
          );
        return response;
      }
      for (const mode of ["desktop", "mobile"]) {
        for (const [label, path, state] of [
          ["list", "/", "populated"],
          ["detail", "/repositories/123456789", "populated"],
          ["configuration", "/repositories/123456789", "populated"],
          ["blocked", "/repositories/2", "blocked"],
          ["empty", "/", "empty"],
          ["failure", "/repositories/123456789", "failure"],
        ]) {
          await visit(path, mode, state);
          if (label === "configuration")
            await page
              .getByRole("navigation", { name: "Repository sections" })
              .getByRole("link", { name: "Configuration", exact: true })
              .click();
          await page.screenshot({ path: `${output}/${name}-${mode}-${label}.png`, fullPage: true });
          if (state === "blocked") {
            assert.equal(await page.locator('input[name="action"][value="enter"]').count(), 0);
            await page
              .getByText("Configuration is required before this application can start.", {
                exact: false,
              })
              .waitFor();
          }
          if (state === "empty")
            await page.getByRole("heading", { name: "No repositories available" }).waitFor();
        }
        for (const width of [320, 390, 768]) {
          await visit("/", mode, "long", width);
          await visit("/repositories/123456789", mode, "long", width, 460);
          for (const disclosure of await page
            .getByText("Exact artifact identifiers", { exact: true })
            .all())
            await disclosure.click();
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
            "expanded full digests fit",
          );
          await page.locator('select[name="releasePolicy"]').focus();
          assert.equal(
            await page
              .locator('select[name="releasePolicy"]')
              .evaluate((e) => e === document.activeElement),
            true,
          );
          await page.keyboard.press("Tab");
          assert.equal(
            await page
              .locator('select[name="releaseId"]')
              .evaluate((e) => e === document.activeElement),
            true,
          );
          await page.screenshot({
            path: `${output}/${name}-${mode}-long-${width}.png`,
            fullPage: true,
          });
        }
        await visit("/repositories/123456789", mode);
        const form = page.locator("[data-configuration-form]");
        assert.equal(await form.count(), 1);
        await page.getByLabel("Search", { exact: false }).check();
        await page
          .getByRole("navigation", { name: "Repository sections" })
          .getByRole("link", { name: "Activity", exact: true })
          .click();
        assert.equal(await page.getByLabel("Search", { exact: false }).isChecked(), true);
        await page
          .getByRole("navigation", { name: "Repository sections" })
          .getByRole("link", { name: "Configuration", exact: true })
          .click();
        await Promise.all([
          page.waitForEvent("dialog").then((dialog) => dialog.dismiss()),
          page
            .getByRole("navigation", { name: "Presentation" })
            .getByRole("link", { name: mode === "mobile" ? "Desktop" : "Mobile", exact: true })
            .click({ noWaitAfter: true }),
        ]);
        assert.equal(await page.locator("body").getAttribute("data-ui"), mode);
        await page.getByRole("button", { name: "Preview selection", exact: true }).click();
        await page.waitForLoadState();
        if ((await page.locator("[data-configuration-form]").count()) === 0)
          console.log(await page.locator("main").innerText());
        assert.equal(await page.getByLabel("Search", { exact: false }).isChecked(), true);
        assert.deepEqual(commands.at(-1).moduleIds, ["editor", "search"]);
        assert.equal(await page.locator("body").getAttribute("data-ui"), mode);
        scenario = "error";
        await page.getByLabel("Editor", { exact: false }).uncheck();
        const failed = page.waitForResponse((response) => response.request().method() === "POST");
        await page
          .getByRole("button", { name: "Save configuration and build", exact: true })
          .click();
        assert.equal((await failed).status(), 409);
        assert.equal(await page.getByLabel("Editor", { exact: false }).isChecked(), false);
        assert.equal(await page.getByLabel("Search", { exact: false }).isChecked(), true);
        assert.equal(
          await page
            .locator('[role="alert"]')
            .filter({ hasText: "The configuration changed" })
            .count(),
          1,
        );
        scenario = "populated";
        await page
          .getByRole("button", { name: "Save configuration and build", exact: true })
          .click();
        await page.waitForLoadState();
        assert.equal(commands.at(-1).kind, "configure");
        assert.equal(commands.at(-1).expectedGeneration, 4);
        assert.ok(commands.at(-1).idempotencyKey.length >= 16);
        for (const [label, kind, state] of [
          ["Stop application", "stop", "populated"],
          ["Redeploy current configuration", "redeploy", "populated"],
          ["Retry operation", "retry", "failure"],
          ["Open application", "enter", "populated"],
        ]) {
          await visit("/repositories/123456789", mode, state);
          await page.getByRole("button", { name: label, exact: true }).click();
          await page.waitForLoadState();
          assert.equal(commands.at(-1).kind, kind);
        }
        await visit("/repositories/123456789", mode);
        scenario = "unsupported";
        await page.getByRole("button", { name: "Preview selection", exact: true }).click();
        await page.waitForLoadState();
        assert.equal(
          await page
            .getByRole("button", { name: "Save configuration and build", exact: true })
            .isDisabled(),
          true,
        );
        assert.equal(
          await page
            .getByText("Incompatible selection <script>not executable</script>", { exact: true })
            .count(),
          1,
        );
        await visit("/repositories/123456789", mode, "readonly");
        assert.equal(await page.locator("[data-configuration-form]").count(), 0);
        assert.equal(await page.getByRole("button", { name: "Stop application" }).count(), 0);
        await visit("/repositories/123456789", mode, "running");
        await page.getByLabel("Search", { exact: false }).check();
        await page.waitForTimeout(1300);
        assert.equal(new URL(page.url()).searchParams.has("poll"), false);
        await page.getByText("Automatic refresh paused while editing.", { exact: false }).waitFor();
        await Promise.all([
          page.waitForEvent("dialog").then((dialog) => dialog.accept()),
          page.waitForURL(
            (url) => url.searchParams.get("ui") === (mode === "mobile" ? "desktop" : "mobile"),
          ),
          page
            .getByRole("navigation", { name: "Presentation" })
            .getByRole("link", { name: mode === "mobile" ? "Desktop" : "Mobile", exact: true })
            .click({ noWaitAfter: true }),
        ]);
        await page.waitForLoadState();
      }
      await visit("/repositories/123456789", "desktop");
      await page
        .getByRole("navigation", { name: "Repository sections" })
        .getByRole("link", { name: "Configuration", exact: true })
        .click();
      const count = commands.length;
      await page
        .getByRole("navigation", { name: "Presentation" })
        .getByRole("link", { name: "Mobile", exact: true })
        .click();
      assert.equal(new URL(page.url()).hash, "#configuration");
      assert.equal(commands.length, count);
      await page.reload();
      assert.equal(await page.locator("body").getAttribute("data-ui"), "mobile");
      await page.goto(`${origin}/repositories/123456789`);
      assert.equal(await page.locator("body").getAttribute("data-ui"), "mobile");
      await page.goBack();
      await page.goForward();
      assert.equal(await page.locator("body").getAttribute("data-ui"), "mobile");
      await page.evaluate(() => {
        const script = document.createElement("script");
        script.textContent = "window.untrustedScriptRan=true";
        document.body.append(script);
        const style = document.createElement("style");
        style.textContent = "body{background:rgb(255,0,0)}";
        document.head.append(style);
      });
      assert.equal(await page.evaluate(() => window.untrustedScriptRan), undefined);
      await page.waitForFunction(() => window.cspViolations.length >= 2);
      assert.equal(
        await page.evaluate(() => getComputedStyle(document.body).backgroundColor),
        "rgba(0, 0, 0, 0)",
      );
      assert.deepEqual(errors, []);
      await context.close();
      const native = await browser.newContext({ javaScriptEnabled: false });
      const nativePage = await native.newPage();
      scenario = "populated";
      await nativePage.goto(`${origin}/repositories/123456789?ui=mobile`);
      await nativePage.getByLabel("Search", { exact: false }).check();
      await nativePage.getByRole("button", { name: "Preview selection" }).click();
      assert.equal(commands.at(-1).kind, "preview");
      assert.equal(await nativePage.getByLabel("Search", { exact: false }).isChecked(), true);
      await native.close();
      results.push({
        browser: name,
        version: browser.version(),
        status: "PASS",
        screenshots: 18,
        contrast: Object.fromEntries(contrast),
        assertions:
          "layouts, CSP enforcement, fields, dirty navigation, polling, preview/error/configure, stop/redeploy/retry/enter, mode/cookie/section/back-forward, keyboard, no-JS",
      });
    } finally {
      await browser.close();
    }
  }
  await writeFile(
    `${output}/result.json`,
    JSON.stringify(
      {
        head: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        scope:
          "Real production portal handler/renderers over local HTTP; synthetic session/service fixtures. No hosted producer or registry acceptance.",
        results,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(results));
} finally {
  await new Promise((done) => server.close(done));
}
