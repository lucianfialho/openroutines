/**
 * Condition Evaluator
 *
 * Evaluate `when` expressions on state machine transitions.
 * Supports simple comparisons against the outputs object.
 */

export class ConditionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConditionError";
  }
}

/**
 * Evaluate a condition expression against the outputs context.
 * Supported formats:
 *   - "output.specialist == 'backend'"
 *   - "output.specialist != 'frontend'"
 *   - "output.count > 5"
 *   - "output.count >= 5"
 *   - "output.count < 5"
 *   - "output.count <= 5"
 *   - "output.has_error" (truthy check)
 *   - "!output.has_error" (falsy check)
 */
export const evaluateCondition = (expression: string, outputs: Record<string, unknown>): boolean => {
  const trimmed = expression.trim();

  // Negation: !output.x
  if (trimmed.startsWith("!")) {
    const inner = trimmed.slice(1).trim();
    return !evaluateCondition(inner, outputs);
  }

  // Comparison operators
  const operators = ["==", "!=", ">=", "<=", ">", "<"];
  for (const op of operators) {
    const idx = trimmed.indexOf(op);
    if (idx !== -1) {
      const left = trimmed.slice(0, idx).trim();
      const right = trimmed.slice(idx + op.length).trim();
      const leftValue = resolvePath(left, outputs);
      const rightValue = parseLiteral(right);
      return compare(leftValue, op, rightValue);
    }
  }

  // Truthy check: output.x
  const value = resolvePath(trimmed, outputs);
  return !!value;
};

const resolvePath = (path: string, outputs: Record<string, unknown>): unknown => {
  if (!path.startsWith("output.")) {
    throw new ConditionError(`Condition must start with 'output.': ${path}`);
  }

  const parts = path.slice("output.".length).split(".");
  let current: unknown = outputs;

  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }

  return current;
};

const parseLiteral = (literal: string): unknown => {
  const trimmed = literal.trim();

  // String literal
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) ||
      (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1);
  }

  // Boolean
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;

  // Null
  if (trimmed === "null") return null;

  // Number
  const num = Number(trimmed);
  if (!isNaN(num)) return num;

  // Bare identifier — resolve from outputs
  if (trimmed.startsWith("output.")) {
    return trimmed; // Will be resolved by caller if needed
  }

  return trimmed;
};

const compare = (left: unknown, op: string, right: unknown): boolean => {
  switch (op) {
    case "==": return left === right;
    case "!=": return left !== right;
    case ">": return (left as number) > (right as number);
    case ">=": return (left as number) >= (right as number);
    case "<": return (left as number) < (right as number);
    case "<=": return (left as number) <= (right as number);
    default: throw new ConditionError(`Unknown operator: ${op}`);
  }
};
