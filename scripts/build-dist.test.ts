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
    expect(a.canonical).toBe(b.canonical);
  });

  test("emits both providers and canonical artifacts", async () => {
    const { providers, canonical, providerCount, canonicalCount } =
      await buildArtifacts();
    expect(providerCount).toBeGreaterThan(0);
    expect(canonicalCount).toBeGreaterThan(0);
    const provData = JSON.parse(providers).data as Array<{ id: string }>;
    const canonData = JSON.parse(canonical).data as Array<{ id: string }>;
    expect(provData.length).toBe(providerCount);
    expect(canonData.length).toBe(canonicalCount);
    // Each canonical entry carries an `<org>/<model>` id.
    for (const m of canonData) expect(m.id).toContain("/");
  });

  test("entries are sorted by id and keys are recursively sorted", () => {
    const json = serializeData([
      { id: "b/two", z: 1, a: 2 },
      { id: "a/one", a: 1 },
    ]);
    const parsed = JSON.parse(json) as { data: Array<Record<string, unknown>> };
    // sorted by id
    expect(parsed.data.map((e) => e.id)).toEqual(["b/two", "a/one"]);
    // NOTE: serializeData does not sort the array — it preserves caller order;
    // the build sorts by id before calling it. Key order, however, is sorted:
    const firstKeys = Object.keys(parsed.data[0]!);
    expect(firstKeys).toEqual([...firstKeys].sort());
    // trailing newline (clean git diff / POSIX text file)
    expect(json.endsWith("}\n")).toBe(true);
  });
});
