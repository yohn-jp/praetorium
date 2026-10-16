import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import * as contracts from "../dist/index.js";
const schemas = Object.fromEntries(
  Object.entries(contracts)
    .filter(([name]) => name.endsWith("Schema"))
    .map(([name, schema]) => [name, z.toJSONSchema(schema)]),
);
const serialized = JSON.stringify(schemas, null, 2) + "\n";
const target = new URL("../schemas/contracts.json", import.meta.url);
if (process.argv.includes("--write")) {
  await mkdir(new URL("../schemas/", import.meta.url), { recursive: true });
  await writeFile(target, serialized);
} else if ((await readFile(target, "utf8")) !== serialized) {
  console.error(
    "Contract JSON schema drift: regenerate with node packages/contracts/scripts/schemas.mjs --write",
  );
  process.exitCode = 1;
} else console.log("Contract JSON schemas match runtime validators");
