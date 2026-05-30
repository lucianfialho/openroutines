/**
 * Template Engine
 *
 * Simple interpolation for skill agent_prompts.
 * Supports: {{inputs.x}}, {{output.y.z}}, {{output_path}}
 */

export interface TemplateContext {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  output_path?: string;
}

export const renderTemplate = (template: string, context: TemplateContext): string => {
  return template.replace(/\{\{(\w+)(?:\.(\w+))?\}\}/g, (_match, key, subKey) => {
    if (key === "inputs" && subKey) {
      const value = context.inputs[subKey];
      return value !== undefined ? String(value) : `{{inputs.${subKey}}}`;
    }
    if (key === "output" && subKey) {
      const value = getNestedValue(context.outputs, subKey);
      return value !== undefined ? String(value) : `{{output.${subKey}}}`;
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
