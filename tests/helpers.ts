import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { LogicEngine } from "../src/index.ts";
import type { AnySpec } from "../src/index.ts";
import { loadSpecFiles } from "../src/node-io.ts";
import { createDemoDb, registerDemoNatives } from "../examples/registration/native.ts";
import type { DemoDb } from "../examples/registration/native.ts";

const here = dirname(fileURLToPath(import.meta.url));
export const examplesDir = join(here, "..", "examples", "registration");

export function loadJsonFile<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(examplesDir, name), "utf8")) as T;
}

export function loadRegistrationSpecs(engine: LogicEngine): void {
  loadSpecFiles(engine, [
    join(examplesDir, "logic.json"),
    join(examplesDir, "events.json"),
    join(examplesDir, "functions.json"),
    join(examplesDir, "classes.json"),
    join(examplesDir, "hooks.json"),
    join(examplesDir, "flows.json"),
  ]);
}

export function makeDemoEngine(opts: { trace?: boolean } = {}): { engine: LogicEngine; db: DemoDb } {
  const db = createDemoDb();
  const engine = new LogicEngine(opts);
  registerDemoNatives(engine, db);
  loadRegistrationSpecs(engine);
  return { engine, db };
}

export function specs(...defs: AnySpec[]): AnySpec[] {
  return defs;
}

export function fn(id: string, definition: Record<string, unknown>, extra: Record<string, unknown> = {}): AnySpec {
  return {
    id,
    name: id,
    type: "function",
    version: "1.0.0",
    spec_version: "1.0.0",
    definition,
    ...extra,
  } as AnySpec;
}

export function flow(id: string, definition: Record<string, unknown>): AnySpec {
  return {
    id,
    name: id,
    type: "flow",
    version: "1.0.0",
    spec_version: "1.0.0",
    definition,
  } as AnySpec;
}

export function cls(id: string, definition: Record<string, unknown>): AnySpec {
  return {
    id,
    name: id,
    type: "class",
    version: "1.0.0",
    spec_version: "1.0.0",
    definition,
  } as AnySpec;
}

export function hook(id: string, definition: Record<string, unknown>): AnySpec {
  return {
    id,
    name: id,
    type: "hook",
    version: "1.0.0",
    spec_version: "1.0.0",
    definition,
  } as AnySpec;
}
