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

export class ExecutionTracer {
  enabled: boolean;
  readonly events: TraceEvent[] = [];
  private starts = new Map<string, number>();

  constructor(enabled = false) {
    this.enabled = enabled;
  }

  record(input: Omit<TraceEvent, "at">): void {
    if (!this.enabled) return;
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

  clear(): void {
    this.events.length = 0;
    this.starts.clear();
  }
}
