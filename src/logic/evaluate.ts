/**
 * Synchronous, side-effect-free expression evaluator.
 *
 *  - literals (number/string/boolean/null) evaluate to themselves
 *  - strings starting with "$" / "@" are data path references
 *  - arrays evaluate element-wise
 *  - plain objects evaluate value-wise (dynamic object construction)
 *  - objects with a string "operator" key dispatch to the operator registry
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import type { LogicEngine } from "../engine.ts";
import type { EvaluationBudget, ExecutionContext } from "../context/context.ts";
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
  /** Expression resource budget (audit F6), shared per execution. */
  budget?: EvaluationBudget;
  /** Current expression nesting depth (internal). */
  depth?: number;
}

function spendBudget(env: EvalEnv, depth: number): void {
  const b = env.budget;
  if (!b) return;
  if (depth > b.maxDepth) {
    throw new VdsError(ErrorCodes.EVAL_LIMIT, `expression depth limit ${b.maxDepth} exceeded`, {
      maxDepth: b.maxDepth,
    });
  }
  b.remainingNodes -= 1;
  if (b.remainingNodes < 0) {
    throw new VdsError(ErrorCodes.EVAL_LIMIT, `expression node budget of ${b.maxNodes} exceeded`, {
      maxNodes: b.maxNodes,
    });
  }
}

export function evaluate(expr: unknown, env: EvalEnv): unknown {
  const depth = env.depth ?? 0;
  spendBudget(env, depth);
  const child = { ...env, depth: depth + 1 };
  if (typeof expr === "string") {
    if (expr === "@acc") return env.acc;
    if (expr.startsWith("$") || expr.startsWith("@")) {
      const r = resolvePath(env.data, expr, env.current);
      return r.found ? r.value : undefined;
    }
    return expr;
  }
  if (Array.isArray(expr)) {
    return expr.map((e) => evaluate(e, child));
  }
  if (expr !== null && typeof expr === "object") {
    const obj = expr as Record<string, unknown>;
    if (typeof obj.operator === "string") {
      const result = applyOperator(obj.operator, obj, child);
      const b = env.budget;
      if (b && typeof result === "string" && result.length > b.maxStringLength) {
        throw new VdsError(ErrorCodes.EVAL_LIMIT, `string result exceeds maxStringLength ${b.maxStringLength}`, {
          length: result.length,
          maxStringLength: b.maxStringLength,
        });
      }
      return result;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = evaluate(obj[k], child);
    return out;
  }
  return expr;
}
