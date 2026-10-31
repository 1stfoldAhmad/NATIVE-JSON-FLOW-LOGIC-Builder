/**
 * LogicEngine — the public facade of the JSON Logic Flow Builder core.
 *
 * The core is fully independent of React/Expo/UI: it runs in Node, in tests,
 * or in a future backend runtime. The Expo adapter (src/expo) is a thin
 * layer on top of this class.
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

import { ErrorCodes, VdsError, normalizeError } from "./errors.ts";
import { ok, fail, toResultError } from "./result.ts";
import type { ExecutionResult } from "./result.ts";
import { assertValidDefinition, validateDefinition } from "./spec/validate.ts";
import type { AnySpec, SpecEnvelope, FlowSpec, FunctionSpec, ClassSpec, HookSpec, EventSpec, LogicSpec } from "./spec/types.ts";
import { evaluate } from "./logic/evaluate.ts";
import { ContextManager } from "./context/context.ts";
import type { ExecutionContext } from "./context/context.ts";
import { StateManager } from "./state/state.ts";
import { ExecutionTracer } from "./trace/tracer.ts";
import { EventManager } from "./events/events.ts";
import type { EventHandler } from "./events/events.ts";
import { FunctionRegistry } from "./functions/registry.ts";
import type { NativeImpl } from "./functions/registry.ts";
import { FunctionExecutor } from "./functions/executor.ts";
import { ClassRegistry } from "./classes/registry.ts";
import type { ClassInstance } from "./classes/registry.ts";
import { MethodExecutor } from "./classes/methods.ts";
import { DependencyResolver } from "./deps/resolver.ts";
import type { DependencyGraph } from "./deps/resolver.ts";
import { HookEngine } from "./hooks/hooks.ts";
import { FlowEngine } from "./flows/executor.ts";
import type { ExecuteFlowOptions } from "./flows/executor.ts";

export interface LogicEngineOptions {
  trace?: boolean;
  projectId?: string;
}

export type ExecutionStatus = "running" | "completed" | "failed";

export interface ExecutionStatusEvent {
  executionId: string;
  flowId?: string;
  status: ExecutionStatus;
  result?: ExecutionResult;
}

export type ExecutionListener = (event: ExecutionStatusEvent) => void;

function isEnvelope(v: unknown): v is SpecEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as SpecEnvelope).id === "string" &&
    typeof (v as SpecEnvelope).type === "string" &&
    typeof (v as SpecEnvelope).definition === "object"
  );
}

/** Normalize a JSON document into a flat list of spec envelopes. */
function normalizeJsonDoc(doc: unknown): AnySpec[] {
  const defs: AnySpec[] = [];
  if (Array.isArray(doc)) {
    defs.push(...(doc as AnySpec[]));
  } else if (isEnvelope(doc)) {
    defs.push(doc as AnySpec);
  } else if (typeof doc === "object" && doc !== null) {
    const bundle = doc as Record<string, unknown>;
    for (const key of ["logic", "functions", "classes", "hooks", "flows", "events", "specs"]) {
      const v = bundle[key];
      if (Array.isArray(v)) defs.push(...(v as AnySpec[]));
      else if (typeof v === "object" && v !== null) defs.push(...(Object.values(v) as AnySpec[]));
    }
  } else {
    throw new VdsError(ErrorCodes.SPEC_INVALID, "loadJson expects an envelope, an array, or a bundle object");
  }
  if (defs.length === 0) {
    throw new VdsError(ErrorCodes.SPEC_INVALID, "loadJson: no definitions found in document");
  }
  return defs;
}

export class LogicEngine {
  readonly contextManager = new ContextManager();
  readonly state = new StateManager();
  readonly events = new EventManager();
  readonly tracer = new ExecutionTracer();

  private functions = new FunctionRegistry();
  private classes = new ClassRegistry();
  private hooks: HookEngine;
  private flowEngine: FlowEngine;
  private functionExecutor: FunctionExecutor;
  private methodExecutor: MethodExecutor;

  private flowDefs = new Map<string, FlowSpec>();
  private eventDefs = new Map<string, EventSpec>();
  private logicDefs = new Map<string, LogicSpec>();
  private allDefs = new Map<string, AnySpec>();

  private executionListeners = new Set<ExecutionListener>();
  private projectId?: string;

  constructor(opts: LogicEngineOptions = {}) {
    this.projectId = opts.projectId;
    if (opts.trace) this.tracer.enabled = true;
    this.functionExecutor = new FunctionExecutor(this.functions, this);
    this.methodExecutor = new MethodExecutor(this.classes, this.functionExecutor, this);
    this.hooks = new HookEngine(this);
    this.flowEngine = new FlowEngine(this);
  }

