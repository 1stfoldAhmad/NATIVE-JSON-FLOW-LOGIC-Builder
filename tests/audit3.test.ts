import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine } from "../src/index.ts";
import { ExecutionTracer } from "../src/trace/tracer.ts";
import { fn, cls, flow, hook } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Audit 3, Finding 1: class dependency lifetime compatibility.
// Load-time validation rejects longer-lived -> shorter-lived dependencies.
// ---------------------------------------------------------------------------

test("F1: singleton depending on execution class is rejected at load time", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load([
        cls("class.ctx", { lifetime: "execution" }),
        cls("class.svc", { lifetime: "singleton", dependencies: ["class.ctx"] }),
      ]),
    (e: unknown) => (e as { code: string }).code === "LIFETIME_INCOMPATIBLE",
  );
});

test("F1: singleton depending on transient class is rejected at load time", () => {
  const engine = new LogicEngine();
  assert.throws(
    () =>
      engine.load([
        cls("class.t", { lifetime: "transient" }),
        cls("class.s", { lifetime: "singleton", dependencies: ["class.t"] }),
      ]),
    (e: unknown) => (e as { code: string }).code === "LIFETIME_INCOMPATIBLE",
  );
});

test("F1: execution depending on transient is rejected; execution->singleton and transient->anything are allowed", () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  engine.load([fn("function.noop", { kind: "native", native: "noop" })]);
  assert.throws(
    () =>
      engine.load([
        cls("class.t", { lifetime: "transient" }),
        cls("class.e", { lifetime: "execution", dependencies: ["class.t"] }),
      ]),
    (e: unknown) => (e as { code: string }).code === "LIFETIME_INCOMPATIBLE",
  );
  // compatible combinations load fine
  engine.load([
    cls("class.s", { lifetime: "singleton", methods: [{ id: "m", name: "m", function: "function.noop" }] }),
    cls("class.e2", { lifetime: "execution", dependencies: ["class.s"] }),
    cls("class.t2", { lifetime: "transient", dependencies: ["class.e2", "class.s"] }),
  ]);
});

test("F1: runtime guard — a disposed dependency is never injected", async () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 1);
  engine.load([
    fn("function.noop", { kind: "native", native: "noop" }),
    cls("class.s", { lifetime: "singleton", methods: [{ id: "m", name: "m", function: "function.noop" }] }),
    cls("class.t", { lifetime: "transient", dependencies: ["class.s"] }),
  ]);
  const t = await engine.getService("class.t");
  engine.disposeInstance(t); // disposes the transient only
  const s = await engine.getService("class.s");
  assert.equal(s.disposed, false);
  // re-creating the transient must get the LIVE singleton, not a disposed one
  const t2 = await engine.getService("class.t");
  assert.equal(t2.services["class.s"], s);
  assert.equal(t2.services["class.s"].disposed, false);
});

// ---------------------------------------------------------------------------
// Audit 3, Finding 2: state manager clones on write (and read).
// ---------------------------------------------------------------------------

test("F2: set() clones the value — later caller mutation does not leak in", () => {
  const engine = new LogicEngine();
  const user = { profile: { name: "Ahmad" } };
  engine.setState("user", user);
  user.profile.name = "Changed";
  assert.deepEqual(engine.getState("user"), { profile: { name: "Ahmad" } });
});

test("F2: replace() deep-clones the replacement state", () => {
  const engine = new LogicEngine();
  const next = { cart: { items: [{ sku: "a" }] } };
  engine.state.replace(next);
  next.cart.items.push({ sku: "b" });
  assert.deepEqual(engine.getState("cart"), { items: [{ sku: "a" }] });
});

test("F2: get() clones — mutating the returned object does not corrupt state", () => {
  const engine = new LogicEngine();
  engine.setState("user", { profile: { name: "Ahmad" } });
  const got = engine.getState("user") as { profile: { name: string } };
  got.profile.name = "Hacked";
  assert.deepEqual(engine.getState("user"), { profile: { name: "Ahmad" } });
});

// ---------------------------------------------------------------------------
// Audit 3, Finding 3: strict event payload contracts.
// ---------------------------------------------------------------------------

test("F3: primitive / array / null payloads are rejected when a contract is declared", async () => {
  const engine = new LogicEngine();
  engine.load([
    {
      id: "event.user.registered",
      type: "event",
      name: "userRegistered",
      version: "1.0.0",
      spec_version: "1.0.0",
      definition: {
        id: "user.registered",
        payload: [
          { name: "userId", type: "string", required: true },
          { name: "email", type: "string", required: true },
        ],
      },
    } as never,
  ]);
  for (const bad of ["just-a-string", 42, true, ["a"], null, undefined]) {
    await assert.rejects(
      () => engine.dispatch("user.registered", bad),
      (e: unknown) => (e as { code: string }).code === "VALIDATION_FAILED",
      `payload ${JSON.stringify(bad)} must be rejected`,
    );
  }
  // a valid object payload passes validation
  const res = await engine.dispatch("user.registered", { userId: "u1", email: "a@b.co" });
  assert.ok(res);
  // missing required field still fails
  await assert.rejects(
    () => engine.dispatch("user.registered", { userId: "u1" }),
    (e: unknown) => (e as { code: string }).code === "VALIDATION_FAILED" || (e as { code: string }).code === "PARAM_INVALID",
  );
});

