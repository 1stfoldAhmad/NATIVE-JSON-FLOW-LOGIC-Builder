/**
 * Function registry: JSON function definitions + explicitly registered
 * native implementations. Native implementations are the ONLY extension
 * point that can touch I/O — JSON itself can never execute code.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { assertValidDefinition } from "../spec/validate.ts";
import type { ExecutionContext } from "../context/context.ts";
import type { FunctionSpec } from "../spec/types.ts";

export type NativeImpl = (
  args: Record<string, unknown>,
  ctx: ExecutionContext,
  instance?: unknown,
) => unknown | Promise<unknown>;

export class FunctionRegistry {
  private defs = new Map<string, FunctionSpec>();
  private natives = new Map<string, NativeImpl>();

  register(def: FunctionSpec): void {
    assertValidDefinition(def);
    if (this.defs.has(def.id)) {
      throw new VdsError(ErrorCodes.SPEC_INVALID, `Duplicate definition id "${def.id}"`);
    }
    this.defs.set(def.id, def);
  }

  registerNative(name: string, impl: NativeImpl): void {
    if (typeof name !== "string" || !name) {
      throw new VdsError(ErrorCodes.PARAM_INVALID, "native name must be a non-empty string");
    }
    this.natives.set(name, impl);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  get(id: string): FunctionSpec {
    const def = this.defs.get(id);
    if (!def) {
      throw new VdsError(ErrorCodes.REF_NOT_FOUND, `Unknown function "${id}"`, { ref: id });
    }
    return def;
  }

  getNative(name: string): NativeImpl {
    const impl = this.natives.get(name);
    if (!impl) {
      throw new VdsError(ErrorCodes.NATIVE_NOT_FOUND, `No native implementation registered as "${name}"`, {
        native: name,
      });
    }
    return impl;
  }

  list(): FunctionSpec[] {
    return [...this.defs.values()];
  }
}
