/**
 * Template Engine
 *
 * Simple interpolation for skill agent_prompts.
 * Supports: {{inputs.x}}, {{output.y.z}}, {{output_path}}
 * Arrays and objects render as JSON — downstream parsers (e.g. the
 * security-judge's verify/contestacao blocks) consume the rendered text.
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
      // Absent path → empty string, not a literal `{{outputs.x}}`. A prompt may
      // reference an output not yet produced (e.g. {{outputs.verify}} on the
      // first implementation pass); leaking the raw token as prompt text is
      // noise the agent shouldn't parse.
      return value !== undefined ? formatValue(value) : "";
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
  if (Array.isArray(value) || typeof value === "object") {
    return JSON.stringify(value, null, 2);
  }
  return String(value);
};
