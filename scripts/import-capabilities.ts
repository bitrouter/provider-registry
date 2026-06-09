#!/usr/bin/env bun
// import-capabilities.ts — seed per-(provider, model) `capabilities` from the
// keyless models.dev catalog, so the full canonical vocabulary has baseline data
// without hand-probing every (provider, model, capability) triple.
//
// What it imports (the NON-MULTIMODAL, request-relevant flags models.dev tracks):
//   models.dev `tool_call` -> `tools`
//   models.dev `reasoning` -> `reasoning`
//
// What it deliberately does NOT import:
//   * `structured_outputs` — that token already has probe-verified, PER-CHANNEL
//     ground truth (verify-capabilities.ts). models.dev's flag is model-level, so
//     importing it would risk over-claiming for reseller channels that silently
//     drop it (a divergence we have already observed). Left to the prober.
//   * `web_search` / `logprobs` — models.dev does not track them (vocabulary-only
//     for now).
//   * input/output modalities — reserved for a later multimodal pass.
//
// Writes are ADDITIVE (never removes an existing capability) and comment-
// preserving (yaml `parseDocument`). models.dev is a model-level BASELINE;
// per-channel divergence is corrected afterwards by verify-capabilities.ts.
//
// Dry-run by default; pass `--write` to apply. Run `bun run validate` after.

import { readFile, writeFile } from "node:fs/promises";
import { parseDocument, isMap, isSeq } from "yaml";
import { loadCatalog, type CatalogModel } from "./catalog.ts";
import { loadProviders, ProviderFile, type Capability } from "./schema.ts";

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Map a models.dev catalog entry to canonical non-multimodal capability tokens. */
function capsFromCatalog(m: CatalogModel): Capability[] {
  const caps: Capability[] = [];
  if (m.tool_call) caps.push("tools");
  if (m.reasoning) caps.push("reasoning");
  return caps;
}

async function main(): Promise<void> {
  const write = process.argv.includes("--write");
  const catalog = await loadCatalog();

  // Global index: norm(models.dev model id) -> [{ providerKey, model }]. Lets a
  // reseller (whose own name isn't a models.dev key) still inherit a model's
  // baseline by matching on the model id, with the canonical org as tiebreaker.
  const index = new Map<string, Array<{ providerKey: string; model: CatalogModel }>>();
  for (const [providerKey, models] of catalog) {
    for (const [modelId, model] of models) {
      const k = norm(modelId);
      const arr = index.get(k) ?? [];
      arr.push({ providerKey, model });
      index.set(k, arr);
    }
  }

  const providers = await loadProviders();

  // providerName -> (canonical id -> merged sorted capability list)
  const plan = new Map<string, Map<string, Capability[]>>();
  const unmatched: string[] = [];
  let addedTokens = 0;

  for (const { data } of providers) {
    for (const m of data.models) {
      const [org, modelPart] = [m.id.split("/")[0]!, m.id.split("/")[1]!];
      // Match on the canonical model part first (so the same canonical model
      // gets the same model-level baseline across every provider that serves
      // it), then fall back to the provider's native id.
      let hit: CatalogModel | null = null;
      for (const cand of [norm(modelPart), norm(m.provider_model_id)]) {
        const entries = index.get(cand);
        if (!entries?.length) continue;
        hit = (entries.find((e) => norm(e.providerKey) === norm(org)) ?? entries[0]!).model;
        break;
      }
      if (!hit) {
        unmatched.push(`${data.name}: ${m.id} (pmid=${m.provider_model_id})`);
        continue;
      }
      const incoming = capsFromCatalog(hit);
      if (incoming.length === 0) continue;
      const merged = new Set<Capability>(m.capabilities ?? []);
      const before = merged.size;
      for (const c of incoming) merged.add(c);
      if (merged.size === before) continue; // nothing new to add
      addedTokens += merged.size - before;
      const byModel = plan.get(data.name) ?? new Map<string, Capability[]>();
      byModel.set(m.id, [...merged].sort());
      plan.set(data.name, byModel);
    }
  }

  // Report.
  console.log(`import-capabilities — ${write ? "WRITE" : "dry-run"} — source: models.dev`);
  let modelCount = 0;
  for (const [prov, models] of plan) {
    for (const [id, caps] of models) {
      console.log(`  ${prov}  ${id}  ->  [${caps.join(", ")}]`);
      modelCount++;
    }
  }
  console.log(
    `\n${modelCount} (provider,model) pairs gain capabilities (+${addedTokens} tokens); ${unmatched.length} unmatched`,
  );
  if (unmatched.length) {
    console.log("unmatched (no confident models.dev entry — left untouched):");
    for (const u of unmatched) console.log(`  - ${u}`);
  }

  if (!write) {
    console.log("\n(dry run — pass --write to apply)");
    return;
  }

  // Apply, comment-preserving, one provider file at a time.
  for (const { path, data } of providers) {
    const models = plan.get(data.name);
    if (!models) continue;
    const doc = parseDocument(await readFile(path, "utf8"));
    const seq = doc.getIn(["models"]);
    if (!isSeq(seq)) continue;
    for (const item of seq.items) {
      if (!isMap(item)) continue;
      const caps = models.get(item.get("id") as string);
      if (caps) item.set("capabilities", doc.createNode(caps));
    }
    ProviderFile.parse(doc.toJSON()); // validate before writing
    await writeFile(path, doc.toString(), "utf8");
  }
  console.log("\n✓ applied. Run `bun run validate` to confirm.");
}

await main();
