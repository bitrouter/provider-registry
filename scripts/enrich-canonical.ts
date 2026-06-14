// scripts/enrich-canonical.ts — fill descriptive canonical fields from models.dev.
import { readFile, writeFile } from "node:fs/promises";
import { isMap, isSeq, parseDocument } from "yaml";
import { loadCatalog } from "./catalog"; // models.dev client
import { CANONICAL_PATH } from "./schema";

// Match canonical model parts to models.dev ids tolerantly: lowercase + strip
// every non-alphanumeric, so `claude-sonnet-4.6` (ours) == `claude-sonnet-4-6`
// (models.dev). Best-effort — unmatched models keep their fields absent; the
// diff review (Step 2) fills any high-value gaps by hand.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const catalog = await loadCatalog();
  const facts = new Map<string, Record<string, unknown>>();
  for (const models of catalog.values())
    for (const m of models.values())
      facts.set(norm(m.id), m as unknown as Record<string, unknown>);

  const doc = parseDocument(await readFile(CANONICAL_PATH, "utf8"));
  const seq = doc.get("models");
  if (!isSeq(seq)) throw new Error("canonical.yaml: models is not a sequence");
  let enriched = 0;
  for (const node of seq.items) {
    if (!isMap(node)) continue;
    const id = String(node.get("id"));
    const f = facts.get(norm(id.split("/")[1] ?? ""));
    if (!f) continue;
    let changed = false;
    // Only accept YYYY-MM-DD; models.dev sometimes provides YYYY-MM only.
    if (f.release_date && /^\d{4}-\d{2}-\d{2}$/.test(String(f.release_date)) && !node.has("release_date")) {
      node.set("release_date", f.release_date); changed = true;
    }
    if (f.knowledge && !node.has("knowledge_cutoff")) { node.set("knowledge_cutoff", f.knowledge); changed = true; }
    if (typeof f.open_weights === "boolean" && !node.has("open_weights")) {
      node.set("open_weights", f.open_weights); changed = true;
    }
    if (f.family && !node.has("family")) { node.set("family", f.family); changed = true; }
    if (changed) enriched++;
  }
  await writeFile(CANONICAL_PATH, doc.toString());
  console.log(`enriched ${enriched} canonical models`);
}
await main();
