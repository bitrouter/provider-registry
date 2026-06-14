// scripts/migrate-v2.ts — one-shot v1→v2 provider migration. Idempotent.
// Reads the YAML files RAW (not via loadProviders) because the now-strict v2
// schema rejects the on-disk `verified` field this script is migrating away.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { PROVIDERS_DIR } from "./schema";

type Feed = { feed: "models_dev" | "v1_models"; key?: string; url?: string };
const COMMUNITY = new Set(["chutes", "ionet", "akashml", "redpill", "tinfoil", "worldrouter"]);
// Use the models.dev feed for every provider models.dev catalogs (key = the
// models.dev provider id when it differs from ours). Only providers models.dev
// does NOT have — akashml/redpill/tinfoil/worldrouter and our own `bitrouter`
// pool — stay manual (no auto_sync block). No `v1_models` feeds are needed today
// (chutes + io-net are both on models.dev).
const AUTO_SYNC: Record<string, Feed> = {
  anthropic: { feed: "models_dev" }, openai: { feed: "models_dev" }, google: { feed: "models_dev" },
  deepseek: { feed: "models_dev" }, alibaba: { feed: "models_dev" }, moonshotai: { feed: "models_dev" },
  zai: { feed: "models_dev" }, minimax: { feed: "models_dev" }, xai: { feed: "models_dev" },
  xiaomi: { feed: "models_dev" }, stepfun: { feed: "models_dev", key: "stepfun-ai" },
  chutes: { feed: "models_dev" }, ionet: { feed: "models_dev", key: "io-net" },
  // tencent stays MANUAL: models.dev's tencent-tokenhub catalog (1 model) is not
  // our TokenHub provider's; its models + prices are curated by hand.
  "alibaba-coding-plan": { feed: "models_dev" },
  "zai-coding-plan": { feed: "models_dev" },
  "moonshotai-coding-plan": { feed: "models_dev", key: "kimi-for-coding" },
};

async function main() {
  const files = (await readdir(PROVIDERS_DIR)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    const name = file.replace(/\.ya?ml$/, "");
    if (name === "anon-b") continue; // deleted in Task 5
    const path = join(PROVIDERS_DIR, file);
    const doc = parseDocument(await readFile(path, "utf8"));
    doc.delete("verified");
    if (COMMUNITY.has(name)) doc.set("community", true);
    if (AUTO_SYNC[name]) doc.set("auto_sync", AUTO_SYNC[name]);
    await writeFile(path, doc.toString());
    console.log(`migrated ${name}`);
  }
}
await main();
