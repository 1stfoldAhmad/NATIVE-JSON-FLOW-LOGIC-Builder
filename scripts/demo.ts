/**
 * First working demonstration (runs in plain Node — no React/Expo needed):
 *
 *   node scripts/demo.ts
 *
 * Proves the smallest meaningful vertical slice:
 *   JSON function <- JSON class method <- JSON flow <- engine API,
 *   plus hooks, logic conditions, cancellation and structured errors.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LogicEngine } from "../src/index.ts";
import { loadSpecFiles } from "../src/node-io.ts";
import { createDemoDb, registerDemoNatives } from "../examples/registration/native.ts";

const here = dirname(fileURLToPath(import.meta.url));
const examples = join(here, "..", "examples", "registration");

const db = createDemoDb();
const engine = new LogicEngine({ trace: true, projectId: "demo", environment: "frontend" });
registerDemoNatives(engine, db);

loadSpecFiles(engine, [
  join(examples, "logic.json"),
  join(examples, "events.json"),
  join(examples, "functions.json"),
  join(examples, "classes.json"),
  join(examples, "hooks.json"),
  join(examples, "flows.json"),
]);

console.log("Loaded definitions:", engine.listDefinitions().map((d) => d.id).join(", "));
console.log("Dependency graph edges:", JSON.stringify(engine.getDependencyGraph().edges, null, 2));

// 1. Pure function from the plan example
const total = await engine.callFunction("function.order.calculate-total", {
  items: [{ price: 10 }, { price: 5.5 }, { price: 4.5 }],
  taxRate: 0.05,
});
console.log("\n[1] pure function calculate-total:", JSON.stringify(total));

// 2. Named logic condition
console.log("[2] logic.registration.eligible age=20:", engine.evaluateLogic("logic.registration.eligible", { age: 20 }));
console.log("[2] logic.registration.eligible age=15:", engine.evaluateLogic("logic.registration.eligible", { age: 15 }));

// 3. Class method
const emailCheck = await engine.callMethod("class.validation-service", "validateEmail", {
  email: "not-an-email",
});
console.log("[3] ValidationService.validateEmail('not-an-email'):", JSON.stringify(emailCheck));

// 4. Full registration flow (success)
const ok = await engine.executeFlow("flow.user.registration", {
  input: { name: "Ahmad", email: "  Ahmad@Example.COM ", password: "secret123", age: 25 },
});
console.log("\n[4] registration success:", JSON.stringify(ok, null, 2));
console.log("    verification notifications sent:", db.notifications.length);

// 5. Duplicate account -> structured error
const dup = await engine.executeFlow("flow.user.registration", {
  input: { name: "Ahmad Again", email: "ahmad@example.com", password: "secret123", age: 25 },
});
console.log("\n[5] duplicate registration:", JSON.stringify(dup.error));

// 6. Invalid email -> structured validation error
const bad = await engine.executeFlow("flow.user.registration", {
  input: { name: "Bad", email: "nope", password: "secret123", age: 30 },
});
console.log("[6] invalid email:", JSON.stringify(bad.error));

// 7. Hook dispatch through the form.submit event
const viaHook = await engine.dispatch("form.submit", {
  formId: "driver-registration",
  values: { name: "Sara", email: "sara@example.com", password: "passw0rd", age: 22 },
});
console.log("\n[7] form.submit hook result:", JSON.stringify(viaHook));

// 8. Cancellation + timeout (a flow with a delay node, aborted mid-flight)
engine.loadJson([
  {
    id: "flow.demo.slow",
    name: "demoSlow",
    type: "flow",
    version: "1.0.0",
    spec_version: "1.0.0",
    definition: {
      nodes: [
        { id: "s", type: "start", next: "d" },
        { id: "d", type: "delay", ms: 5000, next: "r" },
        { id: "r", type: "return", value: "done" },
      ],
    },
  },
]);
const ac = new AbortController();
setTimeout(() => ac.abort(), 20);
const cancelled = await engine.executeFlow("flow.demo.slow", { signal: ac.signal });
console.log("\n[8a] cancelled mid-flight:", JSON.stringify(cancelled.error));
const timedOut = await engine.executeFlow("flow.demo.slow", { timeoutMs: 50 });
console.log("[8b] timed out:", JSON.stringify(timedOut.error));

// 9. Trace of the successful registration
console.log("\n[9] trace events for execution", ok.executionId, ":");
for (const e of engine.tracer.eventsFor(ok.executionId)) {
  console.log("   ", e.kind, e.nodeId ?? e.ref ?? "", e.error ?? "");
}
