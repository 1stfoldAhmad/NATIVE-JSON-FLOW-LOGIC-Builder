import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import { fn, hook, flow, cls } from "./helpers.ts";

function engineWithRecorder() {
  const engine = new LogicEngine();
  const calls: string[] = [];
  engine.registerNative("rec.push", async (args) => {
    calls.push(String(args.v));
    return calls.length;
  });
  engine.registerNative("rec.fail", async () => {
    throw new Error("handler exploded");
  });
  engine.load([
    fn("function.rec.push", { kind: "native", native: "rec.push", parameters: [{ name: "v", type: "string", required: true }] }),
    fn("function.rec.fail", { kind: "native", native: "rec.fail" }),
  ]);
  return { engine, calls };
}

test("hooks dispatch handlers in order", async () => {
  const { engine, calls } = engineWithRecorder();
  engine.load([
    hook("hook.h1", {
      trigger: { event: "go" },
      order: 2,
      handlers: [{ type: "function", ref: "function.rec.push", args: { v: "second" } }],
    }),
    hook("hook.h0", {
      trigger: { event: "go" },
      order: 1,
      handlers: [{ type: "function", ref: "function.rec.push", args: { v: "first" } }],
    }),
  ]);
  await engine.dispatch("go", {});
  assert.deepEqual(calls, ["first", "second"]);
});

test("stopOnError=true aborts dispatch with the handler error", async () => {
  const { engine, calls } = engineWithRecorder();
  engine.load(
    hook("hook.bad", {
      trigger: { event: "go" },
      handlers: [
        { type: "function", ref: "function.rec.fail" },
        { type: "function", ref: "function.rec.push", args: { v: "never" } },
      ],
      execution: { mode: "sequential", stopOnError: true },
    }),
  );
  await assert.rejects(() => engine.dispatch("go", {}), (e: unknown) => e instanceof Error && e.message === "handler exploded");
  assert.deepEqual(calls, []);
});

test("stopOnError=false collects errors and continues", async () => {
  const { engine, calls } = engineWithRecorder();
  engine.load(
    hook("hook.soft", {
      trigger: { event: "go" },
      handlers: [
        { type: "function", ref: "function.rec.fail" },
        { type: "function", ref: "function.rec.push", args: { v: "still-ran" } },
      ],
      execution: { mode: "sequential", stopOnError: false },
    }),
  );
  const results = await engine.dispatch("go", {});
  const hookResults = (results as { hooks: Array<{ ok: boolean }> }).hooks;
  assert.equal(hookResults[0]!.ok, false);
  assert.equal(hookResults[1]!.ok, true);
  assert.deepEqual(calls, ["still-ran"]);
});

test("parallel mode runs all handlers", async () => {
  const { engine, calls } = engineWithRecorder();
  engine.load(
    hook("hook.par", {
      trigger: { event: "go" },
      handlers: [
        { type: "function", ref: "function.rec.push", args: { v: "a" } },
        { type: "function", ref: "function.rec.push", args: { v: "b" } },
      ],
      execution: { mode: "parallel", stopOnError: false },
    }),
  );
  await engine.dispatch("go", {});
  assert.deepEqual([...calls].sort(), ["a", "b"]);
});

test("flow handler executes the referenced flow with event+payload", async () => {
  const engine = new LogicEngine();
  engine.load([
    flow("flow.echo", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: { event: "$.event", user: "$.payload.user" } },
      ],
    }),
    hook("hook.echo", {
      trigger: { event: "user.created" },
      handlers: [{ type: "flow", ref: "flow.echo" }],
    }),
  ]);
  const res = await engine.dispatch("user.created", { user: "amina" });
  const hooks = (res as { hooks: Array<{ ok: boolean; value: unknown }> }).hooks;
  assert.equal(hooks[0]!.ok, true);
  assert.deepEqual(hooks[0]!.value, { event: "user.created", user: "amina" });
});

test("method handler invokes a class method", async () => {
  const engine = new LogicEngine();
  engine.registerNative("store.set", async (args, _ctx, instance) => {
    const inst = instance as { properties: Record<string, unknown> };
    inst.properties.last = args.v;
    return args.v;
  });
  engine.load([
    fn("function.store.set", { kind: "native", native: "store.set", parameters: [{ name: "v", type: "string", required: true }] }),
    cls("class.store", {
      lifetime: "singleton",
      properties: [{ name: "last", type: "string", default: "" }],
      methods: [{ id: "m.set", name: "set", function: "function.store.set" }],
    }),
    hook("hook.store", {
      trigger: { event: "store.it" },
      handlers: [{ type: "method", class: "class.store", method: "set", args: { v: "$.payload" } }],
    }),
  ]);
  await engine.dispatch("store.it", "hello");
  const svc = await engine.getService("class.store");
  assert.equal(svc.properties.last, "hello");
});

test("wildcard hook trigger matches any event", async () => {
  const { engine, calls } = engineWithRecorder();
  engine.load(
    hook("hook.any", {
      trigger: { event: "*" },
      handlers: [{ type: "function", ref: "function.rec.push", args: { v: "$.event" } }],
      execution: { stopOnError: false },
    }),
  );
  await engine.dispatch("anything.at.all", {});
  assert.deepEqual(calls, ["anything.at.all"]);
});
