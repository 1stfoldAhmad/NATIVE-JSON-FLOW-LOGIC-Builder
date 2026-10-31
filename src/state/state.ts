/**
 * Application-level business state (separate from flow execution context
 * and from UI state). Simple observable store with path access.
 */

import { resolvePath, setPath } from "../logic/paths.ts";

export type StateListener = (state: Record<string, unknown>) => void;

export class StateManager {
  private state: Record<string, unknown> = {};
  private listeners = new Set<StateListener>();

  get(path?: string): unknown {
    if (!path) return { ...this.state };
    const r = resolvePath(this.state, path.startsWith("$") ? path : `$.${path}`);
    return r.found ? r.value : undefined;
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
    const snapshot = { ...this.state };
    for (const l of this.listeners) l(snapshot);
  }
}
