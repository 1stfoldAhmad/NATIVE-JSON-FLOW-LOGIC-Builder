import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, { types?: string; default?: string } | string>;
  engines?: { node?: string };
  scripts?: Record<string, string>;
};

test("F-01: package exports map exposes . , ./expo and ./node", () => {
  for (const entry of [".", "./expo", "./node", "./package.json"]) {
    assert.ok(pkg.exports[entry], `exports["${entry}"] must exist`);
  }
  const entry = (e: string) => pkg.exports[e] as { types?: string; default?: string };
  assert.equal(entry(".").default, "./dist/index.js");
  assert.equal(entry("./expo").default, "./dist/expo/index.js");
  assert.equal(entry("./node").default, "./dist/node-io.js");
  assert.equal(entry("./node").types, "./dist/node-io.d.ts");
});

test("F-01: every export target has a matching TypeScript source file", () => {
  // dist/*.js is built from src/**; assert the source counterparts exist so the
  // export can never point at a file that will not be emitted.
  const entry = (e: string) => pkg.exports[e] as { types?: string; default?: string };
  const sources: Record<string, string> = {
    "./dist/index.js": "src/index.ts",
    "./dist/index.d.ts": "src/index.ts",
    "./dist/expo/index.js": "src/expo/index.ts",
    "./dist/expo/index.d.ts": "src/expo/index.ts",
    "./dist/node-io.js": "src/node-io.ts",
    "./dist/node-io.d.ts": "src/node-io.ts",
  };
  for (const [distFile, srcFile] of Object.entries(sources)) {
    const referenced = [".", "./expo", "./node"].some(
      (e) => entry(e).default === distFile || entry(e).types === distFile,
    );
    assert.ok(referenced, `${distFile} must be referenced by an export entry`);
    assert.ok(existsSync(join(root, srcFile)), `source ${srcFile} for ${distFile} must exist`);
  }
});

test("F-02: dev scripts run TypeScript through tsx so Node >=18 can run them; runtime engines stays >=18", () => {
  assert.ok(pkg.engines?.node, "engines.node must be declared");
  assert.equal(pkg.engines!.node, ">=18", "runtime engine requirement stays >=18 (dist is plain JS)");
  assert.match(pkg.scripts!.test, /^tsx /, "test script must use tsx (Node 18 compatible TS runner)");
  assert.match(pkg.scripts!.demo, /^tsx /, "demo script must use tsx");
  assert.ok(!/node .*\.ts/.test(pkg.scripts!.test), "test script must not rely on Node type-stripping (needs >=22.6)");
});
