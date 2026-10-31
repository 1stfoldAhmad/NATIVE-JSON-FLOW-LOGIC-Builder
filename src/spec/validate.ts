/**
 * Schema + semantic validation for JSON definitions. Invalid definitions are
 * rejected BEFORE execution (engine.load throws SPEC_INVALID with issues).
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import { isValidId } from "./check.ts";
import { operatorNames } from "../logic/operators.ts";
import type {
  AnySpec,
  ClassDefinition,
  EventDefinition,
  FlowDefinition,
  FlowNode,
  FunctionDefinition,
  HookDefinition,
  LogicDefinition,
  ParameterDef,
  SpecEnvelope,
} from "./types.ts";
import { JSON_TYPE_NAMES } from "./types.ts";

export interface ValidationIssue {
  path: string;
  code: string;
  message: string;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function issue(list: ValidationIssue[], path: string, code: string, message: string): void {
  list.push({ path, code, message });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function validateParamsShape(
  params: unknown,
  path: string,
  list: ValidationIssue[],
): void {
  if (params === undefined) return;
  if (!Array.isArray(params)) {
    issue(list, path, "SCHEMA", `${path} must be an array`);
    return;
  }
  const names = new Set<string>();
  params.forEach((p, i) => {
    const pp = `${path}[${i}]`;
    if (!isObject(p)) {
      issue(list, pp, "SCHEMA", `${pp} must be an object`);
      return;
    }
    if (typeof p.name !== "string" || !p.name) issue(list, pp, "SCHEMA", `${pp}.name is required`);
    else if (names.has(p.name)) issue(list, pp, "SCHEMA", `${pp}.name "${p.name}" is duplicated`);
    else names.add(p.name as string);
    if (typeof p.type !== "string" || !JSON_TYPE_NAMES.includes(p.type as never)) {
      issue(list, pp, "SCHEMA", `${pp}.type must be one of ${JSON_TYPE_NAMES.join(", ")}`);
    }
    if (p.required !== undefined && typeof p.required !== "boolean")
      issue(list, pp, "SCHEMA", `${pp}.required must be boolean`);
    if (p.nullable !== undefined && typeof p.nullable !== "boolean")
      issue(list, pp, "SCHEMA", `${pp}.nullable must be boolean`);
    if (p.enum !== undefined && !Array.isArray(p.enum)) issue(list, pp, "SCHEMA", `${pp}.enum must be an array`);
  });
}

/** Recursively validate an expression: known operators, sane shapes. */
export function validateExpression(expr: unknown, path: string, list: ValidationIssue[]): void {
  if (expr === null || typeof expr !== "object") return; // literal
  if (Array.isArray(expr)) {
    expr.forEach((e, i) => validateExpression(e, `${path}[${i}]`, list));
    return;
  }
  const obj = expr as Record<string, unknown>;
  if (typeof obj.operator === "string") {
    if (!operatorNames.includes(obj.operator)) {
      issue(list, path, "UNKNOWN_OPERATOR", `${path}: unknown operator "${obj.operator}"`);
    }
    if (obj.arguments !== undefined) {
      if (!Array.isArray(obj.arguments)) {
        issue(list, `${path}.arguments`, "SCHEMA", "arguments must be an array");
      } else {
        obj.arguments.forEach((a, i) => validateExpression(a, `${path}.arguments[${i}]`, list));
      }
    }
    if (obj.value !== undefined) validateExpression(obj.value, `${path}.value`, list);
    return;
  }
  for (const k of Object.keys(obj)) validateExpression(obj[k], `${path}.${k}`, list);
}