  newExecutionId(): string {
    return randomUUID();
  }

  // ------------------------------------------------------------------
  // Loading & validation
  // ------------------------------------------------------------------

  /** Register a native implementation (the only I/O extension point). */
  registerNative(name: string, impl: NativeImpl): this {
    this.functions.registerNative(name, impl);
    return this;
  }

  /** Validate + register one or more definitions, then validate the graph. */
  load(defs: AnySpec | AnySpec[]): this {
    const list = Array.isArray(defs) ? defs : [defs];
    const accepted: AnySpec[] = [];
    for (const def of list) {
      assertValidDefinition(def);
      if (this.allDefs.has(def.id)) {
        throw new VdsError(ErrorCodes.SPEC_INVALID, `Duplicate definition id "${def.id}"`);
      }
      accepted.push(def);
    }
    for (const def of accepted) {
      this.allDefs.set(def.id, def);
      switch (def.type) {
        case "function":
          this.functions.register(def as FunctionSpec);
          break;
        case "class":
          this.classes.register(def as ClassSpec);
          break;
        case "hook":
          this.hooks.register(def as HookSpec);
          break;
        case "flow":
          this.flowDefs.set(def.id, def as FlowSpec);
          break;
        case "event":
          this.eventDefs.set(def.id, def as EventSpec);
          break;
        case "logic":
          this.logicDefs.set(def.id, def as LogicSpec);
          break;
      }
    }
    DependencyResolver.validate([...this.allDefs.values()]);
    return this;
  }

  /**
   * Load a JSON document: a single envelope, an array of envelopes, or a
   * bundle object with keys logic|functions|classes|hooks|flows|events.
   */
  loadJson(doc: unknown): this {
    return this.load(normalizeJsonDoc(doc));
  }

  loadFile(path: string): this {
    return this.load(normalizeJsonDoc(JSON.parse(readFileSync(path, "utf8"))));
  }

  /**
   * Load several spec files in ONE batch, so cross-file references resolve
   * before the dependency graph is validated.
   */
  loadFiles(paths: string[]): this {
    const defs: AnySpec[] = [];
    for (const p of paths) defs.push(...normalizeJsonDoc(JSON.parse(readFileSync(p, "utf8"))));
    return this.load(defs);
  }

  /** Validate a definition without registering it. Returns issues ([] = valid). */
  validate(def: unknown): ReturnType<typeof validateDefinition> {
    return validateDefinition(def as SpecEnvelope);
  }

  getDependencyGraph(): DependencyGraph {
    return DependencyResolver.build([...this.allDefs.values()]);
  }

  // ------------------------------------------------------------------
  // Registries accessors
  // ------------------------------------------------------------------

  getFunctionDef(id: string): FunctionSpec {
    return this.functions.get(id);
  }

  getClassDef(id: string): ClassSpec {
    return this.classes.get(id);
  }

  getFlowDef(id: string): FlowSpec {
    const def = this.flowDefs.get(id);
    if (!def) throw new VdsError(ErrorCodes.REF_NOT_FOUND, `Unknown flow "${id}"`, { ref: id });
    return def;
  }

  getLogicDef(id: string): LogicSpec {
    const def = this.logicDefs.get(id);
    if (!def) throw new VdsError(ErrorCodes.REF_NOT_FOUND, `Unknown logic "${id}"`, { ref: id });
    return def;
  }

  getEventDef(id: string): EventSpec {
    const def = this.eventDefs.get(id);
    if (!def) throw new VdsError(ErrorCodes.REF_NOT_FOUND, `Unknown event "${id}"`, { ref: id });
    return def;
  }

  listDefinitions(): AnySpec[] {
    return [...this.allDefs.values()];
  }

  // ------------------------------------------------------------------
  // Contexts
  // ------------------------------------------------------------------

  createContext(opts: {
    executionId?: string;
    flowId?: string;
    input?: Record<string, unknown>;
    signal?: AbortSignal;
    parentExecutionId?: string;
    user?: Record<string, unknown>;
    environment?: Record<string, unknown>;
    nodeBudget?: number;
  } = {}): ExecutionContext {
    return this.contextManager.create({
      executionId: opts.executionId ?? this.newExecutionId(),
      ...(this.projectId !== undefined ? { projectId: this.projectId } : {}),
      ...(opts.flowId !== undefined ? { flowId: opts.flowId } : {}),
      input: opts.input,
      signal: opts.signal,
      parentExecutionId: opts.parentExecutionId,
      user: opts.user,
      environment: opts.environment,
      nodeBudget: opts.nodeBudget,
      engine: this,
      tracer: this.tracer.enabled ? this.tracer : undefined,
    });
  }

