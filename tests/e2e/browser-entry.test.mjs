import assert from "node:assert/strict";
import { access, lstat, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { chromium } from "@playwright/test";

const CATEGORY = "browser-entry";
const INVENTORY_ENV = "PRAETORIUM_T14_INVENTORY_PATH";
const CATEGORY_ENV = "PRAETORIUM_T14_CATEGORY";
const RESULT_ENV = "PRAETORIUM_T14_RESULT_PATH";
const RESULT_FILENAME = "runner-result.json";
const PRODUCER_STATUS_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../docs/migration/PRODUCER-STATUS.json",
);
const REQUIRED_CATEGORIES = [
  "workers-d1-do",
  "github-access",
  "buildkit-registry",
  "kubernetes-isolation",
  "browser-entry",
  "producer-recovery",
  "stable-rollout",
];
const MAX_INVENTORY_BYTES = 64 * 1024;
const MAX_CONFIG_BYTES = 32 * 1024;
const MAX_STORAGE_STATE_BYTES = 2 * 1024 * 1024;
const MAX_WRITE_BODY_BYTES = 8 * 1024;
const ID_PATTERN = /^ins_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const REVISION_PATTERN = /^[0-9a-f]{40}$/u;
const BLOCKED_CODES = new Set([
  "OWNER_INPUT_MISSING",
  "OWNED_ENVIRONMENT_UNAVAILABLE",
  "PRODUCER_CONTRACT_MISSING",
  "RUNTIME_UNAVAILABLE",
  "BROWSER_UNAVAILABLE",
  "INSUFFICIENT_LIFETIME",
]);

class GateBlocked extends Error {
  constructor(reasonCode) {
    super(reasonCode);
    this.reasonCode = reasonCode;
  }
}

function block(reasonCode) {
  throw new GateBlocked(reasonCode);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return (
    isRecord(value) && Object.keys(value).sort().join("\0") === [...expected].sort().join("\0")
  );
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function safeText(value, maximum = 512) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 0x20 || codePoint === 0x7f;
    })
  );
}

