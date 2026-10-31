/**
 * Execution tracing for testing & debugging. Disabled by default; enable via
 * `new LogicEngine({ trace: true })` or per execution.
 */

export interface TraceEvent {
  at: number;
  executionId: string;
  kind: "flow.start" | "flow.finish" | "node" | "function" | "method" | "event" | "error";
  nodeId?: string;
  ref?: string;
  durationMs?: number;
  error?: string;
  details?: Record<string, unknown>;
}

export interface TracerOptions {
  /** Max total retained events (default 1000). When full, new events are dropped and `truncated` is set. */
  maxEvents?: number;
  /** Max retained events per execution (default 250). */
  maxEventsPerExecution?: number;
}

export class ExecutionTracer {
  enabled: boolean;
  readonly events: TraceEvent[] = [];
  /** True once events were dropped because a retention limit was hit. */
  truncated = false;
  readonly maxEvents: number;
  readonly maxEventsPerExecution: number;
  private starts = new Map<string, number>();
  private perExecution = new Map<string, number>();

  constructor(enabled = false, opts: TracerOptions = {}) {
    this.enabled = enabled;
    this.maxEvents = opts.maxEvents ?? 1000;
    this.maxEventsPerExecution = opts.maxEventsPerExecution ?? 250;
  }

  record(input: Omit<TraceEvent, "at">): void {
    if (!this.enabled) return;
    // Bounded retention (audit F4): never grow unbounded on long-running apps.
    if (this.events.length >= this.maxEvents) {
      this.truncated = true;
      return;
    }
    const count = this.perExecution.get(input.executionId) ?? 0;
    if (count >= this.maxEventsPerExecution) {
      this.truncated = true;
      return;
    }
    this.perExecution.set(input.executionId, count + 1);
    const event: TraceEvent = { ...input, at: Date.now() };
    this.events.push(event);
    if (event.kind === "node" && event.details?.phase === "start") {
      this.starts.set(`${event.executionId}:${event.nodeId}`, event.at);
    }
    if (event.kind === "node" && event.details?.phase === "end") {
      const key = `${event.executionId}:${event.nodeId}`;
      const start = this.starts.get(key);
      if (start !== undefined) {
        event.durationMs = event.at - start;
        this.starts.delete(key);
      }
    }
  }

  eventsFor(executionId: string): TraceEvent[] {
    return this.events.filter((e) => e.executionId === executionId);
  }

  /** Export a copy of the retained events. */
  snapshot(): TraceEvent[] {
    return [...this.events];
  }

  clear(): void {
    this.events.length = 0;
    this.starts.clear();
    this.perExecution.clear();
    this.truncated = false;
  }
}
