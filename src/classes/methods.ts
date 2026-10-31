/**
 * Method executor: invokes a class method, which delegates to a function or
 * a flow — methods never duplicate business logic themselves.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { validateParams } from "../spec/params.ts";
import type { ClassRegistry } from "./registry.ts";
import type { FunctionExecutor } from "../functions/executor.ts";
import type { ExecutionContext } from "../context/context.ts";
import type { LogicEngine } from "../engine.ts";

export class MethodExecutor {
  private classes: ClassRegistry;
  private functions: FunctionExecutor;
  private engine: LogicEngine;

  constructor(classes: ClassRegistry, functions: FunctionExecutor, engine: LogicEngine) {
    this.classes = classes;
    this.functions = functions;
    this.engine = engine;
  }

  /** Invoke class method; returns the RAW return value. */
  async invoke(
    classId: string,
    methodName: string,
    args: Record<string, unknown>,
    ctx: ExecutionContext,
  ): Promise<unknown> {
    const cls = this.classes.get(classId);
    const method = (cls.definition.methods ?? []).find((m) => m.name === methodName);
    if (!method) {
      throw new VdsError(
        ErrorCodes.REF_NOT_FOUND,
        `Class "${classId}" has no method "${methodName}"`,
        { class: classId, method: methodName },
      );
    }
    const instance = await this.classes.createInstance(classId, this.engine);
    const normalized = validateParams(method.parameters ?? [], args, `method ${classId}.${methodName}`);
    ctx.tracer?.record({
      executionId: ctx.executionId,
      kind: "method",
      ref: `${classId}.${methodName}`,
      details: { phase: "start" },
    });
    try {
      let result: unknown;
      if (method.function) {
        result = await this.functions.call(method.function, normalized, ctx, instance);
      } else if (method.flow) {
        const res = await this.engine.executeFlow(method.flow, {
          input: normalized,
          signal: ctx.signal,
          parentExecutionId: ctx.executionId,
        });
        if (!res.success) {
          throw new VdsError(res.error!.code, res.error!.message, res.error!.details);
        }
        result = res.data;
      } else {
        throw new VdsError(
          ErrorCodes.SPEC_INVALID,
          `Method ${classId}.${methodName} references neither a function nor a flow`,
        );
      }
      ctx.tracer?.record({
        executionId: ctx.executionId,
        kind: "method",
        ref: `${classId}.${methodName}`,
        details: { phase: "end" },
      });
      return result;
    } catch (e) {
      ctx.tracer?.record({
        executionId: ctx.executionId,
        kind: "error",
        ref: `${classId}.${methodName}`,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}
