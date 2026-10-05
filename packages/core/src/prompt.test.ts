import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "./prompt.js";

test("system prompt names the product and refuses a root workspace", () => {
  const prompt = buildSystemPrompt(null);
  assert.match(prompt, /DeskForge/);
  assert.match(prompt, /不是 WorkBuddy/);
  assert.match(prompt, /不能是 \//);
});
