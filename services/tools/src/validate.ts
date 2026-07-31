/**
 * Minimal, bounded JSON Schema validation for tool inputs.
 *
 * The gateway must schema-check inputs before invoking a connector, but tool
 * input schemas are attacker-influenced data, so we deliberately support only a
 * safe subset (type, required, properties, enum, additionalProperties) and never
 * evaluate anything Turing-complete. Anything unrecognized is treated as
 * permissive rather than failing closed on a valid-but-unsupported keyword.
 */

import type { JsonSchema } from "./connectors/types";

export type ValidationResult =
  | { ok: true }
  | { ok: false; errors: string[] };

export function validateInput(schema: JsonSchema, input: unknown): ValidationResult {
  const errors: string[] = [];
  validateValue(schema, input, "$", errors, 0);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

const MAX_DEPTH = 20;

function validateValue(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
  depth: number
): void {
  if (depth > MAX_DEPTH) {
    // Fail closed: an input nested deeper than the bound is rejected rather than
    // passed unchecked, so nesting cannot be used to evade required /
    // additionalProperties constraints.
    errors.push(`${path}: input nesting exceeds the maximum depth of ${MAX_DEPTH}`);
    return;
  }

  const type = schema.type;
  if (typeof type === "string" && !matchesType(type, value)) {
    errors.push(`${path}: expected ${type}`);
    return;
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(option, value))) {
    errors.push(`${path}: value is not one of the allowed options`);
  }

  if (type === "object" || (schema.properties && isObject(value))) {
    validateObject(schema, value, path, errors, depth);
  }

  if (type === "array" && Array.isArray(value) && isObject(schema.items)) {
    value.forEach((item, index) =>
      validateValue(schema.items as JsonSchema, item, `${path}[${index}]`, errors, depth + 1)
    );
  }
}

function validateObject(
  schema: JsonSchema,
  value: unknown,
  path: string,
  errors: string[],
  depth: number
): void {
  if (!isObject(value)) {
    errors.push(`${path}: expected object`);
    return;
  }

  const properties = isObject(schema.properties)
    ? (schema.properties as Record<string, JsonSchema>)
    : {};

  if (Array.isArray(schema.required)) {
    for (const key of schema.required) {
      if (typeof key === "string" && !(key in value)) {
        errors.push(`${path}.${key}: required`);
      }
    }
  }

  if (schema.additionalProperties === false) {
    for (const key of Object.keys(value)) {
      if (!(key in properties)) {
        errors.push(`${path}.${key}: unexpected property`);
      }
    }
  }

  for (const [key, propSchema] of Object.entries(properties)) {
    if (key in value) {
      validateValue(propSchema, value[key], `${path}.${key}`, errors, depth + 1);
    }
  }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
