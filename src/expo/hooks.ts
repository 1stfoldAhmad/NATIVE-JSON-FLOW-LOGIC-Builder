/**
 * Expo adapter React hooks. These are thin wrappers over the core engine —
 * all execution happens in the framework-independent LogicEngine; the hooks
 * only synchronize engine state into React state and manage cleanup.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LogicEngine } from "../engine.ts";
import type { ExecutionResult, ResultError } from "../result.ts";
import type { ExecutionStatusEvent } from "../engine.ts";
import type { ClassInstance } from "../classes/registry.ts";
import type { EventHandler } from "../events/events.ts";
import { LogicContext } from "./context.ts";
import { useContext } from "react";

/** Get the engine provided by LogicProvider. Throws when missing. */
export function useEngine(): LogicEngine {
  const engine = useContext(LogicContext);
  if (!engine) {
    throw new Error("useEngine must be used inside a <LogicProvider>");
  }
  return engine;
}

export interface FlowHandle {
  execute: (opts?: { input?: Record<string, unknown> }) => Promise<ExecutionResult>;
  cancel: () => void;
  loading: boolean;
  error: ResultError | null;
  result: unknown;
  executionId: string | null;
}

/** Execute and observe a JSON flow. */
export function useFlow(flowId: string): FlowHandle {
  const engine = useEngine();
  const abortRef = useRef<AbortController | null>(null);
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
      setState((s) => ({ ...s, loading: true, error: null }));
      const res = await engine.executeFlow(flowId, {
        input: opts?.input ?? {},
        signal: ac.signal,
      });
      setState({
        loading: false,
        error: res.success ? null : res.error ?? null,
        result: res.data,
        executionId: res.executionId,
      });
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

/** Observe the latest execution status of a flow. */
export function useFlowState(flowId: string): FlowState | null {
  const engine = useEngine();
  const [state, setState] = useState<FlowState | null>(null);
  useEffect(() => {
    return engine.subscribeExecutions((e: ExecutionStatusEvent) => {
      if (e.flowId === flowId && e.status !== "running") {
        setState({
          status: e.status,
          executionId: e.executionId,
          ...(e.result?.success
            ? { result: e.result.data }
            : { error: e.result?.error }),
        });
      } else if (e.flowId === flowId) {
        setState({ status: "running", executionId: e.executionId });
      }
    });
  }, [engine, flowId]);
  return state;
}

/** Observe one specific execution by id. */
export function useExecution(executionId: string | null): FlowState | null {
  const engine = useEngine();
  const [state, setState] = useState<FlowState | null>(null);
  useEffect(() => {
    if (!executionId) return;
    return engine.subscribeExecutions((e) => {
      if (e.executionId === executionId && e.status !== "running") {
        setState({
          status: e.status,
          executionId: e.executionId,
          ...(e.result?.success ? { result: e.result.data } : { error: e.result?.error }),
        });
      }
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

/** Execute a reusable JSON logic function. */
export function useLogic(functionId: string): LogicHandle {
  const engine = useEngine();
  const [state, setState] = useState<{ loading: boolean; error: ResultError | null; data: unknown }>({
    loading: false,
    error: null,
    data: undefined,
  });
  const execute = useCallback(
    async (args: Record<string, unknown> = {}) => {
      setState((s) => ({ ...s, loading: true, error: null }));
      const res = await engine.callFunction(functionId, args);
      setState({ loading: false, error: res.success ? null : res.error ?? null, data: res.data });
      return res;
    },
    [engine, functionId],
  );
  return { execute, ...state };
}

/** Access a registered service class instance. */
export function useService(classId: string): ClassInstance | null {
  const engine = useEngine();
  const [service, setService] = useState<ClassInstance | null>(null);
  useEffect(() => {
    let alive = true;
    engine.getService(classId).then((s) => {
      if (alive) setService(s);
    });
    return () => {
      alive = false;
    };
  }, [engine, classId]);
  return service;
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
 * AppState when available; safe no-op outside React Native.
 */
export function useAppLifecycle(): void {
  const engine = useEngine();
  useEffect(() => {
    void engine.dispatch("app.start", { at: Date.now() });
    let subscription: { remove(): void } | undefined;
    void (async () => {
      try {
        const RN = await import("react-native");
        subscription = RN.AppState.addEventListener("change", (state) => {
          const event = state === "active" ? "app.foreground" : "app.background";
          void engine.dispatch(event, { state, at: Date.now() });
        });
      } catch {
        // not running inside React Native — lifecycle hooks stay unused
      }
    })();
    return () => subscription?.remove();
  }, [engine]);
}

/** Memoized engine reference (convenience). */
export function useLogicEngine(): LogicEngine {
  return useMemo(() => useEngine(), []);
}
