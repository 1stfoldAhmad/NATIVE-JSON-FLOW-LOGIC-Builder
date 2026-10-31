/**
 * LogicEngine — the public facade of the JSON Logic Flow Builder core.
 *
 * PORTABILITY: this module is pure TypeScript with ZERO Node built-in
 * imports, so it bundles in Expo/Metro, Node.js and future backends alike.
 * Filesystem spec loading lives in the separate "vds-json-logic/node"
 * entry point (src/node-io.ts). The Expo adapter is src/expo/*.
 *
 * The core never imports React: all execution happens here; adapters only
 * observe and synchronize state.
 */

import { ErrorCodes, VdsError, normalizeError } from "./errors.ts";
import { ok, fail, toResultError } from "./result.ts";
import type { ExecutionResult } from "./result.ts";
import { assertValidDefinition, validateDefinition } from "./spec/validate.ts";
import { parseSpecDocument } from "./spec/load.ts";
import { validateParams } from "./spec/params.ts";
import type {
  AnySpec,
  SpecEnvelope,
  FlowSpec,
  FunctionSpec,
  ClassSpec,
  HookSpec,
  EventSpec,
  LogicSpec,
  ExecutionTarget,
} from "./spec/types.ts";
import { evaluate } from "./logic/evaluate.ts";
import { ContextManager } from "./context/context.ts";
import type { ExecutionContext, ExecutionBudget } from "./context/context.ts";
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
import type { CompiledFlow } from "./flows/compiler.ts";
import { compileFlow } from "./flows/compiler.ts";

export type RuntimeEnvironment = "frontend" | "backend";

export interface LogicEngineOptions {
  trace?: boolean;
  projectId?: string;
  /**
   * The environment this engine runs in. Definitions whose
   * `execution.target` is "frontend"/"backend" are only executed when it
   * matches (or when the target is "shared"). Defaults to "frontend"
   * (the first VDS target is Expo). The backend remains authoritative for
   * permissions, payments and secrets.
   */
  environment?: RuntimeEnvironment;
  /**
   * Capabilities this runtime grants (policy). A native call whose function
   * definition requires capabilities must find them granted here or by the
   * native registration itself, otherwise the call is blocked (NOT_ALLOWED).
   */
  capabilities?: string[];
  /** When true, emit nodes and hook triggers must reference registered event definitions. */
  strictEvents?: boolean;
  /**
   * Specification loading mode:
   *  - "trusted" (default): definitions are authored by the application team.
   *  - "untrusted": remotely/user supplied JSON — native-backed functions MUST
   *    declare `execution.capabilities` (deny by default) and each required
   *    capability must be granted by the native registration or engine policy.
   */
  specMode?: "trusted" | "untrusted";
}

export type ExecutionStatus = "running" | "completed" | "failed";

export interface ExecutionStatusEvent {
  executionId: string;
  flowId?: string;
  status: ExecutionStatus;
  result?: ExecutionResult;
}

export type ExecutionListener = (event: ExecutionStatusEvent) => void;

/** Portable execution id — no Node built-ins (works in Hermes/Metro too). */
function newId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return (
    "exec-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  );
}

const MAX_TRACKED_EXECUTIONS = 500;

export class LogicEngine {
  readonly contextManager = new ContextManager();
  readonly state = new StateManager();
  readonly events = new EventManager();
  readonly tracer = new ExecutionTracer();

  /** The environment this engine enforces (frontend by default). */
  readonly environment: RuntimeEnvironment;
  readonly strictEvents: boolean;
  /** Specification loading mode (trusted by default; untrusted = deny-by-default). */
  readonly specMode: "trusted" | "untrusted";

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

  private compiledFlows = new Map<string, CompiledFlow>();
  private grantedCapabilities = new Set<string>();
  private executionListeners = new Set<ExecutionListener>();
  private executions = new Map<string, ExecutionStatusEvent>();
  private projectId?: string;
  private disposed = false;

