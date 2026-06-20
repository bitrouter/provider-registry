// `bun run build` — compile the providers/ directory into dist/providers.json.
//
// The aggregation is the public distribution artifact: one JSON file holding
// every provider's validated config under `{ "data": [ { "id", ... }, ... ] }`.
// Consumers (e.g. the cloud, pinned to a `reg-<timestamp>` tag) read this single
// file instead of walking the YAML tree.
//
// Two invariants make it safe to drive an automated release PR off the output:
//   1. It is loaded through `loadProviders()`, so every file is Zod-validated
//      (defaults resolved) before it ships — a malformed provider fails the build.
//   2. The output is DETERMINISTIC: providers sorted by id, object keys sorted
//      recursively, and NO timestamp or other run-varying content. Identical
//      source always yields a byte-identical file, so a regeneration that changes
//      nothing produces no diff (and therefore opens/updates no release PR).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadProviders, REGISTRY_ROOT } from "./schema";

// Recursively sort object keys (arrays keep their order) so serialization is
// independent of YAML key order / Zod's shape order — the determinism guarantee.
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

async function main(): Promise<void> {
  const providers = await loadProviders();
  // `id` is the provider name (the schema requires it to equal the filename stem).
  const data = providers
    .map(({ data }) => ({ id: data.name, ...data }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const json = `${JSON.stringify(sortKeys({ data }), null, 2)}\n`;
  const distDir = join(REGISTRY_ROOT, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "providers.json"), json, "utf8");
  console.log(`wrote dist/providers.json — ${data.length} providers`);
}

if (import.meta.main) await main();
