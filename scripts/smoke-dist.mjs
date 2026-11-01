/**
 * Dist smoke test (CI): verify the built package's export map resolves and the
 * expected entry points load — run after `npm run build`.
 *
 *   node scripts/smoke-dist.mjs
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));

let failures = 0;
for (const entry of Object.keys(pkg.exports)) {
  if (entry === "./package.json") continue;
  const target = pkg.exports[entry].default ?? pkg.exports[entry];
  const abs = resolve(root, target);
  if (!existsSync(abs)) {
    console.error(`FAIL exports["${entry}"] -> ${target} does not exist`);
    failures++;
    continue;
  }
  try {
    const mod = await import(pathToFileURL(abs).href);
    const expected =
      entry === "." ? "LogicEngine" : entry === "./expo" ? "createExpoEngine" : "loadSpecFiles";
    if (typeof mod[expected] !== "function") throw new Error(`missing export ${expected}`);
    console.log(`OK   exports["${entry}"] -> ${target} (${expected}: ${typeof mod[expected]})`);
  } catch (e) {
    console.error(`FAIL exports["${entry}"] -> ${target}: ${e.message}`);
    failures++;
  }
}

if (failures > 0) {
  console.error(`smoke-dist: ${failures} failure(s)`);
  process.exit(1);
}
console.log("smoke-dist: all export entries OK");
