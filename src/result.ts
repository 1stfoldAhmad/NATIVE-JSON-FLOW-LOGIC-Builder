/**
 * Standard result contract. Every public engine operation (flow execution,
 * function call, method invocation) resolves to an ExecutionResult.
 */

export interface ResultError {
  code: string;
  message: string;
  details?: unknown;
}

export interface ExecutionResult<T = unknown> {
  success: boolean;
  data?: T;
  error?: ResultError;
  executionId: string;
  duration: number;
}

export function ok<T>(data: T, executionId: string, duration: number): ExecutionResult<T> {
  return { success: true, data, executionId, duration };
}

export function fail(
  error: { code: string; message: string; details?: unknown },
  executionId: string,
  duration: number,
): ExecutionResult<never> {
  return { success: false, error, executionId, duration };
}

export function toResultError(e: unknown): ResultError {
  if (typeof e === "object" && e !== null && "code" in e && "message" in e) {
    const err = e as { code: string; message: string; details?: unknown };
    const out: ResultError = { code: err.code, message: err.message };
    if (err.details !== undefined) out.details = err.details;
    return out;
  }
  return { code: "EXEC_ERROR", message: String(e) };
}
