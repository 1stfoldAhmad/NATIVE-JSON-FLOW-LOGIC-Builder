/**
 * Class registry: logical service definitions with controlled instance
 * lifetimes (singleton | instance) and dependency injection. A class never
 * depends on a React component — only on other registered classes.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { assertValidDefinition } from "../spec/validate.ts";
import type { ClassSpec } from "../spec/types.ts";
import type { LogicEngine } from "../engine.ts";

export interface ClassInstance {
  classId: string;
  /** Property values (initialized from defaults). */
  properties: Record<string, unknown>;
  /** Injected dependency instances keyed by their class id. */
  services: Record<string, ClassInstance>;
  disposed: boolean;
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

  /** Create (or fetch the singleton of) a class instance with deps injected. */
  async createInstance(classId: string, engine: LogicEngine): Promise<ClassInstance> {
    const def = this.get(classId);
    const lifetime = def.definition.lifetime ?? "singleton";
    if (lifetime === "singleton") {
      const cached = this.singletons.get(classId);
      if (cached && !cached.disposed) return cached;
    }
    const properties: Record<string, unknown> = {};
    for (const p of def.definition.properties ?? []) {
      properties[p.name] = p.default !== undefined ? p.default : null;
    }
    const services: Record<string, ClassInstance> = {};
    for (const depId of def.definition.dependencies ?? []) {
      services[depId] = await this.createInstance(depId, engine);
    }
    const instance: ClassInstance = { classId, properties, services, disposed: false };
    if (lifetime === "singleton") this.singletons.set(classId, instance);
    return instance;
  }

  dispose(instance: ClassInstance): void {
    instance.disposed = true;
    if (this.singletons.get(instance.classId) === instance) {
      this.singletons.delete(instance.classId);
    }
  }

  list(): ClassSpec[] {
    return [...this.defs.values()];
  }
}
