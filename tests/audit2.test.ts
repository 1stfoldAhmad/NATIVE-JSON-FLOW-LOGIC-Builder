import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import { fn, cls, flow, hook } from "./helpers.ts";

// ---------------------------------------------------------------------------
// F-03: ownership-aware disposal. Disposing a transient/execution instance
// must NEVER dispose its engine-owned singleton dependencies.
// ---------------------------------------------------------------------------

test("F-03: disposing a transient does not dispose its singleton dependency", async () => {
  const engine = new LogicEngine();
  engine.registerNative("probe", async (_args, _ctx, instance) => {
    return (instance as { disposed: boolean }).disposed;
  });
  engine.load([
    fn("function.probe", { kind: "native", native: "probe" }),
    cls("class.shared", {
      lifetime: "singleton",
      methods: [{ id: "m.p", name: "p", function: "function.probe" }],
    }),
    cls("class.tmp", {
      lifetime: "transient",
      dependencies: ["class.shared"],
      methods: [{ id: "m.run", name: "run", function: "function.probe" }],
    }),
  ]);
  const r = await engine.callMethod("class.tmp", "run", {});
  assert.equal(r.success, true);
  // singleton dependency still alive after the transient call finished
  const shared = await engine.getService("class.shared");
  assert.equal(shared.disposed, false);
  assert.equal(shared.lifetime, "singleton");
  const again = await engine.callMethod("class.shared", "p", {});
  assert.equal(again.success, true);
  assert.equal(again.data, false, "singleton instance must not be disposed");
});

test("F-03: nested chain transient -> execution -> singleton keeps singleton alive", async () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  engine.load([
    fn("function.noop", { kind: "native", native: "noop" }),
    cls("class.root", {
      lifetime: "singleton",
      methods: [{ id: "m", name: "m", function: "function.noop" }],
    }),
    cls("class.mid", {
      lifetime: "execution",
      dependencies: ["class.root"],
      methods: [{ id: "m", name: "m", function: "function.noop" }],
    }),
    cls("class.leaf", {
      lifetime: "transient",
      dependencies: ["class.mid"],
      methods: [{ id: "m", name: "m", function: "function.noop" }],
    }),
  ]);
  const r = await engine.callMethod("class.leaf", "m", {});
  assert.equal(r.success, true);
  const root = await engine.getService("class.root");
  assert.equal(root.disposed, false, "singleton must survive disposal of the transient chain");
  const r2 = await engine.callMethod("class.leaf", "m", {});
  assert.equal(r2.success, true);
  assert.equal((await engine.getService("class.root")).disposed, false);
});

test("F-03: class property defaults are deep-cloned per instance", async () => {
  const engine = new LogicEngine();
  engine.registerNative("mutate", async (_args, _ctx, instance) => {
    const inst = instance as { properties: Record<string, unknown> };
    (inst.properties.tags as string[]).push("x");
    return inst.properties.tags;
  });
  engine.load([
    fn("function.mutate", { kind: "native", native: "mutate" }),
    cls("class.a", {
      lifetime: "transient",
      properties: [{ name: "tags", type: "array", default: ["base"] }],
      methods: [{ id: "m", name: "m", function: "function.mutate" }],
    }),
    cls("class.b", {
      lifetime: "transient",
      properties: [{ name: "tags", type: "array", default: ["base"] }],
      methods: [{ id: "m", name: "m", function: "function.mutate" }],
    }),
  ]);
  const a = await engine.callMethod("class.a", "m", {});
  const b = await engine.callMethod("class.b", "m", {});
  assert.deepEqual(a.data, ["base", "x"]);
  assert.deepEqual(b.data, ["base", "x"], "instances must not share the default array");
});

// ---------------------------------------------------------------------------
// F-04: nested executions inherit user/environment/signal/budget context.
// ---------------------------------------------------------------------------

