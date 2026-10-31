/**
 * Function executor: validates arguments, then runs the function by kind —
 * declarative expression (pure/transform/validator/predicate), registered
 * native implementation (native/async), or a referenced flow (flow-backed).
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { validateParams } from "../spec/params.ts";
import { evaluate } from "../logic/evaluate.ts";
import type { FunctionRegistry } from "./registry.ts";
import type { ExecutionContext } from "../context/context.ts";
import type { FunctionSpec } from "../spec/types.ts";
import type { LogicEngine } from "../engine.ts";

export class FunctionExecutor {
  private registry: FunctionRegistry;
  private engine: LogicEngine;

  constructor(registry: FunctionRegistry, engine: LogicEngine) {
    this.registry = registry;
    this.engine = engine;
  }

  resolve(ref: string): FunctionSpec {
    return this.registry.get(ref);
  }

  /** Call a function by id (or def) and return the RAW value (not wrapped). */
  async call(
    ref: string | FunctionSpec,
    args: Record<string, unknown>,
    ctx: ExecutionContext,
    instance?: unknown,
  ): Promise<unknown> {
    const def = typeof ref === "string" ? this.registry.get(ref) : ref;
    // Runtime policy: execution-target compatibility.
    this.engine.assertTargetAllowed(def);
    const d = def.definition;
    const params = d.parameters ?? def.inputs ?? [];
    const normalized = validateParams(params, args, `function ${def.id}`);
    ctx.tracer?.record({
      executionId: ctx.executionId,
      kind: "function",
      ref: def.id,
      details: { phase: "start" },
    });
    try {
      let result: unknown;
      switch (d.kind) {
        case "pure":
        case "transform":
        case "validator":
        case "predicate": {
          if (d.expression === undefined) {
            throw new VdsError(ErrorCodes.SPEC_INVALID, `function ${def.id} has no expression`);
          }
          // Pure functions evaluate against their arguments only.
          result = evaluate(d.expression, { data: normalized, engine: this.engine, ctx });
          break;
        }
        case "native":
        case "async": {
          if (!d.native) {
            throw new VdsError(ErrorCodes.SPEC_INVALID, `function ${def.id} has no native name`);
          }
          const reg = this.registry.getNative(d.native);
          // Capability gate: every capability the definition requires must be
          // granted by the native registration or by the engine policy.
          const required = def.execution?.capabilities ?? [];
          const missing = required.filter(
            (cap) =>
              !reg.capabilities.has(cap) &&
              !reg.capabilities.has("*") &&
              !this.engine.isCapabilityGranted(cap),
          );
          if (missing.length > 0) {
            throw new VdsError(
              ErrorCodes.NOT_ALLOWED,
              `function ${def.id} requires capabilities not granted in this runtime: ${missing.join(", ")}`,
              { ref: def.id, missing, environment: this.engine.environment },
            );
          }
          result = await reg.impl(
            normalized,
            instance !== undefined ? { ...ctx, instance } : ctx,
            instance,
          );
          break;
        }
        case "flow": {
          if (!d.flow) {
            throw new VdsError(ErrorCodes.SPEC_INVALID, `function ${def.id} has no flow ref`);
          }
          const res = await this.engine.executeFlow(d.flow, {
            input: normalized,
            signal: ctx.signal,
            parentExecutionId: ctx.executionId,
          });
          if (!res.success) {
            throw new VdsError(res.error!.code, res.error!.message, res.error!.details);
          }
          result = res.data;
          break;
        }
        default:
          throw new VdsError(ErrorCodes.SPEC_INVALID, `function ${def.id} has unknown kind "${d.kind}"`);
      }
      // Return type check (when declared).
      const ret = d.return ?? def.outputs?.[0];
      if (ret && result !== null && result !== undefined) {
        const { checkType, typeOf } = await import("../spec/check.ts");
        if (!checkType(result, ret.type, ret.nullable ?? false)) {
          throw new VdsError(
            ErrorCodes.TYPE_MISMATCH,
            `function ${def.id} returned ${typeOf(result)} but declared ${ret.type}`,
            { ref: def.id, expected: ret.type, actual: typeOf(result), value: result },
          );
        }
      }
      ctx.tracer?.record({
        executionId: ctx.executionId,
        kind: "function",
        ref: def.id,
        details: { phase: "end" },
      });
      return result;
    } catch (e) {
      ctx.tracer?.record({
        executionId: ctx.executionId,
        kind: "error",
        ref: def.id,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }
}
