/**
 * Execution context and variable scopes.
 *
 * Scopes: input (read-only flow input), flow variables (one execution),
 * local scopes (loop bodies / catch blocks, a stack). "$" paths resolve
 * against the merged data plus explicit namespaces:
 *   $.input  $.variables  $.user  $.environment  $.state  $.event
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { isDangerousSegment } from "../logic/paths.ts";
import type { LogicEngine } from "../engine.ts";
import type { ExecutionTracer } from "../trace/tracer.ts";
import type { ClassInstance } from "../classes/registry.ts";

/** Shared execution budget — propagated to nested flows and event-driven hooks. */
export interface ExecutionBudget {
  remaining: number;
}

export interface ExecutionContext {
  executionId: string;
  projectId?: string;
  flowId?: string;

  input: Record<string, unknown>;
  variables: Record<string, unknown>;

  user?: Record<string, unknown>;
  environment: Record<string, unknown>;

  /** Event currently being dispatched (namespace $.event), if any. */
  event?: string;

  metadata: {
    startedAt: number;
    correlationId?: string;
    parentExecutionId?: string;
  };

  signal?: AbortSignal;

  /** Shared node-execution budget (loop/recursion/event-recursion protection). */
  budget: ExecutionBudget;

  /**
   * This execution's own node limit (from the flow definition) and how many
   * nodes it has spent. The strictest of { shared budget, local limit } wins.
   */
  localNodeLimit: number;
  localSpent: number;

  /** Class instance bound to the current method call, if any. */
  instance?: unknown;

  /** Current foreach item, exposed to expressions as "@". */
  current?: unknown;

  /** Execution-scoped class instances (lifetime "execution"), disposed with the context. */
  instances: Map<string, ClassInstance>;

  engine: LogicEngine;
  tracer?: ExecutionTracer;

  /** Stack of local scopes; the last one is the innermost. */
  scopes: Record<string, unknown>[];
}

export interface CreateContextOptions {
  executionId: string;
  projectId?: string;
  flowId?: string;
  input?: Record<string, unknown>;
  user?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  signal?: AbortSignal;
  parentExecutionId?: string;
  correlationId?: string;
  nodeBudget?: number;
  budget?: ExecutionBudget;
  engine: LogicEngine;
  tracer?: ExecutionTracer;
}

export class ContextManager {
  create(opts: CreateContextOptions): ExecutionContext {
    return {
      executionId: opts.executionId,
      ...(opts.projectId !== undefined ? { projectId: opts.projectId } : {}),
      ...(opts.flowId !== undefined ? { flowId: opts.flowId } : {}),
      input: opts.input ?? {},
      variables: {},
      ...(opts.user !== undefined ? { user: opts.user } : {}),
      environment: opts.environment ?? {},
      metadata: {
        startedAt: Date.now(),
        ...(opts.correlationId !== undefined ? { correlationId: opts.correlationId } : {}),
        ...(opts.parentExecutionId !== undefined ? { parentExecutionId: opts.parentExecutionId } : {}),
      },
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
      budget: opts.budget ?? { remaining: opts.nodeBudget ?? 10000 },
      localNodeLimit: opts.nodeBudget ?? 10000,
      localSpent: 0,
      instances: new Map(),
      engine: opts.engine,
      ...(opts.tracer !== undefined ? { tracer: opts.tracer } : {}),
      scopes: [],
    };
  }

  pushScope(ctx: ExecutionContext): void {
    ctx.scopes.push({});
  }

  popScope(ctx: ExecutionContext): void {
    ctx.scopes.pop();
  }

  /**
   * Set a flow-level variable (visible for the rest of the execution,
   * including after loops). Loop-local bindings use setLocal() instead.
   */
  set(ctx: ExecutionContext, name: string, value: unknown): void {
    // `obj["__proto__"] = v` would mutate the prototype — refuse dangerous names.
    if (isDangerousSegment(name)) {
      throw new VdsError(ErrorCodes.SPEC_INVALID, `Refusing to set dangerous variable name "${name}"`);
    }
    ctx.variables[name] = value;
  }

  /** Set a variable in the innermost local scope (loop body / catch block). */
  setLocal(ctx: ExecutionContext, name: string, value: unknown): void {
    if (isDangerousSegment(name)) {
      throw new VdsError(ErrorCodes.SPEC_INVALID, `Refusing to set dangerous variable name "${name}"`);
    }
    if (ctx.scopes.length > 0) {
      ctx.scopes[ctx.scopes.length - 1]![name] = value;
    } else {
      ctx.variables[name] = value;
    }
  }

  get(ctx: ExecutionContext, name: string): unknown {
    for (let i = ctx.scopes.length - 1; i >= 0; i--) {
      if (name in ctx.scopes[i]!) return ctx.scopes[i]![name];
    }
    if (name in ctx.variables) return ctx.variables[name];
    if (name in ctx.input) return ctx.input[name];
    return undefined;
  }

  /**
   * Merged root for "$" path resolution: input < flow variables < local
   * scopes, plus explicit namespaces ($.input, $.variables, $.user,
   * $.environment, $.state, $.event).
   */
  data(ctx: ExecutionContext): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...ctx.input, ...ctx.variables };
    for (const scope of ctx.scopes) Object.assign(merged, scope);
    merged.input = ctx.input;
    merged.variables = ctx.variables;
    if (ctx.user !== undefined) merged.user = ctx.user;
    merged.environment = ctx.environment;
    merged.state = ctx.engine.state.get() as Record<string, unknown>;
    if (ctx.event !== undefined) merged.event = ctx.event;
    return merged;
  }

  dispose(ctx: ExecutionContext): void {
    ctx.scopes.length = 0;
    ctx.variables = {};
    ctx.instances.clear();
  }
}
