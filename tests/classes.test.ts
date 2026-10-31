import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import { fn, cls, makeDemoEngine } from "./helpers.ts";

test("class method delegates to a function and returns its value", async () => {
  const { engine } = makeDemoEngine();
  const res = await engine.callMethod("class.validation-service", "validateEmail", { email: "a@b.co" });
  assert.equal(res.success, true);
  assert.equal(res.data, true);
  const bad = await engine.callMethod("class.validation-service", "validateEmail", { email: "nope" });
  assert.equal(bad.data, false);
});

test("unknown class / method -> REF_NOT_FOUND", async () => {
  const { engine } = makeDemoEngine();
  const r1 = await engine.callMethod("class.nope", "x", {});
  assert.equal(r1.success, false);
  assert.equal(r1.error!.code, "REF_NOT_FOUND");
  const r2 = await engine.callMethod("class.user-service", "nope", {});
  assert.equal(r2.error!.code, "REF_NOT_FOUND");
});

test("dependency injection: services are available on the instance", async () => {
  const engine = new LogicEngine();
  engine.registerNative("counter.next", async (_args, _ctx, instance) => {
    const inst = instance as { properties: Record<string, unknown> };
    inst.properties.count = ((inst.properties.count as number) ?? 0) + 1;
    return inst.properties.count;
  });
  engine.load([
    fn("function.counter.next", { kind: "native", native: "counter.next" }),
    cls("class.counter", {
      lifetime: "singleton",
      properties: [{ name: "count", type: "integer", default: 0 }],
      methods: [{ id: "m.next", name: "next", function: "function.counter.next" }],
    }),
    cls("class.api", {
      lifetime: "singleton",
      dependencies: ["class.counter"],
      methods: [{ id: "m.bump", name: "bump", function: "function.counter.next" }],
    }),
  ]);
  const r1 = await engine.callMethod("class.api", "bump", {});
  const r2 = await engine.callMethod("class.api", "bump", {});
  assert.equal(r1.data, 1);
  assert.equal(r2.data, 2); // singleton state persists across calls
});

test("singleton vs instance lifetimes", async () => {
  const engine = new LogicEngine();
  engine.registerNative("id.gen", async () => Math.random());
  engine.load([
    fn("function.id.gen", { kind: "native", native: "id.gen" }),
    cls("class.single", {
      lifetime: "singleton",
      methods: [{ id: "m", name: "gen", function: "function.id.gen" }],
    }),
    cls("class.multi", {
      lifetime: "instance",
      methods: [{ id: "m", name: "gen", function: "function.id.gen" }],
    }),
  ]);
  const s1 = await engine.getService("class.single");
  const s2 = await engine.getService("class.single");
  assert.equal(s1, s2);
  const i1 = await engine.getService("class.multi");
  const i2 = await engine.getService("class.multi");
  assert.notEqual(i1, i2);
});

test("method can execute a flow", async () => {
  const engine = new LogicEngine();
  engine.load([
    cls("class.svc", {
      methods: [{ id: "m.run", name: "run", flow: "flow.inner" }],
    }),
    {
      id: "flow.inner",
      name: "inner",
      type: "flow",
      version: "1.0.0",
      spec_version: "1.0.0",
      definition: {
        parameters: [{ name: "v", type: "integer", required: true }],
        nodes: [
          { id: "s", type: "start", next: "r" },
          { id: "r", type: "return", value: { operator: "multiply", arguments: ["$.v", 2] } },
        ],
      },
    } as never,
  ]);
  const res = await engine.callMethod("class.svc", "run", { v: 21 });
  assert.equal(res.success, true);
  assert.equal(res.data, 42);
});
