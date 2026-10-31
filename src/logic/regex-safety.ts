/**
 * Static safety analysis for JSON-supplied regex patterns (ReDoS prevention).
 *
 * JavaScript RegExp has no step limit, so a catastrophic-backtracking pattern
 * can block the whole JS thread (in an Expo app: the entire UI). A length cap
 * alone is not sufficient, so we reject patterns with:
 *   - "star height" >= 2: a quantified group whose body contains a quantifier
 *     (e.g. "(a+)+", "(a*)*", "(\\w+)*")
 *   - a quantified group containing top-level alternation (e.g. "(a|a)*")
 *   - backreferences (e.g. "(a)\\1*") — they can also blow up
 *   - patterns longer than MAX_PATTERN_LENGTH
 *
 * This is a conservative analyzer, not a proof of safety: it rejects known-
 * dangerous shapes and accepts ordinary patterns. It intentionally errs on
 * the side of rejection for anything ambiguous.
 */

export const MAX_PATTERN_LENGTH = 200;

interface GroupFrame {
  /** Does this group's body contain any quantifier (at its own level)? */
  hasQuantifier: boolean;
  /** Does this group's body contain top-level alternation? */
  hasAlternation: boolean;
  /** Depth marker for alternation tracking. */
  alternationDepth: number;
}

export function isSafePattern(pattern: string): { safe: boolean; reason?: string } {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return { safe: false, reason: `pattern longer than ${MAX_PATTERN_LENGTH} characters` };
  }
  if (pattern.includes("\\1") || /\\[2-9]/.test(pattern)) {
    return { safe: false, reason: "backreferences are not allowed" };
  }
  const stack: GroupFrame[] = [];
  let i = 0;
  let prevWasAtom = false; // whether the previous token can be quantified
  const isQuantifier = (ch: string) => ch === "*" || ch === "+" || ch === "?" || ch === "{";

  const markQuantifier = () => {
    if (stack.length > 0) {
      const top = stack[stack.length - 1]!;
      top.hasQuantifier = true;
    }
    // A quantifier applied to a group is checked when the group closes.
  };

  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === "\\") {
      i += 2; // skip escaped char
      prevWasAtom = true;
      continue;
    }
    if (ch === "(") {
      // "(?:" / "(?=" etc. still open a frame for our purposes
      stack.push({ hasQuantifier: false, hasAlternation: false, alternationDepth: stack.length });
      i++;
      prevWasAtom = false;
      continue;
    }
    if (ch === ")") {
      const frame = stack.pop();
      if (frame && stack.length > 0) {
        // closing a group inside another group: the inner content counts toward the parent
        const parent = stack[stack.length - 1]!;
        if (frame.hasQuantifier) parent.hasQuantifier = true;
        if (frame.hasAlternation) parent.hasAlternation = true;
      }
      if (frame) {
        // look ahead for a quantifier applied to this group
        let j = i + 1;
        if (pattern[j] === "?") j++; // lazy quantifier marker
        if (j < pattern.length && isQuantifier(pattern[j]!)) {
          // quantified group: dangerous if its body has a quantifier or top-level alternation
          if (frame.hasQuantifier) {
            return { safe: false, reason: "nested quantifiers (quantified group containing a quantifier)" };
          }
          if (frame.hasAlternation) {
            return { safe: false, reason: "quantified group containing alternation" };
          }
        }
      }
      i++;
      prevWasAtom = true;
      continue;
    }
    if (ch === "|") {
      if (stack.length > 0) stack[stack.length - 1]!.hasAlternation = true;
      prevWasAtom = false;
      i++;
      continue;
    }
    if (isQuantifier(ch)) {
      if (ch === "{") {
        // validate {n} / {n,} / {n,m}
        const close = pattern.indexOf("}", i);
        if (close === -1) return { safe: false, reason: "unterminated { quantifier" };
        const inner = pattern.slice(i + 1, close);
        if (!/^\d+(,\d*)?$/.test(inner)) {
          // not a valid quantifier — treat literally, but reject ambiguity
          return { safe: false, reason: "ambiguous { token" };
        }
        i = close + 1;
      } else {
        i++;
      }
      if (pattern[i] === "?") i++; // lazy
      if (pattern[i] === "+") i++; // possessive (not in JS, but reject-adjacent)
      markQuantifier();
      prevWasAtom = false;
      continue;
    }
    if (ch === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) return { safe: false, reason: "unterminated character class" };
      i = close + 1;
      prevWasAtom = true;
      continue;
    }
    prevWasAtom = true;
    i++;
  }
  if (stack.length > 0) return { safe: false, reason: "unbalanced parentheses" };
  void prevWasAtom;
  return { safe: true };
}
