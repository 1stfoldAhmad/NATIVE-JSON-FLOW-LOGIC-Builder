/**
 * Typed errors with stable codes. Every engine failure is normalized to a
 * VdsError so callers can switch on `code` instead of parsing messages.
 */

export const ErrorCodes = {
  SPEC_INVALID: "SPEC_INVALID",
  REF_NOT_FOUND: "REF_NOT_FOUND",
  REF_TYPE_MISMATCH: "REF_TYPE_MISMATCH",
  CIRCULAR_DEPENDENCY: "CIRCULAR_DEPENDENCY",
  EVENT_CYCLE: "EVENT_CYCLE",
  TYPE_MISMATCH: "TYPE_MISMATCH",
  PARAM_INVALID: "PARAM_INVALID",
  EXPR_ERROR: "EXPR_ERROR",
  NATIVE_NOT_FOUND: "NATIVE_NOT_FOUND",
  EXEC_CANCELLED: "EXEC_CANCELLED",
  EXEC_TIMEOUT: "EXEC_TIMEOUT",
  EXEC_LIMIT: "EXEC_LIMIT",
  EXEC_ERROR: "EXEC_ERROR",
  FLOW_ERROR: "FLOW_ERROR",
  NOT_ALLOWED: "NOT_ALLOWED",
  LIFETIME_INCOMPATIBLE: "LIFETIME_INCOMPATIBLE",
  VALIDATION_FAILED: "VALIDATION_FAILED",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export class VdsError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "VdsError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export function isVdsError(e: unknown): e is VdsError {
  return e instanceof VdsError;
}

/** Convert any thrown value into a VdsError with a stable code. */
export function normalizeError(e: unknown): VdsError {
  if (e instanceof VdsError) return e;
  if (e instanceof Error) {
    if (e.name === "AbortError") {
      return new VdsError(ErrorCodes.EXEC_CANCELLED, "Execution cancelled");
    }
    return new VdsError(ErrorCodes.EXEC_ERROR, e.message, { stack: e.stack });
  }
  return new VdsError(ErrorCodes.EXEC_ERROR, typeof e === "string" ? e : "Unknown error", {
    value: e,
  });
}
