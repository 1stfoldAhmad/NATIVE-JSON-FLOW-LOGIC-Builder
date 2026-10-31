/**
 * Flow engine — the execution backbone. Executes compiled flow IR
 * (src/flows/compiler.ts): pre-resolved node links, branching (if/switch),
 * bounded iteration (foreach with proper scoping), function/method/subflow
 * calls, events, error handling (try/catch, onError), cancellation
 * (AbortSignal), timeouts and a SHARED execution budget for nested/event-
 * driven executions.
 */

import { ErrorCodes, VdsError, normalizeError, isVdsError } from "../errors.ts";
import { evaluate } from "../logic/evaluate.ts";
import { validateParams, deepEqual } from "../spec/params.ts";
import { checkType, typeOf } from "../spec/check.ts";
import { fail, ok } from "../result.ts";
import type { ExecutionResult } from "../result.ts";
import type { FlowSpec } from "../spec/types.ts";
import type { ExecutionContext, ExecutionBudget } from "../context/context.ts";
import type { LogicEngine } from "../engine.ts";
import type { CompiledNode } from "./compiler.ts";

export interface ExecuteFlowOptions {
  input?: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  parentExecutionId?: string;
  user?: Record<string, unknown>;
  environment?: Record<string, unknown>;
  executionId?: string;
  trace?: boolean;
  /** Shared execution budget (used for nested flows / event-driven handlers). */
  budget?: ExecutionBudget;
}

type FlowOutcome = { kind: "continue" } | { kind: "return"; value: unknown };

type Step = { action: "next"; node?: CompiledNode } | { action: "return"; value: unknown };

const DEFAULT_MAX_ITERATIONS = 1000;
const DEFAULT_NODE_BUDGET = 10000;

export class FlowEngine {
  private engine: LogicEngine;

  constructor(engine: LogicEngine) {
    this.engine = engine;
  }

  async execute(flowId: string, opts: ExecuteFlowOptions = {}): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const executionId = opts.executionId ?? this.engine.newExecutionId();
    const cm = this.engine.contextManager;

    // ---- cancellation + timeout ----
    const ac = new AbortController();
    if (opts.signal) {
      if (opts.signal.aborted) ac.abort(opts.signal.reason);
      else opts.signal.addEventListener("abort", () => ac.abort(opts.signal!.reason), { once: true });
    }

