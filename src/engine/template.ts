/**
 * Template Engine
 *
 * Simple interpolation for skill agent_prompts.
 * Supports: {{inputs.x}}, {{output.y.z}}, {{output_path}}
 * Arrays are formatted as bullet lists; objects as key: value lines.
 */

export interface TemplateContext {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  output_path?: string;
}

export const renderTemplate = (template: string, context: TemplateContext): string => {
  return template.replace(/\{\{(\w+)(?:\.([\w.]+))?\}\}/g, (_match, key, subKey) => {
    if (key === "inputs" && subKey) {
      const value = context.inputs[subKey];
      return value !== undefined ? formatValue(value) : `{{inputs.${subKey}}}`;
    }
    if ((key === "output" || key === "outputs") && subKey) {
      const value = getNestedValue(context.outputs, subKey);
      return value !== undefined ? formatValue(value) : `{{${key}.${subKey}}}`;
    }
    if (key === "output_path") {
      return context.output_path ?? ".gates/outputs/output.yaml";
    }
    return _match;
  });
};

const getNestedValue = (obj: Record<string, unknown>, path: string): unknown => {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
};

const formatValue = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => `- ${formatValue(item)}`).join("\n");
  }
  if (typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${formatValue(v)}`)
      .join("\n");
  }
  return String(value);
};
