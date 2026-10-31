/**
 * Runtime policy regression tests (audit findings 4-5):
 *  - execution-target enforcement (backend defs never run on a frontend engine)
 *  - capability gate on native calls
 *  - transactional loading (failed batch leaves no partial state)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine, VdsError } from "../src/index.ts";
import { fn, flow } from "./helpers.ts";

test("backend-targeted function is blocked on a frontend engine", async () => {
  const frontend = new LogicEngine(); // default environment: "frontend"
  frontend.load(
    fn("function.secret.hash", {
      kind: "pure",
      expression: "hashed",
    }, { execution: { target: "backend", mode: "sync" } }),
  );
  const res = await frontend.callFunction("function.secret.hash", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "NOT_ALLOWED");
  assert.match(res.error!.message, /backend/);

  const backend = new LogicEngine({ environment: "backend" });
  backend.load(
    fn("function.secret.hash", {
      kind: "pure",
      expression: "hashed",
    }, { execution: { target: "backend", mode: "sync" } }),
  );
  const okRes = await backend.callFunction("function.secret.hash", {});
  assert.equal(okRes.success, true);
  assert.equal(okRes.data, "hashed");
});

test("backend-targeted flow is blocked on a frontend engine", async () => {
  const frontend = new LogicEngine();
  frontend.load({
    id: "flow.backend.job",
    name: "backendJob",
    type: "flow",
    version: "1.0.0",
    spec_version: "1.0.0",
    execution: { target: "backend", mode: "async" },
    definition: { nodes: [{ id: "s", type: "start" }, { id: "r", type: "return", value: 1 }] },
  } as never);
  const res = await frontend.executeFlow("flow.backend.job", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "NOT_ALLOWED");

  const backend = new LogicEngine({ environment: "backend" });
  backend.load({
    id: "flow.backend.job",
    name: "backendJob",
    type: "flow",
    version: "1.0.0",
    spec_version: "1.0.0",
    execution: { target: "backend", mode: "async" },
    definition: { nodes: [{ id: "s", type: "start" }, { id: "r", type: "return", value: 1 }] },
  } as never);
  const okRes = await backend.executeFlow("flow.backend.job", {});
  assert.equal(okRes.success, true);
});

test("shared-targeted definitions run in any environment", async () => {
  const frontend = new LogicEngine();
  frontend.load(fn("function.shared.calc", { kind: "pure", expression: { operator: "add", arguments: [1, 2] } },
    { execution: { target: "shared" } }));
  const res = await frontend.callFunction("function.shared.calc", {});
  assert.equal(res.success, true);
  assert.equal(res.data, 3);
});

test("capability gate: required capability not granted -> NOT_ALLOWED", async () => {
  const engine = new LogicEngine();
  engine.registerNative("db.write", async () => ({ written: true })); // no capabilities granted
  engine.load(
    fn("function.db.persist", {
      kind: "native",
      native: "db.write",
    }, { execution: { target: "shared", capabilities: ["db.write"] } }),
  );
  const blocked = await engine.callFunction("function.db.persist", {});
  assert.equal(blocked.success, false);
  assert.equal(blocked.error!.code, "NOT_ALLOWED");
  assert.match(blocked.error!.message, /db\.write/);

  // engine policy grants the capability -> allowed
  engine.grantCapability("db.write");
  const allowed = await engine.callFunction("function.db.persist", {});
  assert.equal(allowed.success, true);
  assert.deepEqual(allowed.data, { written: true });
});

test("capability gate: capability granted by the native registration itself", async () => {
  const engine = new LogicEngine();
  engine.registerNative("api.get", async (args) => ({ echo: args }), { capabilities: ["api.read"] });
  engine.load(
    fn("function.api.get", { kind: "native", native: "api.get" },
      { execution: { target: "frontend", capabilities: ["api.read"] } }),
  );
  const res = await engine.callFunction("function.api.get", { id: 7 });
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { echo: { id: 7 } });

  // but a different capability is still blocked
  const engine2 = new LogicEngine();
  engine2.registerNative("api.get", async () => ({}), { capabilities: ["api.read"] });
  engine2.load(
    fn("function.api.get", { kind: "native", native: "api.get" },
      { execution: { target: "shared", capabilities: ["secret.read"] } }),
  );
  const blocked = await engine2.callFunction("function.api.get", {});
  assert.equal(blocked.error!.code, "NOT_ALLOWED");
});

test("loading is transactional: a failed batch leaves the engine unchanged", async () => {
  const engine = new LogicEngine();
  engine.load(fn("function.ok", { kind: "pure", expression: 42 }));
  const before = engine.listDefinitions().map((d) => d.id);

  // batch with a dangling reference -> must throw and register NOTHING
  assert.throws(
    () =>
      engine.load([
        fn("function.staged", { kind: "pure", expression: 1 }),
        flow("flow.dangling", {
          nodes: [
            { id: "s", type: "start", next: "c" },
            { id: "c", type: "callFunction", ref: "function.does-not-exist" },
          ],
        }),
      ]),
    (e: unknown) => e instanceof VdsError && e.code === "REF_NOT_FOUND",
  );
  assert.deepEqual(engine.listDefinitions().map((d) => d.id), before);

  // duplicate id inside a failing batch also leaves nothing behind
  assert.throws(
    () => engine.load([fn("function.ok", { kind: "pure", expression: 1 })]),
    (e: unknown) => e instanceof VdsError && e.code === "SPEC_INVALID",
  );
  assert.deepEqual(engine.listDefinitions().map((d) => d.id), before);

  // retry with a corrected batch works
  engine.load([
    fn("function.staged", { kind: "pure", expression: 1 }),
    flow("flow.fixed", {
      nodes: [
        { id: "s", type: "start", next: "c" },
        { id: "c", type: "callFunction", ref: "function.staged", assign: "v", next: "r" },
        { id: "r", type: "return", value: "$.v" },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.fixed", {});
  assert.equal(res.success, true);
  assert.equal(res.data, 1);
});
