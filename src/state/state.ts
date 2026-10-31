/**
 * Application-level business state (separate from flow execution context
 * and from UI state). Simple observable store with path access.
 */

import { resolvePath, setPath } from "../logic/paths.ts";

export type StateListener = (state: Record<string, unknown>) => void;

/** Deep-clone state on read so consumers cannot mutate internal nested state. */
function cloneState<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  const sc = (globalThis as { structuredClone?: (v: unknown) => unknown }).structuredClone;
  if (typeof sc === "function") return sc(value) as T;
  return JSON.parse(JSON.stringify(value)) as T;
}

export class StateManager {
  private state: Record<string, unknown> = {};
  private listeners = new Set<StateListener>();

  get(path?: string): unknown {
    if (!path) return cloneState(this.state);
    const r = resolvePath(this.state, path.startsWith("$") ? path : `$.${path}`);
    return r.found ? cloneState(r.value) : undefined;
  }

  set(path: string, value: unknown): void {
    setPath(this.state, path.startsWith("$") ? path : `$.${path}`, value);
    this.notify();
  }

  replace(state: Record<string, unknown>): void {
    this.state = { ...state };
    this.notify();
  }

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    const snapshot = cloneState(this.state);
    for (const l of this.listeners) l(snapshot);
  }
}
