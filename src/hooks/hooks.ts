/**
 * Hook engine: JSON-defined lifecycle/event hooks. dispatch() runs matching
 * handlers SEQUENTIALLY in declared order (parallel execution is rejected at
 * load time in v0.x — sharing one execution context across concurrent handlers
 * would be a data race; audit F3). Distinct from React hooks — the Expo
 * adapter exposes these through actual React hooks.
 */

import { normalizeError, VdsError, ErrorCodes } from "../errors.ts";
import { assertValidDefinition } from "../spec/validate.ts";
import { evaluate } from "../logic/evaluate.ts";
import type { HookSpec, HookHandler } from "../spec/types.ts";
import type { ExecutionContext } from "../context/context.ts";
import type { LogicEngine } from "../engine.ts";

export interface HandlerResult {
  hook: string;
  index: number;
  ok: boolean;
  value?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

export class HookEngine {
  private hooks: HookSpec[] = [];
  private engine: LogicEngine;

  constructor(engine: LogicEngine) {
    this.engine = engine;
  }

  register(def: HookSpec): void {
    assertValidDefinition(def);
    if (this.hooks.some((h) => h.id === def.id)) {
      throw new VdsError(ErrorCodes.SPEC_INVALID, `Duplicate hook id "${def.id}"`);
    }
    this.hooks.push(def);
  }

  list(): HookSpec[] {
    return [...this.hooks];
  }

  /** Hooks whose trigger matches the event (exact or "*"), ordered by `order`. */
  matching(event: string): HookSpec[] {
    return this.hooks
      .filter((h) => h.definition.trigger.event === event || h.definition.trigger.event === "*")
      .sort((a, b) => (a.definition.order ?? 0) - (b.definition.order ?? 0));
  }

  async dispatch(event: string, payload: unknown, ctx?: ExecutionContext): Promise<HandlerResult[]> {
    const hooks = this.matching(event);
    const results: HandlerResult[] = [];
    for (const hook of hooks) {
      const stopOnError = hook.definition.execution?.stopOnError ?? true;
      const handlers = hook.definition.handlers;
      const runOne = async (handler: HookHandler, index: number): Promise<HandlerResult> => {
        const base: HandlerResult = { hook: hook.id, index, ok: false };
        try {
          const value = await this.runHandler(hook.id, handler, event, payload, ctx);
          return { ...base, ok: true, value };
        } catch (e) {
          const err = normalizeError(e);
          return {
            ...base,
            ok: false,
            error: { code: err.code, message: err.message, details: err.details },
          };
        }
      };
      // Sequential only, in declared order — deterministic aggregation.
      const batch: HandlerResult[] = [];
      for (let i = 0; i < handlers.length; i++) {
        const r = await runOne(handlers[i]!, i);
        batch.push(r);
        if (!r.ok && stopOnError) {
          results.push(...batch);
          throw new VdsError(r.error!.code, r.error!.message, {
            ...(r.error!.details as object | undefined),
            hook: hook.id,
            handlerIndex: i,
          });
        }
      }
      results.push(...batch);
    }
    return results;
  }

  private async runHandler(
    hookId: string,
    handler: HookHandler,
    event: string,
    payload: unknown,
    ctx?: ExecutionContext,
  ): Promise<unknown> {
    const engine = this.engine;
    const envData: Record<string, unknown> = {
      event,
      payload: payload as Record<string, unknown>,
      ...(ctx ? engine.contextManager.data(ctx) : {}),
    };
    let args: Record<string, unknown>;
    if (handler.args) {
      args = {};
      for (const k of Object.keys(handler.args)) {
        args[k] = evaluate(handler.args[k], { data: envData, engine, ctx });
      }
    } else {
      args = (payload !== null && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : { value: payload }) as Record<string, unknown>;
    }
    switch (handler.type) {
      case "function": {
        if (!handler.ref) throw new VdsError(ErrorCodes.REF_NOT_FOUND, `hook ${hookId}: missing ref`);
        return engine.callFunctionData(handler.ref, args, ctx);
      }
      case "flow": {
        if (!handler.ref) throw new VdsError(ErrorCodes.REF_NOT_FOUND, `hook ${hookId}: missing ref`);
        let input: Record<string, unknown>;
        if (handler.input !== undefined) {
          const v = evaluate(handler.input, { data: envData, engine, ctx });
          input =
            v !== null && typeof v === "object" && !Array.isArray(v)
              ? (v as Record<string, unknown>)
              : { value: v };
        } else {
          input = { event, payload, ...args };
        }
        const res = await engine.executeFlow(handler.ref, {
          input,
          signal: ctx?.signal,
          parentExecutionId: ctx?.executionId,
          budget: ctx?.budget, // shared budget: event-driven recursion is bounded
          user: ctx?.user,
          environment: ctx?.environment,
        });
        if (!res.success) throw new VdsError(res.error!.code, res.error!.message, res.error!.details);
        return res.data;
      }
      case "method": {
        if (!handler.class || !handler.method) {
          throw new VdsError(ErrorCodes.REF_NOT_FOUND, `hook ${hookId}: method handler needs class+method`);
        }
        return engine.callMethodData(handler.class, handler.method, args, ctx);
      }
      default:
        throw new VdsError(ErrorCodes.SPEC_INVALID, `hook ${hookId}: unknown handler type`);
    }
  }
}
