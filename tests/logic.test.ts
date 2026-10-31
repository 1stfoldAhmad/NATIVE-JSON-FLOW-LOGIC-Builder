import { test } from "node:test";
import assert from "node:assert/strict";
import { LogicEngine, VdsError } from "../src/index.ts";

const engine = new LogicEngine();

test("arithmetic operators", () => {
  assert.equal(engine.evaluate({ operator: "add", arguments: [1, 2, 3] }, {}), 6);
  assert.equal(engine.evaluate({ operator: "subtract", arguments: [10, 4] }, {}), 6);
  assert.equal(engine.evaluate({ operator: "multiply", arguments: [3, 4] }, {}), 12);
  assert.equal(engine.evaluate({ operator: "divide", arguments: [10, 4] }, {}), 2.5);
  assert.equal(engine.evaluate({ operator: "modulo", arguments: [10, 3] }, {}), 1);
  assert.equal(engine.evaluate({ operator: "negate", arguments: [5] }, {}), -5);
});

test("division by zero is a structured expression error", () => {
  assert.throws(
    () => engine.evaluate({ operator: "divide", arguments: [1, 0] }, {}),
    (e: unknown) => e instanceof VdsError && e.code === "EXPR_ERROR",
  );
});

test("path resolution with wildcard (plan example shape)", () => {
  const data = { items: [{ price: 10 }, { price: 5 }, { price: 5 }] };
  assert.deepEqual(engine.evaluate("$.items[*].price", data), [10, 5, 5]);
  assert.equal(engine.evaluate({ operator: "sum", value: "$.items[*].price" }, data), 20);
  assert.equal(engine.evaluate("$.items[1].price", data), 5);
  assert.equal(engine.evaluate("$.missing.deep", data), undefined);
  assert.equal(engine.evaluate({ operator: "get", arguments: ["$.missing", "fallback"] }, data), "fallback");
});

test("map / filter / reduce / find with @ item reference", () => {
  const data = { items: [1, 2, 3, 4] };
  assert.deepEqual(
    engine.evaluate({ operator: "map", arguments: ["$.items", { operator: "multiply", arguments: ["@", 10] }] }, data),
    [10, 20, 30, 40],
  );
  assert.deepEqual(
    engine.evaluate({ operator: "filter", arguments: ["$.items", { operator: "gt", arguments: ["@", 2] }] }, data),
    [3, 4],
  );
  assert.equal(
    engine.evaluate(
      { operator: "reduce", arguments: ["$.items", { operator: "add", arguments: ["@acc", "@"] }, 0] },
      data,
    ),
    10,
  );
  assert.equal(
    engine.evaluate({ operator: "find", arguments: ["$.items", { operator: "eq", arguments: ["@", 3] }] }, data),
    3,
  );
});

test("comparison, boolean, control operators", () => {
  assert.equal(engine.evaluate({ operator: "eq", arguments: [{ a: [1, 2] }, { a: [1, 2] }] }, {}), true);
  assert.equal(engine.evaluate({ operator: "ne", arguments: [1, 2] }, {}), true);
  assert.equal(engine.evaluate({ operator: "gte", arguments: [18, 18] }, {}), true);
  assert.equal(engine.evaluate({ operator: "and", arguments: [true, 1, "x"] }, {}), true);
  assert.equal(engine.evaluate({ operator: "or", arguments: [false, 0, "y"] }, {}), true);
  assert.equal(engine.evaluate({ operator: "not", arguments: [false] }, {}), true);
  assert.equal(engine.evaluate({ operator: "if", arguments: [false, "a", "b"] }, {}), "b");
  assert.equal(engine.evaluate({ operator: "coalesce", arguments: [null, undefined, "x"] }, {}), "x");
});

test("string operators incl. regex matches", () => {
  assert.equal(engine.evaluate({ operator: "upper", arguments: ["abc"] }, {}), "ABC");
  assert.equal(engine.evaluate({ operator: "concat", arguments: ["a", 1, "b"] }, {}), "a1b");
  assert.equal(engine.evaluate({ operator: "matches", arguments: ["a@b.co", "^[^@]+@[^@]+\\.[^@]+$"] }, {}), true);
  assert.deepEqual(engine.evaluate({ operator: "split", arguments: ["a,b,c", ","] }, {}), ["a", "b", "c"]);
  assert.equal(engine.evaluate({ operator: "join", arguments: [[1, 2], "-"] }, {}), "1-2");
});

test("dynamic object/array literals evaluate their values", () => {
  const out = engine.evaluate({ total: { operator: "add", arguments: [1, 2] }, list: ["$.x", 5] }, { x: 9 });
  assert.deepEqual(out, { total: 3, list: [9, 5] });
});

test("unknown operator is rejected", () => {
  assert.throws(
    () => engine.evaluate({ operator: "eval", arguments: ["1+1"] }, {}),
    (e: unknown) => e instanceof VdsError && e.code === "EXPR_ERROR",
  );
});

test("no arbitrary code execution: expressions are data, not JS", () => {
  // A string is a literal unless it is a $ path; unknown operators throw.
  assert.equal(engine.evaluate("process.exit(1)", {}), "process.exit(1)");
  assert.throws(
    () => engine.evaluate({ operator: "constructor", arguments: [] }, {}),
    (e: unknown) => e instanceof VdsError && e.code === "EXPR_ERROR",
  );
  assert.throws(
    () => engine.evaluate({ operator: "__proto__", arguments: [] }, {}),
    (e: unknown) => e instanceof VdsError,
  );
});
