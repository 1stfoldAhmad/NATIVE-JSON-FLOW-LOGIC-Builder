import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import { fn, flow } from "./helpers.ts";

test("abort signal stops execution safely with EXEC_CANCELLED", async () => {
  const engine = new LogicEngine();
  engine.registerNative("slow.op", async (_args, ctx) => {
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      ctx.signal?.addEventListener("abort", () => {
        clearTimeout(t);
        reject(new Error("aborted"));
      });
    });
    return "never";
  });
  engine.load([
    fn("function.slow", { kind: "native", native: "slow.op" }),
    flow("flow.slow", {
      nodes: [
        { id: "s", type: "start", next: "c" },
        { id: "c", type: "callFunction", ref: "function.slow", assign: "x" },
        { id: "r", type: "return", value: "$.x" },
      ],
    }),
  ]);
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 30);
  const start = Date.now();
  const res = await engine.executeFlow("flow.slow", { signal: ac.signal });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_CANCELLED");
  assert.ok(Date.now() - start < 2000, "should stop promptly");
});

test("timeoutMs produces EXEC_TIMEOUT", async () => {
  const engine = new LogicEngine();
  engine.load(
    flow("flow.wait", {
      nodes: [
        { id: "s", type: "start", next: "d" },
        { id: "d", type: "delay", ms: 5000, next: "r" },
        { id: "r", type: "return", value: "done" },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.wait", { timeoutMs: 50 });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_TIMEOUT");
});

test("node execution budget prevents runaway flows", async () => {
  const engine = new LogicEngine();
  engine.load(
    flow("flow.budget", {
      limits: { maxNodeExecutions: 5 },
      nodes: [
        { id: "s", type: "start", next: "loop" },
        {
          id: "loop",
          type: "foreach",
          items: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
          as: "i",
          body: [{ id: "b", type: "set", assignments: { z: "@" } }],
          next: "r",
        },
        { id: "r", type: "return", value: "ok" },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.budget", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_LIMIT");
});

test("ExecutionResult contract: success shape", async () => {
  const engine = new LogicEngine();
  engine.load(flow("flow.ok", { nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: 1 }] }));
  const res = await engine.executeFlow("flow.ok", {});
  assert.equal(res.success, true);
  assert.equal(res.data, 1);
  assert.equal(res.error, undefined);
  assert.equal(typeof res.executionId, "string");
  assert.equal(typeof res.duration, "number");
});

test("ExecutionResult contract: failure shape", async () => {
  const engine = new LogicEngine();
  const res = await engine.executeFlow("flow.missing", {});
  assert.equal(res.success, false);
  assert.equal(res.data, undefined);
  assert.equal(typeof res.error!.code, "string");
  assert.equal(typeof res.error!.message, "string");
  assert.equal(typeof res.executionId, "string");
});
