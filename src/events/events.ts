/**
 * Programmatic event bus (on/off/emit). JSON-defined hooks are dispatched by
 * the HookEngine through the same event names via engine.dispatch().
 */

import type { ExecutionContext } from "../context/context.ts";
import { normalizeError } from "../errors.ts";

export type EventHandler = (payload: unknown, ctx?: ExecutionContext) => unknown | Promise<unknown>;

interface Subscription {
  fn: EventHandler;
  once: boolean;
}

export class EventManager {
  private handlers = new Map<string, Set<Subscription>>();

  /** Subscribe. Returns an unsubscribe function. */
  on(event: string, fn: EventHandler, opts?: { once?: boolean }): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    const sub: Subscription = { fn, once: opts?.once ?? false };
    set.add(sub);
    return () => {
      set.delete(sub);
    };
  }

  once(event: string, fn: EventHandler): () => void {
    return this.on(event, fn, { once: true });
  }

  off(event: string, fn: EventHandler): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const sub of set) if (sub.fn === fn) set.delete(sub);
  }

  listenerCount(event: string): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  /** Emit sequentially; the first failing handler aborts the dispatch. */
  async emit(event: string, payload: unknown, ctx?: ExecutionContext): Promise<unknown[]> {
    const set = this.handlers.get(event);
    const wildcard = this.handlers.get("*");
    // Track the actual set each subscription came from so `once` cleanup
    // removes it from the right set (wildcard handlers live in the "*" set).
    const subs: Array<{ sub: Subscription; set: Set<Subscription> }> = [
      ...[...(set ?? [])].map((sub) => ({ sub, set: set! })),
      ...[...(wildcard ?? [])].map((sub) => ({ sub, set: wildcard! })),
    ];
    const results: unknown[] = [];
    for (const { sub, set: owner } of subs) {
      try {
        results.push(await sub.fn(payload, ctx));
      } catch (e) {
        throw normalizeError(e);
      } finally {
        if (sub.once) owner.delete(sub);
      }
    }
    return results;
  }

  clear(): void {
    this.handlers.clear();
  }
}
