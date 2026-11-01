import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import type { EvaluationBudget } from "../src/context/context.ts";
import { fn, cls, flow } from "./helpers.ts";

// ---------------------------------------------------------------------------
// V2.1-A: disposeContext must delegate to contextManager.dispose (the previous
// self-call was a guarded no-op that never cleared scopes/variables).
// ---------------------------------------------------------------------------

test("A: disposeContext clears variables/scopes and is idempotent", () => {
  const engine = new LogicEngine();
  const ctx = engine.createContext({ executionId: "c1" });
  engine.contextManager.set(ctx, "temp", 42);
  engine.contextManager.pushScope(ctx);
  engine.contextManager.setLocal(ctx, "scoped", "x");
  assert.equal((ctx.variables as Record<string, unknown>).temp, 42);
  engine.disposeContext(ctx);
  assert.equal(ctx.cleanedUp, true);
  assert.deepEqual(ctx.variables, {}, "variables must be cleared by contextManager.dispose");
  assert.equal(ctx.scopes.length, 0, "scopes must be cleared");
  engine.disposeContext(ctx); // repeated disposal is a safe no-op
  assert.equal(ctx.cleanedUp, true);
});

test("A: disposeContext disposes execution instances once and preserves singletons", async () => {
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
  ]);
  const ctx = engine.createContext({ executionId: "c2" });
  const execInst = await engine.getService("class.exec-svc", ctx);
  engine.disposeContext(ctx);
  assert.equal(execInst.disposed, true, "execution-scoped instance disposed with the context");
  assert.equal((await engine.getService("class.shared")).disposed, false, "singleton preserved");
  engine.disposeContext(ctx);
  assert.equal(execInst.disposed, true);
});

test("A: normal flow completion, failure and cancellation all clean up (suite-level smoke)", async () => {
  const engine = new LogicEngine();
  engine.load([
    flow("flow.ok", { nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: 1 }] }),
    flow("flow.boom", {
      nodes: [
        { id: "s", type: "start", next: "t" },
        { id: "t", type: "throw", error: { code: "FLOW_ERROR", message: "x" } },
      ],
    }),
    flow("flow.wait", {
      nodes: [
        { id: "s", type: "start", next: "d" },
        { id: "d", type: "delay", ms: 5000, next: "r" },
        { id: "r", type: "return", value: 1 },
      ],
    }),
  ]);
  assert.equal((await engine.executeFlow("flow.ok", {})).success, true);
  const boom = await engine.executeFlow("flow.boom", {});
  assert.equal(boom.success, false);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const cancelled = await engine.executeFlow("flow.wait", { signal: ac.signal });
  assert.equal(cancelled.error!.code, "EXEC_CANCELLED");
});

// ---------------------------------------------------------------------------
// V2.1-B: the evaluation budget is ONE shared mutable object across nested
// flows — sibling children cannot each get a fresh allowance.
// ---------------------------------------------------------------------------

test("B: nested flows share ONE evaluation budget — sibling children cannot each get a fresh allowance", async () => {
  const engine = new LogicEngine();
  // each child expression costs ~61 evaluation nodes
  const chain = (): unknown => {
    let e: unknown = 1;
    for (let i = 0; i < 30; i++) e = { operator: "add", arguments: [e, 1] };
    return e;
  };
  engine.load([
    flow("flow.child", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: chain() },
      ],
    }),
    flow("flow.parent", {
      nodes: [
        { id: "s", type: "start", next: "c1" },
        { id: "c1", type: "callFlow", ref: "flow.child", assign: "a", next: "c2" },
        { id: "c2", type: "callFlow", ref: "flow.child", assign: "b", next: "r" },
        { id: "r", type: "return", value: 1 },
      ],
    }),
  ]);
  // Two children at ~61 nodes each cannot both fit in 100 shared nodes.
  // (With the old per-child clone bug, each child got a fresh 100 and the
  // parent succeeded — this test fails on that implementation.)
  const shared: EvaluationBudget = {
    remainingNodes: 100,
    maxNodes: 100,
    maxDepth: 100,
    maxCollectionItems: 100000,
    maxStringLength: 1000000,
  };
  const res = await engine.executeFlow("flow.parent", { evaluationBudget: shared });
  assert.equal(res.success, false, "the shared tree budget must cap sibling children cumulatively");
  assert.equal(res.error!.code, "EVAL_LIMIT");
  assert.ok(shared.remainingNodes <= 0, `the shared budget object itself must be decremented (left: ${shared.remainingNodes})`);
});

