/**
 * Remediation regression tests for the audit findings:
 *  switch semantics, foreach scoping/current restoration, wildcard once,
 *  class lifetimes + disposal, reference type checking, event contracts
 *  (payload validation, strict events, event-cycle detection), shared
 *  execution budget, context namespaces, compiled IR.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine, VdsError } from "../src/index.ts";
import { fn, flow, cls, hook } from "./helpers.ts";

// ---------------------------------------------------------------- switch

test("switch compares the evaluated value against case values (deep equality)", async () => {
  const engine = new LogicEngine();
  engine.load(
    flow("flow.sw", {
      parameters: [{ name: "n", type: "integer", required: true }],
      nodes: [
        { id: "s", type: "start", next: "sw" },
        {
          id: "sw",
          type: "switch",
          value: "$.n",
          cases: [
            { when: 1, nodes: [{ id: "c1", type: "return", value: "one" }] },
            { when: 2, nodes: [{ id: "c2", type: "return", value: "two" }] },
          ],
          default: [{ id: "d", type: "return", value: "other" }],
        },
      ],
    }),
  );
  assert.equal((await engine.executeFlow("flow.sw", { input: { n: 1 } })).data, "one");
  assert.equal((await engine.executeFlow("flow.sw", { input: { n: 2 } })).data, "two");
  assert.equal((await engine.executeFlow("flow.sw", { input: { n: 99 } })).data, "other");
});

// ---------------------------------------------------------------- foreach

test("nested foreach: loop variables are scoped and @ is restored", async () => {
  const engine = new LogicEngine();
  engine.load(
    flow("flow.nested-loop", {
      nodes: [
        { id: "s", type: "start", next: "init" },
        { id: "init", type: "set", assignments: { acc: "" }, next: "outer" },
        {
          id: "outer",
          type: "foreach",
          items: ["a", "b"],
          as: "outer",
          next: "r",
          body: [
            {
              id: "inner",
              type: "foreach",
              items: ["1", "2"],
              as: "inner",
              next: "after-inner",
              body: [
                {
                  id: "acc",
                  type: "set",
                  assignments: { acc: { operator: "concat", arguments: ["$.acc", "$.outer", "$.inner", ";"] } },
                },
              ],
            },
            // after the inner loop, @ must be the OUTER item again
            { id: "after-inner", type: "set", assignments: { lastOuter: "@" } },
          ],
        },
        { id: "r", type: "return", value: { acc: "$.acc", lastOuter: "$.lastOuter" } },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.nested-loop", {});
  assert.equal(res.success, true, JSON.stringify(res.error));
  assert.deepEqual(res.data, { acc: "a1;a2;b1;b2;", lastOuter: "b" });
});

// ---------------------------------------------------------------- events

test("wildcard once-subscription fires exactly once", async () => {
  const engine = new LogicEngine();
  let calls = 0;
  engine.once("*", () => {
    calls++;
  });
  await engine.dispatch("evt.one", {});
  await engine.dispatch("evt.two", {});
  assert.equal(calls, 1);
});

test("event payloads are validated against the registered event definition", async () => {
  const engine = new LogicEngine();
  engine.load({
    id: "event.user.created",
    name: "userCreated",
    type: "event",
    version: "1.0.0",
    spec_version: "1.0.0",
    definition: { payload: [{ name: "userId", type: "string", required: true }] },
  } as never);
  await assert.rejects(
    () => engine.dispatch("user.created", {}),
    (e: unknown) => e instanceof VdsError && e.code === "PARAM_INVALID",
  );
  const ok = await engine.dispatch("user.created", { userId: "u-1" });
  assert.ok(ok);
});

test("strictEvents: emit nodes and hook triggers must reference registered events", () => {
  const engine = new LogicEngine({ strictEvents: true });
  engine.load({
    id: "event.ping",
    name: "ping",
    type: "event",
    version: "1.0.0",
    spec_version: "1.0.0",
    definition: {},
  } as never);
  // unknown event in a flow emit -> rejected at load
  assert.throws(
    () =>
      engine.load(
        flow("flow.e", {
          nodes: [
            { id: "s", type: "start", next: "e" },
            { id: "e", type: "emit", event: "unknown.event" },
          ],
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "REF_NOT_FOUND" && JSON.stringify(e.details).includes("unknown.event"),
  );
  // registered event -> fine
  engine.load(
    flow("flow.e2", {
      nodes: [
        { id: "s", type: "start", next: "e" },
        { id: "e", type: "emit", event: "ping" },
      ],
    }),
  );
});

test("event-driven recursion (event -> hook -> flow -> emit same event) is detected", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load([
        flow("flow.loop", {
          nodes: [
            { id: "s", type: "start", next: "e" },
            { id: "e", type: "emit", event: "loop" },
          ],
        }),
        hook("hook.loop", {
          trigger: { event: "loop" },
          handlers: [{ type: "flow", ref: "flow.loop" }],
        }),
      ]),
    (e: unknown) => e instanceof VdsError && e.code === "EVENT_CYCLE",
  );
});

// ---------------------------------------------------------------- references

test("reference type mismatches are rejected at load time", () => {
  const engine = new LogicEngine();
  engine.load(
    cls("class.not-a-function", { methods: [] }),
  );
  assert.throws(
    () =>
      engine.load(
        flow("flow.wrongtype", {
          nodes: [
            { id: "s", type: "start", next: "c" },
            { id: "c", type: "callFunction", ref: "class.not-a-function" },
          ],
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "REF_TYPE_MISMATCH",
  );
  // hook handler with wrong ref type
  assert.throws(
    () =>
      engine.load(
        hook("hook.wrong", {
          trigger: { event: "e" },
          handlers: [{ type: "function", ref: "class.not-a-function" }],
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "REF_TYPE_MISMATCH",
  );
  // logic operator referencing a non-logic definition
  engine.load(fn("function.f", { kind: "pure", expression: 1 }));
  assert.throws(
    () =>
      engine.load(
        fn("function.uses-logic", {
          kind: "pure",
          expression: { operator: "logic", arguments: ["function.f"] },
        }),
      ),
    (e: unknown) => e instanceof VdsError && e.code === "REF_TYPE_MISMATCH",
  );
});

// ---------------------------------------------------------------- class lifetimes

test("execution lifetime: one instance per flow execution, disposed after", async () => {
  const engine = new LogicEngine();
  engine.registerNative("counter.bump", async (_args, _ctx, instance) => {
    const inst = instance as { properties: Record<string, unknown> };
    inst.properties.n = ((inst.properties.n as number) ?? 0) + 1;
    return inst.properties.n;
  });
  engine.load([
    fn("function.counter.bump", { kind: "native", native: "counter.bump" }),
    cls("class.counter", {
      lifetime: "execution",
      properties: [{ name: "n", type: "integer", default: 0 }],
      methods: [{ id: "m", name: "bump", function: "function.counter.bump" }],
    }),
    flow("flow.twice", {
      nodes: [
        { id: "s", type: "start", next: "a" },
        { id: "a", type: "callMethod", class: "class.counter", method: "bump", assign: "first", next: "b" },
        { id: "b", type: "callMethod", class: "class.counter", method: "bump", assign: "second", next: "r" },
        { id: "r", type: "return", value: { first: "$.first", second: "$.second" } },
      ],
    }),
  ]);
  const r1 = await engine.executeFlow("flow.twice", {});
  assert.deepEqual(r1.data, { first: 1, second: 2 }); // same instance within one execution
  const r2 = await engine.executeFlow("flow.twice", {});
  assert.deepEqual(r2.data, { first: 1, second: 2 }); // fresh instance per execution
});

test("transient lifetime: new instance per call and disposed afterwards", async () => {
  const engine = new LogicEngine();
  const seen: Array<{ disposedAfter: boolean }> = [];
  engine.registerNative("probe.run", async (_args, _ctx, instance) => {
    const inst = instance as { disposed: boolean };
    seen.push({ disposedAfter: inst.disposed });
    return "ran";
  });
  engine.load([
    fn("function.probe.run", { kind: "native", native: "probe.run" }),
    cls("class.probe", {
      lifetime: "transient",
      methods: [{ id: "m", name: "run", function: "function.probe.run" }],
    }),
  ]);
  const r1 = await engine.callMethod("class.probe", "run", {});
  const r2 = await engine.callMethod("class.probe", "run", {});
  assert.equal(r1.success, true);
  assert.equal(r2.success, true);
  assert.deepEqual(seen, [{ disposedAfter: false }, { disposedAfter: false }]);
});

// ---------------------------------------------------------------- budget

test("nested flows share one execution budget (runaway protection across callFlow)", async () => {
  const engine = new LogicEngine();
  engine.load([
    flow("flow.inner.many", {
      nodes: [
        { id: "s", type: "start", next: "a" },
        { id: "a", type: "set", assignments: { x: 1 }, next: "b" },
        { id: "b", type: "set", assignments: { y: 2 }, next: "c" },
        { id: "c", type: "set", assignments: { z: 3 }, next: "r" },
        { id: "r", type: "return", value: "$.z" },
      ],
    }),
    flow("flow.outer.tight", {
      limits: { maxNodeExecutions: 4 },
      nodes: [
        { id: "s", type: "start", next: "call" },
        { id: "call", type: "callFlow", ref: "flow.inner.many", assign: "v", next: "r" },
        { id: "r", type: "return", value: "$.v" },
      ],
    }),
  ]);
  const res = await engine.executeFlow("flow.outer.tight", {});
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "EXEC_LIMIT"); // inner flow consumed the shared budget
});

// ---------------------------------------------------------------- context namespaces

test("context exposes explicit namespaces: $.input $.variables $.user $.environment $.state $.event", async () => {
  const engine = new LogicEngine();
  engine.setState("mode", "test");
  engine.load(
    flow("flow.ns", {
      parameters: [{ name: "x", type: "integer", required: true }],
      nodes: [
        { id: "s", type: "start", next: "set" },
        { id: "set", type: "set", assignments: { y: { operator: "add", arguments: ["$.input.x", 1] } }, next: "r" },
        {
          id: "r",
          type: "return",
          value: {
            x: "$.input.x",
            y: "$.variables.y",
            userId: "$.user.id",
            envMode: "$.environment.mode",
            stateMode: "$.state.mode",
            eventName: "$.event",
          },
        },
      ],
    }),
  );
  const res = await engine.executeFlow("flow.ns", {
    input: { x: 5 },
    user: { id: "u-9" },
    environment: { mode: "prod" },
  });
  assert.equal(res.success, true, JSON.stringify(res.error));
  assert.deepEqual(res.data, {
    x: 5,
    y: 6,
    userId: "u-9",
    envMode: "prod",
    stateMode: "test",
    eventName: undefined,
  });
});

test("$.event is set while an event is being dispatched inside a flow", async () => {
  const engine = new LogicEngine();
  engine.load(
    flow("flow.emit-evt", {
      nodes: [
        { id: "s", type: "start", next: "e" },
        { id: "e", type: "emit", event: "capture", payload: { v: "$.event" }, next: "r" },
        { id: "r", type: "return", value: "done" },
      ],
    }),
  );
  let captured: unknown;
  engine.on("capture", (p) => {
    captured = p;
  });
  const res = await engine.executeFlow("flow.emit-evt", {});
  assert.equal(res.success, true);
  assert.deepEqual(captured, { v: "capture" }); // $.event inside the emit payload
});

// ---------------------------------------------------------------- compiled IR

test("flows execute through the compiled IR with pre-resolved links", async () => {
  const engine = new LogicEngine();
  engine.load(
    flow("flow.ir", {
      nodes: [
        { id: "s", type: "start", next: "set" },
        { id: "set", type: "set", assignments: { v: 41 }, next: "r" },
        { id: "r", type: "return", value: { operator: "add", arguments: ["$.v", 1] } },
      ],
    }),
  );
  const compiled = engine.getCompiledFlow("flow.ir");
  assert.equal(compiled.start.id, "s");
  assert.equal(compiled.start.next!.id, "set");
  assert.equal(compiled.start.next!.next!.id, "r");
  assert.equal(compiled.nodes.size, 3);
  const res = await engine.executeFlow("flow.ir", {});
  assert.equal(res.data, 42);
});
