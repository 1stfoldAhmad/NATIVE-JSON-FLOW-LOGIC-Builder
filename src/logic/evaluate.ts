/**
 * Synchronous, side-effect-free expression evaluator.
 *
 *  - literals (number/string/boolean/null) evaluate to themselves
 *  - strings starting with "$" / "@" are data path references
 *  - arrays evaluate element-wise
 *  - plain objects evaluate value-wise (dynamic object construction)
 *  - objects with a string "operator" key dispatch to the operator registry
 */

import type { LogicEngine } from "../engine.ts";
import type { ExecutionContext } from "../context/context.ts";
import { resolvePath } from "./paths.ts";
import { applyOperator } from "./operators.ts";

export interface EvalEnv {
  /** Root data for "$" paths. */
  data: unknown;
  /** Current item for "@" paths (map/filter/foreach bodies). */
  current?: unknown;
  /** Accumulator for reduce(). */
  acc?: unknown;
  engine?: LogicEngine;
  ctx?: ExecutionContext;
  /** Raw (unevaluated) operator arguments, used by map/filter/reduce. */
  rawArgs?: unknown[];
}

export function evaluate(expr: unknown, env: EvalEnv): unknown {
  if (typeof expr === "string") {
    if (expr === "@acc") return env.acc;
    if (expr.startsWith("$") || expr.startsWith("@")) {
      const r = resolvePath(env.data, expr, env.current);
      return r.found ? r.value : undefined;
    }
    return expr;
  }
  if (Array.isArray(expr)) {
    return expr.map((e) => evaluate(e, env));
  }
  if (expr !== null && typeof expr === "object") {
    const obj = expr as Record<string, unknown>;
    if (typeof obj.operator === "string") {
      return applyOperator(obj.operator, obj, env);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = evaluate(obj[k], env);
    return out;
  }
  return expr;
}
