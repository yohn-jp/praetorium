/** Export actual Gateway SSR markup from the repository's synthetic fixture. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { build } from "esbuild";

const outDir = resolve(process.env.PRAETORIUM_UI_EXPORT_DIR ?? ".praetorium-preview");
await mkdir(outDir, { recursive: true });
const bundle = await build({
  stdin: {
    contents: "export { renderRepositoryDashboard } from './apps/gateway/src/ui/render.ts'; export { dashboard } from './apps/gateway/src/ui/portal.fixtures.ts';",
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: "node",
  format: "esm",
  write: false,
});
const { renderRepositoryDashboard, dashboard } = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);
const scenarios = {
  "ready-failed": dashboard,
  blocked: {
    ...dashboard,
    repository: {
      ...dashboard.repository,
      instance: {
        ...dashboard.repository.instance,
        state: "blocked",
        reason: "An approved configuration is required before starting.",
        retryable: false,
      },
    },
    current: null,
    desired: null,
    build: null,
    preview: null,
    operations: [],
  },
  unknown: {
    ...dashboard,
    repository: {
      ...dashboard.repository,
      instance: {
        ...dashboard.repository.instance,
        state: "unknown",
        reason: "Runtime state could not be verified. No completion is inferred.",
        retryable: false,
      },
    },
    build: null,
    operations: [],
  },
  "read-only": {
    ...dashboard,
    repository: { ...dashboard.repository, permission: "read" },
    canConfigure: false,
  },
};
const filenames = [];
for (const mode of ["desktop", "mobile"]) {
  for (const [scenario, fixture] of Object.entries(scenarios)) {
    const response = renderRepositoryDashboard(fixture, {
      presentation: { mode, repositoryId: fixture.repository.repositoryId },
      csrfToken: "offline-preview-token",
      createIdempotencyKey: () => "offline-preview-idempotency",
    });
    const html = await response.text();
    const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1];
    assert(style, `Missing stylesheet in ${mode}/${scenario}`);
    const digest = createHash("sha256").update(style).digest("base64");
    assert(response.headers.get("Content-Security-Policy")?.includes(`style-src 'sha256-${digest}'`),
      `CSP hash mismatch in ${mode}/${scenario}`);
    assert(html.includes('class="evidence-workspace"'), `Missing B composition: ${mode}/${scenario}`);
    assert(html.includes('aria-label="Current deployment"'));
    assert(html.includes('aria-label="Desired deployment"'));
    assert(html.includes('id="configuration"') && html.includes('id="activity"'));
    assert(!html.includes("<script>"), "Offline snapshot unexpectedly has application script");
    if (scenario === "ready-failed") {
      assert(html.includes("Ready") && html.includes("Failed"));
      assert(html.includes("producer rejected this module selection"));
    }
    if (scenario === "read-only") {
      assert(!html.includes('name="action" value="configure"'));
    }
    const file = `praetorium-evidence-ledger-${mode}-${scenario}.html`;
    await writeFile(join(outDir, file), html, "utf8");
    filenames.push(file);
    console.log(`${file}: ${Buffer.byteLength(html)} bytes, CSP validated`);
  }
}
const links = filenames.map(name => `<li><a href="${name}">${name}</a></li>`).join("\n");
const index = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Praetorium Evidence Ledger — actual SSR snapshots</title><style>body{margin:0;padding:clamp(18px,4vw,54px);font:16px/1.6 system-ui,sans-serif;color:#153c2f;background:#f1f4ef}main{max-width:950px;margin:auto}h1{font-size:clamp(28px,4vw,50px);letter-spacing:-.05em}a{color:#205b46}li{padding:8px}small{color:#516459}</style><main><h1>Evidence Ledger — rendered HTML</h1><p>Actual server-rendered HTML exported from the Pull Request's TypeScript renderer and its existing synthetic fixture. No real authentication, operations or service backend. Commands shown inside snapshots are inert outside the live Gateway.</p><p><small>Desktop/Mobile are explicitly selected presentation modes; the repository UI does not infer the mode from browser width.</small></p><ul>${links}</ul></main></html>`;
await writeFile(join(outDir, "index.html"), index, "utf8");
console.log(JSON.stringify({ outDir, scenarios: Object.keys(scenarios), modes: ["desktop", "mobile"], files: filenames.length + 1 }));