export function validateEnvelope(def: unknown): ValidationIssue[] {
  const list: ValidationIssue[] = [];
  if (!isObject(def)) {
    issue(list, "$", "SCHEMA", "definition must be an object");
    return list;
  }
  if (!isValidId(def.id)) issue(list, "$.id", "SCHEMA", "id must be a stable dotted identifier");
  if (typeof def.name !== "string" || !def.name) issue(list, "$.name", "SCHEMA", "name is required");
  if (
    typeof def.type !== "string" ||
    !["logic", "function", "class", "hook", "flow", "event"].includes(def.type)
  ) {
    issue(list, "$.type", "SCHEMA", 'type must be one of logic|function|class|hook|flow|event');
  }
  if (typeof def.version !== "string" || !SEMVER.test(def.version))
    issue(list, "$.version", "SCHEMA", "version must be semantic (x.y.z)");
  if (typeof def.spec_version !== "string" || !SEMVER.test(def.spec_version))
    issue(list, "$.spec_version", "SCHEMA", "spec_version must be semantic (x.y.z)");
  if (!isObject(def.definition)) issue(list, "$.definition", "SCHEMA", "definition must be an object");
  if (def.execution !== undefined) {
    const ex = def.execution;
    if (!isObject(ex)) issue(list, "$.execution", "SCHEMA", "execution must be an object");
    else {
      if (ex.target !== undefined && !["frontend", "backend", "shared"].includes(ex.target as string))
        issue(list, "$.execution.target", "SCHEMA", "target must be frontend|backend|shared");
      if (ex.mode !== undefined && !["sync", "async"].includes(ex.mode as string))
        issue(list, "$.execution.mode", "SCHEMA", "mode must be sync|async");
    }
  }
  validateParamsShape(def.inputs, "$.inputs", list);
  validateParamsShape(def.outputs, "$.outputs", list);
  return list;
}

const FUNCTION_KINDS = ["pure", "async", "transform", "validator", "predicate", "flow", "native"];

function validateFunctionDefinition(d: unknown, path: string, list: ValidationIssue[]): void {
  if (!isObject(d)) return issue(list, path, "SCHEMA", "definition must be an object"), undefined;
  if (typeof d.kind !== "string" || !FUNCTION_KINDS.includes(d.kind)) {
    issue(list, `${path}.kind`, "SCHEMA", `kind must be one of ${FUNCTION_KINDS.join(", ")}`);
    return;
  }
  validateParamsShape(d.parameters, `${path}.parameters`, list);
  validateParamsShape(d.return !== undefined ? [d.return] : undefined, `${path}.return`, list);
  const kind = d.kind as string;
  if (["pure", "transform", "validator", "predicate"].includes(kind)) {
    if (d.expression === undefined) issue(list, `${path}.expression`, "SCHEMA", `kind "${kind}" requires an expression`);
    else validateExpression(d.expression, `${path}.expression`, list);
  }
  if (kind === "native" || kind === "async") {
    if (typeof d.native !== "string" || !d.native) {
      issue(list, `${path}.native`, "SCHEMA", `kind "${kind}" requires a registered native name`);
    }
  }
  if (kind === "flow" && !isValidId(d.flow)) {
    issue(list, `${path}.flow`, "REF", 'kind "flow" requires a flow reference id');
  }
}

function validateClassDefinition(d: unknown, path: string, list: ValidationIssue[]): void {
  if (!isObject(d)) return issue(list, path, "SCHEMA", "definition must be an object"), undefined;
  if (
    d.lifetime !== undefined &&
    !["singleton", "execution", "transient", "instance"].includes(d.lifetime as string)
  )
    issue(list, `${path}.lifetime`, "SCHEMA", "lifetime must be singleton|execution|transient|instance");
  if (d.dependencies !== undefined) {
    if (!Array.isArray(d.dependencies) || d.dependencies.some((x) => !isValidId(x)))
      issue(list, `${path}.dependencies`, "REF", "dependencies must be an array of class ids");
  }
  if (d.properties !== undefined) {
    if (!Array.isArray(d.properties)) issue(list, `${path}.properties`, "SCHEMA", "properties must be an array");
    else {
      const names = new Set<string>();
      d.properties.forEach((p, i) => {
        const pp = `${path}.properties[${i}]`;
        if (!isObject(p) || typeof p.name !== "string" || !p.name) issue(list, pp, "SCHEMA", "property requires a name");
        else if (names.has(p.name)) issue(list, pp, "SCHEMA", `duplicate property "${p.name}"`);
        else names.add(p.name);
        if (isObject(p) && (typeof p.type !== "string" || !JSON_TYPE_NAMES.includes(p.type as never)))
          issue(list, `${pp}.type`, "SCHEMA", "invalid property type");
      });
    }
  }
  if (d.methods !== undefined) {
    if (!Array.isArray(d.methods)) issue(list, `${path}.methods`, "SCHEMA", "methods must be an array");
    else {
      const ids = new Set<string>();
      const names = new Set<string>();
      d.methods.forEach((m, i) => {
        const pp = `${path}.methods[${i}]`;
        if (!isObject(m)) return issue(list, pp, "SCHEMA", "method must be an object");
        if (!isValidId(m.id)) issue(list, `${pp}.id`, "SCHEMA", "method id must be a stable identifier");
        else if (ids.has(m.id as string)) issue(list, pp, "SCHEMA", `duplicate method id "${m.id}"`);
        else ids.add(m.id as string);
        if (typeof m.name !== "string" || !m.name) issue(list, `${pp}.name`, "SCHEMA", "method name is required");
        else if (names.has(m.name)) issue(list, pp, "SCHEMA", `duplicate method name "${m.name}"`);
        else names.add(m.name);
        if (!isValidId(m.function) && !isValidId(m.flow))
          issue(list, pp, "REF", "method must reference a function or a flow");
        validateParamsShape(m.parameters, `${pp}.parameters`, list);
      });
    }
  }
}

