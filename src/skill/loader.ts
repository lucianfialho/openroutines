/**
 * Skill Loader
 *
 * Load skills from the filesystem (.gates/skills/ directory).
 * Supports both Markdown prose and YAML state machines.
 */

import { readFileSync, readdirSync, existsSync, statSync } from "fs";
import { join, extname, basename } from "path";
import type { Skill } from "./types.js";
import { parseSkillStateMachine } from "./parser.js";

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}

export const loadSkill = (skillsDir: string, name: string): Skill => {
  // Try nested directory first: skills/<name>/skill.yaml
  const dirPath = join(skillsDir, name);
  const yamlInDir = join(dirPath, "skill.yaml");
  if (existsSync(dirPath) && statSync(dirPath).isDirectory() && existsSync(yamlInDir)) {
    const content = readFileSync(yamlInDir, "utf-8");
    const stateMachine = parseSkillStateMachine(content);
    return {
      format: "state-machine",
      name,
      stateMachine,
      source: yamlInDir,
    };
  }

  // Try flat files in skillsDir
  const files = readdirSync(skillsDir);
  const match = files.find((f) => basename(f, extname(f)) === name);

  if (!match) {
    throw new SkillLoadError(
      `Skill '${name}' not found in ${skillsDir}. Available: ${files.join(", ")}`
    );
  }

  const source = join(skillsDir, match);
  const ext = extname(match);
  const content = readFileSync(source, "utf-8");

  if (ext === ".yaml" || ext === ".yml") {
    const stateMachine = parseSkillStateMachine(content);
    return {
      format: "state-machine",
      name,
      stateMachine,
      source,
    };
  }

  return {
    format: "markdown",
    name,
    content,
    source,
  };
};

export const listSkills = (skillsDir: string): string[] => {
  try {
    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const names = new Set<string>();

    for (const entry of entries) {
      if (entry.isDirectory()) {
        // Check for skill.yaml inside directory
        if (existsSync(join(skillsDir, entry.name, "skill.yaml"))) {
          names.add(entry.name);
        }
      } else {
        const ext = extname(entry.name);
        if (ext === ".md" || ext === ".yaml" || ext === ".yml") {
          names.add(basename(entry.name, ext));
        }
      }
    }

    return Array.from(names);
  } catch {
    return [];
  }
};
