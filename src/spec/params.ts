/**
 * Parameter validation: required checks, defaults, type checks, enums.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { checkType, typeOf } from "./check.ts";
import type { ParameterDef } from "./types.ts";

/**
 * Validate `args` against parameter definitions. Returns a new args object
 * containing only declared parameters, with defaults applied. Throws VdsError
 * with code PARAM_INVALID (missing/invalid enum) or TYPE_MISMATCH.
 */
export function validateParams(
  params: ParameterDef[] | undefined,
  args: Record<string, unknown>,
  label = "arguments",
): Record<string, unknown> {
  // No declared parameters -> pass arguments through unchanged.
  if (!params || params.length === 0) return { ...args };
  const out: Record<string, unknown> = {};
  for (const p of params) {
    let value = args[p.name];
    if (value === undefined || value === null) {
      if (p.default !== undefined) {
        value = p.default;
      } else if (p.required && !p.nullable) {
        throw new VdsError(
          ErrorCodes.PARAM_INVALID,
          `${label}: missing required parameter "${p.name}"`,
          { parameter: p.name },
        );
      } else {
        out[p.name] = value ?? null;
        continue;
      }
    }
    if (value === null && !p.nullable && p.default === undefined && !p.required) {
      out[p.name] = null;
      continue;
    }
    if (!checkType(value, p.type, p.nullable ?? false)) {
      throw new VdsError(
        ErrorCodes.TYPE_MISMATCH,
        `${label}: parameter "${p.name}" expected ${p.type} but got ${typeOf(value)}`,
        { parameter: p.name, expected: p.type, actual: typeOf(value), value },
      );
    }
    if (p.enum && !p.enum.some((e) => deepEqual(e, value))) {
      throw new VdsError(
        ErrorCodes.PARAM_INVALID,
        `${label}: parameter "${p.name}" must be one of ${JSON.stringify(p.enum)}`,
        { parameter: p.name, allowed: p.enum, value },
      );
    }
    out[p.name] = value;
  }
  return out;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (typeof a === "object") {
    const ka = Object.keys(a as object);
    const kb = Object.keys(b as object);
    if (ka.length !== kb.length) return false;
    return ka.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    );
  }
  return false;
}
