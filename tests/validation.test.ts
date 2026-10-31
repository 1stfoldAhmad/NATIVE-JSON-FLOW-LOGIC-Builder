import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine, VdsError } from "../src/index.ts";
import { fn, flow, cls, hook } from "./helpers.ts";

test("invalid envelope is rejected before execution", () => {
  const engine = new LogicEngine();
  assert.throws(
    () => engine.load({ id: "no-type", name: "x", version: "1.0.0", spec_version: "1.0.0", definition: {} } as never),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID",
  );
  assert.throws(
    () => engine.load({ id: "function.bad", name: "x", type: "function", version: "not-semver", spec_version: "1.0.0", definition: { kind: "pure", expression: 1 } } as never),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID",
  );
});

test("function kind pure requires an expression", () => {
  const engine = new LogicEngine();
  assert.throws(
    () => engine.load(fn("function.f", { kind: "pure" })),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID" && JSON.stringify(e.details).includes("expression"),
  );
});

test("unknown operator inside an expression is a validation error", () => {
  const engine = new LogicEngine();
  assert.throws(
    () => engine.load(fn("function.f", { kind: "pure", expression: { operator: "evil", arguments: [] } })),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID" && JSON.stringify(e.details).includes("evil"),
  );
});

test("flow with dangling next reference is rejected", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load(
        flow("flow.f", {
          nodes: [
            { id: "s", type: "start", next: "ghost" },
          ],
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID" && JSON.stringify(e.details).includes("ghost"),
  );
});

test("flow with duplicate node ids is rejected", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load(
        flow("flow.f", {
          nodes: [
            { id: "s", type: "start" },
            { id: "s", type: "return" },
          ],
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID",
  );
});

test("missing function reference is detected at load time", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load(
        flow("flow.f", {
          nodes: [
            { id: "s", type: "start", next: "c" },
            { id: "c", type: "callFunction", ref: "function.missing" },
          ],
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "REF_NOT_FOUND" && JSON.stringify(e.details).includes("function.missing"),
  );
});

test("circular flow dependency is detected", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load([
        flow("flow.a", { nodes: [{ id: "s", type: "start", next: "c" }, { id: "c", type: "callFlow", ref: "flow.b" }] }),
        flow("flow.b", { nodes: [{ id: "s", type: "start", next: "c" }, { id: "c", type: "callFlow", ref: "flow.a" }] }),
      ]),
    (e: unknown) => e instanceof VdsError && e.code === "CIRCULAR_DEPENDENCY" && JSON.stringify(e.details).includes("flow.a"),
  );
});

test("circular class dependency is detected", () => {
  const engine = new LogicEngine();
  engine.load(
    fn("function.noop", { kind: "pure", expression: null }),
  );
  assert.throws(
    () =>
      engine.load([
        cls("class.a", { dependencies: ["class.b"], methods: [{ id: "m", name: "m", function: "function.noop" }] }),
        cls("class.b", { dependencies: ["class.a"], methods: [{ id: "m", name: "m", function: "function.noop" }] }),
      ]),
    (e: unknown) => e instanceof VdsError && e.code === "CIRCULAR_DEPENDENCY",
  );
});

test("hook with method handler pointing at a missing method is rejected", () => {
  const engine = new LogicEngine();
  engine.load(fn("function.noop", { kind: "pure", expression: null }));
  engine.load(cls("class.c", { methods: [{ id: "m", name: "real", function: "function.noop" }] }));
  assert.throws(
    () =>
      engine.load(
        hook("hook.h", {
          trigger: { event: "e" },
          handlers: [{ type: "method", class: "class.c", method: "ghost" }],
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "REF_NOT_FOUND",
  );
});

test("duplicate definition id is rejected", () => {
  const engine = new LogicEngine();
  engine.load(fn("function.dup", { kind: "pure", expression: 1 }));
  assert.throws(
    () => engine.load(fn("function.dup", { kind: "pure", expression: 2 })),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID",
  );
});

test("engine.validate returns issues without throwing", () => {
  const engine = new LogicEngine();
  const issues = engine.validate({ id: "x", type: "flow", version: "1.0.0", spec_version: "1.0.0", definition: { nodes: [] } });
  assert.ok(issues.length > 0);
  const ok = engine.validate(fn("function.ok", { kind: "pure", expression: 1 }));
  assert.equal(ok.length, 0);
});

test("loadJson accepts a bundle object with domain keys", () => {
  const engine = new LogicEngine();
  engine.loadJson({
    functions: [fn("function.bundled", { kind: "pure", expression: { operator: "add", arguments: [1, 2] } })],
    flows: [],
  });
  return engine.callFunction("function.bundled", {}).then((r) => {
    assert.equal(r.success, true);
    assert.equal(r.data, 3);
  });
});
