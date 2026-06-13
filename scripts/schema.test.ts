// Schema invariant tests for context-tier ("staged") pricing.
//
// Run with `bun test`. These exercise the negative cases the `validate`
// gate cannot — `bun run validate` only proves the on-disk registry is
// currently valid, not that malformed pricing is rejected.

import { describe, expect, test } from "bun:test";
import { CanonicalModel, ModelPricing, ProviderFile } from "./schema";

const base = { name: "p", status: "active", models: [] as unknown[] };

test("community defaults false and verified is rejected", () => {
  expect(ProviderFile.parse({ ...base }).community).toBe(false);
  expect(ProviderFile.parse({ ...base, community: true }).community).toBe(true);
  // `verified` is gone — strict() must reject it
  expect(() => ProviderFile.parse({ ...base, verified: true })).toThrow();
});

test("auto_sync: feed enum + key/url feed-gating", () => {
  const p = (auto_sync: unknown) => ProviderFile.parse({ ...base, auto_sync });
  expect(p({ feed: "models_dev", key: "stepfun-ai" }).auto_sync?.feed).toBe("models_dev");
  expect(p({ feed: "v1_models", url: "https://x.test/v1" }).auto_sync?.url).toBe("https://x.test/v1");
  // omitted block is allowed (manual)
  expect(ProviderFile.parse({ ...base }).auto_sync).toBeUndefined();
  // key only valid for models_dev; url only valid for v1_models
  expect(() => p({ feed: "v1_models", key: "x" })).toThrow();
  expect(() => p({ feed: "models_dev", url: "https://x.test/v1" })).toThrow();
  expect(() => p({ feed: "bogus" })).toThrow();
});

const pricingBase = {
  input_tokens: { no_cache: 1.3, cache_read: 0.13 },
  output_tokens: { text: 7.8 },
};

const tier = (above: number, noCache: number, text: number) => ({
  above_input_tokens: above,
  input_tokens: { no_cache: noCache },
  output_tokens: { text },
});

describe("ModelPricing without tiers", () => {
  test("flat pricing parses", () => {
    expect(ModelPricing.safeParse(pricingBase).success).toBe(true);
  });

  test("empty pricing parses (unconfigured is allowed at schema level)", () => {
    expect(ModelPricing.safeParse({}).success).toBe(true);
  });
});

describe("ModelPricing with context_tiers", () => {
  test("a single well-formed tier parses", () => {
    const r = ModelPricing.safeParse({
      ...pricingBase,
      context_tiers: [tier(128000, 2, 12)],
    });
    expect(r.success).toBe(true);
  });

  test("multiple strictly-ascending tiers parse", () => {
    const r = ModelPricing.safeParse({
      ...pricingBase,
      context_tiers: [tier(128000, 2, 12), tier(256000, 3, 18)],
    });
    expect(r.success).toBe(true);
  });

  test("tiers without a complete base bracket are rejected", () => {
    const r = ModelPricing.safeParse({
      // base missing output_tokens.text
      input_tokens: { no_cache: 1.3 },
      context_tiers: [tier(128000, 2, 12)],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("complete base bracket");
  });

  test("a tier missing its own no_cache/text is rejected", () => {
    const r = ModelPricing.safeParse({
      ...pricingBase,
      context_tiers: [
        { above_input_tokens: 128000, output_tokens: { text: 12 } }, // no input no_cache
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("input_tokens.no_cache and output_tokens.text");
  });

  test("non-ascending thresholds are rejected", () => {
    const r = ModelPricing.safeParse({
      ...pricingBase,
      context_tiers: [tier(256000, 3, 18), tier(128000, 2, 12)],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("strictly increase");
  });

  test("duplicate thresholds are rejected", () => {
    const r = ModelPricing.safeParse({
      ...pricingBase,
      context_tiers: [tier(128000, 2, 12), tier(128000, 3, 18)],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r)).toContain("strictly increase");
  });

  test("a zero or negative threshold is rejected", () => {
    expect(
      ModelPricing.safeParse({ ...base, context_tiers: [tier(0, 2, 12)] }).success,
    ).toBe(false);
    expect(
      ModelPricing.safeParse({ ...base, context_tiers: [tier(-1, 2, 12)] }).success,
    ).toBe(false);
  });

  test("unknown keys in a tier are rejected (strict)", () => {
    const r = ModelPricing.safeParse({
      ...pricingBase,
      context_tiers: [{ ...tier(128000, 2, 12), bogus: 1 }],
    });
    expect(r.success).toBe(false);
  });
});
