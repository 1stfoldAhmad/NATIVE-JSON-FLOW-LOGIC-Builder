/**
 * Dependency resolver: builds the reference graph across all loaded
 * definitions and validates it BEFORE anything is committed:
 *  - every reference resolves to a loaded definition (REF_NOT_FOUND)
 *  - every reference points at the CORRECT definition type (REF_TYPE_MISMATCH)
 *    (callFunction -> function, callFlow -> flow, callMethod -> class+method,
 *     hook handlers -> matching type, `logic` operator -> logic definition)
 *  - no circular dependencies (CIRCULAR_DEPENDENCY)
 *  - no event-driven recursion: event -> hook -> flow -> emit -> same event
 *    (EVENT_CYCLE)
 *  - with strictEvents, emit nodes and hook triggers must name registered
 *    event definitions (event contracts)
 *
 * Runs at load time — a flow must never silently call an undefined or
 * wrongly-typed function.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import type { Expression, FlowNode, SpecEnvelope } from "../spec/types.ts";

export interface DependencyGraph {
  nodes: string[];
  edges: Record<string, string[]>;
}

export interface ValidateOptions {
  strictEvents?: boolean;
  /** Returns true when the event name has a registered event definition. */
  eventDefined?: (event: string) => boolean;
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

function collectEmittedEvents(node: FlowNode, out: Set<string>): void {
  if (node.type === "emit") out.add(node.event);
  const children: FlowNode[] = [];
  if (node.type === "if") children.push(...node.then, ...(node.else ?? []));
  if (node.type === "switch") {
    for (const c of node.cases) children.push(...c.nodes);
    children.push(...(node.default ?? []));
  }
  if (node.type === "foreach") children.push(...node.body);
  if (node.type === "try") children.push(...node.body, ...(node.catch ?? []));
  for (const c of children) collectEmittedEvents(c, out);
}

/** Find `logic` operator references inside an expression tree. */
function collectLogicRefs(expr: unknown, out: Set<string>): void {
  if (expr === null || typeof expr !== "object") return;
  if (Array.isArray(expr)) {
    for (const e of expr) collectLogicRefs(e, out);
    return;
  }
  const obj = expr as Record<string, unknown>;
  if (obj.operator === "logic") {
    const args = Array.isArray(obj.arguments) ? obj.arguments : obj.value !== undefined ? [obj.value] : [];
    if (typeof args[0] === "string") out.add(args[0]);
  }
  for (const v of Object.values(obj)) collectLogicRefs(v, out);
}

