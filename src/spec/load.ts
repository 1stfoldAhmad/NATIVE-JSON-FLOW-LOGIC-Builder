/**
 * Pure (portable) parsing of JSON spec documents into envelope lists.
 * No Node built-ins — safe to import from the core or any adapter.
 */

import { ErrorCodes, VdsError } from "../errors.ts";
import type { AnySpec, SpecEnvelope } from "./types.ts";

export function isEnvelope(v: unknown): v is SpecEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as SpecEnvelope).id === "string" &&
    typeof (v as SpecEnvelope).type === "string" &&
    typeof (v as SpecEnvelope).definition === "object"
  );
}

/**
 * Normalize a JSON document into a flat list of spec envelopes.
 * Accepts: a single envelope, an array of envelopes, or a bundle object
 * with keys logic|functions|classes|hooks|flows|events|specs.
 */
export function parseSpecDocument(doc: unknown): AnySpec[] {
  const defs: AnySpec[] = [];
  if (Array.isArray(doc)) {
    defs.push(...(doc as AnySpec[]));
  } else if (isEnvelope(doc)) {
    defs.push(doc as AnySpec);
  } else if (typeof doc === "object" && doc !== null) {
    const bundle = doc as Record<string, unknown>;
    for (const key of ["logic", "functions", "classes", "hooks", "flows", "events", "specs"]) {
      const v = bundle[key];
      if (Array.isArray(v)) defs.push(...(v as AnySpec[]));
      else if (typeof v === "object" && v !== null) defs.push(...(Object.values(v) as AnySpec[]));
    }
  } else {
    throw new VdsError(ErrorCodes.SPEC_INVALID, "parseSpecDocument expects an envelope, an array, or a bundle object");
  }
  if (defs.length === 0) {
    throw new VdsError(ErrorCodes.SPEC_INVALID, "parseSpecDocument: no definitions found in document");
  }
  return defs;
}
