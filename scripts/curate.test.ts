// Unit tests for pure helpers in scripts/curate.ts.
// Run with: bun test scripts/curate.test.ts

import { describe, expect, test } from "bun:test";
import { buildCanonicalResolver, canonicalFromOR, modelsDevProviders } from "./curate";

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

// Keyless catalog-sync matching (`curate sync`). The two feed shapes it handles:
// maker-prefixed ids (OpenRouter, `openai/gpt-5`) and bare slugs (opencode,
// github-copilot, `gpt-5`). Matching is punctuation-insensitive, and an ambiguous
// bare slug must never mis-attach.
describe("buildCanonicalResolver", () => {
  const resolve = buildCanonicalResolver([
    "anthropic/claude-opus-4.5",
    "anthropic/claude-sonnet-4.5",
    "openai/gpt-5.4-nano",
    "moonshotai/kimi-k2.7-code",
    "z-ai/glm-5.2",
  ]);

  test("maker-prefixed id (OpenRouter) resolves by full id", () => {
    expect(resolve("moonshotai/kimi-k2.7-code")).toBe("moonshotai/kimi-k2.7-code");
    expect(resolve("openai/gpt-5.4-nano")).toBe("openai/gpt-5.4-nano");
  });

  test("bare slug (opencode / github-copilot) resolves by unique model slug", () => {
    expect(resolve("claude-opus-4-5")).toBe("anthropic/claude-opus-4.5"); // dash↔dot
    expect(resolve("gpt-5.4-nano")).toBe("openai/gpt-5.4-nano");
    expect(resolve("glm-5.2")).toBe("z-ai/glm-5.2");
  });

  test("unknown model → null", () => {
    expect(resolve("gpt-4o")).toBeNull();
    expect(resolve("some-random-model")).toBeNull();
  });

  test("ambiguous slug shared by two makers never mis-attaches by slug", () => {
    const r = buildCanonicalResolver(["a-corp/dup-model", "b-corp/dup-model"]);
    expect(r("dup-model")).toBeNull(); // bare slug ambiguous → null
    expect(r("a-corp/dup-model")).toBe("a-corp/dup-model"); // full id still precise
    expect(r("b-corp/dup-model")).toBe("b-corp/dup-model");
  });

  test("maker-prefixed id resolves by full id only — no cross-maker slug fallback", () => {
    // `other-corp/glm-5.2` names a different maker than the canonical `z-ai/glm-5.2`;
    // it must miss rather than slug-match the wrong maker's model.
    expect(resolve("other-corp/glm-5.2")).toBeNull();
    expect(resolve("glm-5.2")).toBe("z-ai/glm-5.2"); // bare slug still matches
  });
});