test("B: the provided budget object is used in place (not cloned) for a single flow", async () => {
  const engine = new LogicEngine();
  const chain = (): unknown => {
    let e: unknown = 1;
    for (let i = 0; i < 30; i++) e = { operator: "add", arguments: [e, 1] };
    return e;
  };
  engine.load([
    flow("flow.child", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: chain() },
      ],
    }),
  ]);
  const shared: EvaluationBudget = {
    remainingNodes: 100000,
    maxNodes: 100000,
    maxDepth: 100,
    maxCollectionItems: 100000,
    maxStringLength: 1000000,
  };
  const res = await engine.executeFlow("flow.child", { evaluationBudget: shared });
  assert.equal(res.success, true);
  const spent = 100000 - shared.remainingNodes;
  assert.ok(spent > 30, `the caller's budget object must be decremented in place (spent ${spent})`);
});

test("B: independent top-level executions get fresh budgets (no leak)", async () => {
  const engine = new LogicEngine({ evaluation: { maxNodes: 10 } });
  engine.load([
    flow("flow.big", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: { operator: "add", arguments: [Array.from({ length: 30 }, () => 1)] } },
      ],
    }),
    flow("flow.small", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: { operator: "add", arguments: [1, 2] } },
      ],
    }),
  ]);
  assert.equal((await engine.executeFlow("flow.big", {})).error!.code, "EVAL_LIMIT");
  const ok = await engine.executeFlow("flow.small", {});
  assert.equal(ok.success, true, "a new top-level execution gets a fresh budget");
  assert.equal(ok.data, 3);
});

// ---------------------------------------------------------------------------
// V2.1-C: onFinally runs exactly once on EVERY outcome (success included).
// ---------------------------------------------------------------------------

function finallyEngine(marks: string[]) {
  const engine = new LogicEngine();
  engine.registerNative("mark", async (args) => {
    marks.push(String(args.which));
    return true;
  });
  engine.load([
    fn("function.mark", { kind: "native", native: "mark", parameters: [{ name: "which", type: "string", required: true }] }),
    flow("flow.ok", {
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: "fine" },
      ],
      onFinally: [{ id: "f", type: "callFunction", ref: "function.mark", args: { which: "onFinally" } }],
    }),
    flow("flow.boom", {
      nodes: [
        { id: "s", type: "start", next: "t" },
        { id: "t", type: "throw", error: { code: "FLOW_ERROR", message: "boom" } },
      ],
      onError: [{ id: "e", type: "callFunction", ref: "function.mark", args: { which: "onError" } }],
      onFinally: [{ id: "f", type: "callFunction", ref: "function.mark", args: { which: "onFinally" } }],
    }),
    flow("flow.wait", {
      nodes: [
        { id: "s", type: "start", next: "d" },
        { id: "d", type: "delay", ms: 5000, next: "r" },
        { id: "r", type: "return", value: 1 },
      ],
      onCancel: [{ id: "c", type: "callFunction", ref: "function.mark", args: { which: "onCancel" } }],
      onFinally: [{ id: "f", type: "callFunction", ref: "function.mark", args: { which: "onFinally" } }],
    }),
  ]);
  return engine;
}

test("C: onFinally runs exactly once after SUCCESS", async () => {
  const marks: string[] = [];
  const engine = finallyEngine(marks);
  const res = await engine.executeFlow("flow.ok", {});
  assert.equal(res.success, true);
  assert.deepEqual(marks, ["onFinally"], "onFinally must run on success, exactly once");
});

test("C: onFinally runs exactly once after an ordinary ERROR (after onError)", async () => {
  const marks: string[] = [];
  const engine = finallyEngine(marks);
  const res = await engine.executeFlow("flow.boom", {});
  assert.equal(res.success, false);
  assert.deepEqual(marks, ["onError", "onFinally"]);
});

test("C: onFinally runs exactly once after CANCELLATION (after onCancel, not blocked by the aborted signal)", async () => {
  const marks: string[] = [];
  const engine = finallyEngine(marks);
  const ac = new AbortController();
  setTimeout(() => ac.abort(new Error("stop")), 20);
  const res = await engine.executeFlow("flow.wait", { signal: ac.signal });
  assert.equal(res.error!.code, "EXEC_CANCELLED");
  assert.deepEqual(marks, ["onCancel", "onFinally"]);
});
