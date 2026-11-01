import { test } from "node:test";
import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import { LogicEngine } from "../src/index.ts";
import { fn, cls, flow, hook } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Audit 4, F1: explicit dependency ownership — disposing a transient must not
// dispose the execution-scoped dependency it borrowed.
// ---------------------------------------------------------------------------

test("F1: transient disposal leaves the execution-scoped dependency alive (6-step scenario)", async () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  engine.load([
    fn("function.noop", { kind: "native", native: "noop" }),
    cls("class.exec-svc", {
      lifetime: "execution",
      methods: [{ id: "m", name: "m", function: "function.noop" }],
    }),
    cls("class.tmp", {
      lifetime: "transient",
      dependencies: ["class.exec-svc"],
      methods: [{ id: "m", name: "m", function: "function.noop" }],
    }),
  ]);
  // 1. execution-scoped service created within an execution context
  const ctx = engine.createContext({ executionId: "exec-1" });
  const execInst = await engine.getService("class.exec-svc", ctx);
  assert.equal(execInst.lifetime, "execution");
  assert.equal(execInst.owner, "context");
  // 2+3. transient service receives it as a dependency, then is disposed
  await engine.callMethodData("class.tmp", "m", {}, ctx);
  // 4. execution-scoped service remains alive after the transient was disposed
  assert.equal(execInst.disposed, false);
  // 5. another method in the same execution gets the SAME live instance
  const again = await engine.getService("class.exec-svc", ctx);
  assert.equal(again, execInst);
  assert.equal(again.disposed, false);
  // 6. ending the execution disposes it exactly once (idempotent)
  engine.disposeContext(ctx);
  assert.equal(execInst.disposed, true);
  engine.disposeContext(ctx); // second call is a safe no-op
  assert.equal(execInst.disposed, true);
});

test("F1: singleton dependency survives disposal of transient AND execution instances", async () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  engine.load([
    fn("function.noop", { kind: "native", native: "noop" }),
    cls("class.shared", { lifetime: "singleton", methods: [{ id: "m", name: "m", function: "function.noop" }] }),
    cls("class.exec-svc", {
      lifetime: "execution",
      dependencies: ["class.shared"],
      methods: [{ id: "m", name: "m", function: "function.noop" }],
    }),
    cls("class.tmp", {
      lifetime: "transient",
      dependencies: ["class.exec-svc"],
      methods: [{ id: "m", name: "m", function: "function.noop" }],
    }),
  ]);
  const ctx = engine.createContext({ executionId: "exec-2" });
  await engine.callMethodData("class.tmp", "m", {}, ctx);
  engine.disposeContext(ctx);
  const shared = await engine.getService("class.shared");
  assert.equal(shared.disposed, false, "engine-owned singleton must survive all dependent disposal");
  assert.equal(shared.owner, "engine");
});

// ---------------------------------------------------------------------------
// Audit 4, F2: centralized context cleanup + engine shutdown lifecycle.
// ---------------------------------------------------------------------------

test("F2: callMethod outside a flow disposes execution-scoped instances via disposeContext", async () => {
  const engine = new LogicEngine();
  let seen: { disposed: boolean } | undefined;
  engine.registerNative("probe", async (_args, _ctx, instance) => {
    seen = instance as { disposed: boolean };
    return 1;
  });
  engine.load([
    fn("function.probe", { kind: "native", native: "probe" }),
    cls("class.exec-only", {
      lifetime: "execution",
      methods: [{ id: "m", name: "m", function: "function.probe" }],
    }),
  ]);
  const res = await engine.callMethod("class.exec-only", "m", {});
  assert.equal(res.success, true);
  assert.ok(seen);
  assert.equal(seen!.disposed, true, "execution-scoped instance must be disposed when the context is cleaned up");
});

