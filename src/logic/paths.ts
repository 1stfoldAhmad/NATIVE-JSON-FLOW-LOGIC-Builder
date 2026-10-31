/**
 * Data path resolution for expressions.
 *
 * Grammar:  $ | @  followed by segments:
 *   .name        descend into object property
 *   [n]          array index
 *   ["name"]     object property (quoted)
 *   [*]          wildcard — maps the remaining path over each array element
 *
 * Examples: "$.items[*].price", "$.user.address.city", "@[0].id", "@.name"
 */

export type PathSegment = string | number | "*";

export function parsePath(path: string): PathSegment[] | null {
  if (path === "$" || path === "@") return [];
  const root = path[0];
  if (root !== "$" && root !== "@") return null;
  const segs: PathSegment[] = [];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === ".") {
      let j = i + 1;
      while (j < path.length && path[j] !== "." && path[j] !== "[") j++;
      const name = path.slice(i + 1, j);
      if (!name) return null;
      segs.push(name);
      i = j;
    } else if (ch === "[") {
      const close = path.indexOf("]", i);
      if (close === -1) return null;
      const inner = path.slice(i + 1, close);
      if (inner === "*") segs.push("*");
      else if (/^\d+$/.test(inner)) segs.push(parseInt(inner, 10));
      else if (
        inner.length >= 2 &&
        ((inner[0] === '"' && inner[inner.length - 1] === '"') ||
          (inner[0] === "'" && inner[inner.length - 1] === "'"))
      ) {
        segs.push(inner.slice(1, -1));
      } else return null;
      i = close + 1;
    } else {
      return null;
    }
  }
  return segs;
}

export interface PathResult {
  found: boolean;
  value?: unknown;
}

function walk(value: unknown, segs: PathSegment[], idx: number): PathResult {
  if (idx === segs.length) return { found: true, value };
  const seg = segs[idx]!;
  if (seg === "*") {
    if (!Array.isArray(value)) return { found: false };
    const out: unknown[] = [];
    for (const el of value) {
      const r = walk(el, segs, idx + 1);
      if (r.found) out.push(r.value);
    }
    return { found: true, value: out };
  }
  if (typeof seg === "number") {
    if (!Array.isArray(value) || seg < 0 || seg >= value.length) return { found: false };
    return walk(value[seg], segs, idx + 1);
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value) && seg in value) {
    return walk((value as Record<string, unknown>)[seg], segs, idx + 1);
  }
  return { found: false };
}

/**
 * Resolve a path against a root ("$") or the current item ("@").
 * Returns { found: false } when any segment is missing.
 */
export function resolvePath(root: unknown, path: string, current?: unknown): PathResult {
  const segs = parsePath(path);
  if (segs === null) return { found: false };
  const base = path[0] === "$" ? root : current;
  if (base === undefined && segs.length > 0) return { found: false };
  return walk(base, segs, 0);
}

/** Set a nested value by path, creating intermediate objects. */
export function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const segs = parsePath(path);
  if (!segs || segs.length === 0 || typeof segs[0] !== "string") {
    throw new Error(`setPath requires a property path, got "${path}"`);
  }
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i];
    if (typeof seg !== "string") throw new Error(`setPath: unsupported segment in "${path}"`);
    const next = cur[seg];
    if (typeof next !== "object" || next === null || Array.isArray(next)) {
      cur[seg] = {};
    }
    cur = cur[seg] as Record<string, unknown>;
  }
  cur[segs[segs.length - 1] as string] = value;
}
