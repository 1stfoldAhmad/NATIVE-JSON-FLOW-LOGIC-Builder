/**
 * Runtime type checking for the JSON type system.
 */

import type { JsonTypeName } from "./types.ts";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
const ID_PATTERN = /^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$/;

export function isValidId(id: unknown): id is string {
  return typeof id === "string" && id.length > 0 && id.length <= 200 && ID_PATTERN.test(id);
}

export function typeOf(value: unknown): JsonTypeName {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      if (ISO_DATE.test(value) && !Number.isNaN(Date.parse(value))) {
        return value.length <= 10 ? "date" : "datetime";
      }
      return "string";
    case "number":
      return Number.isInteger(value) ? "integer" : "number";
    case "boolean":
      return "boolean";
    case "object":
      return "object";
    default:
      return "any";
  }
}

export function checkType(value: unknown, type: JsonTypeName, nullable = false): boolean {
  if (value === null || value === undefined) return nullable || type === "any" || type === "null";
  switch (type) {
    case "any":
      return true;
    case "null":
      return false;
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && !Number.isNaN(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
      return typeof value === "object" && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "date":
    case "datetime":
      return typeof value === "string" && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
    case "file":
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { name?: unknown }).name === "string"
      );
    case "reference":
      return isValidId(value);
    default:
      return false;
  }
}
