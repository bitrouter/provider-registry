// Unit tests for pure helpers in scripts/curate.ts.
// Run with: bun test scripts/curate.test.ts

import { expect, test } from "bun:test";
import { canonicalFromOR, modelsDevProviders } from "./curate";

test("models_dev selector uses auto_sync.key, falls back to name", () => {
  const got = modelsDevProviders([
    { data: { name: "stepfun", auto_sync: { feed: "models_dev", key: "stepfun-ai" }, models: [] } },
    { data: { name: "openai", auto_sync: { feed: "models_dev" }, models: [] } },
    { data: { name: "chutes", auto_sync: { feed: "v1_models", url: "x" }, models: [] } },
    { data: { name: "bitrouter", models: [] } },
  ] as never);
  expect(got).toEqual([{ name: "stepfun", key: "stepfun-ai" }, { name: "openai", key: "openai" }]);
});

// Regression: OpenRouter sends `null` (not an omitted key) for unknown optional
// fields; the canonical schema accepts `undefined` but rejects `null`, so
// canonicalFromOR must coerce. Before the fix this threw a ZodError and broke
// the daily curate workflow for any onboarding target with a null cap.
test("canonicalFromOR coerces OpenRouter nulls to omitted optionals", () => {
  const got = canonicalFromOR({
    id: "openai/gpt-4",
    name: null,
    context_length: null,
    architecture: { input_modalities: null, output_modalities: null },
    top_provider: { max_completion_tokens: null },
  } as never);
  expect(got.id).toBe("openai/gpt-4");
  expect(got.name).toBeUndefined();
  expect(got.max_input_tokens).toBeUndefined();
  expect(got.max_output_tokens).toBeUndefined();
  expect(got.input_modalities).toEqual(["text"]);
  expect(got.output_modalities).toEqual(["text"]);
});

test("canonicalFromOR keeps real caps and modalities", () => {
  const got = canonicalFromOR({
    id: "openai/gpt-4o",
    name: "GPT-4o",
    context_length: 128000,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
    top_provider: { max_completion_tokens: 16384 },
  } as never);
  expect(got.max_input_tokens).toBe(128000);
  expect(got.max_output_tokens).toBe(16384);
  expect(got.input_modalities).toEqual(["text", "image"]);
});
