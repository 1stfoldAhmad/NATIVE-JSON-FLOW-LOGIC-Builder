/**
 * vds-json-logic/expo — Expo/React runtime adapter.
 * Thin layer over the framework-independent core: provider + React hooks.
 * UI components themselves belong to the Expo JSON Form Builder; this
 * adapter is consumed by @expo/ui screens via these hooks.
 */

export { LogicProvider } from "./provider.ts";
export type { LogicProviderProps } from "./provider.ts";
export { LogicContext } from "./context.ts";
export {
  useEngine,
  useFlow,
  useFlowState,
  useExecution,
  useLogic,
  useService,
  useFlowEvent,
  useFlowSubscription,
  useAppLifecycle,
  useLogicEngine,
} from "./hooks.ts";
export type { FlowHandle, FlowState, LogicHandle } from "./hooks.ts";

export { LogicEngine } from "../engine.ts";
export type { ExecutionResult } from "../result.ts";
