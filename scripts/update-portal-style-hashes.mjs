import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const source = "apps/gateway/src/ui/styles.ts";
const { outputFiles } = await build({
  entryPoints: [source],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
});
const { portalStyles } = await import(
  `data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`
);
let text = await readFile(source, "utf8");
for (const mode of ["desktop", "mobile"]) {
  const hash = createHash("sha256").update(portalStyles(mode)).digest("base64");
  text = text.replace(new RegExp(`(${mode}: ")[^"]*(")`), `$1${hash}$2`);
}
await writeFile(source, text);