  constructor(opts: LogicEngineOptions = {}) {
    this.projectId = opts.projectId;
    this.environment = opts.environment ?? "frontend";
    this.strictEvents = opts.strictEvents ?? false;
    this.specMode = opts.specMode ?? "trusted";
    for (const c of opts.capabilities ?? []) this.grantedCapabilities.add(c);
    if (opts.trace) this.tracer.enabled = true;
    this.functionExecutor = new FunctionExecutor(this.functions, this);
    this.methodExecutor = new MethodExecutor(this.classes, this.functionExecutor, this);
    this.hooks = new HookEngine(this);
    this.flowEngine = new FlowEngine(this);
  }

  newExecutionId(): string {
    return newId();
  }

  // ------------------------------------------------------------------
  // Runtime policy: execution targets + capabilities
  // ------------------------------------------------------------------

  /** Grant a capability to this runtime (policy). "*" grants everything. */
  grantCapability(capability: string): void {
    this.grantedCapabilities.add(capability);
  }

  isCapabilityGranted(capability: string): boolean {
    return this.grantedCapabilities.has("*") || this.grantedCapabilities.has(capability);
  }

  /**
   * Enforce execution-target compatibility: a definition targeting "backend"
   * must not run on a frontend engine (and vice versa); "shared" runs anywhere.
   * Frontend authorization is never authoritative — the backend enforces.
   */
  assertTargetAllowed(def: SpecEnvelope): void {
    const target: ExecutionTarget | undefined = def.execution?.target;
    if (target && target !== "shared" && target !== this.environment) {
      throw new VdsError(
        ErrorCodes.NOT_ALLOWED,
        `Definition "${def.id}" targets "${target}" but this engine runs in "${this.environment}"`,
        { id: def.id, target, environment: this.environment },
      );
    }
  }

  // ------------------------------------------------------------------
  // Loading & validation (transactional)
  // ------------------------------------------------------------------

  /**
   * Register a native implementation (the only I/O extension point).
   * `capabilities` lists what this implementation is allowed to do; function
   * definitions requiring capabilities are checked against this + the
   * engine policy before the call.
   */
  registerNative(name: string, impl: NativeImpl, opts?: { capabilities?: string[] }): this {
    this.functions.registerNative(name, impl, opts?.capabilities);
    return this;
  }

  /**
   * Validate + register one or more definitions, then validate the whole
   * graph. TRANSACTIONAL: definitions are staged first and only committed to
   * the live registries after every check passes — a failed load leaves the
   * engine unchanged. Load cross-referencing definitions in one call
   * (or use the /node loadSpecFiles helper).
   */
  load(defs: AnySpec | AnySpec[]): this {
    this.assertNotDisposed();
    const list = Array.isArray(defs) ? defs : [defs];
    // ---- stage ----
    const staged = new Map(this.allDefs);
    const accepted: AnySpec[] = [];
    for (const def of list) {
      assertValidDefinition(def);
      if (staged.has(def.id)) {
        throw new VdsError(ErrorCodes.SPEC_INVALID, `Duplicate definition id "${def.id}"`);
      }
      staged.set(def.id, def);
      accepted.push(def);
    }
    // ---- validate the complete staged project ----
    DependencyResolver.validate([...staged.values()], {
      strictEvents: this.strictEvents,
      eventDefined: (e) => this.findEventDef(e) !== undefined,
    });
    // ---- commit ----
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
    this.compiledFlows.clear(); // invalidate compiled IR
    return this;
  }

  /**
   * Load a JSON document (object): a single envelope, an array of envelopes,
   * or a bundle with keys logic|functions|classes|hooks|flows|events.
   * Pure/portable — accepts an already-parsed document.
   */
  loadJson(doc: unknown): this {
    return this.load(parseSpecDocument(doc));
  }

  /** Validate a definition without registering it. Returns issues ([] = valid). */
  validate(def: unknown): ReturnType<typeof validateDefinition> {
    return validateDefinition(def as SpecEnvelope);
  }

