import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { main, writeCliResult } from "./recovery.ts";

async function cli(): Promise<void> {
  try {
    await writeCliResult(await main());
  } catch (error) {
    const message = error instanceof Error ? error.message : "unexpected recovery error";
    process.stderr.write(`legacy recovery failed: ${message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void cli();