  // ------------------------------------------------------------------
  // Execution APIs (non-React)
  // ------------------------------------------------------------------

  /** Evaluate a declarative expression against data. */
  evaluate(expression: unknown, data: unknown): unknown {
    return evaluate(expression, { data, engine: this });
  }

  /** Evaluate a named logic definition. */
  evaluateLogic(id: string, data: unknown): unknown {
    const def = this.getLogicDef(id);
    return evaluate(def.definition.expression, { data, engine: this });
  }

  /** Call a JSON-defined function; returns the standard ExecutionResult. */
  async callFunction(
    id: string,
    args: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; user?: Record<string, unknown> } = {},
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const executionId = this.newExecutionId();
    const ctx = this.createContext({ executionId, input: args, signal: opts.signal, user: opts.user });
    try {
      const data = await this.functionExecutor.call(id, args, ctx);
      return ok(data, executionId, Date.now() - startedAt);
    } catch (e) {
      const err = normalizeError(e);
      return fail(toResultError(err), executionId, Date.now() - startedAt);
    } finally {
      this.contextManager.dispose(ctx);
    }
  }

  /** Raw function call inside an existing execution context. */
  callFunctionData(
    id: string,
    args: Record<string, unknown>,
    ctx?: ExecutionContext,
    instance?: unknown,
  ): Promise<unknown> {
    const context = ctx ?? this.createContext({ input: args });
    return this.functionExecutor.call(id, args, context, instance);
  }

  /** Call a class method; returns the standard ExecutionResult. */
  async callMethod(
    classId: string,
    method: string,
    args: Record<string, unknown> = {},
    opts: { signal?: AbortSignal; user?: Record<string, unknown> } = {},
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const executionId = this.newExecutionId();
    const ctx = this.createContext({ executionId, input: args, signal: opts.signal, user: opts.user });
    try {
      const data = await this.methodExecutor.invoke(classId, method, args, ctx);
      return ok(data, executionId, Date.now() - startedAt);
    } catch (e) {
      const err = normalizeError(e);
      return fail(toResultError(err), executionId, Date.now() - startedAt);
    } finally {
      this.contextManager.dispose(ctx);
    }
  }

  /** Raw method call inside an existing execution context. */
  callMethodData(
    classId: string,
    method: string,
    args: Record<string, unknown>,
    ctx?: ExecutionContext,
  ): Promise<unknown> {
    const context = ctx ?? this.createContext({ input: args });
    return this.methodExecutor.invoke(classId, method, args, context);
  }

  /** Execute a JSON-defined flow; returns the standard ExecutionResult. */
  executeFlow(flowId: string, opts: ExecuteFlowOptions = {}): Promise<ExecutionResult> {
    return this.flowEngine.execute(flowId, opts);
  }

  /** Dispatch an event: JSON hooks first, then programmatic listeners. */
  async dispatch(event: string, payload: unknown, ctx?: ExecutionContext): Promise<unknown> {
    const hookResults = await this.hooks.dispatch(event, payload, ctx);
    const listenerResults = await this.events.emit(event, payload, ctx);
    return { hooks: hookResults, listeners: listenerResults };
  }

  on(event: string, handler: EventHandler): () => void {
    return this.events.on(event, handler);
  }

  once(event: string, handler: EventHandler): () => void {
    return this.events.once(event, handler);
  }

  off(event: string, handler: EventHandler): void {
    this.events.off(event, handler);
  }

  /** Access a registered service (singleton instance). */
  getService(classId: string): Promise<ClassInstance> {
    return this.classes.createInstance(classId, this);
  }

  // ------------------------------------------------------------------
  // State
  // ------------------------------------------------------------------

  getState(path?: string): unknown {
    return this.state.get(path);
  }

  setState(path: string, value: unknown): void {
    this.state.set(path, value);
  }

  subscribeState(listener: (state: Record<string, unknown>) => void): () => void {
    return this.state.subscribe(listener);
  }

  // ------------------------------------------------------------------
  // Execution observation (used by the Expo adapter hooks)
  // ------------------------------------------------------------------

  subscribeExecutions(listener: ExecutionListener): () => void {
    this.executionListeners.add(listener);
    return () => this.executionListeners.delete(listener);
  }

  notifyExecution(event: ExecutionStatusEvent): void {
    for (const l of this.executionListeners) l(event);
  }
}
