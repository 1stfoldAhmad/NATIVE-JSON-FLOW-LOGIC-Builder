/**
 * JSON specification types — the shared envelope and the per-domain
 * `definition` payloads for logic, functions, classes, hooks, flows, events.
 *
 * Conventions:
 *  - stable dotted IDs ("function.user.validate"), semantic versions
 *  - typed inputs/outputs, explicit references, execution targets
 *  - no arbitrary JavaScript: expressions use a controlled operator language
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type JsonTypeName =
  | "string"
  | "number"
  | "integer"
  | "boolean"
  | "null"
  | "object"
  | "array"
  | "date"
  | "datetime"
  | "file"
  | "reference"
  | "any";

export const JSON_TYPE_NAMES: readonly JsonTypeName[] = [
  "string",
  "number",
  "integer",
  "boolean",
  "null",
  "object",
  "array",
  "date",
  "datetime",
  "file",
  "reference",
  "any",
];

export type SpecType = "logic" | "function" | "class" | "hook" | "flow" | "event";

export type ExecutionTarget = "frontend" | "backend" | "shared";
export type ExecutionMode = "sync" | "async";

export interface ParameterDef {
  name: string;
  type: JsonTypeName;
  required?: boolean;
  nullable?: boolean;
  default?: JsonValue;
  enum?: JsonValue[];
  description?: string;
}

export interface ExecutionDecl {
  target?: ExecutionTarget;
  mode?: ExecutionMode;
  capabilities?: string[];
}

/** Common metadata contract shared by every JSON definition. */
export interface SpecEnvelope<T = unknown> {
  id: string;
  name: string;
  type: SpecType;
  version: string;
  spec_version: string;
  description?: string;
  execution?: ExecutionDecl;
  inputs?: ParameterDef[];
  outputs?: ParameterDef[];
  definition: T;
  deprecated?: boolean;
}

/**
 * Expressions are plain JSON. An object with a string "operator" key is an
 * operation call: `{ "operator": "add", "arguments": [...] }` (or a single
 * `"value"`). A string starting with "$" or "@" is a data path reference
 * ("$.items[*].price", "@", "@acc"). Anything else is a literal.
 */
export type Expression = JsonValue;

export type FunctionKind =
  | "pure"
  | "async"
  | "transform"
  | "validator"
  | "predicate"
  | "flow"
  | "native";

export interface FunctionDefinition {
  kind: FunctionKind;
  parameters?: ParameterDef[];
  return?: ParameterDef;
  /** Declarative expression body for pure/transform/validator/predicate. */
  expression?: Expression;
  /** Name of a registered native implementation (kind "native"/"async"). */
  native?: string;
  /** Flow reference (kind "flow"). */
  flow?: string;
}

export interface PropertyDef {
  name: string;
  type: JsonTypeName;
  default?: JsonValue;
  description?: string;
}

export interface MethodDef {
  id: string;
  name: string;
  /** Function reference the method delegates to. */
  function?: string;
  /** Or a flow the method executes. */
  flow?: string;
  parameters?: ParameterDef[];
  return?: ParameterDef;
  description?: string;
}

export interface ClassDefinition {
  serviceType?: string;
  lifetime?: "singleton" | "instance";
  properties?: PropertyDef[];
  methods?: MethodDef[];
  /** Class IDs injected as dependencies. */
  dependencies?: string[];
}

export interface HookHandler {
  type: "function" | "flow" | "method";
  /** Function or flow ID (for type "function" / "flow"). */
  ref?: string;
  /** Class ID (for type "method"). */
  class?: string;
  /** Method name (for type "method"). */
  method?: string;
  /** Extra arguments evaluated against { event, payload, ...context }. */
  args?: Record<string, Expression>;
  /**
   * For flow handlers: input expression evaluated against
   * { event, payload, ...context }. Defaults to { event, payload, ...args }.
   */
  input?: Expression;
}