function validateHookDefinition(d: unknown, path: string, list: ValidationIssue[]): void {
  if (!isObject(d)) return issue(list, path, "SCHEMA", "definition must be an object"), undefined;
  if (!isObject(d.trigger) || typeof d.trigger.event !== "string" || !d.trigger.event) {
    issue(list, `${path}.trigger.event`, "SCHEMA", "trigger.event is required");
  }
  if (d.order !== undefined && typeof d.order !== "number")
    issue(list, `${path}.order`, "SCHEMA", "order must be a number");
  if (!Array.isArray(d.handlers) || d.handlers.length === 0) {
    issue(list, `${path}.handlers`, "SCHEMA", "handlers must be a non-empty array");
  } else {
    d.handlers.forEach((h, i) => {
      const pp = `${path}.handlers[${i}]`;
      if (!isObject(h)) return issue(list, pp, "SCHEMA", "handler must be an object");
      if (!["function", "flow", "method"].includes(h.type as string)) {
        issue(list, `${pp}.type`, "SCHEMA", "handler type must be function|flow|method");
        return;
      }
      if (h.type === "method") {
        if (!isValidId(h.class) || typeof h.method !== "string" || !h.method)
          issue(list, pp, "REF", 'method handler requires "class" and "method"');
      } else if (!isValidId(h.ref)) {
        issue(list, pp, "REF", `handler of type "${h.type}" requires a ref id`);
      }
      if (h.args !== undefined && !isObject(h.args))
        issue(list, `${pp}.args`, "SCHEMA", "args must be an object of expressions");
      else if (isObject(h.args))
        for (const k of Object.keys(h.args)) validateExpression(h.args[k], `${pp}.args.${k}`, list);
      if (h.input !== undefined) validateExpression(h.input, `${pp}.input`, list);
    });
  }
  if (d.execution !== undefined) {
    const ex = d.execution;
    if (!isObject(ex)) issue(list, `${path}.execution`, "SCHEMA", "execution must be an object");
    else if (ex.mode !== undefined && !["sequential", "parallel"].includes(ex.mode as string))
      issue(list, `${path}.execution.mode`, "SCHEMA", "mode must be sequential|parallel");
  }
}

const NODE_TYPES = [
  "start", "return", "end", "set", "callFunction", "callMethod", "if", "switch",
  "foreach", "emit", "callFlow", "try", "throw", "delay",
] as const;

