/**
 * Execution context and variable scopes.
 *
 * Scopes: local (one function/loop body, a stack), flow (variables for one
 * execution), and input (read-only flow input). "$" paths resolve against
 * the merge: input < flow variables < innermost local scope.
 */

import type { LogicEngine } from "../engine.ts";
import type { ExecutionTracer } from "../trace/tracer.ts";

export interface ExecutionContext {
  executionId: string;
  projectId?: string;
  flowId?: string;

  input: Record<string, unknown>;
  variables: Record<string, unknown>;

  user?: Record<string, unknown>;
  environment: Record<string, unknown>;

  metadata: {
    startedAt: number;
    correlationId?: string;
    parentExecutionId?: string;
  };

  signal?: AbortSignal;

  /** Remaining node-execution budget (loop/recursion protection). */
  nodeBudget: number;

  /** Class instance bound to the current method call, if any. */
  instance?: unknown;

  /** Current foreach item, exposed to expressions as "@". */
  current?: unknown;

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
      nodeBudget: opts.nodeBudget ?? 10000,
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
   * Set a flow-level variable. Loop-local bindings (foreach `as`/`index`,
   * catch `error`) are written directly into the pushed scope instead.
   */
  set(ctx: ExecutionContext, name: string, value: unknown): void {
    ctx.variables[name] = value;
  }

  /** Set a variable in the innermost local scope (loop body / catch block). */
  setLocal(ctx: ExecutionContext, name: string, value: unknown): void {
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

  /** Merged root for "$" path resolution. */
  data(ctx: ExecutionContext): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...ctx.input, ...ctx.variables };
    for (const scope of ctx.scopes) Object.assign(merged, scope);
    return merged;
  }

  dispose(ctx: ExecutionContext): void {
    ctx.scopes.length = 0;
    ctx.variables = {};
  }
}
