/**
 * Dependency resolver: builds the reference graph across all loaded
 * definitions, detects missing references and circular dependencies, and
 * verifies that method handlers point at real methods. Runs at load time —
 * a flow must never silently call an undefined function.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import type { FlowNode, SpecEnvelope } from "../spec/types.ts";

export interface DependencyGraph {
  nodes: string[];
  edges: Record<string, string[]>;
}

function collectNodeRefs(node: FlowNode, out: Set<string>): void {
  switch (node.type) {
    case "callFunction":
    case "callFlow":
      out.add(node.ref);
      break;
    case "callMethod":
      out.add(node.class);
      break;
    case "if":
      node.then.forEach((n) => collectNodeRefs(n, out));
      (node.else ?? []).forEach((n) => collectNodeRefs(n, out));
      break;
    case "switch":
      node.cases.forEach((c) => c.nodes.forEach((n) => collectNodeRefs(n, out)));
      (node.default ?? []).forEach((n) => collectNodeRefs(n, out));
      break;
    case "foreach":
      node.body.forEach((n) => collectNodeRefs(n, out));
      break;
    case "try":
      node.body.forEach((n) => collectNodeRefs(n, out));
      (node.catch ?? []).forEach((n) => collectNodeRefs(n, out));
      break;
    default:
      break;
  }
}

export class DependencyResolver {
  /** All outgoing references of a definition. */
  static refsOf(def: SpecEnvelope): string[] {
    const out = new Set<string>();
    const d = def.definition as Record<string, unknown>;
    switch (def.type) {
      case "function": {
        if (typeof d.flow === "string") out.add(d.flow);
        break;
      }
      case "class": {
        for (const dep of (d.dependencies as string[] | undefined) ?? []) out.add(dep);
        for (const m of (d.methods as Array<Record<string, unknown>> | undefined) ?? []) {
          if (typeof m.function === "string") out.add(m.function);
          if (typeof m.flow === "string") out.add(m.flow);
        }
        break;
      }
      case "hook": {
        for (const h of (d.handlers as Array<Record<string, unknown>> | undefined) ?? []) {
          if (typeof h.ref === "string") out.add(h.ref);
          if (typeof h.class === "string") out.add(h.class);
        }
        break;
      }
      case "flow": {
        for (const n of (d.nodes as FlowNode[] | undefined) ?? []) collectNodeRefs(n, out);
        for (const n of (d.onError as FlowNode[] | undefined) ?? []) collectNodeRefs(n, out);
        break;
      }
      default:
        break;
    }
    return [...out];
  }

  static build(defs: SpecEnvelope[]): DependencyGraph {
    const edges: Record<string, string[]> = {};
    for (const def of defs) edges[def.id] = this.refsOf(def);
    return { nodes: defs.map((d) => d.id), edges };
  }

  /**
   * Validate the whole graph: every reference must resolve to a loaded
   * definition (or, for method handlers, to a class + method), and there
   * must be no circular dependencies. Throws VdsError.
   */
  static validate(defs: SpecEnvelope[]): DependencyGraph {
    const byId = new Map(defs.map((d) => [d.id, d]));
    const graph = this.build(defs);

    // 1. missing references
    for (const def of defs) {
      for (const ref of graph.edges[def.id] ?? []) {
        if (!byId.has(ref)) {
          throw new VdsError(
            ErrorCodes.REF_NOT_FOUND,
            `"${def.id}" references unknown definition "${ref}"`,
            { from: def.id, ref },
          );
        }
      }
      // method handlers / callMethod nodes must point at a real method
      if (def.type === "hook") {
        for (const h of (def.definition as { handlers: Array<Record<string, unknown>> }).handlers ?? []) {
          if (h.type === "method" && typeof h.class === "string" && typeof h.method === "string") {
            const cls = byId.get(h.class as string);
            const methods = (cls?.definition as { methods?: Array<{ name: string }> } | undefined)?.methods ?? [];
            if (!methods.some((m) => m.name === h.method)) {
              throw new VdsError(
                ErrorCodes.REF_NOT_FOUND,
                `Hook "${def.id}" references missing method "${String(h.method)}" on "${String(h.class)}"`,
                { from: def.id, class: h.class, method: h.method },
              );
            }
          }
        }
      }
    }

    // 2. cycle detection (DFS)
    const WHITE = 0, GRAY = 1, BLACK = 2;
    const color = new Map<string, number>();
    for (const id of graph.nodes) color.set(id, WHITE);
    const stack: string[] = [];
    const visit = (id: string): void => {
      color.set(id, GRAY);
      stack.push(id);
      for (const ref of graph.edges[id] ?? []) {
        if (!byId.has(ref)) continue;
        const c = color.get(ref) ?? WHITE;
        if (c === GRAY) {
          const cycle = [...stack.slice(stack.indexOf(ref)), ref];
          throw new VdsError(
            ErrorCodes.CIRCULAR_DEPENDENCY,
            `Circular dependency detected: ${cycle.join(" -> ")}`,
            { cycle },
          );
        }
        if (c === WHITE) visit(ref);
      }
      stack.pop();
      color.set(id, BLACK);
    };
    for (const id of graph.nodes) {
      if (color.get(id) === WHITE) visit(id);
    }

    return graph;
  }
}
