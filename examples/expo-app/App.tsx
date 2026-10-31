/**
 * Minimal Expo app proving the first vertical slice end to end:
 *
 *   Form Builder UI  --form.submit event-->  JSON hook  -->  JSON flow
 *     -->  JSON classes/functions  -->  registered natives (API adapter)  -->  result
 *
 * All business logic lives in ./specs/*.json (copied from
 * examples/registration). This file only wires the engine and the adapter.
 */

import { useMemo } from "react";
import { StatusBar } from "expo-status-bar";
import { LogicProvider, createExpoEngine } from "vds-json-logic/expo";

import RegistrationScreen from "./RegistrationScreen";
import { registerAppNatives } from "./natives";

// Metro bundles JSON imports natively.
import logicSpec from "./specs/logic.json";
import functionsSpec from "./specs/functions.json";
import classesSpec from "./specs/classes.json";
import hooksSpec from "./specs/hooks.json";
import flowsSpec from "./specs/flows.json";
import eventsSpec from "./specs/events.json";

export default function App() {
  const engine = useMemo(() => {
    // createExpoEngine fixes environment: "frontend" — backend-only specs are
    // rejected at load time (NOT_ALLOWED), the backend stays authoritative.
    const engine = createExpoEngine({ trace: true });
    registerAppNatives(engine);
    // One transactional batch: cross-file references resolve before validation.
    engine.loadJson([logicSpec, functionsSpec, classesSpec, hooksSpec, flowsSpec, eventsSpec]);
    return engine;
  }, []);

  return (
    <LogicProvider engine={engine}>
      <StatusBar style="auto" />
      <RegistrationScreen />
    </LogicProvider>
  );
}