function validateNodeList(
  nodes: unknown,
  path: string,
  list: ValidationIssue[],
  opts: { allowEmpty?: boolean } = {},
): void {
  if (!Array.isArray(nodes) || (!opts.allowEmpty && nodes.length === 0)) {
    issue(list, path, "SCHEMA", opts.allowEmpty ? "node list must be an array" : "node list must be a non-empty array");
    return;
  }
  if (nodes.length === 0) return;
  const ids = new Set<string>();
  const starts: string[] = [];
  nodes.forEach((n, i) => {
    const pp = `${path}[${i}]`;
    if (!isObject(n)) return issue(list, pp, "SCHEMA", "node must be an object");
    if (typeof n.id !== "string" || !n.id) issue(list, `${pp}.id`, "SCHEMA", "node id is required");
    else if (ids.has(n.id)) issue(list, pp, "SCHEMA", `duplicate node id "${n.id}"`);
    else ids.add(n.id);
    if (typeof n.type !== "string" || !(NODE_TYPES as readonly string[]).includes(n.type)) {
      issue(list, `${pp}.type`, "SCHEMA", `unknown node type "${String(n.type)}"`);
      return;
    }
    if (n.type === "start") starts.push(String(n.id));
    if (n.next !== undefined && typeof n.next !== "string") issue(list, `${pp}.next`, "SCHEMA", "next must be a node id");
    switch (n.type) {
      case "set":
        if (!isObject(n.assignments) || Object.keys(n.assignments).length === 0)
          issue(list, `${pp}.assignments`, "SCHEMA", "set node requires assignments");
        else
          for (const k of Object.keys(n.assignments)) {
            if (k === "__proto__" || k === "constructor" || k === "prototype") {
              issue(list, `${pp}.assignments.${k}`, "SCHEMA", `dangerous assignment name "${k}" is not allowed`);
            }
            validateExpression(n.assignments[k], `${pp}.assignments.${k}`, list);
          }
        break;
      case "callFunction":
        if (!isValidId(n.ref)) issue(list, `${pp}.ref`, "REF", "callFunction requires a function ref");
        validateArgs(n.args, pp, list);
        break;
      case "callMethod":
        if (!isValidId(n.class)) issue(list, `${pp}.class`, "REF", "callMethod requires a class id");
        if (typeof n.method !== "string" || !n.method) issue(list, `${pp}.method`, "SCHEMA", "callMethod requires a method name");
        validateArgs(n.args, pp, list);
        break;
      case "if":
        if (n.condition === undefined) issue(list, `${pp}.condition`, "SCHEMA", "if node requires a condition");
        else validateExpression(n.condition, `${pp}.condition`, list);
        validateNodeList(n.then, `${pp}.then`, list, { allowEmpty: true });
        if (n.else !== undefined) validateNodeList(n.else, `${pp}.else`, list, { allowEmpty: true });
        break;
      case "switch":
        if (n.value !== undefined) validateExpression(n.value, `${pp}.value`, list);
        if (!Array.isArray(n.cases)) issue(list, `${pp}.cases`, "SCHEMA", "switch requires cases array");
        else n.cases.forEach((c, ci) => {
          const cp = `${pp}.cases[${ci}]`;
          if (!isObject(c)) return issue(list, cp, "SCHEMA", "case must be an object");
          if (c.when !== undefined) validateExpression(c.when, `${cp}.when`, list);
          validateNodeList(c.nodes, `${cp}.nodes`, list, { allowEmpty: true });
        });
        if (n.default !== undefined) validateNodeList(n.default, `${pp}.default`, list, { allowEmpty: true });
        break;
      case "foreach":
        if (n.items !== undefined) validateExpression(n.items, `${pp}.items`, list);
        if (typeof n.as !== "string" || !n.as) issue(list, `${pp}.as`, "SCHEMA", "foreach requires an item variable name");
        validateNodeList(n.body, `${pp}.body`, list, { allowEmpty: true });
        if (n.maxIterations !== undefined && (typeof n.maxIterations !== "number" || n.maxIterations < 1))
          issue(list, `${pp}.maxIterations`, "SCHEMA", "maxIterations must be a positive number");
        break;
      case "emit":
        if (typeof n.event !== "string" || !n.event) issue(list, `${pp}.event`, "SCHEMA", "emit requires an event name");
        if (n.payload !== undefined) validateExpression(n.payload, `${pp}.payload`, list);
        break;
      case "callFlow":
        if (!isValidId(n.ref)) issue(list, `${pp}.ref`, "REF", "callFlow requires a flow ref");
        if (n.input !== undefined) validateExpression(n.input, `${pp}.input`, list);
        break;
      case "try":
        validateNodeList(n.body, `${pp}.body`, list, { allowEmpty: true });
        if (n.catch !== undefined) validateNodeList(n.catch, `${pp}.catch`, list, { allowEmpty: true });
        break;
      case "throw":
        if (n.error === undefined) issue(list, `${pp}.error`, "SCHEMA", "throw requires an error");
        else validateExpression(n.error, `${pp}.error`, list);
        break;
      case "delay":
        if (typeof n.ms !== "number" && n.ms !== undefined) validateExpression(n.ms, `${pp}.ms`, list);
        break;
      case "return":
      case "end":
        if (n.value !== undefined) validateExpression(n.value, `${pp}.value`, list);
        break;
    }
  });
  if (starts.length > 1) issue(list, path, "SCHEMA", "at most one start node is allowed");
  // next references must point at a node in the same list
  for (const n of nodes) {
    if (isObject(n) && typeof n.next === "string" && !ids.has(n.next)) {
      issue(list, `${path}`, "REF", `node "${String(n.id)}" points to unknown next node "${n.next}"`);
    }
  }
}

