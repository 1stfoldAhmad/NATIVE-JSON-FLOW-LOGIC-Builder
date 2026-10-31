/**
 * Security regression tests (audit findings 1-3):
 *  - core entry point must not import Node built-ins (Expo/Metro portability)
 *  - prototype pollution via data paths and state paths
 *  - ReDoS-safe regex (matches operator)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LogicEngine, resolvePath, setPath, VdsError, isSafePattern } from "../src/index.ts";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) yield p;
  }
}

test("core source never imports Node built-ins (only the /node entry may)", () => {
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    if (file.endsWith("node-io.ts")) continue; // the Node-only adapter entry
    const content = readFileSync(file, "utf8");
    if (/from\s+["']node:/.test(content) || /require\(["']node:/.test(content)) {
      offenders.push(file);
    }
  }
  assert.deepEqual(offenders, [], `Node built-ins imported outside node-io.ts: ${offenders.join(", ")}`);
});

test("path parser rejects dangerous segments", () => {
  assert.equal(resolvePath({}, "$.__proto__.polluted").found, false);
  assert.equal(resolvePath({}, "$['constructor']['prototype']").found, false);
  assert.equal(resolvePath({}, "$.prototype.x").found, false);
  assert.equal(resolvePath({}, "$.__proto__").found, false);
  assert.equal(resolvePath({ a: 1 }, "$.a").value, 1); // normal paths still work
});

test("path reads use own properties only (no inherited exposure)", () => {
  const proto = { hidden: "secret" };
  const obj = Object.create(proto) as Record<string, unknown>;
  obj.own = 2;
  assert.equal(resolvePath(obj, "$.hidden").found, false);
  assert.equal(resolvePath(obj, "$.own").value, 2);
});

test("setPath refuses dangerous keys (prototype pollution write)", () => {
  const root: Record<string, unknown> = {};
  assert.throws(() => setPath(root, "__proto__.polluted", true), /dangerous/);
  assert.throws(() => setPath(root, "$.constructor.prototype.polluted", true), /dangerous|property path/);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  setPath(root, "$.user.name", "amina"); // normal write works
  assert.equal((root.user as Record<string, unknown>).name, "amina");
});

test("state manager is protected against pollution paths", () => {
  const engine = new LogicEngine();
  assert.throws(() => engine.setState("__proto__.polluted", true), /dangerous/);
  engine.setState("user.name", "amina");
  assert.equal(engine.getState("user.name"), "amina");
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test("flow set node refuses dangerous assignment names", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load({
        id: "flow.bad",
        name: "bad",
        type: "flow",
        version: "1.0.0",
        spec_version: "1.0.0",
        definition: {
          nodes: [
            { id: "s", type: "start", next: "set" },
            { id: "set", type: "set", assignments: { __proto__: 1 } },
          ],
        },
      } as never),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID",
  );
});

test("regex safety: catastrophic patterns are rejected before compilation", () => {
  for (const pattern of ["(a+)+", "(a*)*", "(\\w+)*", "(a|a)*", "(a|aa)+", "(a)\\1"]) {
    assert.equal(isSafePattern(pattern).safe, false, `expected unsafe: ${pattern}`);
  }
  const engine = new LogicEngine();
  assert.throws(
    () => engine.evaluate({ operator: "matches", arguments: ["aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "(a+)+$"] }, {}),
    (e: unknown) => e instanceof VdsError && e.code === "EXPR_ERROR" && /unsafe regex/.test(e.message),
  );
});

test("regex safety: ordinary patterns still work", () => {
  assert.equal(isSafePattern("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$").safe, true);
  assert.equal(isSafePattern("^[a-z]+[0-9]+$").safe, true);
  assert.equal(isSafePattern("^(admin|user)$").safe, true); // alternation without quantifier
  const engine = new LogicEngine();
  assert.equal(
    engine.evaluate({ operator: "matches", arguments: ["abc123", "^[a-z]+[0-9]+$"] }, {}),
    true,
  );
  assert.equal(
    engine.evaluate({ operator: "matches", arguments: ["a@b.co", "^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$"] }, {}),
    true,
  );
  // length cap still enforced
  assert.equal(isSafePattern("a".repeat(201)).safe, false);
});
