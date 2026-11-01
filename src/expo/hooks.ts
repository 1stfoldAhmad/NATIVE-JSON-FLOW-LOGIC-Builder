/**
 * Expo adapter React hooks. Thin wrappers over the framework-independent
 * core engine — all execution happens in LogicEngine; the hooks only
 * synchronize engine state into React state, guard against stale updates
 * from concurrent executions, and manage cleanup on unmount.
 */

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { LogicEngine } from "../engine.ts";
import type { ExecutionResult, ResultError } from "../result.ts";
import type { ExecutionStatusEvent } from "../engine.ts";
import type { EventHandler } from "../events/events.ts";
import { LogicContext } from "./context.ts";

/** Get the engine provided by LogicProvider. Throws when missing. */
export function useEngine(): LogicEngine {
  const engine = useContext(LogicContext);
  if (!engine) {
    throw new Error("useEngine must be used inside a <LogicProvider>");
  }
  return engine;
}

/** The engine from context — context values are already stable; no memo needed. */
export function useLogicEngine(): LogicEngine {
  return useEngine();
}

export interface FlowHandle {
  execute: (opts?: { input?: Record<string, unknown> }) => Promise<ExecutionResult>;
  cancel: () => void;
  loading: boolean;
  error: ResultError | null;
  result: unknown;
  executionId: string | null;
}

/** Execute and observe a JSON flow. Stale executions never overwrite newer state. */
export function useFlow(flowId: string): FlowHandle {
  const engine = useEngine();
  const abortRef = useRef<AbortController | null>(null);
  const execCounter = useRef(0);
  const [state, setState] = useState<{
    loading: boolean;
    error: ResultError | null;
    result: unknown;
    executionId: string | null;
  }>({ loading: false, error: null, result: undefined, executionId: null });

  const execute = useCallback(
    async (opts?: { input?: Record<string, unknown> }) => {
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;
      const execId = ++execCounter.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      const res = await engine.executeFlow(flowId, {
        input: opts?.input ?? {},
        signal: ac.signal,
      });
      if (execCounter.current === execId) {
        // only the latest execution may update state
        setState({
          loading: false,
          error: res.success ? null : res.error ?? null,
          result: res.data,
          executionId: res.executionId,
        });
      }
      return res;
    },
    [engine, flowId],
  );

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { execute, cancel, ...state };
}

export interface FlowState {
  status: "running" | "completed" | "failed";
  executionId: string;
  result?: unknown;
  error?: ResultError;
}

function toFlowState(e: ExecutionStatusEvent): FlowState {
  return {
    status: e.status,
    executionId: e.executionId,
    ...(e.result?.success ? { result: e.result.data } : { error: e.result?.error }),
  };
}

/** Latest tracked execution status of a flow, or null (pure helper, testable without React). */
export function flowStateFromHistory(engine: LogicEngine, flowId: string): FlowState | null {
  const tracked = engine
    .listExecutions()
    .filter((e) => e.flowId === flowId)
    .at(-1);
  return tracked ? toFlowState(tracked) : null;
}

/** Observe the latest execution status of a flow (initialized from tracked history). */
export function useFlowState(flowId: string): FlowState | null {
  const engine = useEngine();
  const [state, setState] = useState<FlowState | null>(() => flowStateFromHistory(engine, flowId));
  useEffect(() => {
    // Audit F5: when flowId changes, re-sync from the new flow's history so the
    // previous flow's state is never exposed, then subscribe to updates.
    setState(flowStateFromHistory(engine, flowId));
    return engine.subscribeExecutions((e) => {
      if (e.flowId === flowId) setState(toFlowState(e));
    });
  }, [engine, flowId]);
  return state;
}

