// Unit tests for pure helpers in scripts/curate.ts.
// Run with: bun test scripts/curate.test.ts

import { expect, test } from "bun:test";
import { modelsDevProviders } from "./curate";

test("models_dev selector uses auto_sync.key, falls back to name", () => {
  const got = modelsDevProviders([
    { data: { name: "stepfun", auto_sync: { feed: "models_dev", key: "stepfun-ai" }, models: [] } },
    { data: { name: "openai", auto_sync: { feed: "models_dev" }, models: [] } },
    { data: { name: "chutes", auto_sync: { feed: "v1_models", url: "x" }, models: [] } },
    { data: { name: "bitrouter", models: [] } },
  ] as never);
  expect(got).toEqual([{ name: "stepfun", key: "stepfun-ai" }, { name: "openai", key: "openai" }]);
});