  getDependencyGraph(): DependencyGraph {
    return DependencyResolver.build([...this.allDefs.values()]);
  }

  /** Compiled IR for a flow (cached, invalidated on load). */
  getCompiledFlow(flowId: string): CompiledFlow {
    const def = this.getFlowDef(flowId);
    const cached = this.compiledFlows.get(flowId);
    if (cached && cached.version === def.version) return cached;
    const compiled = compileFlow(def);
    this.compiledFlows.set(flowId, compiled);
    return compiled;
  }

  // ------------------------------------------------------------------
  // Registry accessors
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

  /**
   * Find the event definition for a dispatched event name. Matches by exact
   * id ("event.form.submit"), by dotted suffix ("form.submit"), or by name.
   */
  findEventDef(event: string): EventSpec | undefined {
    const direct = this.eventDefs.get(event);
    if (direct) return direct;
    const prefixed = this.eventDefs.get(`event.${event}`);
    if (prefixed) return prefixed;
    for (const d of this.eventDefs.values()) {
      if (d.name === event) return d;
    }
    return undefined;
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
    budget?: ExecutionBudget;
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
      budget: opts.budget,
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
    opts: { signal?: AbortSignal; user?: Record<string, unknown>; environment?: Record<string, unknown> } = {},
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const executionId = this.newExecutionId();
    const ctx = this.createContext({
      executionId,
      input: args,
      signal: opts.signal,
      user: opts.user,
      environment: opts.environment ?? { runtime: this.environment },
    });
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

  /**
   * Dispatch an event: validates the payload against the registered event
   * definition (when one matches), then runs JSON hooks and programmatic
   * listeners. Event names are formal contracts when strictEvents is on.
   */
  async dispatch(event: string, payload: unknown, ctx?: ExecutionContext): Promise<unknown> {
    const def = this.findEventDef(event);
    if (def?.definition.payload && payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
      validateParams(def.definition.payload, payload as Record<string, unknown>, `event "${event}" payload`);
    }
    const run = async (): Promise<unknown> => {
      const hookResults = await this.hooks.dispatch(event, payload, ctx);
      const listenerResults = await this.events.emit(event, payload, ctx);
      return { hooks: hookResults, listeners: listenerResults };
    };
    if (ctx) {
      const prev = ctx.event;
      ctx.event = event;
      try {
        return await run();
      } finally {
        ctx.event = prev;
      }
    }
    return run();
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

  /** Access a registered service (singleton/execution instance). */
  getService(classId: string, ctx?: ExecutionContext): Promise<ClassInstance> {
    return this.classes.createInstance(classId, this, ctx);
  }

  /** Dispose one class instance (used for execution/transient lifetimes). */
  disposeInstance(instance: ClassInstance): void {
    this.classes.dispose(instance);
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
    // track latest status per execution (bounded)
    if (this.executions.has(event.executionId)) this.executions.delete(event.executionId);
    this.executions.set(event.executionId, event);
    if (this.executions.size > MAX_TRACKED_EXECUTIONS) {
      const oldest = this.executions.keys().next().value;
      if (oldest !== undefined) this.executions.delete(oldest);
    }
    for (const l of this.executionListeners) l(event);
  }

  /** Latest tracked status of one execution (survives late subscribers). */
  getExecution(executionId: string): ExecutionStatusEvent | undefined {
    return this.executions.get(executionId);
  }

  /** All tracked execution statuses (latest per execution). */
  listExecutions(): ExecutionStatusEvent[] {
    return [...this.executions.values()];
  }

  // ------------------------------------------------------------------
  // Disposal
  // ------------------------------------------------------------------

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new VdsError(ErrorCodes.EXEC_ERROR, "LogicEngine has been disposed");
    }
  }

  /** Dispose singleton class instances and clear listeners. */
  dispose(): void {
    this.disposed = true;
    this.classes.disposeAll();
    this.executionListeners.clear();
    this.events.clear();
  }
}