function parseOrigin(value) {
  if (!nonEmpty(value)) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.origin !== value ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.hostname.length > 253 ||
      /(?:^|\.)(?:localhost|example\.(?:com|net|org)|invalid|test)$/u.test(url.hostname)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function safeAbsolutePath(value) {
  return typeof value === "string" && path.isAbsolute(value) && !value.includes("\0");
}

function validateInventory(inventory) {
  if (
    !exactKeys(inventory, ["schemaVersion", "inventoryId", "owner", "environment", "resources"]) ||
    inventory.schemaVersion !== 1 ||
    !safeText(inventory.inventoryId, 128) ||
    !exactKeys(inventory.owner, ["name", "identity"]) ||
    !safeText(inventory.owner.name, 256) ||
    !safeText(inventory.owner.identity, 256) ||
    !exactKeys(inventory.environment, [
      "name",
      "purpose",
      "disposable",
      "production",
      "expiresAt",
      "cleanupProcedure",
    ]) ||
    !safeText(inventory.environment.name, 256) ||
    inventory.environment.purpose !== "t14-disposable-test" ||
    inventory.environment.disposable !== true ||
    inventory.environment.production !== false ||
    !safeText(inventory.environment.cleanupProcedure, 2048) ||
    !safeText(inventory.environment.expiresAt, 64) ||
    Date.parse(inventory.environment.expiresAt) <= Date.now() ||
    !exactKeys(inventory.resources, REQUIRED_CATEGORIES)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  for (const category of REQUIRED_CATEGORIES) {
    const resource = inventory.resources[category];
    if (
      !exactKeys(resource, ["state", "owner", "disposable", "production", "reference"]) ||
      !["available", "missing"].includes(resource.state) ||
      resource.owner !== inventory.owner.identity ||
      resource.disposable !== true ||
      resource.production !== false ||
      (resource.state === "missing" && resource.reference !== null) ||
      (resource.state === "available" && !safeText(resource.reference, 1024))
    ) {
      block("OWNER_INPUT_MISSING");
    }
  }

  if (inventory.resources[CATEGORY].state !== "available") {
    block("OWNED_ENVIRONMENT_UNAVAILABLE");
  }
  if (!safeAbsolutePath(inventory.resources[CATEGORY].reference)) {
    block("OWNER_INPUT_MISSING");
  }
}

async function readJsonFile(filePath, maximumBytes, privateFile = false) {
  if (!safeAbsolutePath(filePath)) block("OWNER_INPUT_MISSING");
  const linkInfo = await lstat(filePath).catch(() => null);
  if (!linkInfo?.isFile() || linkInfo.isSymbolicLink()) block("OWNER_INPUT_MISSING");
  const actualPath = await realpath(filePath).catch(() => null);
  if (!actualPath || actualPath !== path.resolve(filePath)) block("OWNER_INPUT_MISSING");
  const fileInfo = await stat(actualPath).catch(() => null);
  if (
    !fileInfo?.isFile() ||
    fileInfo.size > maximumBytes ||
    (privateFile && (fileInfo.uid !== process.getuid?.() || (fileInfo.mode & 0o077) !== 0))
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const contents = await readFile(actualPath).catch(() => null);
  if (!contents || contents.byteLength > maximumBytes) block("OWNER_INPUT_MISSING");
  try {
    const value = JSON.parse(contents.toString("utf8"));
    if (!isRecord(value)) block("OWNER_INPUT_MISSING");
    return value;
  } catch {
    block("OWNER_INPUT_MISSING");
  }
}

function validateBrowserState(state) {
  if (
    !exactKeys(state, ["cookies", "origins"]) ||
    !Array.isArray(state.cookies) ||
    !Array.isArray(state.origins)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  if (state.origins.length !== 0) block("OWNER_INPUT_MISSING");
  for (const cookie of state.cookies) {
    if (!isRecord(cookie) || typeof cookie.domain !== "string") block("OWNER_INPUT_MISSING");
    const domain = cookie.domain.replace(/^\./u, "").toLowerCase();
    if (domain !== "github.com" && !domain.endsWith(".github.com")) {
      block("OWNER_INPUT_MISSING");
    }
  }
}

function validateWriteProbe(value) {
  if (
    !exactKeys(value, ["path", "body"]) ||
    typeof value.path !== "string" ||
    !isRecord(value.body)
  ) {
    block("OWNER_INPUT_MISSING");
  }
  let parsed;
  try {
    parsed = new URL(value.path, "https://instance.invalid");
  } catch {
    block("OWNER_INPUT_MISSING");
  }
  if (
    parsed.origin !== "https://instance.invalid" ||
    parsed.pathname !== value.path ||
    parsed.search ||
    parsed.hash ||
    !(
      parsed.pathname.startsWith("/api/") ||
      parsed.pathname === "/mcp" ||
      parsed.pathname.startsWith("/mcp/")
    )
  ) {
    block("OWNER_INPUT_MISSING");
  }
  const body = JSON.stringify(value.body);
  if (Buffer.byteLength(body) > MAX_WRITE_BODY_BYTES) block("OWNER_INPUT_MISSING");
  return body;
}

function validateConfig(config, inventory) {
  if (
    !exactKeys(config, [
      "schemaVersion",
      "inventory",
      "gateway",
      "repository",
      "instance",
      "browser",
      "producer",
      "writeProbe",
      "selection",
      "timeouts",
    ]) ||
    config.schemaVersion !== 1
  ) {
    block("OWNER_INPUT_MISSING");
  }
  if (
    !exactKeys(config.inventory, [
      "inventoryId",
      "ownerIdentity",
      "environmentName",
      "expiresAt",
    ]) ||
    config.inventory.inventoryId !== inventory.inventoryId ||
    config.inventory.ownerIdentity !== inventory.owner.identity ||
    config.inventory.environmentName !== inventory.environment.name ||
    config.inventory.expiresAt !== inventory.environment.expiresAt
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.gateway, ["origin", "expectedUserId"]) ||
    !parseOrigin(config.gateway.origin) ||
    !safeText(config.gateway.expectedUserId, 128) ||
    !exactKeys(config.repository, ["id", "fullName"]) ||
    !Number.isSafeInteger(config.repository.id) ||
    config.repository.id < 1 ||
    !/^[A-Za-z0-9_.-]{1,255}\/[A-Za-z0-9_.-]{1,255}$/u.test(config.repository.fullName) ||
    !exactKeys(config.instance, ["id", "origin", "applicationHeading"]) ||
    !ID_PATTERN.test(config.instance.id) ||
    !parseOrigin(config.instance.origin) ||
    !safeText(config.instance.applicationHeading, 256)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  const instanceOrigin = parseOrigin(config.instance.origin);
  const gatewayOrigin = parseOrigin(config.gateway.origin);
  const expectedInstanceLabel = `ins-${config.instance.id.slice(4).toLowerCase()}.`;
  if (
    !instanceOrigin ||
    !gatewayOrigin ||
    instanceOrigin.origin === gatewayOrigin.origin ||
    !instanceOrigin.hostname.startsWith(expectedInstanceLabel) ||
    instanceOrigin.hostname.split(".").length < 3
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.browser, ["executablePath", "githubStorageStatePath"]) ||
    !safeAbsolutePath(config.browser.executablePath) ||
    !safeAbsolutePath(config.browser.githubStorageStatePath)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.producer, ["revision", "tree", "artifactDigest"]) ||
    !REVISION_PATTERN.test(config.producer.revision) ||
    !REVISION_PATTERN.test(config.producer.tree) ||
    !DIGEST_PATTERN.test(config.producer.artifactDigest)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.selection, [
      "releasePolicy",
      "releaseId",
      "moduleIds",
      "resourceProfileId",
    ]) ||
    !["stable", "pinned"].includes(config.selection.releasePolicy) ||
    !safeText(config.selection.releaseId, 128) ||
    !Array.isArray(config.selection.moduleIds) ||
    config.selection.moduleIds.length === 0 ||
    config.selection.moduleIds.some((moduleId) => !safeText(moduleId, 128)) ||
    new Set(config.selection.moduleIds).size !== config.selection.moduleIds.length ||
    !safeText(config.selection.resourceProfileId, 128)
  ) {
    block("OWNER_INPUT_MISSING");
  }

  if (
    !exactKeys(config.timeouts, [
      "loginSeconds",
      "wakeSeconds",
      "configurationSeconds",
      "redeploySeconds",
    ]) ||
    Object.values(config.timeouts).some(
      (seconds) => !Number.isSafeInteger(seconds) || seconds < 10 || seconds > 1800,
    )
  ) {
    block("OWNER_INPUT_MISSING");
  }

  const requiredLifetimeSeconds =
    Object.values(config.timeouts).reduce((sum, value) => sum + value, 0) + 120;
  if (
    requiredLifetimeSeconds > 3_600 ||
    Date.parse(inventory.environment.expiresAt) - Date.now() < requiredLifetimeSeconds * 1000
  ) {
    block("INSUFFICIENT_LIFETIME");
  }

  const writeProbeBody = validateWriteProbe(config.writeProbe);
  return { gatewayOrigin, instanceOrigin, writeProbeBody };
}

async function loadInputs() {
  if (process.env[CATEGORY_ENV] !== CATEGORY || !safeAbsolutePath(process.env[INVENTORY_ENV])) {
    block("OWNER_INPUT_MISSING");
  }
  const inventory = await readJsonFile(process.env[INVENTORY_ENV], MAX_INVENTORY_BYTES);
  validateInventory(inventory);
  const configPath = inventory.resources[CATEGORY].reference;
  const config = await readJsonFile(configPath, MAX_CONFIG_BYTES, true);
  const derived = validateConfig(config, inventory);

  const executablePath = await realpath(config.browser.executablePath).catch(() => null);
  if (!executablePath || !(await stat(executablePath).catch(() => null))?.isFile()) {
    block("BROWSER_UNAVAILABLE");
  }
  try {
    await access(executablePath, fsConstants.X_OK);
  } catch {
    block("BROWSER_UNAVAILABLE");
  }

  const storageState = await readJsonFile(
    config.browser.githubStorageStatePath,
    MAX_STORAGE_STATE_BYTES,
    true,
  );
  validateBrowserState(storageState);

  const producer = await readJsonFile(PRODUCER_STATUS_PATH, MAX_CONFIG_BYTES);
  const capabilities = new Map(
    Array.isArray(producer.capabilities)
      ? producer.capabilities.filter((item) => isRecord(item)).map((item) => [item.id, item])
      : [],
  );
  const producerReady = ["S01", "S02", "S03", "S04", "S05"].every(
    (id) => capabilities.get(id)?.status === "available",
  );
  if (
    !producerReady ||
    !REVISION_PATTERN.test(producer.producerRevision ?? "") ||
    !REVISION_PATTERN.test(producer.producerTree ?? "") ||
    !DIGEST_PATTERN.test(producer.artifactDigest ?? "") ||
    producer.producerRevision !== config.producer.revision ||
    producer.producerTree !== config.producer.tree ||
    producer.artifactDigest !== config.producer.artifactDigest
  ) {
    block("PRODUCER_CONTRACT_MISSING");
  }
  return { inventory, config, storageState, derived, executablePath };
}

async function writeRunnerResult(status, reasonCode) {
  if (!BLOCKED_CODES.has(reasonCode) && reasonCode !== "ACCEPTANCE_ASSERTION_FAILED") return;
  const reportPath = process.env[RESULT_ENV];
  if (!safeAbsolutePath(reportPath)) return;
  const isolatedHome = process.env.HOME;
  if (!safeAbsolutePath(isolatedHome)) return;
  const resolvedHome = await realpath(isolatedHome).catch(() => null);
  const resolvedParent = await realpath(path.dirname(reportPath)).catch(() => null);
  if (
    !resolvedHome ||
    resolvedParent !== resolvedHome ||
    path.basename(reportPath) !== RESULT_FILENAME
  )
    return;
  const report = { reportVersion: 1, category: CATEGORY, status, reasonCode };
  await writeFile(path.join(resolvedHome, RESULT_FILENAME), `${JSON.stringify(report)}\n`, {
    flag: "wx",
    mode: 0o600,
  }).catch(() => {});
}

function isGithubHost(hostname) {
  const host = hostname.toLowerCase();
  return (
    host === "github.com" ||
    host.endsWith(".github.com") ||
    host === "githubassets.com" ||
    host.endsWith(".githubassets.com") ||
    host === "githubusercontent.com" ||
    host.endsWith(".githubusercontent.com")
  );
}

function readCookie(cookies, name, host) {
  const matches = cookies.filter((cookie) => cookie.name === name);
  assert.equal(matches.length, 1, "expected one host-only cookie");
  const cookie = matches[0];
  assert.equal(cookie.domain, host, "cookie must be host-only");
  assert.equal(cookie.secure, true, "cookie must be Secure");
  assert.equal(cookie.sameSite, "Lax", "cookie must use SameSite=Lax");
  return cookie;
}

async function cookiesAt(context, origin) {
  const host = new URL(origin).hostname;
  return (await context.cookies()).filter((cookie) => cookie.domain === host);
}

function parseModuleSelection(text) {
  const match = /Requested modules:\s*([\s\S]*?)\s*Included modules:/u.exec(text);
  if (!match) return null;
  const section = match[1]?.trim() ?? "";
  if (section === "None") return [];
  return section.split(", ").map((value) => value.replace(/\s+\([^()]*\)$/u, "").trim());
}

async function formSelection(form) {
  return {
    releasePolicy: await form.locator('select[name="releasePolicy"]').inputValue(),
    releaseId: await form.locator('select[name="releaseId"]').inputValue(),
    moduleIds: await form
      .locator('select[name="moduleIds"] option:checked')
      .evaluateAll((options) => options.map((option) => option.value).sort()),
    resourceProfileId: await form.locator('select[name="resourceProfileId"]').inputValue(),
  };
}

function sameSelection(left, right) {
  return (
    left.releasePolicy === right.releasePolicy &&
    left.releaseId === right.releaseId &&
    JSON.stringify([...left.moduleIds].sort()) === JSON.stringify([...right.moduleIds].sort()) &&
    left.resourceProfileId === right.resourceProfileId
  );
}

function extractDigest(text) {
  return /Composed image:\s*(sha256:[0-9a-f]{64})/u.exec(text)?.[1] ?? null;
}

async function dashboardSnapshot(page, config, gatewayOrigin) {
  const response = await page.goto(`${gatewayOrigin.origin}/repositories/${config.repository.id}`, {
    waitUntil: "domcontentloaded",
  });
  assert.equal(response?.status(), 200, "repository dashboard must load successfully");
  await page.getByRole("heading", { name: config.repository.fullName, exact: true }).waitFor();
  const text = await page.locator("main").innerText();
  const state = /Instance:\s*(Ready|Starting|Stopped|Failed|Blocked|Status unavailable)/u.exec(
    text,
  )?.[1];
  assert.ok(state, "dashboard must show the instance state");
  const current = page
    .getByRole("heading", { name: "Current deployment", exact: true })
    .locator("xpath=..");
  const desired = page
    .getByRole("heading", { name: "Desired deployment", exact: true })
    .locator("xpath=..");
  const configureForm = page.locator("form").filter({
    has: page.locator('input[name="action"][value="configure"]'),
  });
  return {
    text,
    state,
    currentDigest: extractDigest(await current.innerText()),
    desiredDigest: extractDigest(await desired.innerText()),
    currentModules: parseModuleSelection(await current.innerText()),
    desiredModules: parseModuleSelection(await desired.innerText()),
    selection: (await configureForm.count()) === 1 ? await formSelection(configureForm) : null,
  };
}

async function waitForReadyApp(page, config, derived, handoffPosts, deadlineMs) {
  const entryPath = `/entry/${encodeURIComponent(config.instance.id)}`;
  while (Date.now() < deadlineMs) {
    const location = new URL(page.url());
    if (location.origin === derived.instanceOrigin.origin && location.pathname === "/") {
      const heading = page.getByRole("heading", {
        name: config.instance.applicationHeading,
        exact: true,
      });
      if (await heading.count()) {
        await heading.waitFor({ state: "visible", timeout: 5_000 });
        return;
      }
    }

    if (location.origin === derived.gatewayOrigin.origin && location.pathname === entryPath) {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      if (body.includes("Configuration required")) {
        throw new Error("application artifact is not configured");
      }
      const poll = Number(location.searchParams.get("poll") ?? "0");
      if (body.includes("Repository instance is starting") && poll >= 5) {
        const statusLink = page.getByRole("link", { name: "Check status", exact: true });
        if (await statusLink.count()) await statusLink.click();
      }
    }

    await delay(1_000);
  }
  assert.fail("instance did not reach the producer application before the owned deadline");
}

async function waitForDeployment(page, config, derived, expectedModules, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const snapshot = await dashboardSnapshot(page, config, derived.gatewayOrigin);
    const alerts = await page.getByRole("alert").allTextContents();
    if (alerts.length > 0 || /Build: (Failed|Canceled)/u.test(snapshot.text)) {
      assert.fail("configuration build failed; current deployment must remain available");
    }
    const deployedAndRequestedModulesMatch =
      snapshot.currentModules !== null &&
      snapshot.desiredModules !== null &&
      snapshot.currentModules.length > 0 &&
      JSON.stringify([...snapshot.currentModules].sort()) ===
        JSON.stringify([...snapshot.desiredModules].sort());
    if (
      snapshot.state === "Ready" &&
      snapshot.currentDigest &&
      snapshot.currentDigest === snapshot.desiredDigest &&
      snapshot.selection !== null &&
      sameSelection(snapshot.selection, config.selection) &&
      deployedAndRequestedModulesMatch &&
      JSON.stringify([...snapshot.selection.moduleIds].sort()) ===
        JSON.stringify([...expectedModules].sort())
    ) {
      return snapshot;
    }
    await delay(2_000);
  }
  assert.fail("configuration did not build and become ready before the owned deadline");
}

