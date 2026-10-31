/**
 * Class registry: logical service definitions with a precise lifetime
 * contract and dependency injection. A class never depends on a React
 * component — only on other registered classes.
 *
 * Lifetimes:
 *  - "singleton"   one instance per engine (default); disposed via engine.dispose()
 *  - "execution"   one instance per flow execution (cached on the context,
 *                  disposed when the execution finishes)
 *  - "transient"   a new instance per method call, disposed after the call
 *  - "instance"    deprecated alias of "transient"
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { assertValidDefinition } from "../spec/validate.ts";
import type { ClassSpec } from "../spec/types.ts";
import type { ExecutionContext } from "../context/context.ts";
import type { LogicEngine } from "../engine.ts";

export type ClassLifetime = "singleton" | "execution" | "transient";

export interface ClassInstance {
  classId: string;
  lifetime: ClassLifetime;
  /** Property values (initialized from defaults). */
  properties: Record<string, unknown>;
  /** Injected dependency instances keyed by their class id. */
  services: Record<string, ClassInstance>;
  disposed: boolean;
}

/** Deep-clone a JSON default so instances never share mutable references. */
function cloneDefault<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const sc = (globalThis as { structuredClone?: (v: unknown) => unknown }).structuredClone;
  if (typeof sc === "function") return sc(value) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

export class ClassRegistry {
  private defs = new Map<string, ClassSpec>();
  private singletons = new Map<string, ClassInstance>();

  register(def: ClassSpec): void {
    assertValidDefinition(def);
    if (this.defs.has(def.id)) {
      throw new VdsError(ErrorCodes.SPEC_INVALID, `Duplicate definition id "${def.id}"`);
    }
    this.defs.set(def.id, def);
  }

  has(id: string): boolean {
    return this.defs.has(id);
  }

  get(id: string): ClassSpec {
    const def = this.defs.get(id);
    if (!def) {
      throw new VdsError(ErrorCodes.REF_NOT_FOUND, `Unknown class "${id}"`, { ref: id });
    }
    return def;
  }

  static lifetimeOf(def: ClassSpec): ClassLifetime {
    const lt = def.definition.lifetime ?? "singleton";
    return lt === "instance" ? "transient" : (lt as ClassLifetime);
  }

  /**
   * Create (or fetch) a class instance according to its lifetime.
   * "execution" instances are cached on the provided context.
   */
  async createInstance(classId: string, engine: LogicEngine, ctx?: ExecutionContext): Promise<ClassInstance> {
    const def = this.get(classId);
    const lifetime = ClassRegistry.lifetimeOf(def);
    if (lifetime === "singleton") {
      const cached = this.singletons.get(classId);
      if (cached && !cached.disposed) return cached;
    }
    if (lifetime === "execution" && ctx) {
      const cached = ctx.instances.get(classId);
      if (cached && !cached.disposed) return cached;
    }
    const properties: Record<string, unknown> = {};
    for (const p of def.definition.properties ?? []) {
      properties[p.name] = p.default !== undefined ? cloneDefault(p.default) : null;
    }
    const services: Record<string, ClassInstance> = {};
    for (const depId of def.definition.dependencies ?? []) {
      const depInstance = await this.createInstance(depId, engine, ctx);
      if (depInstance.disposed) {
        // Audit F1 runtime guard: a disposed dependency must never be wired
        // into a live instance (load-time validation normally prevents this).
        throw new VdsError(
          ErrorCodes.LIFETIME_INCOMPATIBLE,
          `dependency "${depId}" of "${classId}" is disposed and cannot be injected`,
          { from: classId, ref: depId },
        );
      }
      services[depId] = depInstance;
    }
    const instance: ClassInstance = { classId, lifetime, properties, services, disposed: false };
    if (lifetime === "singleton") this.singletons.set(classId, instance);
    if (lifetime === "execution" && ctx) ctx.instances.set(classId, instance);
    return instance;
  }

  /**
   * Dispose an instance and only the dependencies it OWNS. Singleton
   * dependencies are engine-owned and are NEVER disposed by a dependent —
   * disposing a transient/execution instance must not invalidate a shared
   * singleton. Singletons are only disposed via disposeAll() (engine shutdown).
   */
  dispose(instance: ClassInstance): void {
    if (instance.disposed) return;
    instance.disposed = true;
    for (const dep of Object.values(instance.services)) {
      if (dep.lifetime !== "singleton") this.dispose(dep);
    }
    if (this.singletons.get(instance.classId) === instance) {
      this.singletons.delete(instance.classId);
    }
  }

  /** Dispose all singleton instances (engine shutdown). */
  disposeAll(): void {
    for (const instance of [...this.singletons.values()]) this.dispose(instance);
  }

  list(): ClassSpec[] {
    return [...this.defs.values()];
  }
}