test("F-04: callFlow subflow inherits user and environment", async () => {
  const engine = new LogicEngine();
  engine.load([
    flow("flow.inner", {
      nodes: [
        { id: "s", type: "start", next: "set" },
        {
          id: "set",
          type: "set",
          assignments: { who: { operator: "concat", arguments: ["$.user.id", "@", "$.environment.tenant"] } },
          next: "r",
        },
        { id: "r", type: "return", value: "$.who" },
      ],
    }),
    flow("flow.outer", {
      nodes: [
        { id: "s", type: "start", next: "call" },
        { id: "call", type: "callFlow", ref: "flow.inner", assign: "inner", next: "r" },
        { id: "r", type: "return", value: "$.inner" },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.outer", {
    user: { id: "u-1" },
    environment: { tenant: "acme" },
  });
  assert.equal(res.success, true);
  assert.equal(res.data, "u-1acme");
});

test("F-04: flow-backed function inherits caller user/environment", async () => {
  const engine = new LogicEngine();
  engine.load([
    fn("function.whoami", { kind: "flow", flow: "flow.inner" }),
    flow("flow.inner", {
      nodes: [
        { id: "s", type: "start", next: "set" },
        {
          id: "set",
          type: "set",
          assignments: { w: { operator: "concat", arguments: ["$.user.id", "-", "$.environment.tenant"] } },
          next: "r",
        },
        { id: "r", type: "return", value: "$.w" },
      ],
    }),
  ]);
  const res = await engine.callFunction("function.whoami", {}, {
    user: { id: "u-9" },
    environment: { tenant: "t9" },
  });
  assert.equal(res.success, true);
  assert.equal(res.data, "u-9-t9");
});

test("F-04: hook-triggered flow inherits dispatch context user/environment", async () => {
  const engine = new LogicEngine();
  let captured: { user: unknown; environment: unknown } | undefined;
  engine.registerNative("capture", async (_args, ctx) => {
    captured = { user: ctx.user, environment: ctx.environment };
    return true;
  });
  engine.load([
    fn("function.capture", { kind: "native", native: "capture" }),
    {
      id: "event.form.submit",
      type: "event",
      name: "form.submit",
      version: "1.0.0",
      spec_version: "1.0.0",
      definition: {
        id: "form.submit",
        payload: [
          { name: "values", type: "object", required: true },
        ],
      },
    } as never,
    flow("flow.on-submit", {
      nodes: [
        { id: "s", type: "start", next: "call" },
        { id: "call", type: "callFunction", ref: "function.capture", args: { v: "$.input.values" }, next: "r" },
        { id: "r", type: "return", value: true },
      ],
    }),
    hook("hook.on-submit", {
      trigger: { event: "form.submit" },
      handlers: [{ type: "flow", ref: "flow.on-submit" }],
    }),
    flow("flow.trigger", {
      nodes: [
        { id: "s", type: "start", next: "emit" },
        { id: "emit", type: "emit", event: "form.submit", payload: { values: { name: "Ahmad" } }, next: "r" },
        { id: "r", type: "return", value: true },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.trigger", {
    user: { id: "u-2" },
    environment: { tenant: "acme" },
  });
  assert.equal(res.success, true);
  assert.deepEqual(captured, { user: { id: "u-2" }, environment: { tenant: "acme" } });
});

// ---------------------------------------------------------------------------
// F-05: deny-by-default capability policy in untrusted spec mode.
// ---------------------------------------------------------------------------

test("F-05: untrusted specMode denies native function with no capability declaration", async () => {
  const engine = new LogicEngine({ specMode: "untrusted" });
  engine.registerNative("net.fetch", async () => "data", { capabilities: ["network"] });
  engine.load([fn("function.get", { kind: "native", native: "net.fetch" })]); // no execution.capabilities
  const res = await engine.callFunction("function.get", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "NOT_ALLOWED");
  assert.match(res.error!.message, /declares no capabilities/);
});

test("F-05: untrusted specMode requires declared capabilities to be granted", async () => {
  const engine = new LogicEngine({ specMode: "untrusted" });
  engine.registerNative("net.fetch", async () => "data", { capabilities: ["network"] });
  engine.load([fn("function.get", { kind: "native", native: "net.fetch" }, { execution: { capabilities: ["network"] } })]);
  const ok = await engine.callFunction("function.get", {});
  assert.equal(ok.success, true);
  // declared but NOT granted -> denied
  engine.load([fn("function.steal", { kind: "native", native: "net.fetch" }, { execution: { capabilities: ["admin"] } })]);
  const denied = await engine.callFunction("function.steal", {});
  assert.equal(denied.success, false);
  assert.equal(denied.error!.code, "NOT_ALLOWED");
});

test("F-05: trusted specMode (default) keeps opt-in behavior", async () => {
  const engine = new LogicEngine();
  engine.registerNative("plain", async () => 42);
  engine.load([fn("function.plain", { kind: "native", native: "plain" })]);
  const res = await engine.callFunction("function.plain", {});
  assert.equal(res.success, true);
  assert.equal(res.data, 42);
});

// ---------------------------------------------------------------------------
// F-08: strictest applicable node limit wins (local limit vs shared budget).
// ---------------------------------------------------------------------------

test("F-08: child flow local limit is enforced even when parent budget is large", async () => {
  const engine = new LogicEngine();
  engine.load([
    flow("flow.child", {
      limits: { maxNodeExecutions: 3 },
      nodes: [
        { id: "s", type: "start", next: "c1" },
        { id: "c1", type: "set", assignments: { a: 1 }, next: "c2" },
        { id: "c2", type: "set", assignments: { b: 2 }, next: "c3" },
        { id: "c3", type: "set", assignments: { c: 3 }, next: "c4" },
        { id: "c4", type: "set", assignments: { d: 4 }, next: "r" }, // exceeds local limit of 3
        { id: "r", type: "return", value: 1 },
      ],
    }),
    flow("flow.parent", {
      nodes: [
        { id: "s", type: "start", next: "call" },
        { id: "call", type: "callFlow", ref: "flow.child", assign: "child", next: "r" },
        { id: "r", type: "return", value: "$.child" },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.parent", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_LIMIT");
});

test("F-08: shared budget still binds the whole tree when it is stricter", async () => {
  const engine = new LogicEngine();
  engine.load([
    flow("flow.child", {
      nodes: [
        { id: "s", type: "start", next: "c1" },
        { id: "c1", type: "set", assignments: { a: 1 }, next: "r" },
        { id: "r", type: "return", value: 2 },
      ],
    }),
    flow("flow.parent", {
      nodes: [
        { id: "s", type: "start", next: "p1" },
        { id: "p1", type: "callFlow", ref: "flow.child", assign: "c1", next: "p2" },
        { id: "p2", type: "callFlow", ref: "flow.child", assign: "c2", next: "p3" },
        { id: "p3", type: "callFlow", ref: "flow.child", assign: "c3", next: "r" },
        { id: "r", type: "return", value: 0 },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.parent", { budget: { remaining: 6 } });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_LIMIT");
});