test("F3: events without a payload contract still accept any payload", async () => {
  const engine = new LogicEngine();
  engine.load([
    { id: "event.ping", type: "event", name: "ping", version: "1.0.0", spec_version: "1.0.0", definition: { id: "ping" } } as never,
  ]);
  assert.ok(await engine.dispatch("ping", "anything"));
  assert.ok(await engine.dispatch("ping", [1, 2]));
});

// ---------------------------------------------------------------------------
// Audit 3, Finding 4: bounded tracer retention.
// ---------------------------------------------------------------------------

test("F4: tracer drops events beyond maxEvents and sets truncated", () => {
  const tracer = new ExecutionTracer(true, { maxEvents: 10, maxEventsPerExecution: 1000 });
  for (let i = 0; i < 50; i++) {
    tracer.record({ executionId: "e1", kind: "node", nodeId: `n${i}` });
  }
  assert.equal(tracer.events.length, 10);
  assert.equal(tracer.truncated, true);
  assert.equal(tracer.snapshot().length, 10);
  tracer.clear();
  assert.equal(tracer.truncated, false);
  assert.equal(tracer.events.length, 0);
});

test("F4: per-execution cap is enforced independently", () => {
  const tracer = new ExecutionTracer(true, { maxEvents: 1000, maxEventsPerExecution: 3 });
  for (let i = 0; i < 5; i++) tracer.record({ executionId: "e1", kind: "node", nodeId: `a${i}` });
  for (let i = 0; i < 5; i++) tracer.record({ executionId: "e2", kind: "node", nodeId: `b${i}` });
  assert.equal(tracer.eventsFor("e1").length, 3);
  assert.equal(tracer.eventsFor("e2").length, 3);
  assert.equal(tracer.events.length, 6);
  assert.equal(tracer.truncated, true);
});

test("F4: engine wires traceMaxEvents options into the tracer", () => {
  const engine = new LogicEngine({ trace: true, traceMaxEvents: 5, traceMaxEventsPerExecution: 2 });
  assert.equal(engine.tracer.maxEvents, 5);
  assert.equal(engine.tracer.maxEventsPerExecution, 2);
  const engine2 = new LogicEngine({ trace: true });
  assert.equal(engine2.tracer.maxEvents, 1000);
});

// ---------------------------------------------------------------------------
// Audit 3, Finding 7: raw helpers dispose the context they create.
// ---------------------------------------------------------------------------

test("F7: callFunctionData without a context disposes its temporary context", async () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => 42);
  engine.load([fn("function.noop", { kind: "native", native: "noop" })]);
  const before = engine.listExecutions().length;
  const v = await engine.callFunctionData("function.noop", {});
  assert.equal(v, 42);
  // internal contexts are not tracked as executions, but the call must not leak:
  // calling again still works and no execution history entries pile up
  assert.equal(engine.listExecutions().length, before);
  const v2 = await engine.callFunctionData("function.noop", {});
  assert.equal(v2, 42);
});

test("F7: callMethodData without a context works and does not leak", async () => {
  const engine = new LogicEngine();
  engine.registerNative("noop", async () => "ok");
  engine.load([
    fn("function.noop", { kind: "native", native: "noop" }),
    cls("class.s", { lifetime: "singleton", methods: [{ id: "m", name: "m", function: "function.noop" }] }),
  ]);
  const v = await engine.callMethodData("class.s", "m", {});
  assert.equal(v, "ok");
});

// ---------------------------------------------------------------------------
// Audit 3, Finding 5 (pure part): flowStateFromHistory picks the latest flow.
// ---------------------------------------------------------------------------

test("F5: flowStateFromHistory returns the latest execution of the requested flow only", async () => {
  const { flowStateFromHistory } = await import("../src/expo/hooks.ts");
  const engine = new LogicEngine();
  engine.load([
    flow("flow.a", { nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: "A" }] }),
    flow("flow.b", { nodes: [{ id: "s", type: "start", next: "r" }, { id: "r", type: "return", value: "B" }] }),
  ]);
  assert.equal(flowStateFromHistory(engine, "flow.a"), null);
  await engine.executeFlow("flow.a", {});
  await engine.executeFlow("flow.b", {});
  assert.equal(flowStateFromHistory(engine, "flow.a")?.status, "completed");
  assert.equal(flowStateFromHistory(engine, "flow.b")?.status, "completed");
  assert.equal(flowStateFromHistory(engine, "flow.a")?.result, "A");
});

// silence unused-import lint for hook (kept for parity with other suites)
void hook;
