/**
 * End-to-end: the plan's first working demonstration — user registration —
 * executed entirely in Node (no React), proving the core vertical slice:
 * JSON functions <- class methods <- flow <- hooks/events <- engine API.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDemoEngine, loadJsonFile } from "./helpers.ts";

test("JSON specs from examples/registration load and validate", () => {
  const { engine } = makeDemoEngine();
  const ids = engine.listDefinitions().map((d) => d.id);
  for (const expected of [
    "flow.user.registration",
    "class.user-service",
    "class.validation-service",
    "function.user.validate-email",
    "function.notification.send-verification",
    "hook.user.registered-notify",
    "hook.form.before-submit",
    "logic.registration.eligible",
    "event.form.submit",
  ]) {
    assert.ok(ids.includes(expected), `missing ${expected}`);
  }
  // bundle files are valid JSON documents with envelopes
  const fns = loadJsonFile<Array<{ id: string }>>("functions.json");
  assert.ok(fns.length >= 5);
});

test("successful registration executes the whole workflow", async () => {
  const { engine, db } = makeDemoEngine();
  const res = await engine.executeFlow("flow.user.registration", {
    input: { name: "Ahmad", email: "  Ahmad@Example.COM ", password: "secret123", age: 25 },
  });
  assert.equal(res.success, true, JSON.stringify(res.error));
  const data = res.data as { success: boolean; user: { id: string; email: string; roles: string[] } };
  assert.equal(data.success, true);
  assert.equal(data.user.email, "ahmad@example.com"); // normalized
  assert.equal(data.user.id, "user-1");
  // user.registered hook sent a verification notification
  assert.equal(db.notifications.length, 1);
  assert.equal(db.notifications[0]!.userId, "user-1");
});

test("duplicate account -> ACCOUNT_EXISTS", async () => {
  const { engine } = makeDemoEngine();
  const input = { name: "A", email: "a@b.co", password: "secret123", age: 30 };
  const first = await engine.executeFlow("flow.user.registration", { input });
  assert.equal(first.success, true);
  const second = await engine.executeFlow("flow.user.registration", { input });
  assert.equal(second.success, false);
  assert.equal(second.error!.code, "ACCOUNT_EXISTS");
});

test("invalid email -> VALIDATION_FAILED with field details", async () => {
  const { engine } = makeDemoEngine();
  const res = await engine.executeFlow("flow.user.registration", {
    input: { name: "B", email: "not-an-email", password: "secret123", age: 30 },
  });
  assert.equal(res.success, false);
  assert.equal(res.error!.code, "VALIDATION_FAILED");
  assert.deepEqual((res.error!.details as { field: string }).field, "email");
});

test("weak password -> VALIDATION_FAILED with errors array", async () => {
  const { engine } = makeDemoEngine();
  const res = await engine.executeFlow("flow.user.registration", {
    input: { name: "C", email: "c@d.co", password: "short", age: 30 },
  });
  assert.equal(res.error!.code, "VALIDATION_FAILED");
  assert.ok(Array.isArray((res.error!.details as { errors: unknown[] }).errors));
});

test("underage registrant -> NOT_ELIGIBLE via logic condition", async () => {
  const { engine } = makeDemoEngine();
  const res = await engine.executeFlow("flow.user.registration", {
    input: { name: "Kid", email: "kid@d.co", password: "secret123", age: 12 },
  });
  assert.equal(res.error!.code, "NOT_ELIGIBLE");
});

test("form.submit hook runs the registration flow end-to-end", async () => {
  const { engine, db } = makeDemoEngine();
  const res = await engine.dispatch("form.submit", {
    formId: "registration",
    values: { name: "Sara", email: "sara@example.com", password: "passw0rd", age: 22 },
  });
  const hooks = (res as { hooks: Array<{ ok: boolean; value: unknown }> }).hooks;
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0]!.ok, true);
  assert.equal((hooks[0]!.value as { success: boolean }).success, true);
  assert.equal(db.users.size, 1);
});

test("subflow order quote uses the pure calculate-total function", async () => {
  const { engine } = makeDemoEngine();
  const res = await engine.executeFlow("flow.order.quote", {
    input: { items: [{ price: 10 }, { price: 5 }], taxRate: 0.1 },
  });
  assert.equal(res.success, true);
  assert.deepEqual(res.data, { total: 16.5, currency: "USD" });
});

test("named logic conditions are evaluable directly", () => {
  const { engine } = makeDemoEngine();
  assert.equal(engine.evaluateLogic("logic.registration.eligible", { age: 18 }), true);
  assert.equal(engine.evaluateLogic("logic.registration.eligible", { age: 17 }), false);
  assert.equal(engine.evaluateLogic("logic.order.free-shipping-threshold", { total: 100 }), true);
  assert.equal(engine.evaluateLogic("logic.order.free-shipping-threshold", { total: 99.9 }), false);
});

test("engine works without React — pure Node execution", async () => {
  // This whole file runs under plain `node --test` with no React import.
  const { engine } = makeDemoEngine();
  const res = await engine.callFunction("function.order.calculate-total", {
    items: [{ price: 3 }, { price: 4 }],
    taxRate: 0,
  });
  assert.equal(res.success, true);
  assert.equal(res.data, 7);
});

test("execution tracing records node/function events", async () => {
  const { engine } = makeDemoEngine({ trace: true });
  const res = await engine.executeFlow("flow.order.quote", { input: { items: [{ price: 1 }] } });
  assert.equal(res.success, true);
  const events = engine.tracer.eventsFor(res.executionId);
  assert.ok(events.some((e) => e.kind === "flow.start"));
  assert.ok(events.some((e) => e.kind === "node" && e.nodeId === "calc"));
  assert.ok(events.some((e) => e.kind === "function" && e.ref === "function.order.calculate-total"));
  assert.ok(events.some((e) => e.kind === "flow.finish"));
});
