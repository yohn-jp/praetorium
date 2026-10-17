#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (["--inventory", "--secret-files", "--kubeconfig", "--confirm", "--cloudflare-token-file"].includes(argv[i]) && argv[i + 1]) {
    options[argv[i]] = argv[++i];
  } else if (["--check", "--apply"].includes(argv[i])) {
    if (options.mode) throw new Error("choose one of --check or --apply");
    options.mode = argv[i];
  } else {
    throw new Error("Usage: node scripts/deploy-platform.mjs --inventory <file> --secret-files <file> --kubeconfig <file> --confirm <cluster> [--cloudflare-token-file <file>] [--check|--apply]");
  }
}
for (const field of ["--inventory", "--secret-files", "--kubeconfig", "--confirm"]) {
  if (!options[field]) throw new Error("missing " + field);
}
options.mode ??= "--check";
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
const k3s = ["--inventory", options["--inventory"], "--secret-files", options["--secret-files"],
  "--kubeconfig", options["--kubeconfig"], "--confirm", options["--confirm"]];
const cloudflare = ["--inventory", options["--inventory"], "--secret-files", options["--secret-files"]];
console.log("Preflighting target K3s and Cloudflare before any remote deployment...");
execute("deploy-k3s.mjs", [...k3s, "--check"]);
execute("deploy-cloudflare.mjs", [...cloudflare, "--check"]);
if (options.mode === "--check") {
  console.log("Both deployments passed preflight. Nothing changed.");
  process.exit(0);
}
console.log("Applying Cloudflare migrations and Workers...");
execute("deploy-cloudflare.mjs", [...cloudflare, "--apply"]);
console.log("Installing and reconciling declared K3s services...");
execute("deploy-k3s.mjs", [...k3s, "--apply"]);
console.log("Praetorium Cloudflare and static K3s deployment complete.");
console.log("Run the Hosted end-to-end acceptance separately; ingress transport and GitHub/Scriptorium are not certified by this step.");
