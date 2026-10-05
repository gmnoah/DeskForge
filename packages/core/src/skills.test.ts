import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { listSkills, loadSkill, parseSkillMarkdown } from "./skills.js";

test("SKILL.md frontmatter is listed and loaded by slug", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "deskforge-skills-"));
  try {
    const dir = path.join(root, "workspace-notes");
    await mkdir(dir);
    const source = `---\nname: workspace-notes\ndescription: 整理笔记\n---\n\n只在工作区内写 Markdown。\n`;
    await writeFile(path.join(dir, "SKILL.md"), source);
    const parsed = parseSkillMarkdown(source, path.join(dir, "SKILL.md"));
    assert.equal(parsed?.name, "workspace-notes");
    assert.equal(listSkills([root]).length, 1);
    assert.match(loadSkill([root], "workspace-notes")?.body ?? "", /Markdown/);
    assert.equal(loadSkill([root], "../secret"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
