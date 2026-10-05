import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillSummary {
  name: string;
  description: string;
  filePath: string;
}

export interface SkillDocument extends SkillSummary {
  body: string;
}

export function parseSkillMarkdown(source: string, filePath: string): SkillDocument | null {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(source);
  if (!match) return null;
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key) meta[key] = value;
  }
  const name = meta.name ?? "";
  const description = meta.description ?? "";
  if (!SKILL_NAME.test(name) || !description) return null;
  return {
    name,
    description,
    body: (match[2] ?? "").trim(),
    filePath,
  };
}

export function listSkills(directories: readonly string[]): SkillSummary[] {
  const byName = new Map<string, SkillSummary>();
  for (const directory of directories) {
    let entries: string[] = [];
    try {
      entries = readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!SKILL_NAME.test(entry)) continue;
      const filePath = path.join(directory, entry, "SKILL.md");
      let source: string;
      try {
        if (!statSync(filePath).isFile()) continue;
        source = readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const skill = parseSkillMarkdown(source, filePath);
      if (!skill || skill.name !== entry) continue;
      byName.set(skill.name, { name: skill.name, description: skill.description, filePath });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function loadSkill(directories: readonly string[], name: string): SkillDocument | null {
  if (!SKILL_NAME.test(name)) return null;
  for (const directory of directories) {
    const filePath = path.join(directory, name, "SKILL.md");
    try {
      const skill = parseSkillMarkdown(readFileSync(filePath, "utf8"), filePath);
      if (skill && skill.name === name) return skill;
    } catch {
      continue;
    }
  }
  return null;
}
