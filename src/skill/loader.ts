/**
 * Skill Loader
 *
 * Load skills from the filesystem (.gates/skills/ directory).
 */

import { readFileSync, readdirSync } from "fs";
import { join, extname, basename } from "path";
import type { Skill } from "./types.js";

export class SkillLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillLoadError";
  }
}

export const loadSkill = (skillsDir: string, name: string): Skill => {
  const files = readdirSync(skillsDir);
  const match = files.find((f) => basename(f, extname(f)) === name);

  if (!match) {
    throw new SkillLoadError(
      `Skill '${name}' not found in ${skillsDir}. Available: ${files.join(", ")}`
    );
  }

  const source = join(skillsDir, match);
  const content = readFileSync(source, "utf-8");

  return {
    name,
    content,
    source,
  };
};

export const listSkills = (skillsDir: string): string[] => {
  try {
    return readdirSync(skillsDir)
      .filter((f) => extname(f) === ".md" || extname(f) === ".yaml" || extname(f) === ".yml")
      .map((f) => basename(f, extname(f)));
  } catch {
    return [];
  }
};
