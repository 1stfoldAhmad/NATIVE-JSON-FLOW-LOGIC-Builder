import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import { fn, flow } from "./helpers.ts";

function baseEngine() {
  const engine = new LogicEngine();
  engine.load(
    fn("function.math.add", {
      kind: "pure",
      parameters: [
        { name: "a", type: "number", required: true },
        { name: "b", type: "number", required: true },
      ],
      return: { name: "sum", type: "number" },
      expression: { operator: "add", arguments: ["$.a", "$.b"] },
    }),
  );
  return engine;
}

test("sequential flow: set + callFunction + return", async () => {
  const engine = baseEngine();
  engine.load(
    flow("flow.t1", {
      parameters: [{ name: "x", type: "number", required: true }],
      nodes: [
        { id: "s", type: "start", next: "set" },
        { id: "set", type: "set", assignments: { doubled: { operator: "multiply", arguments: ["$.x", 2] } }, next: "call" },
        {
          id: "call",
          type: "callFunction",
          ref: "function.math.add",
          args: { a: "$.doubled", b: 1 },
          assign: "sum",
          next: "r",
        },
        { id: "r", type: "return", value: { sum: "$.sum" } },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.t1", { input: { x: 20 } });
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { sum: 41 });
});

test("conditional branch: if/else picks the correct path", async () => {
  const engine = baseEngine();
  const branchFlow = (cond: unknown) =>
    flow("flow.t2", {
      parameters: [{ name: "n", type: "number", required: true }],
      nodes: [
        { id: "s", type: "start", next: "if" },
        {
          id: "if",
          type: "if",
          condition: cond,
          then: [{ id: "t", type: "return", value: "big" }],
          else: [{ id: "e", type: "return", value: "small" }],
        },
      ],
    });
  engine.load(branchFlow({ operator: "gt", arguments: ["$.n", 10] }));
  assert.deepEqual((await engine.executeFlow("flow.t2", { input: { n: 50 } })).data, "big");
  assert.deepEqual((await engine.executeFlow("flow.t2", { input: { n: 5 } })).data, "small");
});

test("switch node selects the matching case", async () => {
  const engine = baseEngine();
  engine.load(
    flow("flow.t3", {
      parameters: [{ name: "role", type: "string", required: true }],
      nodes: [
        { id: "s", type: "start", next: "sw" },
        {
          id: "sw",
          type: "switch",
          value: "$.role",
          cases: [
            { when: { operator: "eq", arguments: ["$.role", "admin"] }, nodes: [{ id: "a", type: "return", value: "admin-area" }] },
            { when: { operator: "eq", arguments: ["$.role", "user"] }, nodes: [{ id: "u", type: "return", value: "user-area" }] },
          ],
          default: [{ id: "d", type: "return", value: "guest-area" }],
        },
      ],
    }),
  );
  assert.deepEqual((await engine.executeFlow("flow.t3", { input: { role: "admin" } })).data, "admin-area");
  assert.deepEqual((await engine.executeFlow("flow.t3", { input: { role: "user" } })).data, "user-area");
  assert.deepEqual((await engine.executeFlow("flow.t3", { input: { role: "anon" } })).data, "guest-area");
});

test("foreach iterates with item scope and accumulates", async () => {
  const engine = baseEngine();
  engine.load(
    flow("flow.t4", {
      parameters: [{ name: "items", type: "array", required: true }],
      nodes: [
        { id: "s", type: "start", next: "init" },
        { id: "init", type: "set", assignments: { total: 0 }, next: "loop" },
        {
          id: "loop",
          type: "foreach",
          items: "$.items",
          as: "item",
          body: [
            {
              id: "acc",
              type: "set",
              assignments: { total: { operator: "add", arguments: ["$.total", "@"] } },
            },
          ],
          next: "r",
        },
        { id: "r", type: "return", value: { total: "$.total", count: { operator: "count", value: "$.items" } } },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.t4", { input: { items: [1, 2, 3, 4] } });
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { total: 10, count: 4 });
});

test("foreach respects maxIterations (execution limit)", async () => {
  const engine = baseEngine();
  engine.load(
    flow("flow.t5", {
      nodes: [
        { id: "s", type: "start", next: "loop" },
        { id: "loop", type: "foreach", items: [1, 2, 3], as: "i", maxIterations: 2, body: [] },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.t5", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_LIMIT");
});

test("nested flow: callFlow propagates the subflow result", async () => {
  const engine = baseEngine();
  engine.load([
    flow("flow.inner", {
      parameters: [{ name: "v", type: "number", required: true }],
      nodes: [
        { id: "s", type: "start", next: "r" },
        { id: "r", type: "return", value: { operator: "multiply", arguments: ["$.v", 10] } },
      ],
    }),
    flow("flow.outer", {
      parameters: [{ name: "v", type: "number", required: true }],
      nodes: [
        { id: "s", type: "start", next: "call" },
        { id: "call", type: "callFlow", ref: "flow.inner", input: { v: "$.v" }, assign: "inner", next: "r" },
        { id: "r", type: "return", value: { operator: "add", arguments: ["$.inner", 1] } },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.outer", { input: { v: 5 } });
  assert.equal(res.success, true);
  assert.equal(res.data, 51);
});

test("nested flow error propagates as structured error", async () => {
  const engine = baseEngine();
  engine.load([
    flow("flow.inner", {
      nodes: [
        { id: "s", type: "start", next: "t" },
        { id: "t", type: "throw", error: { code: "INNER_FAIL", message: "boom" } },
      ],
    }),
    flow("flow.outer", {
      nodes: [
        { id: "s", type: "start", next: "call" },
        { id: "call", type: "callFlow", ref: "flow.inner" },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.outer", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "INNER_FAIL");
  assert.equal(res.error!.message, "boom");
});

test("try/catch handles errors and exposes the error object", async () => {
  const engine = baseEngine();
  engine.load(
    flow("flow.t6", {
      nodes: [
        { id: "s", type: "start", next: "try" },
        {
          id: "try",
          type: "try",
          body: [{ id: "t", type: "throw", error: { code: "X", message: "kaput", details: { k: 1 } } }],
          catch: [{ id: "c", type: "return", value: { caught: "$.error.code", msg: "$.error.message" } }],
        },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.t6", {});
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { caught: "X", msg: "kaput" });
});

test("flow-level onError handlers run on failure", async () => {
  const engine = new LogicEngine();
  let observed: unknown;
  engine.on("flow.error", (payload) => {
    observed = payload;
  });
  engine.load(
    flow("flow.t7", {
      nodes: [
        { id: "s", type: "start", next: "t" },
        { id: "t", type: "throw", error: { code: "BAD", message: "nope" } },
      ],
      onError: [{ id: "h", type: "emit", event: "flow.error", payload: { error: "$.error" } }],
    }),
  );
  const res = await engine.executeFlow("flow.t7", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "BAD");
  assert.deepEqual(observed, { error: { code: "BAD", message: "nope", details: undefined } });
});

test("flow input is validated before execution", async () => {
  const engine = baseEngine();
  engine.load(
    flow("flow.t8", {
      parameters: [{ name: "n", type: "integer", required: true }],
      nodes: [{ id: "s", type: "start" }, { id: "r", type: "return", value: "$.n" }],
    }),
  );
  const missing = await engine.executeFlow("flow.t8", { input: {} });
  assert.equal(missing.success, false);
  assert.equal(missing.error!.code, "PARAM_INVALID");
  const wrongType = await engine.executeFlow("flow.t8", { input: { n: "x" } });
  assert.equal(wrongType.error!.code, "TYPE_MISMATCH");
});

test("unknown flow -> REF_NOT_FOUND", async () => {
  const engine = baseEngine();
  const res = await engine.executeFlow("flow.nope", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "REF_NOT_FOUND");
});

test("emit node dispatches events to listeners", async () => {
  const engine = baseEngine();
  const seen: unknown[] = [];
  engine.on("ping", (p) => seen.push(p));
  engine.load(
    flow("flow.t9", {
      nodes: [
        { id: "s", type: "start", next: "e" },
        { id: "e", type: "emit", event: "ping", payload: { n: 1 }, next: "r" },
        { id: "r", type: "return", value: "ok" },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.t9", {});
  assert.equal(res.data, "ok");
  assert.deepEqual(seen, [{ n: 1 }]);
});

test("delay node waits and can be cancelled", async () => {
  const engine = baseEngine();
  engine.load(
    flow("flow.t10", {
      nodes: [
        { id: "s", type: "start", next: "d" },
        { id: "d", type: "delay", ms: 5000, next: "r" },
        { id: "r", type: "return", value: "done" },
      ],
    }),
  );
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 20);
  const start = Date.now();
  const res = await engine.executeFlow("flow.t10", { signal: ac.signal });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_CANCELLED");
  assert.ok(Date.now() - start < 1000);
});
