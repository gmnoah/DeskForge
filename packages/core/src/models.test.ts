import assert from "node:assert/strict";
import test from "node:test";
import { MODEL_PRESETS, ModelProfileError, resolveApiKey, resolveModelProfile } from "./models.js";

test("presets are OpenAI-compatible and include a custom baseUrl", () => {
  const ids = MODEL_PRESETS.map((preset) => preset.id);
  assert.deepEqual(ids, ["deepseek", "kimi", "tongyi", "custom"]);
  for (const preset of MODEL_PRESETS) {
    if (preset.id === "custom") {
      assert.equal(preset.baseUrl, "");
    } else {
      assert.equal(preset.baseUrl.startsWith("https://"), true);
    }
  }
});

test("custom profile requires baseUrl and model, and presets can be overridden", () => {
  assert.throws(() => resolveModelProfile({ preset: "custom" }), ModelProfileError);
  const custom = resolveModelProfile({
    preset: "custom",
    baseUrl: "https://llm.example.test/v1",
    model: "my-model",
  });
  assert.equal(custom.baseUrl, "https://llm.example.test/v1");
  assert.equal(custom.model, "my-model");
  const deepseek = resolveModelProfile({
    preset: "deepseek",
    baseUrl: "http://127.0.0.1:8000/v1",
    model: "deepseek-reasoner",
  });
  assert.equal(deepseek.baseUrl, "http://127.0.0.1:8000/v1");
  assert.equal(deepseek.model, "deepseek-reasoner");
  assert.throws(
    () => resolveModelProfile({ preset: "kimi", baseUrl: "http://example.com/v1", model: "x" }),
    ModelProfileError,
  );
});

test("api key resolution never invents a key", () => {
  const profile = resolveModelProfile({ preset: "deepseek" });
  assert.equal(resolveApiKey(profile, {}), undefined);
  assert.equal(resolveApiKey(profile, { DESKFORGE_API_KEY: "shared", DEEPSEEK_API_KEY: "preset" }), "preset");
  assert.equal(resolveApiKey(profile, { DEEPSEEK_API_KEY: "preset" }, "memory"), "memory");
});
