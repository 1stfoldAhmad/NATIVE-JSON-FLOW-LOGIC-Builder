/**
 * Controlled expression operator set. No eval, no arbitrary code: every
 * operator is an explicit, pure implementation registered here.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { deepEqual } from "../spec/params.ts";
import { resolvePath } from "./paths.ts";
import { isSafePattern } from "./regex-safety.ts";
import { evaluate } from "./evaluate.ts";
import type { EvalEnv } from "./evaluate.ts";

export interface OpContext {
  env: EvalEnv;
  argCount: number;
  /** Evaluate raw argument i lazily (for short-circuiting operators). */
  evalArg: (i: number) => unknown;
}

export type OperatorImpl = (ctx: OpContext) => unknown;

function fail(message: string, details?: unknown): never {
  throw new VdsError(ErrorCodes.EXPR_ERROR, message, details);
}

function num(ctx: OpContext, i: number): number {
  const v = ctx.evalArg(i);
  if (typeof v !== "number" || Number.isNaN(v)) {
    fail(`operator expected a number at argument ${i}, got ${typeof v}`, { value: v });
  }
  return v;
}

function str(ctx: OpContext, i: number): string {
  const v = ctx.evalArg(i);
  if (typeof v !== "string") {
    fail(`operator expected a string at argument ${i}, got ${typeof v}`, { value: v });
  }
  return v;
}

function arr(ctx: OpContext, i: number): unknown[] {
  const v = ctx.evalArg(i);
  if (!Array.isArray(v)) {
    fail(`operator expected an array at argument ${i}, got ${typeof v}`, { value: v });
  }
  // Audit F6: collection-processing operators are bounded by the evaluation budget.
  const b = ctx.env.budget;
  if (b && v.length > b.maxCollectionItems) {
    throw new VdsError(ErrorCodes.EVAL_LIMIT, `collection of ${v.length} items exceeds maxCollectionItems ${b.maxCollectionItems}`, {
      length: v.length,
      maxCollectionItems: b.maxCollectionItems,
    });
  }
  return v;
}

function truthy(v: unknown): boolean {
  return Boolean(v);
}

function numbers(list: unknown[]): number[] {
  return list.map((v) => {
    if (typeof v !== "number" || Number.isNaN(v)) {
      fail("aggregate operator requires numeric values", { value: v });
    }
    return v;
  });
}

function childEnv(env: EvalEnv, patch: Partial<EvalEnv>): EvalEnv {
  return { ...env, ...patch };
}

