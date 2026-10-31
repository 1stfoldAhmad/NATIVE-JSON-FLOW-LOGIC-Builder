/**
 * vds-json-logic — public API of the core engine (framework-independent).
 * For the Expo/React adapter import from "vds-json-logic/expo".
 */

export { LogicEngine } from "./engine.ts";
export type {
  LogicEngineOptions,
  ExecutionStatus,
  ExecutionStatusEvent,
  ExecutionListener,
} from "./engine.ts";

// NOTE: the core entry point is portable — it must never import node:* built-ins.
// Filesystem spec loading lives in the separate "vds-json-logic/node" entry.

export { parseSpecDocument, isEnvelope } from "./spec/load.ts";
export { isSafePattern, MAX_PATTERN_LENGTH } from "./logic/regex-safety.ts";
export { compileFlow } from "./flows/compiler.ts";
export type { CompiledFlow, CompiledNode, CompiledCase } from "./flows/compiler.ts";
export type { ClassLifetime } from "./classes/registry.ts";
export { isDangerousSegment, DANGEROUS_SEGMENTS } from "./logic/paths.ts";
export type { RuntimeEnvironment } from "./engine.ts";

export { VdsError, ErrorCodes, normalizeError, isVdsError } from "./errors.ts";
export type { ErrorCode } from "./errors.ts";

export { ok, fail, toResultError } from "./result.ts";
export type { ExecutionResult, ResultError } from "./result.ts";

export { ContextManager } from "./context/context.ts";
export type { ExecutionContext, CreateContextOptions, ExecutionBudget } from "./context/context.ts";

export { StateManager } from "./state/state.ts";
export type { StateListener } from "./state/state.ts";

export { ExecutionTracer } from "./trace/tracer.ts";
export type { TraceEvent } from "./trace/tracer.ts";

export { EventManager } from "./events/events.ts";
export type { EventHandler } from "./events/events.ts";

export { FunctionRegistry } from "./functions/registry.ts";
export type { NativeImpl } from "./functions/registry.ts";
export { FunctionExecutor } from "./functions/executor.ts";

export { ClassRegistry } from "./classes/registry.ts";
export type { ClassInstance } from "./classes/registry.ts";
export { MethodExecutor } from "./classes/methods.ts";

export { DependencyResolver } from "./deps/resolver.ts";
export type { DependencyGraph } from "./deps/resolver.ts";

export { HookEngine } from "./hooks/hooks.ts";
export type { HandlerResult } from "./hooks/hooks.ts";

export { FlowEngine } from "./flows/executor.ts";
export type { ExecuteFlowOptions } from "./flows/executor.ts";

export { evaluate } from "./logic/evaluate.ts";
export type { EvalEnv } from "./logic/evaluate.ts";
export { operators, applyOperator, operatorNames } from "./logic/operators.ts";
export type { OpContext, OperatorImpl } from "./logic/operators.ts";
export { resolvePath, parsePath, setPath } from "./logic/paths.ts";
export type { PathSegment, PathResult } from "./logic/paths.ts";

export {
  validateEnvelope,
  validateDefinition,
  validateExpression,
  assertValidDefinition,
} from "./spec/validate.ts";
export type { ValidationIssue } from "./spec/validate.ts";
export { validateParams, deepEqual } from "./spec/params.ts";
export { checkType, typeOf, isValidId } from "./spec/check.ts";

export type {
  SpecEnvelope,
  AnySpec,
  LogicSpec,
  FunctionSpec,
  ClassSpec,
  HookSpec,
  FlowSpec,
  EventSpec,
  SpecType,
  ExecutionTarget,
  ExecutionMode,
  ParameterDef,
  ExecutionDecl,
  Expression,
  JsonValue,
  JsonTypeName,
  FunctionDefinition,
  FunctionKind,
  ClassDefinition,
  MethodDef,
  PropertyDef,
  HookDefinition,
  HookHandler,
  FlowDefinition,
  FlowNode,
  FlowNodeType,
  FlowLimits,
  EventDefinition,
  LogicDefinition,
} from "./spec/types.ts";
export { JSON_TYPE_NAMES } from "./spec/types.ts";