export class DependencyResolver {
  /** All outgoing references of a definition. */
  static refsOf(def: SpecEnvelope): string[] {
    const out = new Set<string>();
    const d = def.definition as Record<string, unknown>;
    switch (def.type) {
      case "function": {
        if (typeof d.flow === "string") out.add(d.flow);
        if (d.expression !== undefined) collectLogicRefs(d.expression as Expression, out);
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
      case "logic": {
        if (d.expression !== undefined) collectLogicRefs(d.expression as Expression, out);
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
   * Validate the whole graph: references exist AND have the expected type,
   * no cycles, no event recursion. Throws VdsError.
   */
  static validate(defs: SpecEnvelope[], opts: ValidateOptions = {}): DependencyGraph {
    const byId = new Map(defs.map((d) => [d.id, d]));
    const graph = this.build(defs);

    const expectType = (from: string, ref: string, expected: string): void => {
      const target = byId.get(ref);
      if (!target) {
        throw new VdsError(ErrorCodes.REF_NOT_FOUND, `"${from}" references unknown definition "${ref}"`, {
          from,
          ref,
        });
      }
      if (target.type !== expected) {
        throw new VdsError(
          ErrorCodes.REF_TYPE_MISMATCH,
          `"${from}" references "${ref}" which is a ${target.type}, expected ${expected}`,
          { from, ref, expected, actual: target.type },
        );
      }
    };

    const checkMethod = (from: string, classId: unknown, methodName: unknown): void => {
      if (typeof classId !== "string" || typeof methodName !== "string") return;
      const cls = byId.get(classId);
      if (!cls) {
        throw new VdsError(ErrorCodes.REF_NOT_FOUND, `"${from}" references unknown class "${classId}"`, {
          from,
          ref: classId,
        });
      }
      if (cls.type !== "class") {
        throw new VdsError(
          ErrorCodes.REF_TYPE_MISMATCH,
          `"${from}" references "${classId}" which is a ${cls.type}, expected class`,
          { from, ref: classId, expected: "class", actual: cls.type },
        );
      }
      const methods = (cls.definition as { methods?: Array<{ name: string }> }).methods ?? [];
      if (!methods.some((m) => m.name === methodName)) {
        throw new VdsError(
          ErrorCodes.REF_NOT_FOUND,
          `"${from}" references missing method "${methodName}" on "${classId}"`,
          { from, class: classId, method: methodName },
        );
      }
    };

    const checkEventName = (from: string, event: string): void => {
      if (opts.strictEvents && opts.eventDefined && !opts.eventDefined(event)) {
        throw new VdsError(
          ErrorCodes.REF_NOT_FOUND,
          `"${from}" uses event "${event}" but no event definition is registered for it`,
          { from, event },
        );
      }
    };

    const walkFlowNodes = (flowId: string, nodes: FlowNode[] | undefined): void => {
      for (const n of nodes ?? []) {
        switch (n.type) {
          case "callFunction":
            expectType(flowId, n.ref, "function");
            break;
          case "callFlow":
            expectType(flowId, n.ref, "flow");
            break;
          case "callMethod":
            checkMethod(flowId, n.class, n.method);
            break;
          case "emit":
            checkEventName(flowId, n.event);
            break;
          default:
            break;
        }
        if (n.type === "if") {
          walkFlowNodes(flowId, n.then);
          walkFlowNodes(flowId, n.else);
        } else if (n.type === "switch") {
          for (const c of n.cases) walkFlowNodes(flowId, c.nodes);
          walkFlowNodes(flowId, n.default);
        } else if (n.type === "foreach") {
          walkFlowNodes(flowId, n.body);
        } else if (n.type === "try") {
          walkFlowNodes(flowId, n.body);
          walkFlowNodes(flowId, n.catch);
        }
      }
    };

    for (const def of defs) {
      // existence (all refs)
      for (const ref of graph.edges[def.id] ?? []) {
        if (!byId.has(ref)) {
          throw new VdsError(ErrorCodes.REF_NOT_FOUND, `"${def.id}" references unknown definition "${ref}"`, {
            from: def.id,
            ref,
          });
        }
      }
      const d = def.definition as Record<string, unknown>;
      switch (def.type) {
        case "function": {
          if (typeof d.flow === "string") expectType(def.id, d.flow, "flow");
          if (d.expression !== undefined) {
            const logicRefs = new Set<string>();
            collectLogicRefs(d.expression as Expression, logicRefs);
            for (const r of logicRefs) expectType(def.id, r, "logic");
          }
          break;
        }
        case "class": {
          for (const dep of (d.dependencies as string[] | undefined) ?? []) expectType(def.id, dep, "class");
          for (const m of (d.methods as Array<Record<string, unknown>> | undefined) ?? []) {
            if (typeof m.function === "string") expectType(def.id, m.function, "function");
            if (typeof m.flow === "string") expectType(def.id, m.flow, "flow");
          }
          break;
        }
        case "hook": {
          checkEventName(def.id, (d.trigger as { event: string }).event);
          for (const h of (d.handlers as Array<Record<string, unknown>> | undefined) ?? []) {
            if (h.type === "method") {
              checkMethod(def.id, h.class, h.method);
            } else if (typeof h.ref === "string") {
              expectType(def.id, h.ref, h.type === "flow" ? "flow" : "function");
            }
          }
          break;
        }
        case "flow": {
          walkFlowNodes(def.id, d.nodes as FlowNode[] | undefined);
          walkFlowNodes(def.id, d.onError as FlowNode[] | undefined);
          break;
        }
        case "logic": {
          if (d.expression !== undefined) {
            const logicRefs = new Set<string>();
            collectLogicRefs(d.expression as Expression, logicRefs);
            for (const r of logicRefs) expectType(def.id, r, "logic");
          }
          break;
        }
        default:
          break;
      }
    }

    // ---- cycle detection (DFS over the id graph) ----
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

    // ---- event-driven recursion analysis ----
    // edges: eventName -> flowId (hook with flow handler) and flowId -> eventName (emit)
    const eventEdges = new Map<string, Set<string>>();
    const addEdge = (a: string, b: string) => {
      let s = eventEdges.get(a);
      if (!s) {
        s = new Set();
        eventEdges.set(a, s);
      }
      s.add(b);
    };
    for (const def of defs) {
      const d = def.definition as Record<string, unknown>;
      if (def.type === "hook") {
        const event = (d.trigger as { event: string }).event;
        for (const h of (d.handlers as Array<Record<string, unknown>> | undefined) ?? []) {
          if (h.type === "flow" && typeof h.ref === "string") addEdge(event, h.ref);
        }
      } else if (def.type === "flow") {
        const emitted = new Set<string>();
        for (const n of (d.nodes as FlowNode[] | undefined) ?? []) collectEmittedEvents(n, emitted);
        for (const n of (d.onError as FlowNode[] | undefined) ?? []) collectEmittedEvents(n, emitted);
        for (const e of emitted) addEdge(def.id, e);
      }
    }
    const eColor = new Map<string, number>();
    const eStack: string[] = [];
    const visitEvent = (id: string): void => {
      eColor.set(id, GRAY);
      eStack.push(id);
      for (const ref of eventEdges.get(id) ?? []) {
        const c = eColor.get(ref) ?? WHITE;
        if (c === GRAY) {
          const cycle = [...eStack.slice(eStack.indexOf(ref)), ref];
          throw new VdsError(
            ErrorCodes.EVENT_CYCLE,
            `Event-driven recursion detected: ${cycle.join(" -> ")}`,
            { cycle },
          );
        }
        if (c === WHITE) visitEvent(ref);
      }
      eStack.pop();
      eColor.set(id, BLACK);
    };
    for (const id of eventEdges.keys()) {
      if ((eColor.get(id) ?? WHITE) === WHITE) visitEvent(id);
    }

    return graph;
  }
}