test("F2: engine.dispose() rejects new work and aborts an active execution", async () => {
  const engine = new LogicEngine({ shutdownTimeoutMs: 2000 });
  engine.load([
    flow("flow.wait", {
      nodes: [
        { id: "s", type: "start", next: "d" },
        { id: "d", type: "delay", ms: 5000, next: "r" },
        { id: "r", type: "return", value: "done" },
      ],
    }),
  ]);
  const pending = engine.executeFlow("flow.wait", {});
  const disposePromise = engine.dispose();
  const res = await pending;
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_CANCELLED");
  await disposePromise;
  // new work is rejected after shutdown
  assert.throws(() => engine.executeFlow("flow.wait", {}), /disposed/);
  await assert.rejects(() => engine.dispatch("any.event", {}), /disposed/);
  const res2 = await engine.callFunction("function.nope", {}).catch((e) => e);
  assert.match(String(res2), /disposed/);
});

// ---------------------------------------------------------------------------
// Audit 4, F4: parent abort listeners are removed after nested flows finish.
// ---------------------------------------------------------------------------

test("F4: repeated nested flows leave zero abort listeners on the parent signal", async () => {
  const engine = new LogicEngine();
  engine.load([
    flow("flow.child", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: 1 },
      ],
    }),
    flow("flow.parent", {
      nodes: [
        { id: "s", type: "start", next: "c" },
        { id: "c", type: "callFlow", ref: "flow.child", assign: "x", next: "r" },
        { id: "r", type: "return", value: "$.x" },
      ],
    }),
  ]);
  const parent = new AbortController();
  for (let i = 0; i < 25; i++) {
    const res = await engine.executeFlow("flow.parent", { signal: parent.signal });
    assert.equal(res.success, true);
  }
  assert.equal(getEventListeners(parent.signal, "abort").length, 0, "no listener accumulation on the parent signal");
});

// ---------------------------------------------------------------------------
// Audit 4, F5: logic references inside flow nodes and hook args are validated
// at load time.
// ---------------------------------------------------------------------------