export const operators: Record<string, OperatorImpl> = {
  // ---- arithmetic ----
  add: (c) => foldNum(c, (a, b) => a + b, 0),
  subtract: (c) => (c.argCount === 1 ? -num(c, 0) : foldNum(c, (a, b) => a - b)),
  multiply: (c) => foldNum(c, (a, b) => a * b, 1),
  divide: (c) => {
    if (c.argCount === 1) {
      const d = num(c, 0);
      if (d === 0) fail("division by zero");
      return 1 / d;
    }
    let acc = num(c, 0);
    for (let i = 1; i < c.argCount; i++) {
      const d = num(c, i);
      if (d === 0) fail("division by zero");
      acc = acc / d;
    }
    return acc;
  },
  modulo: (c) => {
    const b = num(c, 1);
    if (b === 0) fail("modulo by zero");
    return num(c, 0) % b;
  },
  negate: (c) => -num(c, 0),

  // ---- aggregates ----
  sum: (c) => numbers(arr(c, 0)).reduce((a, b) => a + b, 0),
  avg: (c) => {
    const ns = numbers(arr(c, 0));
    if (ns.length === 0) fail("avg of empty array");
    return ns.reduce((a, b) => a + b, 0) / ns.length;
  },
  min: (c) => {
    const ns = numbers(arr(c, 0));
    if (ns.length === 0) fail("min of empty array");
    return Math.min(...ns);
  },
  max: (c) => {
    const ns = numbers(arr(c, 0));
    if (ns.length === 0) fail("max of empty array");
    return Math.max(...ns);
  },
  count: (c) => arr(c, 0).length,

  // ---- comparison ----
  eq: (c) => deepEqual(c.evalArg(0), c.evalArg(1)),
  ne: (c) => !deepEqual(c.evalArg(0), c.evalArg(1)),
  gt: (c) => compare(c, (a, b) => a > b),
  gte: (c) => compare(c, (a, b) => a >= b),
  lt: (c) => compare(c, (a, b) => a < b),
  lte: (c) => compare(c, (a, b) => a <= b),

  // ---- boolean (short-circuit) ----
  and: (c) => {
    for (let i = 0; i < c.argCount; i++) if (!truthy(c.evalArg(i))) return false;
    return true;
  },
  or: (c) => {
    for (let i = 0; i < c.argCount; i++) if (truthy(c.evalArg(i))) return true;
    return false;
  },
  not: (c) => !truthy(c.evalArg(0)),

  // ---- control ----
  if: (c) => (truthy(c.evalArg(0)) ? c.evalArg(1) : c.argCount > 2 ? c.evalArg(2) : null),
  coalesce: (c) => {
    for (let i = 0; i < c.argCount; i++) {
      const v = c.evalArg(i);
      if (v !== null && v !== undefined) return v;
    }
    return null;
  },

  // ---- strings ----
  concat: (c) => {
    let out = "";
    for (let i = 0; i < c.argCount; i++) {
      const v = c.evalArg(i);
      out += v === null || v === undefined ? "" : String(v);
    }
    return out;
  },
  upper: (c) => str(c, 0).toUpperCase(),
  lower: (c) => str(c, 0).toLowerCase(),
  trim: (c) => str(c, 0).trim(),
  length: (c) => {
    const v = c.evalArg(0);
    if (typeof v === "string" || Array.isArray(v)) return v.length;
    fail("length expects a string or array", { value: v });
  },
  includes: (c) => {
    const hay = c.evalArg(0);
    const needle = c.evalArg(1);
    if (typeof hay === "string") return hay.includes(String(needle));
    if (Array.isArray(hay)) return hay.some((x) => deepEqual(x, needle));
    fail("includes expects a string or array", { value: hay });
  },
  startsWith: (c) => str(c, 0).startsWith(str(c, 1)),
  endsWith: (c) => str(c, 0).endsWith(str(c, 1)),
  matches: (c) => {
    const value = str(c, 0);
    const pattern = str(c, 1);
    // ReDoS protection: statically reject unsafe patterns before compiling.
    const verdict = isSafePattern(pattern);
    if (!verdict.safe) {
      fail(`unsafe regex pattern rejected: ${verdict.reason}`, { pattern });
    }
    let re: RegExp;
    try {
      re = new RegExp(pattern);
    } catch {
      fail(`invalid regex pattern "${pattern}"`);
    }
    return re.test(value);
  },
  split: (c) => str(c, 0).split(str(c, 1)),
  join: (c) =>
    arr(c, 0)
      .map((v) => (v === null || v === undefined ? "" : String(v)))
      .join(str(c, 1)),
  replace: (c) => str(c, 0).split(str(c, 1)).join(str(c, 2)),

  // ---- data access / transformation ----
  get: (c) => {
    // The first argument is a raw path string, NOT evaluated as an expression.
    const raw = c.env.rawArgs?.[0];
    const path = typeof raw === "string" ? raw : str(c, 0);
    const r = resolvePath(c.env.data, path, c.env.current);
    if (!r.found) return c.argCount > 1 ? c.evalArg(1) : null;
    return r.value;
  },
  keys: (c) => {
    const v = c.evalArg(0);
    if (typeof v !== "object" || v === null || Array.isArray(v)) fail("keys expects an object", { value: v });
    return Object.keys(v);
  },
  values: (c) => {
    const v = c.evalArg(0);
    if (typeof v !== "object" || v === null || Array.isArray(v)) fail("values expects an object", { value: v });
    return Object.values(v);
  },
  map: (c) =>
    arr(c, 0).map((item) => evaluate(c.env.rawArgs![1], childEnv(c.env, { current: item }))),
  filter: (c) =>
    arr(c, 0).filter((item) =>
      truthy(evaluate(c.env.rawArgs![1], childEnv(c.env, { current: item }))),
    ),
  reduce: (c) => {
    const items = arr(c, 0);
    let acc = c.argCount > 2 ? c.evalArg(2) : null;
    for (const item of items) {
      acc = evaluate(c.env.rawArgs![1], childEnv(c.env, { current: item, acc }));
    }
    return acc;
  },
  find: (c) =>
    arr(c, 0).find((item) =>
      truthy(evaluate(c.env.rawArgs![1], childEnv(c.env, { current: item }))),
    ) ?? null,
  sort: (c) => {
    const items = arr(c, 0).slice();
    const desc = c.argCount > 1 ? truthy(c.evalArg(1)) : false;
    return items.sort((a, b) => {
      if (typeof a === "number" && typeof b === "number") return desc ? b - a : a - b;
      return desc ? String(b).localeCompare(String(a)) : String(a).localeCompare(String(b));
    });
  },

  // ---- type inspection / casting ----
  typeOf: (c) => {
    const v = c.evalArg(0);
    if (v === null) return "null";
    if (Array.isArray(v)) return "array";
    return typeof v;
  },
  isNull: (c) => {
    const v = c.evalArg(0);
    return v === null || v === undefined;
  },
  isArray: (c) => Array.isArray(c.evalArg(0)),
  isObject: (c) => {
    const v = c.evalArg(0);
    return typeof v === "object" && v !== null && !Array.isArray(v);
  },
  isString: (c) => typeof c.evalArg(0) === "string",
  isNumber: (c) => typeof c.evalArg(0) === "number" && !Number.isNaN(c.evalArg(0) as number),
  isBoolean: (c) => typeof c.evalArg(0) === "boolean",
  toNumber: (c) => {
    const v = c.evalArg(0);
    if (typeof v === "number") return v;
    const n = Number(v);
    if (Number.isNaN(n)) fail(`cannot convert to number: ${String(v)}`, { value: v });
    return n;
  },
  toString: (c: OpContext) => {
    const v = c.evalArg(0);
    return v === null || v === undefined ? "" : String(v);
  },
  toBoolean: (c) => truthy(c.evalArg(0)),

  // ---- engine bridge ----
  logic: (c) => {
    const id = str(c, 0);
    const engine = c.env.engine;
    if (!engine) fail('operator "logic" requires an engine context');
    const data = c.argCount > 1 ? c.evalArg(1) : c.env.data;
    return engine.evaluateLogic(id, data);
  },
};