    let flow: FlowSpec | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctx: ExecutionContext | undefined;
    try {
      // ---- resolve flow, enforce target, validate input before any node runs ----
      flow = this.engine.getFlowDef(flowId);
      this.engine.assertTargetAllowed(flow);
      const input = (opts.input ?? {}) as Record<string, unknown>;
      if (flow.definition.parameters) {
        validateParams(flow.definition.parameters, input, `flow ${flowId} input`);
      }
      const timeoutMs = opts.timeoutMs ?? flow.definition.limits?.timeoutMs;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timer = setTimeout(
          () =>
            ac.abort(
              new VdsError(ErrorCodes.EXEC_TIMEOUT, `Flow "${flowId}" timed out after ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }
      // Shared budget: nested flows (callFlow) and event handlers inherit it.
      const budget: ExecutionBudget =
        opts.budget ?? { remaining: flow.definition.limits?.maxNodeExecutions ?? DEFAULT_NODE_BUDGET };
      ctx = cm.create({
        executionId,
        flowId,
        input,
        user: opts.user,
        environment: opts.environment,
        signal: ac.signal,
        parentExecutionId: opts.parentExecutionId,
        budget,
        // F-08: a flow's own maxNodeExecutions is a LOCAL limit; the strictest
        // of the shared inherited budget and this local limit is enforced.
        nodeBudget: flow.definition.limits?.maxNodeExecutions ?? DEFAULT_NODE_BUDGET,
        engine: this.engine,
        tracer: this.engine.tracer.enabled || opts.trace ? this.engine.tracer : undefined,
      });

      this.engine.notifyExecution({ executionId, flowId, status: "running" });
      this.engine.tracer.record({ executionId, kind: "flow.start", ref: flowId });
      const compiled = this.engine.getCompiledFlow(flowId);
      const outcome = await this.runNodes([compiled.start], ctx, compiled);
      const data = outcome.kind === "return" ? outcome.value : undefined;
      const ret = flow.definition.returns;
      if (ret && data !== null && data !== undefined && !checkType(data, ret.type, ret.nullable ?? false)) {
        throw new VdsError(
          ErrorCodes.TYPE_MISMATCH,
          `flow ${flowId} returned ${typeOf(data)} but declared ${ret.type}`,
          { expected: ret.type, actual: typeOf(data), value: data },
        );
      }
      const result = ok(data, executionId, Date.now() - startedAt);
      this.engine.tracer.record({ executionId, kind: "flow.finish", ref: flowId });
      this.engine.notifyExecution({ executionId, flowId, status: "completed", result });
      return result;
    } catch (e) {
      // If the abort signal fired, report cancellation/timeout rather than
      // whatever error the interrupted operation happened to raise.
      let err = normalizeError(e);
      if (ac.signal.aborted) {
        err = isVdsError(ac.signal.reason)
          ? ac.signal.reason
          : new VdsError(ErrorCodes.EXEC_CANCELLED, "Execution cancelled", {
              reason:
                ac.signal.reason instanceof Error
                  ? ac.signal.reason.message
                  : String(ac.signal.reason ?? ""),
            });
      }
      // flow-level onError handlers run with `error` in scope; their own
      // failures are traced but never mask the original error.
      if (flow && ctx && flow.definition.onError && flow.definition.onError.length > 0) {
        try {
          const compiled = this.engine.getCompiledFlow(flowId);
          cm.pushScope(ctx);
          cm.setLocal(ctx, "error", { code: err.code, message: err.message, details: err.details });
          await this.runNodes(compiled.onError ?? [], ctx, compiled);
        } catch (handlerErr) {
          this.engine.tracer.record({
            executionId,
            kind: "error",
            ref: `${flowId}#onError`,
            error: handlerErr instanceof Error ? handlerErr.message : String(handlerErr),
          });
        } finally {
          cm.popScope(ctx);
        }
      }
      const result = fail(
        { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) },
        executionId,
        Date.now() - startedAt,
      );
      this.engine.tracer.record({
        executionId,
        kind: "flow.finish",
        ref: flowId,
        error: `${err.code}: ${err.message}`,
      });
      this.engine.notifyExecution({ executionId, flowId, status: "failed", result });
      return result;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (ctx) {
        // dispose execution-scoped class instances
        for (const instance of ctx.instances.values()) this.engine.disposeInstance(instance);
        cm.dispose(ctx);
      }
    }
  }

  // ------------------------------------------------------------------

  private env(ctx: ExecutionContext) {
    return {
      data: this.engine.contextManager.data(ctx),
      engine: this.engine,
      ctx,
      current: ctx.current,
    };
  }

  private throwIfCancelled(ctx: ExecutionContext): void {
    if (ctx.signal?.aborted) {
      const reason = ctx.signal.reason;
      if (isVdsError(reason)) throw reason;
      throw new VdsError(ErrorCodes.EXEC_CANCELLED, "Execution cancelled", {
        reason: reason instanceof Error ? reason.message : String(reason ?? ""),
      });
    }
  }

  private spendBudget(ctx: ExecutionContext): void {
    // Shared (inherited) budget across the whole execution tree...
    ctx.budget.remaining -= 1;
    // ...and this execution's own local limit — the strictest one wins.
    ctx.localSpent += 1;
    if (ctx.budget.remaining < 0 || ctx.localSpent > ctx.localNodeLimit) {
      throw new VdsError(ErrorCodes.EXEC_LIMIT, "Flow node execution budget exceeded (possible runaway loop or event recursion)", {
        executionId: ctx.executionId,
        remaining: ctx.budget.remaining,
        localSpent: ctx.localSpent,
        localNodeLimit: ctx.localNodeLimit,
      });
    }
  }

  private async runNodes(nodes: CompiledNode[], ctx: ExecutionContext, flow: { nodes: Map<string, CompiledNode> }): Promise<FlowOutcome> {
    if (nodes.length === 0) return { kind: "continue" };
    let node: CompiledNode | undefined = nodes.find((n) => n.type === "start") ?? nodes[0];
    while (node) {
      this.throwIfCancelled(ctx);
      this.spendBudget(ctx);
      this.engine.tracer.record({
        executionId: ctx.executionId,
        kind: "node",
        nodeId: node.id,
        ref: node.type,
        details: { phase: "start" },
      });
      const step = await this.runNode(node, ctx, flow);
      this.engine.tracer.record({
        executionId: ctx.executionId,
        kind: "node",
        nodeId: node.id,
        details: { phase: "end" },
      });
      if (step.action === "return") return { kind: "return", value: step.value };
      node = step.node;
    }
    return { kind: "continue" };
  }

  private async runNode(
    c: CompiledNode,
    ctx: ExecutionContext,
    flow: { nodes: Map<string, CompiledNode> },
  ): Promise<Step> {
    const cm = this.engine.contextManager;
    const env = this.env(ctx);
    const node = c.node;
    const next = (): Step => ({ action: "next", node: c.next });

    switch (node.type) {
      case "start":
        return next();

      case "return":
      case "end": {
        const value = node.value !== undefined ? evaluate(node.value, env) : undefined;
        return { action: "return", value };
      }

      case "set": {
        for (const [name, expr] of Object.entries(node.assignments)) {
          cm.set(ctx, name, evaluate(expr, env));
        }
        return next();
      }

      case "callFunction": {
        const args = this.evalArgs(node.args, env);
        const value = await this.engine.callFunctionData(node.ref, args, ctx);
        if (node.assign) cm.set(ctx, node.assign, value);
        return next();
      }

      case "callMethod": {
        const args = this.evalArgs(node.args, env);
        const value = await this.engine.callMethodData(node.class, node.method, args, ctx);
        if (node.assign) cm.set(ctx, node.assign, value);
        return next();
      }

      case "if": {
        const cond = Boolean(evaluate(node.condition, env));
        const body = cond ? c.then ?? [] : c.else ?? [];
        const r = await this.runNodes(body, ctx, flow);
        if (r.kind === "return") return { action: "return", value: r.value };
        return next();
      }

      case "switch": {
        // Switch semantics: the switch value is evaluated once and compared
        // (deep equality) against each case's `when` value, in order.
        const value = evaluate(node.value, env);
        let body: CompiledNode[] = c.default ?? [];
        for (const cs of c.cases ?? []) {
          if (deepEqual(value, evaluate(cs.when, env))) {
            body = cs.nodes;
            break;
          }
        }
        const r = await this.runNodes(body, ctx, flow);
        if (r.kind === "return") return { action: "return", value: r.value };
        return next();
      }

      case "foreach": {
        const items = evaluate(node.items, env);
        if (!Array.isArray(items)) {
          throw new VdsError(ErrorCodes.FLOW_ERROR, `foreach node "${node.id}": items must be an array`, {
            value: items,
          });
        }
        const max = node.maxIterations ?? DEFAULT_MAX_ITERATIONS;
        if (items.length > max) {
          throw new VdsError(
            ErrorCodes.EXEC_LIMIT,
            `foreach node "${node.id}" exceeded maxIterations (${max})`,
            { count: items.length, maxIterations: max },
          );
        }
        cm.pushScope(ctx);
        const prevCurrent = ctx.current; // save/restore for nested loops
        try {
          for (let i = 0; i < items.length; i++) {
            this.throwIfCancelled(ctx);
            this.spendBudget(ctx);
            cm.setLocal(ctx, node.as, items[i]);
            cm.setLocal(ctx, "index", i);
            ctx.current = items[i]; // enables "@" inside the loop body
            const r = await this.runNodes(c.body ?? [], ctx, flow);
            if (r.kind === "return") return { action: "return", value: r.value };
          }
        } finally {
          ctx.current = prevCurrent;
          cm.popScope(ctx);
        }
        return next();
      }

      case "emit": {
        this.engine.tracer.record({
          executionId: ctx.executionId,
          kind: "event",
          ref: node.event,
        });
        // $.event is visible while the payload is evaluated and dispatched
        const prevEvent = ctx.event;
        ctx.event = node.event;
        try {
          const payload = node.payload !== undefined ? evaluate(node.payload, this.env(ctx)) : {};
          await this.engine.dispatch(node.event, payload, ctx);
        } finally {
          ctx.event = prevEvent;
        }
        return next();
      }

      case "callFlow": {
        const rawInput = node.input !== undefined ? evaluate(node.input, env) : {};
        const subInput =
          rawInput !== null && typeof rawInput === "object" && !Array.isArray(rawInput)
            ? (rawInput as Record<string, unknown>)
            : { value: rawInput };
        const res = await this.engine.executeFlow(node.ref, {
          input: subInput,
          signal: ctx.signal,
          parentExecutionId: ctx.executionId,
          budget: ctx.budget, // shared budget across the execution tree
          // F-04: inherit explicitly permitted context namespaces
          user: ctx.user,
          environment: ctx.environment,
        });
        if (!res.success) {
          throw new VdsError(res.error!.code, res.error!.message, res.error!.details);
        }
        if (node.assign) cm.set(ctx, node.assign, res.data);
        return next();
      }

      case "try": {
        try {
          const r = await this.runNodes(c.body ?? [], ctx, flow);
          if (r.kind === "return") return { action: "return", value: r.value };
        } catch (e) {
          const err = normalizeError(e);
          if (!c.catch || c.catch.length === 0) throw err;
          cm.pushScope(ctx);
          try {
            cm.setLocal(ctx, "error", { code: err.code, message: err.message, details: err.details });
            const r = await this.runNodes(c.catch, ctx, flow);
            if (r.kind === "return") return { action: "return", value: r.value };
          } finally {
            cm.popScope(ctx);
          }
        }
        return next();
      }

      case "throw": {
        const ev = evaluate(node.error, env);
        if (ev !== null && typeof ev === "object" && !Array.isArray(ev)) {
          const o = ev as Record<string, unknown>;
          if (typeof o.code === "string") {
            throw new VdsError(
              o.code,
              typeof o.message === "string" ? o.message : "Flow threw an error",
              o.details,
            );
          }
        }
        throw new VdsError(ErrorCodes.FLOW_ERROR, `throw node "${node.id}" requires an error object`, {
          value: ev,
        });
      }

      case "delay": {
        const ms = typeof node.ms === "number" ? node.ms : Number(evaluate(node.ms, env));
        if (!Number.isFinite(ms) || ms < 0) {
          throw new VdsError(ErrorCodes.FLOW_ERROR, `delay node "${node.id}": invalid ms`, { ms });
        }
        await sleep(ms, ctx.signal);
        return next();
      }

      default: {
        const exhaustive: never = node;
        throw new VdsError(
          ErrorCodes.SPEC_INVALID,
          `Unknown node type "${String((exhaustive as { type: string }).type)}"`,
        );
      }
    }
  }

  private evalArgs(
    args: Record<string, unknown> | undefined,
    env: ReturnType<FlowEngine["env"]>,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args ?? {})) out[k] = evaluate(v, env);
    return out;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(
        isVdsError(signal.reason)
          ? signal.reason
          : new VdsError(ErrorCodes.EXEC_CANCELLED, "Execution cancelled"),
      );
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(
        isVdsError(signal!.reason)
          ? signal!.reason
          : new VdsError(ErrorCodes.EXEC_CANCELLED, "Execution cancelled"),
      );
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
