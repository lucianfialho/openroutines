/**
 * Lightweight JSON Schema Validator
 *
 * Self-contained subset of JSON Schema.
 * Supports: type, required, enum, array items, object properties.
 * Ported from atomic-gates/lib/schema_validate.py
 */

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

export interface JsonSchema {
  type?: string;
  required?: string[];
  enum?: unknown[];
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
}

export const validate = (value: unknown, schema: JsonSchema, path = ""): void => {
  // Type validation
  if (schema.type) {
    const actualType = getJsonType(value);
    if (actualType !== schema.type) {
      throw new ValidationError(
        `Expected type "${schema.type}" at ${path || "root"}, got "${actualType}"`
      );
    }
  }

  // Enum validation
  if (schema.enum && !schema.enum.includes(value)) {
    throw new ValidationError(
      `Value at ${path || "root"} must be one of: ${schema.enum.join(", ")}`
    );
  }

  // Object validation
  if (schema.type === "object" && schema.properties && typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    // Required fields
    if (schema.required) {
      for (const key of schema.required) {
        if (!(key in obj)) {
          throw new ValidationError(`Missing required field "${key}" at ${path || "root"}`);
        }
        validate(obj[key], schema.properties[key] ?? {}, `${path}.${key}`);
      }
    }

    // Validate present fields
    for (const [key, val] of Object.entries(obj)) {
      if (schema.properties[key]) {
        validate(val, schema.properties[key], `${path}.${key}`);
      }
    }
  }

  // Array validation
  if (schema.type === "array" && Array.isArray(value) && schema.items) {
    for (let i = 0; i < value.length; i++) {
      validate(value[i], schema.items, `${path}[${i}]`);
    }
  }
};

const getJsonType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number" && Number.isInteger(value)) return "integer";
  return typeof value;
};
