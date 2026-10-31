/**
 * Factory for an engine preconfigured for the Expo (frontend) runtime:
 * execution target enforcement is set to "frontend", so definitions marked
 * "backend" can never execute in the app (the backend stays authoritative).
 */

import { LogicEngine } from "../engine.ts";
import type { LogicEngineOptions } from "../engine.ts";

export function createExpoEngine(opts: Omit<LogicEngineOptions, "environment"> = {}): LogicEngine {
  return new LogicEngine({ ...opts, environment: "frontend" });
}
