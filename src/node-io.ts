/**
 * Node-only adapter entry point ("vds-json-logic/node").
 *
 * The core engine (src/engine.ts, src/index.ts) is portable pure TypeScript
 * with ZERO Node built-in imports, so it bundles cleanly in Expo/Metro.
 * Filesystem loading lives here, in a separate package entry, for Node.js
 * tooling, tests and future backend runtimes.
 */

import { readFileSync } from "node:fs";
import type { LogicEngine } from "./engine.ts";
import type { AnySpec } from "./spec/types.ts";
import { parseSpecDocument } from "./spec/load.ts";

/** Load one JSON spec file into the engine (transactional batch of one file). */
export function loadSpecFile(engine: LogicEngine, path: string): LogicEngine {
  return loadSpecJson(engine, readFileSync(path, "utf8"));
}

/** Load several JSON spec files in ONE transactional batch (cross-file refs resolve). */
export function loadSpecFiles(engine: LogicEngine, paths: string[]): LogicEngine {
  const defs: AnySpec[] = [];
  for (const p of paths) {
    defs.push(...parseSpecDocument(JSON.parse(readFileSync(p, "utf8"))));
  }
  engine.load(defs);
  return engine;
}

/** Load a JSON spec document from a string. */
export function loadSpecJson(engine: LogicEngine, json: string): LogicEngine {
  return engine.loadJson(JSON.parse(json));
}