export interface HookDefinition {
  trigger: { event: string };
  order?: number;
  handlers: HookHandler[];
  execution?: {
    mode?: "sequential" | "parallel";
    stopOnError?: boolean;
  };
}

export interface EventDefinition {
  payload?: ParameterDef[];
}

export interface LogicDefinition {
  parameters?: ParameterDef[];
  expression: Expression;
}

// ---------------------------------------------------------------------------
// Flows
// ---------------------------------------------------------------------------

export type FlowNodeType =
  | "start"
  | "return"
  | "end"
  | "set"
  | "callFunction"
  | "callMethod"
  | "if"
  | "switch"
  | "foreach"
  | "emit"
  | "callFlow"
  | "try"
  | "throw"
  | "delay";

interface NodeBase {
  id: string;
  type: FlowNodeType;
  /** ID of the next node in the same node list. */
  next?: string;
  description?: string;
}

export interface StartNode extends NodeBase {
  type: "start";
}
export interface ReturnNode extends NodeBase {
  type: "return" | "end";
  value?: Expression;
}
export interface SetNode extends NodeBase {
  type: "set";
  assignments: Record<string, Expression>;
}
export interface CallFunctionNode extends NodeBase {
  type: "callFunction";
  ref: string;
  args?: Record<string, Expression>;
  assign?: string;
}
export interface CallMethodNode extends NodeBase {
  type: "callMethod";
  class: string;
  method: string;
  args?: Record<string, Expression>;
  assign?: string;
}
export interface IfNode extends NodeBase {
  type: "if";
  condition: Expression;
  then: FlowNode[];
  else?: FlowNode[];
}
export interface SwitchCase {
  /**
   * Case value: evaluated and compared (deep equality) against the switch
   * node's evaluated `value`. The first matching case runs; otherwise
   * `default` runs.
   */
  when: Expression;
  nodes: FlowNode[];
}
export interface SwitchNode extends NodeBase {
  type: "switch";
  value: Expression;
  cases: SwitchCase[];
  default?: FlowNode[];
}
export interface ForEachNode extends NodeBase {
  type: "foreach";
  items: Expression;
  as: string;
  body: FlowNode[];
  maxIterations?: number;
}
export interface EmitNode extends NodeBase {
  type: "emit";
  event: string;
  payload?: Expression;
}
export interface CallFlowNode extends NodeBase {
  type: "callFlow";
  ref: string;
  input?: Expression;
  assign?: string;
}
export interface TryNode extends NodeBase {
  type: "try";
  body: FlowNode[];
  catch?: FlowNode[];
}
export interface ThrowNode extends NodeBase {
  type: "throw";
  error: Expression;
}
export interface DelayNode extends NodeBase {
  type: "delay";
  ms: number | Expression;
}

export type FlowNode =
  | StartNode
  | ReturnNode
  | SetNode
  | CallFunctionNode
  | CallMethodNode
  | IfNode
  | SwitchNode
  | ForEachNode
  | EmitNode
  | CallFlowNode
  | TryNode
  | ThrowNode
  | DelayNode;

export interface FlowLimits {
  maxNodeExecutions?: number;
  maxIterations?: number;
  timeoutMs?: number;
}

export interface FlowDefinition {
  parameters?: ParameterDef[];
  returns?: ParameterDef;
  nodes: FlowNode[];
  onError?: FlowNode[];
  limits?: FlowLimits;
}

// ---------------------------------------------------------------------------
// Typed spec aliases
// ---------------------------------------------------------------------------

export type LogicSpec = SpecEnvelope<LogicDefinition>;
export type FunctionSpec = SpecEnvelope<FunctionDefinition>;
export type ClassSpec = SpecEnvelope<ClassDefinition>;
export type HookSpec = SpecEnvelope<HookDefinition>;
export type FlowSpec = SpecEnvelope<FlowDefinition>;
export type EventSpec = SpecEnvelope<EventDefinition>;

export type AnySpec = LogicSpec | FunctionSpec | ClassSpec | HookSpec | FlowSpec | EventSpec;
