// `bun run build` — compile the registry into the public dist/ artifacts.
//
// Two distribution files, both shaped as `{ "data": [ … ] }`:
//   - `dist/providers.json` — every provider's validated config (one entry per
//     provider, `id` first). Consumers route off the per-provider model lists.
//   - `dist/canonical.json` — the canonical model list (one entry per canonical
//     id). Consumers that need the authoritative model set + descriptive
//     metadata (e.g. "this gateway serves every canonical model") read this.
//
// Consumers (the cloud, pinned to a `reg-<timestamp>` tag; the OSS gateway,
// fetching the raw files) read these instead of walking the YAML tree.
//
// Two invariants make it safe to drive an automated release PR off the output:
//   1. Both files are loaded through `loadProviders()` / `loadCanonical()`, so
//      every entry is Zod-validated (defaults resolved) before it ships — a
//      malformed file fails the build.
//   2. The output is DETERMINISTIC: entries sorted by id, object keys sorted
//      recursively, and NO timestamp or other run-varying content. Identical
//      source always yields a byte-identical file, so a regeneration that
//      changes nothing produces no diff (and opens/updates no release PR).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadCanonical, loadProviders, REGISTRY_ROOT } from "./schema";

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

// Serialize a `{ data }` envelope deterministically (sorted keys, trailing
// newline). Exported so the determinism test can assert byte-stability without
// touching the filesystem.
export function serializeData(data: unknown[]): string {
  return `${JSON.stringify(sortKeys({ data }), null, 2)}\n`;
}

// Build both artifacts' JSON strings from the on-disk registry. Returns the
// serialized bodies + counts; the caller writes them (or, in tests, compares
// successive calls for determinism).
export async function buildArtifacts(): Promise<{
  providers: string;
  canonical: string;
  providerCount: number;
  canonicalCount: number;
}> {
  const [providers, canonical] = await Promise.all([
    loadProviders(),
    loadCanonical(),
  ]);
  // `id` is the provider name (the schema requires it to equal the filename stem).
  const providerData = providers
    .map(({ data }) => ({ id: data.name, ...data }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Canonical entries already carry `id`; sort by it for a stable order.
  const canonicalData = [...canonical].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return {
    providers: serializeData(providerData),
    canonical: serializeData(canonicalData),
    providerCount: providerData.length,
    canonicalCount: canonicalData.length,
  };
}

async function main(): Promise<void> {
  const { providers, canonical, providerCount, canonicalCount } =
    await buildArtifacts();
  const distDir = join(REGISTRY_ROOT, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "providers.json"), providers, "utf8");
  await writeFile(join(distDir, "canonical.json"), canonical, "utf8");
  console.log(
    `wrote dist/providers.json — ${providerCount} providers; ` +
      `dist/canonical.json — ${canonicalCount} canonical models`,
  );
}

if (import.meta.main) await main();