/** Observe one specific execution by id (initialized from tracked history). */
export function useExecution(executionId: string | null): FlowState | null {
  const engine = useEngine();
  const [state, setState] = useState<FlowState | null>(() => {
    const tracked = executionId ? engine.getExecution(executionId) : undefined;
    return tracked ? toFlowState(tracked) : null;
  });
  useEffect(() => {
    if (!executionId) return;
    const tracked = engine.getExecution(executionId);
    if (tracked) setState(toFlowState(tracked));
    return engine.subscribeExecutions((e) => {
      if (e.executionId === executionId) setState(toFlowState(e));
    });
  }, [engine, executionId]);
  return state;
}

export interface LogicHandle {
  execute: (args?: Record<string, unknown>) => Promise<ExecutionResult>;
  loading: boolean;
  error: ResultError | null;
  data: unknown;
}

/** Execute a reusable JSON logic function. Stale executions never overwrite newer state. */
export function useLogic(functionId: string): LogicHandle {
  const engine = useEngine();
  const execCounter = useRef(0);
  const [state, setState] = useState<{ loading: boolean; error: ResultError | null; data: unknown }>({
    loading: false,
    error: null,
    data: undefined,
  });
  const execute = useCallback(
    async (args: Record<string, unknown> = {}) => {
      const execId = ++execCounter.current;
      setState((s) => ({ ...s, loading: true, error: null }));
      const res = await engine.callFunction(functionId, args);
      if (execCounter.current === execId) {
        setState({ loading: false, error: res.success ? null : res.error ?? null, data: res.data });
      }
      return res;
    },
    [engine, functionId],
  );
  return { execute, ...state };
}

/**
 * Service facade: invoke JSON-defined methods on a registered class,
 * e.g. `const userService = useService("class.user-service");
 * await userService.findUser({ email })`. Internal instance details stay private.
 */
export type ServiceFacade = {
  readonly classId: string;
  invoke: (method: string, args?: Record<string, unknown>) => Promise<ExecutionResult>;
} & Record<string, unknown>;

export function useService(classId: string): ServiceFacade | null {
  const engine = useEngine();
  return useMemo<ServiceFacade | null>(() => {
    const base = {
      classId,
      invoke: (method: string, args: Record<string, unknown> = {}) =>
        engine.callMethod(classId, method, args),
    };
    return new Proxy(base, {
      get(target, prop) {
        if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
        if (typeof prop === "string") {
          // service.someMethod(args) -> engine.callMethod(classId, "someMethod", args)
          return (args: Record<string, unknown> = {}) => engine.callMethod(classId, prop, args);
        }
        return undefined;
      },
    }) as ServiceFacade;
  }, [engine, classId]);
}

/** Subscribe to engine events (flow events, domain events, "*"). Cleans up automatically. */
export function useFlowEvent(event: string, handler: EventHandler): void {
  const engine = useEngine();
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    return engine.on(event, (payload, ctx) => ref.current(payload, ctx));
  }, [engine, event]);
}

/** Generic engine subscription with cleanup. */
export function useFlowSubscription(event: string, handler: EventHandler): void {
  useFlowEvent(event, handler);
}

/**
 * Connect Expo app lifecycle events to the engine as JSON hook triggers
 * (app.start / app.foreground / app.background). Uses react-native's
 * AppState when available; safe no-op outside React Native. The async
 * import is guarded so a late resolution after unmount attaches nothing.
 */
export function useAppLifecycle(): void {
  const engine = useEngine();
  useEffect(() => {
    let alive = true;
    let subscription: { remove(): void } | undefined;
    void engine.dispatch("app.start", { at: Date.now() });
    void (async () => {
      try {
        const RN = await import("react-native");
        if (!alive) return;
        subscription = RN.AppState.addEventListener("change", (state) => {
          const event = state === "active" ? "app.foreground" : "app.background";
          void engine.dispatch(event, { state, at: Date.now() });
        });
      } catch {
        // not running inside React Native — lifecycle hooks stay unused
      }
    })();
    return () => {
      alive = false;
      subscription?.remove();
    };
  }, [engine]);
}
