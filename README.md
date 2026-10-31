# NATIVE-JSON-FLOW-LOGIC-Builder (`vds-json-logic`)

**JSON Logic Flow Builder** — define business logic once in JSON, execute it
through a predictable engine, and expose reusable classes, functions and hooks
to the application. First runtime target: **Expo + `@expo/ui`** — but the core
engine is fully independent of React, Expo, React Native and UI rendering, and
runs unchanged in Node.js or a future backend runtime.

## The central principle

```
JSON Specifications (logic.json · functions.json · classes.json · hooks.json · flows.json · events.json)
        │  validated + compiled at load time (no eval, ever)
        ▼
Independent Core Engine  ──►  Expo Runtime Adapter (LogicProvider + React hooks)  ──►  Expo App (@expo/ui screens)
```

Three related capabilities, as separate modules sharing one specification and
execution infrastructure:

1. **Logic Engine** — expressions, conditions, calculations, transformations.
2. **Flow Engine** — sequences of operations, decisions, events, async tasks, workflows.
3. **Application Integration** — classes, methods, functions and React hooks
   exposed to Expo applications.

## Four first-class building blocks

| Concept | Role | Example |
| --- | --- | --- |
| **Function** | smallest reusable unit (pure / async / transform / validator / predicate / flow-backed / native) | `function.user.validate-email` |
| **Method** | named operation exposed by a class, delegating to a function or flow | `UserService.createUser()` |
| **Class** | logical service with properties, dependencies, controlled lifetime (singleton/instance) — never a UI component | `class.user-service` |
| **Hook** | JSON lifecycle/event hook (not a React hook) | `hook.form.before-submit` on `form.submit` |
| **Flow** | coordinates functions/methods/events into a business process | `flow.user.registration` |

The smallest meaningful vertical slice — *a JSON function called from a JSON
class method, executed by a JSON flow, dispatched by a JSON hook* — is
implemented and tested (see `examples/registration` and `tests/registration.test.ts`).

## Package layout

```
src/
  spec/       JSON envelope, type system, schema + semantic validation, pure doc parsing
  logic/      controlled expression language: hardened paths, safe-regex analyzer,
              operator registry, evaluator
  functions/  function registry + executor (kinds, target + capability gates)
  classes/    class registry (singleton/execution/transient lifetimes, disposal,
              dependency injection) + method executor
  flows/      compiler (normalized IR with pre-resolved links) + executor:
              if/switch/foreach/try, callFlow, emit, cancellation, timeouts,
              shared execution budget
  hooks/      JSON hook engine (ordering, sequential/parallel, stopOnError)
  events/     programmatic event bus (correct once/wildcard cleanup)
  context/    execution context, scopes, namespaces, pollution-safe writes
  state/      application state store (observable, pollution-safe paths)
  deps/       dependency resolver: missing refs, WRONG-TYPE refs, cycles,
              event-recursion (EVENT_CYCLE), strict event contracts
  trace/      execution tracer (records ids/refs only — never payloads)
  engine.ts   LogicEngine facade — the whole public core API (ZERO node:* imports)
  node-io.ts  Node-only entry ("vds-json-logic/node"): filesystem spec loading
  expo/       thin Expo/React adapter: LogicProvider, createExpoEngine, hooks
examples/registration/   JSON specs + demo natives for the registration workflow
scripts/demo.ts          runnable demo (plain Node): npm run demo
tests/                   node:test suite (112 tests incl. security/policy regressions)
```

## Quick start (core, no React)

```ts
import { LogicEngine } from "vds-json-logic";

const engine = new LogicEngine({ trace: true });

// Native implementations are the ONLY I/O extension point (API adapters,
// notifications, storage). JSON itself can never execute code.
engine.registerNative("userApi.findByEmail", async (args) => { /* fetch */ });

// In-app, load already-bundled JSON (one transactional batch so cross-file
// references resolve before validation):
engine.loadJson(bundledSpecs); // envelope | envelope[] | { functions: [...], flows: [...], ... }

// In Node tooling/tests, filesystem loading lives in the separate /node entry:
//   import { loadSpecFiles } from "vds-json-logic/node";
//   loadSpecFiles(engine, ["specs/logic.json", "specs/functions.json", ...]);

// Non-React APIs
const result = await engine.executeFlow("flow.user.registration", {
  input: { name: "Ahmad", email: "ahmad@example.com", password: "secret123", age: 25 },
});
// => ExecutionResult { success, data?, error?, executionId, duration }

await engine.callFunction("function.order.calculate-total", { items, taxRate: 0.05 });
await engine.callMethod("class.user-service", "findUser", { email });
const valid = engine.evaluateLogic("logic.registration.eligible", { age: 20 });
await engine.dispatch("form.submit", { formId: "...", values: { ... } }); // runs JSON hooks
```

Every operation returns the standard result contract:

```ts
interface ExecutionResult<T> {
  success: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
  executionId: string;
  duration: number;
}
```

