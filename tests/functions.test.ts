import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import { fn, makeDemoEngine } from "./helpers.ts";

test("pure function: deterministic output (plan example)", async () => {
  const engine = new LogicEngine();
  engine.load(
    fn("function.order.calculate-total", {
      kind: "pure",
      parameters: [
        { name: "items", type: "array", required: true },
        { name: "taxRate", type: "number", default: 0 },
      ],
      return: { name: "total", type: "number" },
      expression: {
        operator: "add",
        arguments: [
          { operator: "sum", value: "$.items[*].price" },
          { operator: "multiply", arguments: [{ operator: "sum", value: "$.items[*].price" }, "$.taxRate"] },
        ],
      },
    }),
  );
  const args = { items: [{ price: 100 }, { price: 50 }], taxRate: 0.1 };
  const r1 = await engine.callFunction("function.order.calculate-total", args);
  const r2 = await engine.callFunction("function.order.calculate-total", args);
  assert.equal(r1.success, true);
  assert.equal(r1.data, 165); // 150 + 15
  assert.deepEqual(r1.data, r2.data); // deterministic
  // default applied when taxRate omitted
  const r3 = await engine.callFunction("function.order.calculate-total", { items: [{ price: 10 }] });
  assert.equal(r3.data, 10);
});

test("missing required parameter -> PARAM_INVALID", async () => {
  const engine = new LogicEngine();
  engine.load(fn("function.f", { kind: "pure", parameters: [{ name: "x", type: "number", required: true }], expression: "$.x" }));
  const res = await engine.callFunction("function.f", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "PARAM_INVALID");
});

test("type mismatch -> TYPE_MISMATCH", async () => {
  const engine = new LogicEngine();
  engine.load(fn("function.f", { kind: "pure", parameters: [{ name: "x", type: "number", required: true }], expression: "$.x" }));
  const res = await engine.callFunction("function.f", { x: "not-a-number" });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "TYPE_MISMATCH");
});

test("return type mismatch -> TYPE_MISMATCH", async () => {
  const engine = new LogicEngine();
  engine.load(
    fn("function.f", {
      kind: "pure",
      parameters: [],
      return: { name: "n", type: "number" },
      expression: "hello",
    }),
  );
  const res = await engine.callFunction("function.f", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "TYPE_MISMATCH");
});

test("enum constraint enforced", async () => {
  const engine = new LogicEngine();
  engine.load(
    fn("function.f", {
      kind: "predicate",
      parameters: [{ name: "color", type: "string", required: true, enum: ["red", "blue"] }],
      expression: true,
    }),
  );
  const bad = await engine.callFunction("function.f", { color: "green" });
  assert.equal(bad.success, false);
  assert.equal(bad.error!.code, "PARAM_INVALID");
  const good = await engine.callFunction("function.f", { color: "red" });
  assert.equal(good.success, true);
});

test("native function: registered implementation is called (async)", async () => {
  const engine = new LogicEngine();
  engine.registerNative("math.double", async (args) => Number(args.x) * 2);
  engine.load(fn("function.math.double", { kind: "native", native: "math.double", parameters: [{ name: "x", type: "number", required: true }] }));
  const res = await engine.callFunction("function.math.double", { x: 21 });
  assert.equal(res.success, true);
  assert.equal(res.data, 42);
});

test("native function without registration -> NATIVE_NOT_FOUND", async () => {
  const engine = new LogicEngine();
  engine.load(fn("function.f", { kind: "native", native: "missing.impl" }));
  const res = await engine.callFunction("function.f", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "NATIVE_NOT_FOUND");
});

test("flow-backed function executes the referenced flow", async () => {
  const engine = new LogicEngine();
  engine.load([
    fn("function.greet", { kind: "flow", flow: "flow.greet" }),
    {
      id: "flow.greet",
      name: "greet",
      type: "flow",
      version: "1.0.0",
      spec_version: "1.0.0",
      definition: {
        parameters: [{ name: "name", type: "string", required: true }],
        nodes: [
          { id: "s", type: "start", next: "r" },
          { id: "r", type: "return", value: { operator: "concat", arguments: ["Hello, ", "$.name", "!"] } },
        ],
      },
    } as never,
  ]);
  const res = await engine.callFunction("function.greet", { name: "VDS" });
  assert.equal(res.success, true);
  assert.deepEqual(res.data, "Hello, VDS!");
});

test("validator function returns structured result", async () => {
  const { engine } = makeDemoEngine();
  const res = await engine.callFunction("function.user.validate-password", { password: "short" });
  assert.equal(res.success, true);
  assert.deepEqual(res.data, {
    valid: false,
    errors: ["Password must be at least 8 characters and contain a digit"],
  });
  const okRes = await engine.callFunction("function.user.validate-password", { password: "secret123" });
  assert.deepEqual(okRes.data, { valid: true, errors: [] });
});
