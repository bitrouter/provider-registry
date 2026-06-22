// `bun run build` — compile the registry into the public dist/ artifacts.
//
// The source YAML authors `api_protocol` / `rate_limits` as glob → value
// pattern lists (e.g. `- "*": openai`, `- "claude-*": anthropic`). The dist is
// the RESOLVED, expanded view: each (provider, model) pair carries its concrete
// `api_protocol` and `rate_limits`, so a consumer reads a value and never runs
// a glob engine. Pattern resolution lives here, in the one producer, instead of
// being re-implemented (and drifting) in every consumer.
//
// Two symmetric `{ "data": [ … ] }` views of the same graph:
//   - `dist/providers.json` — provider dimension: one entry per provider
//     (`api_base`, `byok`, `community`, `billing`, …) whose `models[]` each
//     carry the resolved `api_protocol` + `rate_limits`.
//   - `dist/models.json` — model dimension: one entry per canonical model
//     (descriptive metadata) with `providers[]` listing every provider that
//     serves it and that pair's resolved config. Replaces the old
//     `canonical.json`; consumers that need the authoritative model set (e.g.
//     "this gateway serves every canonical model") read `data[].id`.
//
// Two invariants make it safe to drive an automated release PR off the output:
//   1. Sources are loaded through `loadProviders()` / `loadCanonical()`, so
//      every entry is Zod-validated (defaults resolved) before it ships.
//   2. The output is DETERMINISTIC: entries sorted by id, object keys sorted
//      recursively, and NO timestamp or other run-varying content. Identical
//      source always yields a byte-identical file, so a regeneration that
//      changes nothing produces no diff (and opens/updates no release PR).

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ApiProtocol, ProviderFile, RateLimits } from "./schema";
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

// ── Pattern resolution ────────────────────────────────────────────────────
// Mirrors the consumers' longest-match semantics so the resolved value the dist
// ships is exactly what a glob-resolving consumer would have computed.

function patternMatches(pattern: string, id: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith("*")) return id.startsWith(pattern.slice(0, -1));
  return pattern === id;
}

// Higher = more specific. `*` is the least specific; an exact id beats any glob.
function patternSpecificity(pattern: string): number {
  if (pattern === "*") return 0;
  if (pattern.endsWith("*")) return pattern.length; // (prefix.len) + 1
  return pattern.length + 2;
}

// The value of the longest pattern that matches `id`, if any. Each entry is a
// single-key `{ pattern: value }` map (the source YAML shape).
function resolvePattern<T>(
  entries: Array<Record<string, T>>,
  id: string,
): T | undefined {
  let best: { weight: number; value: T } | undefined;
  for (const entry of entries) {
    const [pattern, value] = Object.entries(entry)[0] as [string, T];
    if (!patternMatches(pattern, id)) continue;
    const weight = patternSpecificity(pattern);
    if (best === undefined || weight > best.weight) best = { weight, value };
  }
  return best?.value;
}

// The resolved per-(provider, model) config shared by both views.
interface ResolvedModel {
  id: string;
  provider_model_id: string;
  api_protocol: ApiProtocol;
  pricing?: unknown;
  capabilities?: unknown;
  rate_limits?: RateLimits;
  deprecation_date?: string | null;
}

// Resolve every model of one provider: per-model override wins, else the
// longest matching provider pattern, else (api_protocol only) the `openai`
// default — matching the consumers' precedence.
function resolveModels(provider: ProviderFile): ResolvedModel[] {
  return provider.models.map((model) => {
    const api_protocol: ApiProtocol =
      model.api_protocol ??
      resolvePattern(provider.api_protocol, model.id) ??
      "openai";
    const rate_limits =
      model.rate_limits ?? resolvePattern(provider.rate_limits, model.id);
    const resolved: ResolvedModel = {
      id: model.id,
      provider_model_id: model.provider_model_id,
      api_protocol,
    };
    if (model.pricing !== undefined) resolved.pricing = model.pricing;
    if (model.capabilities !== undefined)
      resolved.capabilities = model.capabilities;
    if (rate_limits !== undefined) resolved.rate_limits = rate_limits;
    if (model.deprecation_date != null)
      resolved.deprecation_date = model.deprecation_date;
    return resolved;
  });
}

// Build both artifacts' JSON strings from the on-disk registry. Returns the
// serialized bodies + counts; the caller writes them (or, in tests, compares
// successive calls for determinism).
export async function buildArtifacts(): Promise<{
  providers: string;
  models: string;
  providerCount: number;
  modelCount: number;
}> {
  const [providers, canonical] = await Promise.all([
    loadProviders(),
    loadCanonical(),
  ]);

  // ── Provider view ──
  // `id` is the provider name (schema requires it to equal the filename stem).
  // Drop the provider-level glob arrays — they are now resolved onto each model.
  const providerData = providers
    .map(({ data }) => {
      const { api_protocol: _ap, rate_limits: _rl, models: _m, ...rest } = data;
      return { id: data.name, ...rest, models: resolveModels(data) };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  // ── Model view ──
  // Invert provider → models into model → providers. Every canonical model
  // appears (with an empty `providers` list if nothing serves it yet).
  const servedBy = new Map<
    string,
    Array<{ provider: string } & Omit<ResolvedModel, "id">>
  >();
  for (const { data } of providers) {
    for (const m of resolveModels(data)) {
      const { id, ...perModel } = m;
      const list = servedBy.get(id) ?? [];
      list.push({ provider: data.name, ...perModel });
      servedBy.set(id, list);
    }
  }
  const modelData = [...canonical]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((model) => {
      const providersForModel = (servedBy.get(model.id) ?? []).sort((a, b) =>
        a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0,
      );
      return { ...model, providers: providersForModel };
    });

  return {
    providers: serializeData(providerData),
    models: serializeData(modelData),
    providerCount: providerData.length,
    modelCount: modelData.length,
  };
}

async function main(): Promise<void> {
  const { providers, models, providerCount, modelCount } =
    await buildArtifacts();
  const distDir = join(REGISTRY_ROOT, "dist");
  await mkdir(distDir, { recursive: true });
  await writeFile(join(distDir, "providers.json"), providers, "utf8");
  await writeFile(join(distDir, "models.json"), models, "utf8");
  console.log(
    `wrote dist/providers.json — ${providerCount} providers; ` +
      `dist/models.json — ${modelCount} canonical models`,
  );
}

if (import.meta.main) await main();
