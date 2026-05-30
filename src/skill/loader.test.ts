import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadSkill, listSkills, SkillLoadError } from "./loader.js";

describe("loadSkill", () => {
  it("should load a markdown skill", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    writeFileSync(join(dir, "solve-issue.md"), "# Skill: solve-issue\n\nDo it.");

    const skill = loadSkill(dir, "solve-issue");
    expect(skill.name).toBe("solve-issue");
    expect(skill.content).toContain("Do it");
    expect(skill.source).toContain("solve-issue.md");

    rmSync(dir, { recursive: true });
  });

  it("should load a yaml skill", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    const yaml = `id: deploy
name: Deploy Service
initial_state: build
states:
  build:
    agent_prompt: Build the service
    transitions:
      - to: push
  push:
    agent_prompt: Push the image
    terminal: true
`;
    writeFileSync(join(dir, "deploy.yaml"), yaml);

    const skill = loadSkill(dir, "deploy");
    expect(skill.name).toBe("deploy");
    expect(skill.format).toBe("state-machine");
    expect(skill.stateMachine?.states.build?.agent_prompt).toBe("Build the service");

    rmSync(dir, { recursive: true });
  });

  it("should throw when skill not found", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    expect(() => loadSkill(dir, "missing")).toThrow(SkillLoadError);
    expect(() => loadSkill(dir, "missing")).toThrow("not found");
    rmSync(dir, { recursive: true });
  });
});

describe("listSkills", () => {
  it("should list all skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "skills-"));
    writeFileSync(join(dir, "a.md"), "A");
    writeFileSync(join(dir, "b.yaml"), "B");
    writeFileSync(join(dir, "c.txt"), "C"); // ignored

    const skills = listSkills(dir);
    expect(skills).toContain("a");
    expect(skills).toContain("b");
    expect(skills).not.toContain("c");

    rmSync(dir, { recursive: true });
  });

  it("should return empty array for missing dir", () => {
    expect(listSkills("/nonexistent/path")).toEqual([]);
  });
});
