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
  spec/       JSON envelope, type system, schema + semantic validation
  logic/      controlled expression language: paths ($.items[*].price, @), operators, evaluator
  functions/  function registry + executor (kinds: pure/native/async/flow/...)
  classes/    class registry (lifetimes, dependency injection) + method executor
  flows/      flow engine: graph walk, if/switch/foreach/try, callFlow, emit, cancellation, timeouts
  hooks/      JSON hook engine (ordering, sequential/parallel, stopOnError)
  events/     programmatic event bus (on/off/emit)
  context/    execution context + variable scopes
  state/      application state store (observable)
  deps/       dependency resolver: missing refs + circular dependency detection
  trace/      execution tracer
  engine.ts   LogicEngine facade — the whole public core API
  expo/       thin Expo/React adapter: LogicProvider, useFlow, useLogic, useService, ...
examples/registration/   JSON specs + demo natives for the registration workflow
scripts/demo.ts          runnable demo (plain Node): node scripts/demo.ts
tests/                   node:test suite (71 tests)
```

## Quick start (core, no React)

```ts
import { LogicEngine } from "vds-json-logic";

const engine = new LogicEngine({ trace: true });

// Native implementations are the ONLY I/O extension point (API adapters,
// notifications, storage). JSON itself can never execute code.
engine.registerNative("userApi.findByEmail", async (args) => { /* fetch */ });

// Load JSON specs (one batch so cross-file references resolve before validation)
engine.loadFiles([
  "specs/logic.json", "specs/functions.json", "specs/classes.json",
  "specs/hooks.json", "specs/flows.json", "specs/events.json",
]);

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
// engine.registerNative(...); engine.loadFiles([...]);

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

See `examples/expo-registration/RegistrationScreen.tsx` for a full
`@expo/ui` screen sketch.

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

- Files: `logic.json`, `functions.json`, `classes.json`, `hooks.json`, `flows.json`, `events.json` (load them in one `loadFiles([...])` batch).
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

## Scripts

```bash
npm install
npm test          # node --test (71 tests, plain Node — core needs no React)
npm run demo      # end-to-end registration demo
npm run typecheck # tsc --noEmit over src + tests + examples
npm run build     # emit dist/ (core + ./expo entry)
```

## Roadmap (from the VDS plan)

Phases 1–5 are implemented here (specification, logic engine, function/class
engine, flow engine, hook/event engine, context/state). Next: Phase 7 in a real
Expo app with `@expo/ui` + Form Builder integration (form.submit → hook → flow),
then Phase 8 diagnostics and Phase 9 VDS project integration. Later: parallel
node execution, durable/resumable workflows, backend execution adapters.