function validateArgs(args: unknown, pp: string, list: ValidationIssue[]): void {
  if (args === undefined) return;
  if (!isObject(args)) return issue(list, `${pp}.args`, "SCHEMA", "args must be an object of expressions");
  for (const k of Object.keys(args)) validateExpression(args[k], `${pp}.args.${k}`, list);
}

function validateFlowDefinition(d: unknown, path: string, list: ValidationIssue[]): void {
  if (!isObject(d)) return issue(list, path, "SCHEMA", "definition must be an object"), undefined;
  validateParamsShape(d.parameters, `${path}.parameters`, list);
  validateParamsShape(d.returns !== undefined ? [d.returns] : undefined, `${path}.returns`, list);
  validateNodeList(d.nodes, `${path}.nodes`, list);
  if (d.onError !== undefined) validateNodeList(d.onError, `${path}.onError`, list, { allowEmpty: true });
  if (d.limits !== undefined && !isObject(d.limits))
    issue(list, `${path}.limits`, "SCHEMA", "limits must be an object");
}

function validateEventDefinition(d: unknown, path: string, list: ValidationIssue[]): void {
  if (!isObject(d)) return issue(list, path, "SCHEMA", "definition must be an object"), undefined;
  validateParamsShape(d.payload, `${path}.payload`, list);
}

function validateLogicDefinition(d: unknown, path: string, list: ValidationIssue[]): void {
  if (!isObject(d)) return issue(list, path, "SCHEMA", "definition must be an object"), undefined;
  validateParamsShape(d.parameters, `${path}.parameters`, list);
  if (d.expression === undefined) issue(list, `${path}.expression`, "SCHEMA", "logic requires an expression");
  else validateExpression(d.expression, `${path}.expression`, list);
}

/** Validate a full envelope including its domain-specific definition. */
export function validateDefinition(def: SpecEnvelope): ValidationIssue[] {
  const list = validateEnvelope(def);
  if (list.length > 0) return list;
  const d = def.definition;
  const base = `definition`;
  switch (def.type) {
    case "function":
      validateFunctionDefinition(d, base, list);
      break;
    case "class":
      validateClassDefinition(d, base, list);
      break;
    case "hook":
      validateHookDefinition(d, base, list);
      break;
    case "flow":
      validateFlowDefinition(d, base, list);
      break;
    case "event":
      validateEventDefinition(d, base, list);
      break;
    case "logic":
      validateLogicDefinition(d, base, list);
      break;
  }
  return list;
}

/** Throws VdsError(SPEC_INVALID) when the definition is invalid. */
export function assertValidDefinition(def: unknown): asserts def is AnySpec {
  if (typeof def !== "object" || def === null) {
    throw new VdsError(ErrorCodes.SPEC_INVALID, "Definition must be an object");
  }
  const issues = validateDefinition(def as SpecEnvelope);
  if (issues.length > 0) {
    throw new VdsError(
      ErrorCodes.SPEC_INVALID,
      `Invalid ${(def as SpecEnvelope).type ?? "unknown"} definition "${String((def as SpecEnvelope).id ?? "?")}": ` +
        issues.map((i) => `${i.path}: ${i.message}`).join("; "),
      { issues },
    );
  }
}

export type { FlowNode, ParameterDef };
