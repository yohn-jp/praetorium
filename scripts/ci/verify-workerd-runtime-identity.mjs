#!/usr/bin/env node
// CI owns this ephemeral Miniflare fixture. The owner declaration is only for
// tests/integration/workers-d1-do.test.mjs and cannot authorize remote assets.
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temp = mkdtempSync(path.join(os.tmpdir(), "praetorium-ci-workerd-"));
const owner = `ci-local-${process.env.GITHUB_RUN_ID ?? process.pid}`;
const inventoryPath = path.join(temp, "inventory.json");
try {
  writeFileSync(inventoryPath, JSON.stringify({
    environment: {
      purpose: "t14-disposable-test",
      disposable: true,
      production: false,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    },
    owner: { identity: owner },
    resources: {
      "workers-d1-do": {
        state: "available",
        owner,
        disposable: true,
        production: false,
        reference: `local-miniflare:${owner}`,
      },
    },
  }));
  const child = spawnSync(process.execPath, ["--test", "tests/integration/workers-d1-do.test.mjs"], {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PRAETORIUM_T14_INVENTORY_PATH: inventoryPath,
      PRAETORIUM_T14_CATEGORY: "workers-d1-do",
    },
    timeout: 180_000,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) process.exitCode = child.status ?? 1;
} finally {
  rmSync(temp, { recursive: true, force: true });
}
