#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { readInventory } from "../infrastructure/scripts/inventory.mjs";
import {
  validateWorkNotificationTokens,
  verifyWorkNotificationEndpoints,
  workNotificationEndpoints,
  workNotificationsEnabled,
} from "../infrastructure/scripts/work-notifications.mjs";

const args = process.argv.slice(2);
let inventoryPath;
let secretFilesPath;
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--inventory" && args[index + 1]) inventoryPath = args[++index];
  else if (args[index] === "--secret-files" && args[index + 1]) secretFilesPath = args[++index];
  else throw new Error("Usage: node scripts/verify-work-notifications.mjs --inventory <file> --secret-files <file>");
}
if (!inventoryPath || !secretFilesPath) throw new Error("--inventory and --secret-files are required");

function privateFile(filename, label) {
  if (!path.isAbsolute(filename)) throw new Error(`${label} must be an absolute path`);
  const metadata = lstatSync(filename);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (process.platform !== "win32" &&
      ((metadata.mode & 0o077) !== 0 ||
        (typeof process.getuid === "function" && metadata.uid !== process.getuid())))
  ) {
    throw new Error(`${label} must be an owner-only regular file`);
  }
  return realpathSync(filename);
}

const inventoryResult = readInventory(inventoryPath);
if (inventoryResult.errors.length || inventoryResult.blockers.length) {
  throw new Error("deployment inventory is incomplete");
}
const inventory = inventoryResult.inventory;
if (
  inventory.environment !== "deployment" ||
  inventory.cloudflare.mode !== "remote" ||
  !workNotificationsEnabled(inventory)
) {
  throw new Error("notification endpoint verification requires enabled deployment inventory");
}

const manifestPath = privateFile(secretFilesPath, "secret-files manifest");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
if (
  manifest.apiVersion !== "praetorium.io/secret-files/v1" ||
  !manifest.values ||
  typeof manifest.values !== "object" ||
  Array.isArray(manifest.values) ||
  Object.keys(manifest).sort().join(",") !== "apiVersion,values"
) {
  throw new Error("invalid private secret-files manifest");
}

function readSecret(role) {
  const filename = manifest.values[role];
  if (typeof filename !== "string") throw new Error(`${role} file reference is missing`);
  return readFileSync(privateFile(filename, `secret file ${role}`));
}

const provisionerBytes = readSecret("provisionerWorkNotificationToken");
const buildBytes = readSecret("buildWorkerWorkNotificationToken");
validateWorkNotificationTokens({
  provisioner: provisionerBytes,
  build: buildBytes,
  provisionerClaim: readSecret("controlPlaneCredential"),
  buildClaim: readSecret("buildWorkerControlPlaneAuth"),
});

await verifyWorkNotificationEndpoints(
  workNotificationEndpoints(inventory),
  { provisioner: provisionerBytes.toString("ascii"), build: buildBytes.toString("ascii") },
);
console.log("Provisioner work notification HTTPS endpoint returned HTTP 202.");
console.log("Build Worker work notification HTTPS endpoint returned HTTP 202.");
