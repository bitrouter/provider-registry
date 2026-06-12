// Compile the YAML registry into a single `registry.json` artifact — the
// fetchable golden that the bitrouter-cloud router pulls at runtime instead of
// reading the YAML directory at deploy time. Like the cloud's
// `openapi.golden.yaml`, this file is GENERATED, never hand-edited: a CI test
// (`bun test`) fails the PR if `registry.json` drifts from the YAML source, so
// the committed artifact on `main` is always the source of truth the cloud
// fetches.
//
// The artifact is the two-layer registry the cloud consumes directly:
//   { schema_version, canonical: CanonicalModel[], providers: ProviderFile[] }
// Deliberately NOT models.dev's denormalized `api.json` shape — the cloud
// builds its routing catalog from the separate canonical and provider layers.
//
// No timestamp is embedded on purpose: the golden must be byte-deterministic so
// the in-sync check is stable across unrelated commits. The cloud tracks
// freshness via the HTTP ETag (GitHub raw returns the blob SHA) and its own
// last-successful-fetch time.
//
// Usage:
//   bun run build-registry-json            # (re)write registry.json
//   bun run build-registry-json --check    # exit non-zero if it would change

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { crossFileIssues, loadRegistry, REGISTRY_ROOT } from "./schema";

// Bumped only on a breaking change to the artifact's shape. The cloud consumer
// pins the major it understands and keeps its last-good registry on a mismatch.
export const SCHEMA_VERSION = 1;

export const REGISTRY_JSON_PATH = join(REGISTRY_ROOT, "registry.json");

/**
 * Build the canonical `registry.json` text from the YAML source. Throws if any
 * file is schema-invalid (via `loadRegistry`) or the cross-file invariants
 * fail — so a broken registry can never be compiled into a published artifact.
 */
export async function buildRegistryJson(): Promise<string> {
  const reg = await loadRegistry();
  const issues = crossFileIssues(reg);
  if (issues.length > 0) {
    const detail = issues.map((i) => `  ${i.file}: ${i.message}`).join("\n");
    throw new Error(`registry is not internally consistent:\n${detail}`);
  }
  const artifact = {
    schema_version: SCHEMA_VERSION,
    canonical: reg.canonical,
    providers: reg.providers.map((p) => p.data),
  };
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const next = await buildRegistryJson();
  if (check) {
    const current = existsSync(REGISTRY_JSON_PATH)
      ? await readFile(REGISTRY_JSON_PATH, "utf8")
      : "";
    if (current !== next) {
      console.error(
        "✗ registry.json is out of sync with the YAML source.\n" +
          "  Run `bun run build-registry-json` and commit the result.",
      );
      process.exit(1);
    }
    console.log("✓ registry.json is in sync with the YAML source.");
    return;
  }
  await writeFile(REGISTRY_JSON_PATH, next, "utf8");
  console.log(`✓ wrote ${REGISTRY_JSON_PATH}`);
}

if (import.meta.main) await main();
