import { createContext } from "react";
import type { LogicEngine } from "../engine.ts";

export const LogicContext = createContext<LogicEngine | null>(null);