function foldNum(c: OpContext, f: (a: number, b: number) => number, initial?: number): number {
  if (c.argCount === 0) fail("operator requires at least one argument");
  let acc = initial !== undefined ? initial : num(c, 0);
  const start = initial !== undefined ? 0 : 1;
  for (let i = start; i < c.argCount; i++) acc = f(acc, num(c, i));
  return acc;
}

function compare(c: OpContext, f: (a: never, b: never) => boolean): boolean {
  const a = c.evalArg(0);
  const b = c.evalArg(1);
  if (typeof a === "number" && typeof b === "number") return f(a as never, b as never);
  if (typeof a === "string" && typeof b === "string") return f(a as never, b as never);
  fail("comparison requires two numbers or two strings", { a, b });
}

/** Dispatch an operation node `{ operator, arguments?/value? }`. */
export function applyOperator(op: string, node: Record<string, unknown>, env: EvalEnv): unknown {
  // hasOwnProperty guard: "__proto__"/"constructor" must not resolve to Object.prototype
  if (!Object.prototype.hasOwnProperty.call(operators, op)) {
    throw new VdsError(ErrorCodes.EXPR_ERROR, `Unknown operator "${op}"`);
  }
  const fn = operators[op]!;
  const rawArgs: unknown[] = Array.isArray(node.arguments)
    ? node.arguments
    : node.value !== undefined
      ? [node.value]
      : [];
  const ctx: OpContext = {
    env: { ...env, rawArgs },
    argCount: rawArgs.length,
    evalArg: (i: number) => {
      if (i < 0 || i >= rawArgs.length) {
        throw new VdsError(ErrorCodes.EXPR_ERROR, `operator "${op}": argument ${i} out of range`);
      }
      return evaluate(rawArgs[i], env);
    },
  };
  return fn(ctx);
}

export const operatorNames: readonly string[] = Object.keys(operators);
