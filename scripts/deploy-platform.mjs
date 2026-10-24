#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";
import { workNotificationsEnabled } from "../infrastructure/scripts/work-notifications.mjs";
import { platformDeploymentSteps } from "./deployment-plan.mjs";
import { privateFile, adoptCiServiceImages, withDeploymentLock } from "./service-image-publication.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (["--inventory", "--secret-files", "--kubeconfig", "--confirm", "--cloudflare-token-file", "--buildctl", "--buildkit-address", "--management-inventory"].includes(argv[i]) && argv[i + 1]) {
    options[argv[i]] = argv[++i];
  } else if (["--check", "--apply"].includes(argv[i])) {
    if (options.mode) throw new Error("choose one of --check or --apply");
    options.mode = argv[i];
  } else {
    throw new Error("Usage: node scripts/deploy-platform.mjs --inventory <file> --secret-files <file> --kubeconfig <file> --confirm <cluster> [--cloudflare-token-file <file>] [--buildctl <absolute-path>] [--buildkit-address <loopback-tcp-tunnel>] [--management-inventory <file>] [--check|--apply]");
  }
}
for (const field of ["--inventory", "--secret-files", "--kubeconfig", "--confirm"]) {
  if (!options[field]) throw new Error("missing " + field);
}
options.mode ??= "--check";
const inventoryResult = readInventory(options["--inventory"]);
if (inventoryResult.errors.length || inventoryResult.blockers.length) {
  throw new Error("deployment inventory is incomplete");
}
const notificationsEnabled = workNotificationsEnabled(inventoryResult.inventory);
// The KV read has no Wrangler config argument: explicitly select the same account as the inventory.
process.env.CLOUDFLARE_ACCOUNT_ID = inventoryResult.inventory.cloudflare.accountId;
if (options.mode === "--apply") {
  if (!options["--management-inventory"]) throw new Error("--apply requires --management-inventory for the existing Coordination role");
  privateFile(options["--management-inventory"], "Management Ansible inventory");
}
if (options["--cloudflare-token-file"]) {
  const filename = options["--cloudflare-token-file"];
  if (!path.isAbsolute(filename)) throw new Error("Cloudflare token file must be an absolute path");
  const meta = lstatSync(filename);
  if (!meta.isFile() || meta.isSymbolicLink() ||
      (process.platform !== "win32" && (meta.mode & 0o077) !== 0)) {
    throw new Error("Cloudflare API token must be a private non-symlink file");
  }
  const token = readFileSync(filename, "utf8").trim();
  if (!token || /[\s]/u.test(token)) throw new Error("Cloudflare API token file is empty or invalid");
  process.env.CLOUDFLARE_API_TOKEN = token;
}
function execute(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
    cwd: root, env: process.env, encoding: "utf8", stdio: "inherit", timeout: 90 * 60_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(script + " failed (" + (result.error?.code ?? result.status) + ")");
  }
}
function executeTool(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: "inherit",
    shell: process.platform === "win32", timeout: 15 * 60_000 });
  if (result.error || result.status !== 0) throw new Error(command + " prerequisite failed");
}
const revision = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
const dirty = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (revision.status !== 0 || dirty.status !== 0 || dirty.stdout.trim()) {
  throw new Error("Deployment requires a clean immutable Git checkout");
}
console.log("Deploying Git revision " + revision.stdout.trim());
executeTool("corepack", ["pnpm@11.18.0", "install", "--frozen-lockfile"]);
if (options.mode === "--apply") executeTool("corepack", ["pnpm@11.18.0", "build"]);
const k3s = ["--inventory", options["--inventory"], "--secret-files", options["--secret-files"],
  "--kubeconfig", options["--kubeconfig"], "--confirm", options["--confirm"]];
const cloudflare = ["--inventory", options["--inventory"], "--secret-files", options["--secret-files"]];
function preflight(candidate) {
  execute("deploy-k3s.mjs", ["--inventory", candidate, ...k3s.slice(2), "--check"]);
  execute("deploy-cloudflare.mjs", ["--inventory", candidate, ...cloudflare.slice(2), "--preflight"]);
  managementService(candidate, "coordination", true);
  managementService(candidate, "observer", true);
}
function managementService(candidate, role, check) {
  const inventory = readInventory(candidate);
  if (inventory.errors.length || inventory.blockers.length || !inventory.inventory.images[role]) {
    throw new Error(role + " requires the verified candidate inventory");
  }
  const variables = { [`${role}_enabled`]: true, [`${role}_image`]: inventory.inventory.images[role] };
  if (role === "observer") {
    const secrets = JSON.parse(readFileSync(privateFile(options["--secret-files"], "secret manifest"), "utf8"));
    variables.observer_registry_auth_src = privateFile(
      secrets.values?.applicationImagePull, "Observer read-only registry credential",
    );
  }
  const args = ["-i", options["--management-inventory"],
    path.join(root, "infrastructure/ansible/playbooks/host-bootstrap.yml"),
    "--limit", "management", "--tags", role,
    "--extra-vars", JSON.stringify(variables),
    ...(check ? ["--check"] : [])];
  const result = spawnSync("ansible-playbook", args, {
    cwd: path.join(root, "infrastructure/ansible"), env: process.env, encoding: "utf8",
    stdio: "inherit", timeout: 20 * 60_000,
  });
  if (result.error || result.status !== 0) throw new Error(role + " Ansible " + (check ? "preflight" : "rollout") + " failed");
}
async function deploy() {
 for (const step of platformDeploymentSteps(options.mode, notificationsEnabled)) {
  console.log(step.stage + "...");
  if (step.script === "service-image-publication.mjs") {
    await adoptCiServiceImages({ root, inventoryPath: options["--inventory"],
      secretFilesPath: options["--secret-files"], preflight });
  } else if (step.script === "coordination" || step.script === "observer") {
    managementService(options["--inventory"], step.script, false);
  } else if (step.script === "verify-work-notifications.mjs") {
    execute(step.script, [
      "--inventory", options["--inventory"],
      "--secret-files", options["--secret-files"],
    ]);
  } else {
    const base = step.script === "deploy-k3s.mjs" ? k3s : cloudflare;
    execute(step.script, [...base, step.mode]);
  }
 }
}
if (options.mode === "--apply") await withDeploymentLock(options["--inventory"], deploy);
else await deploy();
if (options.mode === "--check") {
  console.log("Both deployments passed preflight. Nothing changed.");
} else {
  console.log("Praetorium Cloudflare and static K3s deployment complete.");
  console.log("Run Hosted end-to-end acceptance separately; ingress transport and GitHub/Scriptorium are not certified by this step.");
}