## Expo integration (`vds-json-logic/expo`)

The adapter is a thin layer: all execution stays in the framework-independent
core; the hooks only sync engine state into React state. `react` is an optional
peer dependency — the core never imports it.

```tsx
import { LogicEngine } from "vds-json-logic";
import { LogicProvider, useFlow, useFlowState, useLogic, useService, useFlowEvent, useAppLifecycle } from "vds-json-logic/expo";

const engine = new LogicEngine();
// engine.registerNative(...);
// engine.loadJson([logicSpec, functionsSpec, classesSpec, hooksSpec, flowsSpec, eventsSpec]); // bundled JSON

export default function App() {
  return (
    <LogicProvider engine={engine}>
      <RegistrationScreen />
    </LogicProvider>
  );
}

function RegistrationScreen() {
  useAppLifecycle(); // dispatches app.start / app.foreground / app.background JSON hooks
  const { execute, loading, error, result, cancel } = useFlow("flow.user.registration");
  const flowState = useFlowState("flow.user.registration");
  const { execute: validate } = useLogic("function.user.validate-email");
  const userService = useService("class.user-service");
  useFlowEvent("user.registered", (payload) => console.log("registered", payload));

  // Render with @expo/ui (UI itself belongs to the Expo JSON Form Builder):
  //   <Button onPress={() => execute({ input: formValues })}>Register</Button>
  return null;
}
```

See `examples/expo-registration/RegistrationScreen.tsx` for a `@expo/ui`
screen sketch, and `examples/expo-app/` for a complete runnable Expo app
(`npx expo start`) wiring the Form Builder's `form.submit` event through
`LogicProvider`/`useFlow` into the registration flow.

### Adapter hooks

| Hook | Responsibility |
| --- | --- |
| `useFlow(id)` | execute + observe a flow (`execute`, `cancel`, `loading`, `error`, `result`) |
| `useFlowState(id)` | observe the latest execution status of a flow |
| `useExecution(id)` | observe one execution by id |
| `useLogic(id)` | execute a reusable logic function |
| `useService(id)` | access a registered service class instance |
| `useFlowEvent(event, handler)` / `useFlowSubscription` | subscribe to engine events with cleanup |
| `useAppLifecycle()` | connect Expo app lifecycle to JSON hooks |

## JSON specification conventions

Every definition shares one envelope:

```json
{
  "id": "function.user.validate",
  "name": "validateUser",
  "type": "function",
  "version": "1.0.0",
  "spec_version": "1.0.0",
  "description": "...",
  "execution": { "target": "shared", "mode": "sync", "capabilities": ["api.read"] },
  "inputs": [],
  "outputs": [],
  "definition": {}
}
```

- Files: `logic.json`, `functions.json`, `classes.json`, `hooks.json`, `flows.json`, `events.json` (load them in one transactional batch: `engine.loadJson([...])` for bundled JSON in-app, or `loadSpecFiles(engine, [...])` from `vds-json-logic/node` in Node).
- Stable dotted IDs, semantic versions, typed inputs/outputs
  (`string number integer boolean null object array date datetime file reference any`,
  plus `required` / `nullable` / `default` / `enum`).
- Execution targets: `frontend` | `backend` | `shared`. The backend stays
  authoritative for permissions/payments/secrets — the frontend never claims them.
- Expressions are a **controlled operator language**, not JavaScript: no `eval`,
  no arbitrary code. Data paths: `$.items[*].price`, `@` (current item), `@acc` (reduce).
- Operators: arithmetic (`add subtract multiply divide modulo negate`),
  aggregates (`sum avg min max count`), comparison (`eq ne gt gte lt lte`),
  boolean (`and or not`), control (`if coalesce`), strings (`concat upper lower
  trim length includes startsWith endsWith matches split join replace`), data
  (`get keys values map filter reduce find sort`), types (`typeOf isNull isArray
  ... toNumber toString toBoolean`), and `logic` (call a named `logic.json` condition).

### Flow nodes

`start`, `return`/`end`, `set`, `callFunction`, `callMethod`, `if`, `switch`,
`foreach` (bounded by `maxIterations`), `emit`, `callFlow` (nested flows),
`try`/`catch`, `throw`, `delay`. Flows support `onError` handlers, `limits`
(`maxNodeExecutions`, `timeoutMs`), cancellation via `AbortSignal`, and typed
input/output validation.

## Security & reliability

- No `eval` / `new Function`; expressions are data interpreted by a fixed operator registry.
- Untrusted definitions are schema + semantically validated **before** execution
  (`SPEC_INVALID`), missing references and circular dependencies are detected at
  load time (`REF_NOT_FOUND`, `CIRCULAR_DEPENDENCY`).
