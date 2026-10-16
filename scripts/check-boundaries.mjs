import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
const failures = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory() && !["node_modules", "dist"].includes(entry.name)) await walk(p);
    else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) {
      const text = await readFile(p, "utf8");
      if (
        /from\s+["'](?:@praetorium\/(?:github|ghcr|buildkit|kubernetes|scriptorium|legacy-recovery)|.*plugins\/)/.test(
          text,
        )
      )
        failures.push(`${p}: concrete provider dependency forbidden`);
    }
  }
}
for (const dir of ["packages/domain/src", "packages/application/src", "packages/contracts/src"])
  await walk(dir);
if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else console.log("Neutral package provider boundaries verified");
