/**
 * LogicProvider — mounts a LogicEngine instance into the React tree.
 * The engine itself is plain TypeScript and never imports React.
 */

import { createElement } from "react";
import type { ReactNode } from "react";
import type { LogicEngine } from "../engine.ts";
import { LogicContext } from "./context.ts";

export interface LogicProviderProps {
  engine: LogicEngine;
  children?: ReactNode;
}

export function LogicProvider(props: LogicProviderProps) {
  return createElement(LogicContext.Provider, { value: props.engine }, props.children);
}