- Registered functions declare `capabilities`; network/storage go through registered adapters only.
- Stable error codes (`VALIDATION_FAILED`, `ACCOUNT_EXISTS`, `EXEC_CANCELLED`,
  `EXEC_TIMEOUT`, `EXEC_LIMIT`, ...), execution trace IDs, cancellation, timeouts,
  loop/recursion budgets, cleanup of subscriptions and class instances.

## Security & runtime policy (hardened)

- **Portable core** — `src/index.ts`/`src/engine.ts` never import `node:*` built-ins
  (enforced by a regression test), so the package bundles in Expo/Metro. Filesystem
  loading lives only in the separate `vds-json-logic/node` entry (`loadSpecFile(s)`).
  Execution IDs use `crypto.randomUUID` when available with a portable fallback.
- **No arbitrary code** — expressions are interpreted by a fixed operator registry;
  `__proto__`/`constructor` are rejected even as operator names.
- **Prototype-pollution-safe paths** — path segments `__proto__`, `constructor`,
  `prototype` are rejected by the parser; reads use own-property checks only;
  `setPath`/state writes and flow `set` assignments refuse dangerous names.
- **ReDoS-safe `matches`** — JSON-supplied regex patterns are statically analyzed
  (`isSafePattern`): nested quantifiers (`(a+)+`), quantified alternation (`(a|a)*`),
  backreferences and >200-char patterns are rejected before compilation.
- **Execution-target enforcement** — `new LogicEngine({ environment: "frontend" })`
  (the default; `createExpoEngine()` does this) refuses to run definitions whose
  `execution.target` is `backend` (`NOT_ALLOWED`). The backend stays authoritative.
- **Capability gate** — `registerNative(name, impl, { capabilities: [...] })` declares
  what a native may do; function definitions declare required capabilities in
  `execution.capabilities`; the engine policy (`grantCapability`) can grant more.
  Missing capability → `NOT_ALLOWED` before the call.
- **Transactional loading** — `load()` stages definitions, validates the complete
  graph (missing refs, wrong-type refs, cycles, event recursion), and only then
  commits. A failed load leaves the engine untouched.
- **Event contracts** — payloads are validated against registered `events.json`
  definitions on dispatch; `strictEvents: true` requires emit nodes and hook
  triggers to name registered events; event→hook→flow→emit cycles are detected
  (`EVENT_CYCLE`) and nested/event-driven executions share one execution budget.
- **Flow semantics** — `switch` evaluates its value once and deep-compares it to
  each case's `when` (first match wins, `default` otherwise); `foreach` binds the
  item/index in a local scope and restores `@` after nested loops; flows execute
  through a compiled IR cached per flow id+version.
- **Class lifetimes** — `singleton` (per engine), `execution` (per flow execution,
  disposed with it), `transient` (per call, disposed after). Disposal is
  ownership-aware: disposing a transient/execution instance NEVER disposes its
  singleton dependencies (those are engine-owned and only `disposeAll()` —
  engine shutdown — disposes them). Property defaults are deep-cloned per instance.
- **Context namespaces** — `$.input`, `$.variables`, `$.user`, `$.environment`,
  `$.state`, `$.event` are explicit namespaces alongside merged flow data.
- **Context propagation (nested executions)** — `callFlow`, flow-backed functions,
  method-backed flows and hook handlers INHERIT `user`, `environment`, `signal`
  and the shared execution budget from the caller; `input`/`variables`/`event`
  are per-execution (isolated). `$.state` reads are deep-cloned.
- **Deny-by-default capabilities (untrusted specs)** — `new LogicEngine({ specMode:
  "untrusted" })` requires every native-backed function to declare
  `execution.capabilities`, and each declared capability must still be granted by
  the native registration or `grantCapability` (missing declaration → `NOT_ALLOWED`).
  Default `specMode: "trusted"` keeps the opt-in behavior for app-authored specs.
- **Nested budget semantics** — every flow's `limits.maxNodeExecutions` is a LOCAL
  limit on top of the shared tree-wide budget; the strictest applicable limit wins
  (`EXEC_LIMIT`).

## Scripts

```bash
npm install
npm test          # tsx --test (112 tests; tsx runs the TS tests on Node >=18 — core dist needs no React)
npm run demo      # end-to-end registration demo
npm run typecheck # tsc --noEmit over src + tests + examples (examples/expo-app has its own tsconfig — run tsc there after its npm install)
npm run build     # emit dist/ (core + ./expo entry)
```

## Roadmap (from the VDS plan)

Phases 1–5 are implemented here (specification, logic engine, function/class
engine, flow engine, hook/event engine, context/state). Phase 7's first vertical
slice ships in `examples/expo-app/` — a real Expo app (`@expo/ui` +
`LogicProvider`/`useFlow`) wiring the Form Builder's `form.submit` event through
a JSON hook into the registration flow (run it with `npx expo start`; see its
README for the verification checklist). Next: Phase 8 diagnostics and Phase 9
VDS project integration. Later: parallel node execution, durable/resumable
workflows, backend execution adapters.
