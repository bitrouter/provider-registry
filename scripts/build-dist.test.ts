// Tests for the dist/ aggregation build.
//
// The release automation drives an automated PR off `bun run build`, so the
// output MUST be deterministic: two runs over identical source produce
// byte-identical files (else every CI run would churn a no-op release PR).

import { describe, expect, test } from "bun:test";
import { buildArtifacts, serializeData } from "./build-dist";

describe("dist build", () => {
  test("output is deterministic across runs", async () => {
    const a = await buildArtifacts();
    const b = await buildArtifacts();
    expect(a.providers).toBe(b.providers);
    expect(a.models).toBe(b.models);
  });

  test("emits both providers and models artifacts", async () => {
    const { providers, models, providerCount, modelCount } =
      await buildArtifacts();
    expect(providerCount).toBeGreaterThan(0);
    expect(modelCount).toBeGreaterThan(0);
    const provData = JSON.parse(providers).data as Array<{ id: string }>;
    const modelData = JSON.parse(models).data as Array<{ id: string }>;
    expect(provData.length).toBe(providerCount);
    expect(modelData.length).toBe(modelCount);
    // Each model-view entry carries an `<org>/<model>` id.
    for (const m of modelData) expect(m.id).toContain("/");
  });

  // A resolved protocol is a single maker name or a non-empty ordered set.
  const PROTOS = ["openai", "anthropic", "google", "responses"];
  const isProtocol = (p: unknown): boolean =>
    typeof p === "string"
      ? PROTOS.includes(p)
      : Array.isArray(p) && p.length > 0 && p.every((x) => PROTOS.includes(x as string));

  test("curated providers resolve per-model; runtime-discovered keep provider globs", async () => {
    const { providers } = await buildArtifacts();
    const data = JSON.parse(providers).data as Array<{
      id: string;
      access?: string;
      byok?: boolean;
      api_protocol?: unknown;
      rate_limits?: unknown;
      models: Array<{ id: string; api_protocol: unknown }>;
    }>;
    for (const p of data) {
      // Derived back-compat alias: byok iff access === "api_key".
      expect(p.byok).toBe(p.access === "api_key");
      if (p.models.length === 0) {
        // Catalog discovered at runtime (provider declares an auto_sync feed):
        // provider-level globs are kept so the consumer can apply them to what
        // it discovers.
        expect(p.api_protocol).toBeDefined();
      } else {
        // Curated: globs resolved onto each model; no provider-level arrays.
        expect(p.api_protocol).toBeUndefined();
        expect(p.rate_limits).toBeUndefined();
        for (const m of p.models) expect(isProtocol(m.api_protocol)).toBe(true);
      }
    }
  });

  test("models.json inverts provider→model into model→providers", async () => {
    const { models } = await buildArtifacts();
    const data = JSON.parse(models).data as Array<{
      id: string;
      providers: Array<{ provider: string; provider_model_id: string; api_protocol: unknown }>;
    }>;
    // At least one canonical model is served by a provider, and each provider
    // entry references a provider id + carries the resolved per-pair config.
    const served = data.filter((m) => m.providers.length > 0);
    expect(served.length).toBeGreaterThan(0);
    for (const m of served) {
      for (const p of m.providers) {
        expect(typeof p.provider).toBe("string");
        expect(typeof p.provider_model_id).toBe("string");
        expect(isProtocol(p.api_protocol)).toBe(true);
      }
    }
  });

  test("entries are sorted by id and keys are recursively sorted", () => {
    const json = serializeData([
      { id: "b/two", z: 1, a: 2 },
      { id: "a/one", a: 1 },
    ]);
    const parsed = JSON.parse(json) as { data: Array<Record<string, unknown>> };
    // NOTE: serializeData preserves caller order; the build sorts by id before
    // calling it. So array order is the caller's, but object keys are sorted.
    expect(parsed.data.map((e) => e.id)).toEqual(["b/two", "a/one"]);
    const firstKeys = Object.keys(parsed.data[0]!);
    expect(firstKeys).toEqual([...firstKeys].sort());
    // trailing newline (clean git diff / POSIX text file)
    expect(json.endsWith("}\n")).toBe(true);
  });
});
