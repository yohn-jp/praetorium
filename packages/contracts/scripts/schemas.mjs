import { readFile, writeFile, mkdir } from "node:fs/promises";
import { z } from "zod";
import * as contracts from "../dist/index.js";
const schemas = Object.fromEntries(
  Object.entries(contracts)
    .filter(([name]) => name.endsWith("Schema"))
    .map(([name, schema]) => [name, z.toJSONSchema(schema)]),
);
// JSON Schema cannot express cross-field arithmetic/bindings or uniqueness by object id.
// These remain mandatory semantic checks in the versioned runtime parsers.
function supplement(schema) {
  if (!schema || typeof schema !== "object") return;
  for (const [name, property] of Object.entries(schema.properties ?? {})) {
    if (
      [
        "requestedModules",
        "supportedPlatforms",
        "requires",
        "conflicts",
        "sharedResourceGroupIds",
        "enabledModuleIds",
      ].includes(name) &&
      property.type === "array"
    )
      property.uniqueItems = true;
    if (name === "repositoryLocator")
      property.pattern =
        "^https://github\\.com/(?!\\.\\.?/)[A-Za-z0-9_.-]+/(?!\\.\\.?$)[A-Za-z0-9_.-]+$";
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach(supplement);
    else if (value && typeof value === "object") supplement(value);
  }
}
for (const schema of Object.values(schemas)) {
  supplement(schema);
  schema.$comment =
    "Structural wire schema with expressible semantic constraints. Normative semantic validation in @praetorium/contracts is also required: cross-field host/origin, grant time arithmetic, object-id uniqueness, module graph/resource closure and epoch/operation bindings cannot be certified by this JSON schema alone.";
}
if (schemas.QuiesceResultSchema)
  schemas.QuiesceResultSchema.allOf = [
    {
      if: { properties: { disposition: { const: "safe" } }, required: ["disposition"] },
      then: {
        properties: {
          activeMutations: { const: 0 },
          activeJobs: { const: 0 },
          pendingCheckpoints: { const: 0 },
          uncertainPublication: { const: false },
        },
      },
    },
  ];
const serialized = JSON.stringify(schemas, null, 2) + "\n";
const target = new URL("../schemas/contracts.json", import.meta.url);
if (process.argv.includes("--write")) {
  await mkdir(new URL("../schemas/", import.meta.url), { recursive: true });
  await writeFile(target, serialized);
} else if (JSON.stringify(JSON.parse(await readFile(target, "utf8"))) !== JSON.stringify(schemas)) {
  console.error(
    "Contract JSON schema drift: regenerate with node packages/contracts/scripts/schemas.mjs --write",
  );
  process.exitCode = 1;
} else console.log("Contract structural JSON schemas match canonical generation");
