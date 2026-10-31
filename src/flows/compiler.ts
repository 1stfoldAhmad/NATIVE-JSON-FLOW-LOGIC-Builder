/**
 * Flow compiler — produces a normalized intermediate representation (IR):
 * every node's `next` link and all inline bodies (if/switch/foreach/try)
 * are pre-resolved to direct node references at load/compile time, so the
 * runtime never re-parses or re-validates the graph per execution.
 *
 * The IR is data (no generated code). Compiled flows are cached per
 * flow id + version and invalidated whenever definitions are (re)loaded.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import type { Expression, FlowNode, FlowNodeType, FlowSpec } from "../spec/types.ts";

export interface CompiledCase {
  when: Expression;
  nodes: CompiledNode[];
}

export interface CompiledNode {
  id: string;
  type: FlowNodeType;
  /** Original JSON node (payload fields). */
  node: FlowNode;
  /** Pre-resolved next node in the same list. */
  next?: CompiledNode;
  then?: CompiledNode[];
  else?: CompiledNode[];
  cases?: CompiledCase[];
  default?: CompiledNode[];
  body?: CompiledNode[];
  catch?: CompiledNode[];
}

export interface CompiledFlow {
  flowId: string;
  version: string;
  start: CompiledNode;
  nodes: Map<string, CompiledNode>;
  onError?: CompiledNode[];
}

function compileNodes(nodes: FlowNode[], flowId: string): CompiledNode[] {
  const byId = new Map<string, CompiledNode>();
  const out: CompiledNode[] = nodes.map((n) => {
    const c: CompiledNode = { id: n.id, type: n.type, node: n };
    byId.set(n.id, c);
    return c;
  });
  for (const c of out) {
    const nextId = c.node.next;
    if (nextId !== undefined) {
      const nx = byId.get(nextId);
      if (!nx) {
        throw new VdsError(
          ErrorCodes.SPEC_INVALID,
          `flow "${flowId}": node "${c.id}" points to unknown next node "${nextId}"`,
          { flow: flowId, node: c.id, next: nextId },
        );
      }
      c.next = nx;
    }
    switch (c.node.type) {
      case "if":
        c.then = compileNodes(c.node.then, flowId);
        if (c.node.else) c.else = compileNodes(c.node.else, flowId);
        break;
      case "switch":
        c.cases = c.node.cases.map((cs) => ({ when: cs.when, nodes: compileNodes(cs.nodes, flowId) }));
        if (c.node.default) c.default = compileNodes(c.node.default, flowId);
        break;
      case "foreach":
        c.body = compileNodes(c.node.body, flowId);
        break;
      case "try":
        c.body = compileNodes(c.node.body, flowId);
        if (c.node.catch) c.catch = compileNodes(c.node.catch, flowId);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Compile a validated flow definition into its IR. */
export function compileFlow(def: FlowSpec): CompiledFlow {
  const nodes = compileNodes(def.definition.nodes, def.id);
  if (nodes.length === 0) {
    throw new VdsError(ErrorCodes.SPEC_INVALID, `flow "${def.id}" has no nodes`);
  }
  const start = nodes.find((n) => n.type === "start") ?? nodes[0]!;
  return {
    flowId: def.id,
    version: def.version,
    start,
    nodes: new Map(nodes.map((n) => [n.id, n])),
    onError: def.definition.onError ? compileNodes(def.definition.onError, def.id) : undefined,
  };
}