test("F5: flow node condition referencing unknown logic is rejected at load", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load([
        flow("flow.bad", {
          nodes: [
            { id: "s", type: "start", next: "i" },
            {
              id: "i",
              type: "if",
              condition: { operator: "logic", arguments: ["logic.user.is-eligible"] },
              then: [{ id: "y", type: "return", value: true }],
            },
          ],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "REF_NOT_FOUND",
  );
});

test("F5: hook handler args referencing unknown logic are rejected at load", () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  engine.load([fn("function.noop", { kind: "native", native: "noop" })]);
  assert.throws(
    () =>
      engine.load([
        hook("hook.bad", {
          trigger: { event: "go" },
          handlers: [{ type: "function", ref: "function.noop", args: { v: { operator: "logic", arguments: ["logic.missing"] } } }],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "REF_NOT_FOUND",
  );
});

test("F5: known logic reference in a flow node loads and executes", async () => {
  const engine = new LogicEngine();
  engine.load([
    {
      id: "logic.user.is-eligible",
      type: "logic",
      name: "isEligible",
      version: "1.0.0",
      spec_version: "1.0.0",
      definition: { expression: { operator: "gte", arguments: ["$.age", 18] } },
    } as never,
    flow("flow.check", {
      nodes: [
        { id: "s", type: "start", next: "i" },
        {
          id: "i",
          type: "if",
          condition: { operator: "logic", arguments: ["logic.user.is-eligible"] },
          then: [{ id: "y", type: "return", value: "yes" }],
          else: [{ id: "n", type: "return", value: "no" }],
        },
      ],
    }),
  ]);
  const okRes = await engine.executeFlow("flow.check", { input: { age: 20 } });
  assert.equal(okRes.data, "yes");
  const noRes = await engine.executeFlow("flow.check", { input: { age: 10 } });
  assert.equal(noRes.data, "no");
});

// ---------------------------------------------------------------------------
// Audit 4, F6: expression evaluation budgets (depth / nodes / collections /
// string length).
// ---------------------------------------------------------------------------

test("F6: expression depth limit is enforced (EVAL_LIMIT)", async () => {
  const engine = new LogicEngine({ evaluation: { maxDepth: 10 } });
  let expr: unknown = 1;
  for (let i = 0; i < 50; i++) expr = { operator: "add", arguments: [expr, 1] };
  engine.load([flow("flow.deep", { nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: expr }] })]);
  const res = await engine.executeFlow("flow.deep", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EVAL_LIMIT");
});

test("F6: expression node budget is enforced and does not leak across executions", async () => {
  const engine = new LogicEngine({ evaluation: { maxNodes: 20 } });
  engine.load([
    flow("flow.big", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        {
          id: "r",
          type: "return",
          value: { operator: "add", arguments: [Array.from({ length: 30 }, () => 1)] },
        },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.big", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EVAL_LIMIT");
  // a fresh execution gets a fresh budget (no leak from the previous one)
  engine.load([
    flow("flow.small", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: { operator: "add", arguments: [1, 2] } },
      ],
    }),
  ]);
  const okRes = await engine.executeFlow("flow.small", {});
  assert.equal(okRes.success, true);
  assert.equal(okRes.data, 3);
});

test("F6: collection operators are bounded by maxCollectionItems", async () => {
  const engine = new LogicEngine({ evaluation: { maxCollectionItems: 3 } });
  engine.load([
    flow("flow.map", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        {
          id: "r",
          type: "return",
          value: { operator: "map", arguments: ["$.items", { operator: "multiply", arguments: ["@", 2] }] },
        },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.map", { input: { items: [1, 2, 3, 4, 5] } });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EVAL_LIMIT");
  const okRes = await engine.executeFlow("flow.map", { input: { items: [1, 2] } });
  assert.deepEqual(okRes.data, [2, 4]);
});

test("F6: string results are bounded by maxStringLength", async () => {
  const engine = new LogicEngine({ evaluation: { maxStringLength: 10 } });
  engine.load([
    flow("flow.str", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: { operator: "concat", arguments: ["$.a", "$.b"] } },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.str", { input: { a: "aaaaaaaaaa", b: "bbbbbbbbbb" } });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EVAL_LIMIT");
});

// ---------------------------------------------------------------------------
// Audit 4, F7: stricter validation contracts.
// ---------------------------------------------------------------------------

test("F7: method with both function and flow is rejected", () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  engine.load([fn("function.noop", { kind: "native", native: "noop" })]);
  assert.throws(
    () =>
      engine.load([
        flow("flow.x", { nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: 1 }] }),
        cls("class.bad", {
          methods: [{ id: "m", name: "m", function: "function.noop", flow: "flow.x" }],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
});

test("F7: malformed capabilities / dangerous param names / bad defaults / bad limits are rejected", () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  // capabilities not an array of non-empty strings
  assert.throws(
    () => engine.load([fn("function.f1", { kind: "native", native: "noop" }, { execution: { capabilities: "api.read" } })]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
  assert.throws(
    () => engine.load([fn("function.f2", { kind: "native", native: "noop" }, { execution: { capabilities: [""] } })]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
  // dangerous parameter name
  assert.throws(
    () =>
      engine.load([
        fn("function.f3", {
          kind: "native",
          native: "noop",
          parameters: [{ name: "__proto__", type: "string" }],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
  // default not matching declared type
  assert.throws(
    () =>
      engine.load([
        fn("function.f4", {
          kind: "native",
          native: "noop",
          parameters: [{ name: "n", type: "integer", default: "not-a-number" }],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
  // invalid flow limits
  assert.throws(
    () =>
      engine.load([
        flow("flow.bad", {
          limits: { maxNodeExecutions: -5 },
          nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: 1 }],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
  assert.throws(
    () =>
      engine.load([
        flow("flow.bad2", {
          limits: { timeoutMs: -1 },
          nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: 1 }],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
});

test("F7: unknown operator in an expression is rejected at load", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load([
        flow("flow.op", {
          nodes: [
            { id: "s", type: "start", next: "r" },
            { id: "r", type: "return", value: { operator: "eval", arguments: ["1+1"] } },
          ],
        }),
      ]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID",
  );
});

test("F7: additionalProperties policy reject/strip on unknown envelope fields", () => {
  const rejectEngine = new LogicEngine({ additionalProperties: "reject" });
  assert.throws(
    () =>
      rejectEngine.load([
        { ...fn("function.f1", { kind: "pure", expression: 1 }), evilField: "x" } as never,
      ]),
    (e: unknown) => (e as { code: string }).code === "SPEC_INVALID" && /unknown top-level/.test((e as Error).message),
  );
  const stripEngine = new LogicEngine({ additionalProperties: "strip" });
  const def = { ...fn("function.f2", { kind: "pure", expression: 42 }), extraJunk: true } as never;
  stripEngine.load([def]);
  assert.equal((def as Record<string, unknown>).extraJunk, undefined, "strip removes unknown fields");
  // default "allow" keeps them
  const allowEngine = new LogicEngine();
  const def2 = { ...fn("function.f3", { kind: "pure", expression: 7 }), extraJunk: true } as never;
  allowEngine.load([def2]);
  assert.equal((def2 as Record<string, unknown>).extraJunk, true);
});

// ---------------------------------------------------------------------------
// Audit 4, §3: error/cancel/timeout/finally lifecycle handlers.
// ---------------------------------------------------------------------------

function lifecycleEngine(marks: string[]) {
  const engine = new LogicEngine();
  engine.registerNative("mark", async (args) => {
    marks.push(String(args.which));
    return true;
  });
  engine.load([
    fn("function.mark", { kind: "native", native: "mark", parameters: [{ name: "which", type: "string", required: true }] }),
    flow("flow.wait", {
      nodes: [
        { id: "s", type: "start", next: "d" },
        { id: "d", type: "delay", ms: 5000, next: "r" },
        { id: "r", type: "return", value: "done" },
      ],
      onError: [{ id: "e", type: "callFunction", ref: "function.mark", args: { which: "onError" } }],
      onCancel: [{ id: "c", type: "callFunction", ref: "function.mark", args: { which: "onCancel" } }],
      onTimeout: [{ id: "t", type: "callFunction", ref: "function.mark", args: { which: "onTimeout" } }],
      onFinally: [{ id: "f", type: "callFunction", ref: "function.mark", args: { which: "onFinally" } }],
    }),
    flow("flow.boom", {
      nodes: [
        { id: "s", type: "start", next: "t" },
        { id: "t", type: "throw", error: { code: "FLOW_ERROR", message: "boom" }, next: "r" },
        { id: "r", type: "return", value: "never" },
      ],
      onError: [{ id: "e", type: "callFunction", ref: "function.mark", args: { which: "onError" } }],
      onCancel: [{ id: "c", type: "callFunction", ref: "function.mark", args: { which: "onCancel" } }],
      onFinally: [{ id: "f", type: "callFunction", ref: "function.mark", args: { which: "onFinally" } }],
    }),
  ]);
  return engine;
}

test("§3: cancellation runs onCancel + onFinally but NOT onError, even with an aborted signal", async () => {
  const marks: string[] = [];
  const engine = lifecycleEngine(marks);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("user cancelled")), 20);
  const res = await engine.executeFlow("flow.wait", { signal: ac.signal });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_CANCELLED");
  assert.ok(marks.includes("onCancel"), "onCancel must run");
  assert.ok(marks.includes("onFinally"), "onFinally must run even when cancelled");
  assert.ok(!marks.includes("onError"), "onError must NOT run for cancellation");
});

test("§3: timeout runs onTimeout + onFinally but NOT onError", async () => {
  const marks: string[] = [];
  const engine = lifecycleEngine(marks);
  const res = await engine.executeFlow("flow.wait", { timeoutMs: 30 });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_TIMEOUT");
  assert.ok(marks.includes("onTimeout"));
  assert.ok(marks.includes("onFinally"));
  assert.ok(!marks.includes("onError"));
});

test("§3: ordinary failure runs onError + onFinally but NOT onCancel/onTimeout", async () => {
  const marks: string[] = [];
  const engine = lifecycleEngine(marks);
  const res = await engine.executeFlow("flow.boom", {});
  assert.equal(res.success, false);
  assert.ok(marks.includes("onError"));
  assert.ok(marks.includes("onFinally"));
  assert.ok(!marks.includes("onCancel"));
  assert.ok(!marks.includes("onTimeout"));
});