async function verifyApplicationCookies(context, derived) {
  const cookies = await cookiesAt(context, derived.instanceOrigin.origin);
  const access = readCookie(cookies, "__Host-praetorium_access", derived.instanceOrigin.hostname);
  const refresh = readCookie(
    cookies,
    "__Secure-praetorium_refresh",
    derived.instanceOrigin.hostname,
  );
  const csrf = readCookie(cookies, "__Host-praetorium_csrf", derived.instanceOrigin.hostname);
  assert.equal(access.path, "/");
  assert.equal(access.httpOnly, true);
  assert.equal(refresh.path, "/_platform");
  assert.equal(refresh.httpOnly, true);
  assert.equal(csrf.path, "/");
  assert.equal(csrf.httpOnly, false);
}

test(
  "real Gateway OAuth, repository UI, stopped-origin wake, handoff, and reconfiguration",
  { timeout: 3_600_000 },
  async () => {
    let inputs;
    try {
      inputs = await loadInputs();
    } catch (error) {
      const reasonCode =
        error instanceof GateBlocked && BLOCKED_CODES.has(error.reasonCode)
          ? error.reasonCode
          : "OWNER_INPUT_MISSING";
      await writeRunnerResult("BLOCKED", reasonCode);
      throw new Error(`BLOCKED: ${reasonCode}`);
    }

    const { config, storageState, derived, executablePath } = inputs;
    let browser;
    let context;
    let stage = "browser-launch";
    const gatewayRequests = [];
    const instanceRequests = [];
    const handoffPosts = [];
    try {
      try {
        browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
      } catch {
        block("BROWSER_UNAVAILABLE");
      }
      context = await browser.newContext({ storageState });
      context.setDefaultTimeout(15_000);
      context.setDefaultNavigationTimeout(Math.max(...Object.values(config.timeouts)) * 1_000);
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin === derived.gatewayOrigin.origin ||
          url.origin === derived.instanceOrigin.origin ||
          (url.protocol === "https:" && isGithubHost(url.hostname))
        ) {
          await route.continue();
        } else {
          await route.abort("blockedbyclient");
        }
      });
      const page = await context.newPage();
      page.on("request", (request) => {
        const url = new URL(request.url());
        const entry = { origin: url.origin, pathname: url.pathname, method: request.method() };
        if (url.origin === derived.gatewayOrigin.origin) gatewayRequests.push(entry);
        if (url.origin === derived.instanceOrigin.origin) {
          instanceRequests.push(entry);
          if (url.pathname === "/_platform/handoff" && request.method() === "POST") {
            const form = new URLSearchParams(request.postData() ?? "");
            const values = form.getAll("code");
            const returnPaths = form.getAll("returnPath");
            handoffPosts.push({
              code: values.length === 1 ? values[0] : null,
              validForm: values.length === 1 && returnPaths.length === 1 && returnPaths[0] === "/",
              referer: request.headers().referer ?? "",
            });
          }
        }
      });

      stage = "gateway-runtime-probe";
      let gatewayHealth;
      try {
        gatewayHealth = await context.request.get(`${derived.gatewayOrigin.origin}/healthz`, {
          timeout: 10_000,
          maxRedirects: 0,
        });
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      if (gatewayHealth.status() !== 200) block("RUNTIME_UNAVAILABLE");

      stage = "github-oauth-login";
      await page.goto(`${derived.gatewayOrigin.origin}/`, { waitUntil: "domcontentloaded" });
      const loginDeadline = Date.now() + config.timeouts.loginSeconds * 1000;
      while (Date.now() < loginDeadline) {
        const location = new URL(page.url());
        if (location.origin === derived.gatewayOrigin.origin && location.pathname === "/") break;
        if (location.hostname === "github.com" || location.hostname.endsWith(".github.com")) {
          await delay(1_000);
          continue;
        }
        block("OWNED_ENVIRONMENT_UNAVAILABLE");
      }
      if (
        new URL(page.url()).origin !== derived.gatewayOrigin.origin ||
        new URL(page.url()).pathname !== "/"
      ) {
        block("OWNED_ENVIRONMENT_UNAVAILABLE");
      }
      assert.equal(
        gatewayRequests.filter((request) => request.pathname === "/auth/github/callback").length,
        1,
        "the authenticated Gateway session must be created by its real GitHub OAuth callback",
      );
      const session = await page.evaluate(async () => {
        const response = await fetch("/api/session", { cache: "no-store" });
        return { status: response.status, body: await response.json().catch(() => null) };
      });
      assert.equal(session.status, 200, "OAuth callback must create a usable Gateway session");
      assert.equal(session.body?.userId, config.gateway.expectedUserId);
      const gatewayCookies = await cookiesAt(context, derived.gatewayOrigin.origin);
      const sessionCookie = readCookie(
        gatewayCookies,
        "__Host-praetorium_session",
        derived.gatewayOrigin.hostname,
      );
      const csrfCookie = readCookie(
        gatewayCookies,
        "__Host-praetorium_csrf",
        derived.gatewayOrigin.hostname,
      );
      assert.equal(sessionCookie.path, "/");
      assert.equal(sessionCookie.httpOnly, true);
      assert.equal(csrfCookie.path, "/");
      assert.equal(csrfCookie.httpOnly, false);
      assert.equal(
        gatewayCookies.some((cookie) => cookie.name === "__Host-praetorium_login_nonce"),
        false,
        "OAuth nonce must be cleared after callback",
      );

      stage = "repository-and-stopped-dashboard";
      const dashboard = await dashboardSnapshot(page, config, derived.gatewayOrigin);
      if (dashboard.state !== "Stopped" || !dashboard.currentDigest || !dashboard.desiredDigest) {
        block("OWNED_ENVIRONMENT_UNAVAILABLE");
      }
      assert.match(
        dashboard.text,
        new RegExp(config.repository.fullName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")),
      );
      assert.match(dashboard.text, /GitHub App: Active/u);
      assert.match(dashboard.text, /Repository access: (Maintain|Admin) access/u);

      const configureForm = page.locator("form").filter({
        has: page.locator('input[name="action"][value="configure"]'),
      });
      if (!(await configureForm.count())) block("OWNED_ENVIRONMENT_UNAVAILABLE");
      const initialSelection = await formSelection(configureForm);
      if (sameSelection(initialSelection, config.selection)) block("OWNER_INPUT_MISSING");
      if (
        dashboard.currentModules &&
        JSON.stringify([...dashboard.currentModules].sort()) ===
          JSON.stringify([...config.selection.moduleIds].sort())
      ) {
        block("OWNER_INPUT_MISSING");
      }

      stage = "stopped-api-write-no-replay";
      const stoppedBeforeWrite = await dashboardSnapshot(page, config, derived.gatewayOrigin);
      if (stoppedBeforeWrite.state !== "Stopped") block("OWNED_ENVIRONMENT_UNAVAILABLE");
      if ((await cookiesAt(context, derived.instanceOrigin.origin)).length !== 0) {
        block("OWNER_INPUT_MISSING");
      }
      let writeResponse;
      try {
        writeResponse = await context.request.post(
          `${derived.instanceOrigin.origin}${config.writeProbe.path}`,
          {
            data: derived.writeProbeBody,
            headers: {
              Accept: "application/json",
              "Cache-Control": "no-store",
              "Content-Type": "application/json",
              Origin: derived.instanceOrigin.origin,
              "Sec-Fetch-Mode": "cors",
              "Sec-Fetch-Site": "same-origin",
            },
            maxRedirects: 0,
            timeout: 10_000,
          },
        );
      } catch {
        block("RUNTIME_UNAVAILABLE");
      }
      assert.equal(writeResponse.status(), 503, "stopped instance writes must fail closed");
      assert.equal(writeResponse.headers()["retry-after"], "5");
      assert.equal(
        writeResponse.headers()["location"],
        undefined,
        "write must not be redirected or replayed",
      );
      const writeResult = await writeResponse.json().catch(() => null);
      assert.equal(writeResult?.error?.code, "INSTANCE_STARTING");

      stage = "stopped-bookmark-wake-and-handoff";
      const initialHandoffCount = handoffPosts.length;
      await page.goto(`${derived.instanceOrigin.origin}/`, { waitUntil: "domcontentloaded" });
      await waitForReadyApp(
        page,
        config,
        derived,
        handoffPosts,
        Date.now() + config.timeouts.wakeSeconds * 1000,
      );
      assert.equal(new URL(page.url()).origin, derived.instanceOrigin.origin);
      assert.equal(new URL(page.url()).pathname, "/");
      assert.equal(
        await page
          .getByRole("heading", { name: config.instance.applicationHeading, exact: true })
          .count(),
        1,
      );
      assert.equal(
        handoffPosts.length - initialHandoffCount,
        1,
        "stopped bookmark wake must use one handoff",
      );
      const firstHandoff = handoffPosts.at(-1);
      assert.ok(
        firstHandoff?.validForm && firstHandoff.code,
        "handoff form must carry one one-use code",
      );
      assert.equal(firstHandoff.referer, "", "handoff code must not be sent in a Referer header");
      await verifyApplicationCookies(context, derived);

      const replay = await context.request.post(
        `${derived.instanceOrigin.origin}/_platform/handoff`,
        {
          data: new URLSearchParams({ code: firstHandoff.code, returnPath: "/" }).toString(),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            Origin: derived.gatewayOrigin.origin,
          },
          maxRedirects: 0,
          timeout: 10_000,
        },
      );
      assert.equal(replay.status(), 401, "a consumed handoff code must not be reusable");
      assert.equal(
        replay.headers()["set-cookie"],
        undefined,
        "replayed code must not mint application cookies",
      );

      stage = "ui-selection-preview";
      await dashboardSnapshot(page, config, derived.gatewayOrigin);
      const previewButton = page.getByRole("button", { name: "Preview selection", exact: true });
      const previewForm = previewButton.locator("xpath=ancestor::form");
      await previewForm
        .locator('select[name="releasePolicy"]')
        .selectOption(config.selection.releasePolicy);
      await previewForm
        .locator('select[name="releaseId"]')
        .selectOption(config.selection.releaseId);
      await previewForm
        .locator('select[name="moduleIds"]')
        .selectOption(config.selection.moduleIds);
      await previewForm
        .locator('select[name="resourceProfileId"]')
        .selectOption(config.selection.resourceProfileId);
      await previewButton.click();
      await page.getByText("Supported module configuration", { exact: true }).waitFor();
      const previewStatus = page.locator(
        'section[aria-labelledby="module-preview"] [role="status"]',
      );
      const previewText = await previewStatus.innerText();
      assert.ok(previewText.includes("Requested modules:"));
      const previewedForm = page.locator("form").filter({
        has: page.locator('input[name="action"][value="configure"]'),
      });
      assert.equal(await previewedForm.count(), 1);
      assert.ok(sameSelection(await formSelection(previewedForm), config.selection));

      stage = "ui-reconfigure-build-and-preservation";
      const actionPath = `/repositories/${config.repository.id}/actions`;
      const saveResponsePromise = page.waitForResponse(
        (response) =>
          response.url().startsWith(`${derived.gatewayOrigin.origin}${actionPath}`) &&
          response.request().method() === "POST",
      );
      await page.getByRole("button", { name: "Save and build", exact: true }).click();
      const saveResponse = await saveResponsePromise;
      assert.equal(saveResponse.status(), 202, "UI configuration must queue the build");
      const duringBuild = await page.goto(`${derived.instanceOrigin.origin}/`, {
        waitUntil: "domcontentloaded",
      });
      assert.equal(
        duringBuild?.status(),
        200,
        "current application must remain reachable during a new build",
      );
      await page
        .getByRole("heading", { name: config.instance.applicationHeading, exact: true })
        .waitFor();
      const configured = await waitForDeployment(
        page,
        config,
        derived,
        config.selection.moduleIds,
        Date.now() + config.timeouts.configurationSeconds * 1000,
      );
      assert.notEqual(
        configured.currentDigest,
        dashboard.currentDigest,
        "a distinct composition must produce a new digest",
      );
      const configuredDigest = configured.currentDigest;

      stage = "ui-same-image-redeploy";
      await page
        .getByRole("button", { name: "Redeploy current configuration", exact: true })
        .waitFor();
      const redeployResponsePromise = page.waitForResponse(
        (response) =>
          response.url().startsWith(`${derived.gatewayOrigin.origin}${actionPath}`) &&
          response.request().method() === "POST",
      );
      await page
        .getByRole("button", { name: "Redeploy current configuration", exact: true })
        .click();
      const redeployResponse = await redeployResponsePromise;
      assert.equal(redeployResponse.status(), 202, "same-image redeploy must be accepted");
      let redeployed;
      const redeployDeadline = Date.now() + config.timeouts.redeploySeconds * 1000;
      while (Date.now() < redeployDeadline) {
        redeployed = await dashboardSnapshot(page, config, derived.gatewayOrigin);
        if (/redeploy: Complete/iu.test(redeployed.text) && redeployed.state === "Ready") break;
        if (/redeploy: Failed|redeploy: Blocked/iu.test(redeployed.text)) {
          assert.fail("same-image redeploy failed");
        }
        await delay(2_000);
      }
      assert.ok(
        redeployed && /redeploy: Complete/iu.test(redeployed.text),
        "redeploy operation must complete",
      );
      assert.equal(redeployed.state, "Ready");
      assert.equal(
        redeployed.currentDigest,
        configuredDigest,
        "same-image redeploy must preserve the image digest",
      );

      stage = "ui-entry-after-redeploy";
      await page.getByRole("button", { name: "Enter application", exact: true }).waitFor();
      const handoffCountBeforeUiEntry = handoffPosts.length;
      await page.getByRole("button", { name: "Enter application", exact: true }).click();
      await waitForReadyApp(
        page,
        config,
        derived,
        handoffPosts,
        Date.now() + config.timeouts.redeploySeconds * 1000,
      );
      assert.equal(
        handoffPosts.length - handoffCountBeforeUiEntry,
        1,
        "UI entry must mint one handoff",
      );
      assert.equal(
        new URL(page.url()).origin,
        derived.instanceOrigin.origin,
        "reconfiguration must keep the stable origin",
      );
      await verifyApplicationCookies(context, derived);

      stage = "instance-access-csrf-refresh";
      const csrfBefore = (await cookiesAt(context, derived.instanceOrigin.origin)).find(
        (cookie) => cookie.name === "__Host-praetorium_csrf",
      );
      assert.ok(csrfBefore && !csrfBefore.httpOnly);
      const invalidRefresh = await page.evaluate(async () => {
        const response = await fetch("/_platform/refresh", {
          method: "POST",
          headers: { "X-CSRF-Token": "invalid-t14-csrf" },
          redirect: "manual",
        });
        return { status: response.status, body: await response.json().catch(() => null) };
      });
      assert.equal(invalidRefresh.status, 403, "invalid-CSRF refresh must fail");
      assert.equal(invalidRefresh.body?.error?.code, "CSRF_INVALID");
      const beforeRefresh = (await cookiesAt(context, derived.instanceOrigin.origin)).find(
        (cookie) => cookie.name === "__Host-praetorium_access",
      )?.value;
      const validRefresh = await page.evaluate(async () => {
        const csrf = globalThis.document.cookie
          .split(";")
          .map((part) => part.trim())
          .find((part) => part.startsWith("__Host-praetorium_csrf="))
          ?.slice("__Host-praetorium_csrf=".length);
        const response = await fetch("/_platform/refresh", {
          method: "POST",
          headers: { "X-CSRF-Token": csrf ?? "" },
          redirect: "manual",
        });
        return { status: response.status, location: response.headers.get("location") };
      });
      assert.equal(validRefresh.status, 303, "valid same-origin CSRF refresh must rotate access");
      assert.equal(validRefresh.location, "/");
      const afterRefreshCookies = await cookiesAt(context, derived.instanceOrigin.origin);
      assert.notEqual(
        afterRefreshCookies.find((cookie) => cookie.name === "__Host-praetorium_access")?.value,
        beforeRefresh,
        "refresh must replace the short-lived access cookie",
      );
      assert.equal(
        handoffPosts.some((handoff) => handoff.code?.includes("=")),
        false,
      );
      assert.equal(
        instanceRequests.some(
          (request) => request.pathname === "/_platform/handoff" && request.method === "GET",
        ),
        false,
      );
    } catch (error) {
      const reasonCode =
        error instanceof GateBlocked && BLOCKED_CODES.has(error.reasonCode)
          ? error.reasonCode
          : "ACCEPTANCE_ASSERTION_FAILED";
      await writeRunnerResult(
        reasonCode === "ACCEPTANCE_ASSERTION_FAILED" ? "FAILED" : "BLOCKED",
        reasonCode,
      );
      throw new Error(`${reasonCode}: ${stage}`);
    } finally {
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  },
);
