// `bun run curate` — AA-driven curation as a (near-)pure function.
//
//   resolve (default)  state = f(AA scores, crosswalk cache, canonical,
//                                providers, policy, as-of)
//                      Deterministic: crosswalk lookup first, then a pure
//                      mechanical slug normalization. NO fuzzy logic, no
//                      OpenRouter, no clock except the passed --as-of date.
//                      Prints onboard / deprecate / saved / unresolved.
//
//   suggest            For AA models the resolver left UNRESOLVED, propose
//                      crosswalk entries (mechanical guess, cross-checked
//                      against OpenRouter) as ready-to-paste YAML for review.
//                      This is the ONLY place intelligence/heuristics live;
//                      its output is committed to curation/crosswalk/aa.yaml
//                      and thereafter the resolver is a pure lookup.
//
// The design goal: every decision is reproducible from (data sources + cache).
// Judgment happens once (here, or by an agent), is frozen as data, and is never
// recomputed. Flags:
//   --as-of=YYYY-MM-DD   date used for deprecation_date (default: today)
//   --check              exit non-zero if a served/top-N model is unresolved
//   --all                (suggest) propose for every unmapped model, not just
//                        rank-relevant ones from orgs we serve
//
// Requires AA_API_KEY (header x-api-key); Bun auto-loads .env.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import { z } from "zod";
import {
  loadCanonical,
  loadProviders,
  providerPath,
  writeCanonicalFile,
  CanonicalModel,
  ProviderFile,
  ProviderModel,
  REGISTRY_ROOT,
} from "./schema";
import { loadCatalog, type Catalog, type CatalogModel } from "./catalog";

const POLICY_PATH = join(REGISTRY_ROOT, "curation", "policy.yaml");
const AA_CROSSWALK = join(REGISTRY_ROOT, "curation", "crosswalk", "aa.yaml");
const AA_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

// ── policy & crosswalk schemas ──────────────────────────────────────────
const Policy = z.object({
  ranking: z
    .object({
      intelligence_weight: z.number().default(0.5),
      coding_weight: z.number().default(0.5),
      top_n: z.number().int().positive().default(100),
    })
    .default({ intelligence_weight: 0.5, coding_weight: 0.5, top_n: 100 }),
  deprecation: z
    .object({ grace_days: z.number().int().positive().default(60) })
    .default({ grace_days: 60 }),
  protected: z.array(z.string()).default([]),
  org_aliases: z.record(z.string(), z.string()).default({}),
  // provider name → models.dev provider key, when they differ (e.g. stepfun)
  modelsdev_keys: z.record(z.string(), z.string()).default({}),
  // safety cap: never onboard more than this many canonical models per run
  max_onboard_per_run: z.number().int().positive().default(8),
});
type Policy = z.infer<typeof Policy>;

const Verdict = z
  .object({
    slug: z.string().optional(),
    canonical: z.string().optional(),
    collapse_of: z.string().optional(),
    ignore: z.string().optional(),
    by: z.string().optional(),
    date: z.string().optional(),
  })
  .refine(
    (v) => [v.canonical, v.collapse_of, v.ignore].filter((x) => x !== undefined).length === 1,
    { message: "each crosswalk entry needs exactly one of canonical|collapse_of|ignore" },
  );
type Verdict = z.infer<typeof Verdict>;
const Crosswalk = z.object({ entries: z.record(z.string(), Verdict).default({}) });

async function loadPolicy(): Promise<Policy> {
  return Policy.parse(parseYaml(await readFile(POLICY_PATH, "utf8")) ?? {});
}
async function loadCrosswalk(): Promise<Map<string, Verdict>> {
  if (!existsSync(AA_CROSSWALK)) return new Map();
  const parsed = Crosswalk.parse(parseYaml(await readFile(AA_CROSSWALK, "utf8")) ?? {});
  return new Map(Object.entries(parsed.entries));
}

// ── http ────────────────────────────────────────────────────────────────
async function fetchWithRetry(url: string, init: RequestInit, attempts = 4): Promise<Response> {
  let lastErr: unknown;
  let lastRes: Response | undefined;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if (res.status < 500) return res; // 2xx/4xx final; 5xx worth retrying
      lastRes = res;
    } catch (err) {
      lastErr = err;
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  if (lastRes) return lastRes;
  throw lastErr ?? new Error("fetch failed");
}

interface AAModel {
  id: string;
  slug: string;
  name: string;
  release_date?: string;
  model_creator?: { slug?: string; name?: string };
  evaluations?: Record<string, number | null>;
}

async function fetchAA(): Promise<AAModel[]> {
  const key = process.env.AA_API_KEY;
  if (!key) {
    console.error("✗ AA_API_KEY not set (put it in .env) — get one at https://artificialanalysis.ai/");
    process.exit(2);
  }
  const r = await fetchWithRetry(AA_URL, { headers: { "x-api-key": key, Accept: "application/json" } });
  if (!r.ok) {
    console.error(`✗ AA API HTTP ${r.status} ${r.statusText}`);
    process.exit(2);
  }
  return ((await r.json()) as { data?: AAModel[] }).data ?? [];
}

async function fetchOpenRouterIds(): Promise<Set<string>> {
  try {
    const r = await fetchWithRetry(OPENROUTER_URL, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    return new Set((body.data ?? []).map((m) => m.id).filter(Boolean) as string[]);
  } catch (err) {
    console.error(`! OpenRouter unavailable (${(err as Error).message})`);
    return new Set();
  }
}

// ── pure mechanical normalization (deterministic; no network, no fuzz) ───
// Strips effort/reasoning variants (NOT `thinking`, which names real models)
// and trailing dates, then version-hyphen → dot. This is a total pure function
// of the slug string; it is the fallback for AA models without a crosswalk
// entry. Where it is WRONG (word-order, `-it`, semantic collapse), a crosswalk
// entry overrides it.
const VARIANT = /-(non-reasoning|reasoning|adaptive|high|medium|low|minimal)$/;
const DATE_SUFFIX = /-\d{4,8}$/;
function baseSlug(slug: string): string {
  let s = slug;
  for (let i = 0; i < 4; i++) {
    const before = s;
    s = s.replace(DATE_SUFFIX, "").replace(VARIANT, "");
    if (s === before) break;
  }
  return s;
}
function mechanical(slug: string, creator: string, policy: Policy, canonIds: Set<string>): string | null {
  const model = baseSlug(slug).replace(/(\d)-(\d)/g, "$1.$2");
  const org = policy.org_aliases[creator] ?? creator;
  if (!org || !model) return null;
  const cand = `${org}/${model}`;
  if (canonIds.has(cand)) return cand;
  if (canonIds.has(`${cand}-preview`)) return `${cand}-preview`; // soft preview drift
  return null;
}

// ── resolution (pure) ───────────────────────────────────────────────────
type Resolution =
  | { kind: "canonical" | "collapse"; id: string; via: "crosswalk" }
  | { kind: "mechanical"; id: string; via: "mechanical" }
  | { kind: "ignore" }
  | { kind: "unresolved" };

function resolveModel(m: AAModel, crosswalk: Map<string, Verdict>, policy: Policy, canonIds: Set<string>): Resolution {
  const cw = crosswalk.get(m.id);
  if (cw) {
    if (cw.ignore !== undefined) return { kind: "ignore" };
    if (cw.canonical) return { kind: "canonical", id: cw.canonical, via: "crosswalk" };
    if (cw.collapse_of) return { kind: "collapse", id: cw.collapse_of, via: "crosswalk" };
  }
  const mech = mechanical(m.slug, m.model_creator?.slug ?? "", policy, canonIds);
  return mech ? { kind: "mechanical", id: mech, via: "mechanical" } : { kind: "unresolved" };
}

function globToRe(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
}
function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function scorer(policy: Policy) {
  const { intelligence_weight: wi, coding_weight: wc } = policy.ranking;
  return (m: AAModel): number | null => {
    const e = m.evaluations ?? {};
    const i = e.artificial_analysis_intelligence_index;
    const c = e.artificial_analysis_coding_index;
    return typeof i === "number" && typeof c === "number" ? wi * i + wc * c : null;
  };
}

// Shared ranking: every scored AA model collapses to a group — its canonical id
// (resolved) or a deterministic `aa:<creator>/<base>` slot (unresolved) so the
// denominator is honest. Returned sorted by score desc; rank = array index.
interface GroupInfo {
  key: string;
  isCanonical: boolean;
  score: number;
  creator: string;
  release?: string;
  bestModel: AAModel;
  onlyMechanical: boolean;
}
function buildGroups(
  aa: AAModel[],
  crosswalk: Map<string, Verdict>,
  policy: Policy,
  canonIds: Set<string>,
  score: (m: AAModel) => number | null,
): GroupInfo[] {
  const groups = new Map<string, GroupInfo>();
  for (const m of aa) {
    const sc = score(m);
    if (sc == null) continue;
    const res = resolveModel(m, crosswalk, policy, canonIds);
    if (res.kind === "ignore") continue;
    const isCanonical = res.kind !== "unresolved";
    const key = isCanonical
      ? (res as { id: string }).id
      : `aa:${m.model_creator?.slug ?? "?"}/${baseSlug(m.slug)}`;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, {
        key,
        isCanonical,
        score: sc,
        creator: m.model_creator?.slug ?? "?",
        release: m.release_date,
        bestModel: m,
        onlyMechanical: res.kind === "mechanical",
      });
    } else {
      if (sc > cur.score) {
        cur.score = sc;
        cur.bestModel = m;
        cur.release = m.release_date;
      }
      cur.onlyMechanical = cur.onlyMechanical && res.kind === "mechanical";
    }
  }
  return [...groups.values()].sort((a, b) => b.score - a.score);
}

// ── resolve command ─────────────────────────────────────────────────────
async function cmdResolve(opts: { asOf: string; check: boolean; topN?: number }): Promise<void> {
  const [policy, crosswalk, aa, canon, providers] = await Promise.all([
    loadPolicy(),
    loadCrosswalk(),
    fetchAA(),
    loadCanonical(),
    loadProviders(),
  ]);
  if (opts.topN && Number.isFinite(opts.topN)) policy.ranking.top_n = opts.topN;
  const canonIds = new Set(canon.map((m) => m.id));
  const ourOrgs = new Set([...canonIds].map((id) => id.split("/")[0]));
  const served = new Map<string, string[]>();
  for (const { data } of providers)
    for (const m of data.models) served.set(m.id, [...(served.get(m.id) ?? []), data.name]);

  const score = scorer(policy);
  const { top_n } = policy.ranking;

  const ranked = buildGroups(aa, crosswalk, policy, canonIds, score);
  const byKey = new Map(ranked.map((g) => [g.key, g]));
  const rankOf = new Map(ranked.map((g, i) => [g.key, i + 1]));
  const cutoff = ranked[Math.min(top_n, ranked.length) - 1]?.score ?? 0;
  const keptCanonical = new Set(ranked.slice(0, top_n).filter((g) => g.isCanonical).map((g) => g.key));

  const protectedRes = policy.protected.map(globToRe);
  const isProtected = (id: string) => protectedRes.some((re) => re.test(id));
  const depDate = new Date(`${opts.asOf}T00:00:00Z`);
  depDate.setUTCDate(depDate.getUTCDate() + policy.deprecation.grace_days);
  const depIso = depDate.toISOString().slice(0, 10);

  const bar = "─".repeat(80);
  console.log(`curate resolve — as-of ${opts.asOf} — AA top ${top_n} by ${policy.ranking.intelligence_weight}·int + ${policy.ranking.coding_weight}·cod`);
  console.log(`AA ${aa.length} models | ${ranked.length} groups | crosswalk ${crosswalk.size} entries | cutoff ${cutoff.toFixed(1)} | grace ${policy.deprecation.grace_days}d`);
  console.log(bar);

  // A. onboard — kept canonical id, in our canonical.yaml, not served
  const onboard = ranked
    .slice(0, top_n)
    .filter((g) => g.isCanonical && !served.has(g.key))
    .filter((g) => ourOrgs.has(g.key.split("/")[0]));
  console.log(`\n## ONBOARD — top ${top_n}, in canonical, not served: ${onboard.length}`);
  for (const g of onboard)
    console.log(`  #${pad(String(rankOf.get(g.key)), 3)} ${pad(g.key, 38)} (AA:${g.bestModel.slug}, ${g.release ?? "?"}${g.onlyMechanical ? ", mech" : ""})`);

  // B. deprecate — served, not kept, not protected
  const deprecate: Array<{ id: string; provs: string[]; rank?: number }> = [];
  const saved: Array<{ id: string; provs: string[]; rank?: number }> = [];
  for (const [id, provs] of served) {
    if (keptCanonical.has(id)) continue;
    (isProtected(id) ? saved : deprecate).push({ id, provs, rank: rankOf.get(id) });
  }
  deprecate.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  console.log(`\n## DEPRECATE — served, outside top ${top_n}, not protected: ${deprecate.length}`);
  console.log(`   (would set deprecation_date=${depIso})`);
  for (const d of deprecate)
    console.log(`  ${pad(d.rank ? `rank #${d.rank}` : "unresolved", 16)} ${pad(d.id, 38)} served by: ${d.provs.join(", ")}`);

  // C. protected saves
  console.log(`\n## SAVED BY PROTECTED RULE: ${saved.length}`);
  for (const s of saved.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9)))
    console.log(`  ${pad(s.rank ? `rank #${s.rank}` : "unresolved", 16)} ${pad(s.id, 38)} (${s.provs.join(", ")})`);

  // D. unresolved & rank-relevant from our orgs → crosswalk gaps
  const gaps = ranked
    .slice(0, top_n)
    .filter((g) => !g.isCanonical && ourOrgs.has(policy.org_aliases[g.creator] ?? g.creator));
  console.log(`\n## UNRESOLVED, top ${top_n}, our orgs → run \`curate suggest\`: ${gaps.length}`);
  for (const g of gaps.slice(0, 15))
    console.log(`  #${pad(String(rankOf.get(g.key)), 3)} ${pad(`${g.creator}/${baseSlug(g.bestModel.slug)}`, 42)} score ${g.score.toFixed(1)}`);

  // determinism note: served ids resolved only by the mechanical fallback
  const mechServed = [...served.keys()].filter((id) => byKey.get(id)?.onlyMechanical);
  if (mechServed.length)
    console.log(`\n   note: ${mechServed.length} served id(s) resolved by mechanical fallback (pin to crosswalk to freeze): ${mechServed.slice(0, 8).join(", ")}${mechServed.length > 8 ? ", …" : ""}`);

  console.log(`\n${bar}`);
  console.log(`summary: onboard ${onboard.length} | deprecate ${deprecate.length} | saved ${saved.length} | gaps ${gaps.length}  — DRY RUN, nothing written`);

  if (opts.check) {
    const servedUnresolved = [...served.keys()].filter((id) => !byKey.has(id));
    const fail = gaps.length > 0 || servedUnresolved.length > 0;
    if (fail) {
      console.error(`\n✗ --check: ${gaps.length} top-${top_n} gap(s), ${servedUnresolved.length} served id(s) with no AA mapping — resolve the crosswalk first`);
      process.exit(1);
    }
    console.error(`\n✓ --check: every served + top-${top_n} model from our orgs is resolved`);
  }
}

// ── suggest command (the only place heuristics run) ─────────────────────
async function cmdSuggest(opts: { all: boolean; pin: boolean }): Promise<void> {
  const [policy, crosswalk, aa, canon, orIds] = await Promise.all([
    loadPolicy(),
    loadCrosswalk(),
    fetchAA(),
    loadCanonical(),
    fetchOpenRouterIds(),
  ]);
  const canonIds = new Set(canon.map((m) => m.id));
  const ourOrgs = new Set([...canonIds].map((id) => id.split("/")[0]));
  const score = scorer(policy);
  const ourOrg = (creator: string) => ourOrgs.has(policy.org_aliases[creator] ?? creator);

  const emit = (m: AAModel, verdict: string) => {
    console.log(`  ${m.id}:`);
    console.log(`    slug: ${m.slug}`);
    console.log(`    ${verdict}`);
    console.log(`    by: heuristic`);
  };

  console.log("# proposed additions to curation/crosswalk/aa.yaml — review, then paste under `entries:`");
  console.log("# (by: heuristic; confirm the canonical id before committing)\n");
  let n = 0;

  if (opts.pin) {
    // Freeze the deterministic mechanical resolutions as explicit cache entries.
    for (const m of aa) {
      if (score(m) == null || crosswalk.has(m.id)) continue;
      if (!opts.all && !ourOrg(m.model_creator?.slug ?? "")) continue;
      const mech = mechanical(m.slug, m.model_creator?.slug ?? "", policy, canonIds);
      if (!mech) continue;
      emit(m, baseSlug(m.slug) === m.slug ? `canonical: ${mech}` : `collapse_of: ${mech}`);
      n++;
    }
  } else {
    // Default: the SAME gaps `resolve` reports — unresolved groups in the top_n
    // from orgs we serve (or all, with --all). One proposal per group.
    const ranked = buildGroups(aa, crosswalk, policy, canonIds, score);
    const top = opts.all ? ranked : ranked.slice(0, policy.ranking.top_n);
    for (const g of top.filter((g) => !g.isCanonical && (opts.all || ourOrg(g.creator)))) {
      const m = g.bestModel;
      const guess = `${policy.org_aliases[g.creator] ?? g.creator}/${baseSlug(m.slug).replace(/(\d)-(\d)/g, "$1.$2")}`;
      emit(
        m,
        orIds.has(guess)
          ? `canonical: ${guess}   # NEW — add to canonical.yaml first`
          : `ignore: TODO   # heuristic could not map; human/agent decide (maybe collapse_of an existing id)`,
      );
      n++;
    }
  }
  console.log(`\n# ${n} proposal(s).${opts.all ? "" : " --all = every org / below cutoff; --pin = freeze mechanically-resolved models."}`);
}

// ── apply command (verified-provider catalog sync) ──────────────────────
// The mutating path, scoped to `verified` providers (public-repo safe). It uses
// KEYLESS sources only: models.dev for each provider's catalog + pricing, and
// OpenRouter (also keyless) for canonical-id authority + metadata. For an
// AA-top-N model a verified provider actually serves (per models.dev), it adds
// the canonical entry, caches the AA→canonical judgment in the crosswalk, and
// attaches the model with models.dev pricing. Verified-provider models that
// fell out of AA top-N (and aren't protected) get a staged deprecation_date.
// Anonymous providers are never touched here.

interface ORModel {
  id: string;
  name?: string;
  context_length?: number;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
  top_provider?: { max_completion_tokens?: number };
}
async function fetchOpenRouterCatalog(): Promise<Map<string, ORModel>> {
  const r = await fetchWithRetry(OPENROUTER_URL, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`OpenRouter HTTP ${r.status}`);
  const body = (await r.json()) as { data?: ORModel[] };
  return new Map((body.data ?? []).map((m) => [m.id, m]));
}

function providerOrg(data: ProviderFile): string | null {
  const counts = new Map<string, number>();
  for (const m of data.models) {
    const org = m.id.split("/")[0]!;
    counts.set(org, (counts.get(org) ?? 0) + 1);
  }
  let best: string | null = null;
  let n = 0;
  for (const [org, c] of counts) if (c > n) ((best = org), (n = c));
  return best;
}
function canonicalFromOR(or: ORModel): z.infer<typeof CanonicalModel> {
  const allow = new Set(["text", "image", "audio"]);
  const inMod = (or.architecture?.input_modalities ?? ["text"]).filter((m) => allow.has(m));
  const outMod = (or.architecture?.output_modalities ?? ["text"]).filter((m) => m === "text" || m === "audio");
  return CanonicalModel.parse({
    id: or.id,
    name: or.name,
    input_modalities: inMod.length ? inMod : ["text"],
    output_modalities: outMod.length ? outMod : ["text"],
    max_input_tokens: or.context_length,
    max_output_tokens: or.top_provider?.max_completion_tokens,
  });
}
// models.dev `cost` is already per-1M tokens — the same convention as the yamls.
function pricingFromCost(cost?: CatalogModel["cost"]): ProviderModel["pricing"] {
  const clean = (x?: number) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : undefined);
  const input: Record<string, number> = {};
  if (clean(cost?.input) !== undefined) input.no_cache = cost!.input!;
  if (clean(cost?.cache_read) !== undefined) input.cache_read = cost!.cache_read!;
  if (clean(cost?.cache_write) !== undefined) input.cache_write = cost!.cache_write!;
  const out: Record<string, number> = {};
  if (clean(cost?.output) !== undefined) out.text = cost!.output!;
  const pricing: Record<string, unknown> = {};
  if (Object.keys(input).length) pricing.input_tokens = input;
  if (Object.keys(out).length) pricing.output_tokens = out;
  return Object.keys(pricing).length ? (pricing as ProviderModel["pricing"]) : undefined;
}

async function cmdApply(opts: { asOf: string; write: boolean; topN?: number }): Promise<void> {
  const [policy, crosswalk, aa, canon, providers] = await Promise.all([
    loadPolicy(),
    loadCrosswalk(),
    fetchAA(),
    loadCanonical(),
    loadProviders(),
  ]);
  if (opts.topN && Number.isFinite(opts.topN)) policy.ranking.top_n = opts.topN;
  let orCatalog: Map<string, ORModel>;
  let catalog: Catalog;
  try {
    [orCatalog, catalog] = await Promise.all([fetchOpenRouterCatalog(), loadCatalog()]);
  } catch (err) {
    console.error(`✗ ${(err as Error).message} — apply needs OpenRouter (id authority) + models.dev (catalogs/pricing)`);
    process.exit(2);
  }
  const canonIds = new Set(canon.map((m) => m.id));
  const ourOrgs = new Set([...canonIds].map((id) => id.split("/")[0]));
  const score = scorer(policy);
  const ranked = buildGroups(aa, crosswalk, policy, canonIds, score);
  const keptCanonical = new Set(ranked.slice(0, policy.ranking.top_n).filter((g) => g.isCanonical).map((g) => g.key));
  const protectedRes = policy.protected.map(globToRe);
  const isProtected = (id: string) => protectedRes.some((re) => re.test(id));

  // onboarding candidates: AA-top-N gap groups (our orgs) whose mechanical id is
  // a real OpenRouter id not yet in canonical — i.e. genuinely new models.
  interface OnboardTarget { id: string; uuid: string; slug: string }
  const targets: OnboardTarget[] = [];
  for (const g of ranked.slice(0, policy.ranking.top_n)) {
    if (g.isCanonical) continue;
    const org = policy.org_aliases[g.creator] ?? g.creator;
    if (!ourOrgs.has(org)) continue;
    const guess = `${org}/${baseSlug(g.bestModel.slug).replace(/(\d)-(\d)/g, "$1.$2")}`;
    if (orCatalog.has(guess) && !canonIds.has(guess)) targets.push({ id: guess, uuid: g.bestModel.id, slug: g.bestModel.slug });
  }

  const verified = providers.filter((p) => p.data.verified);
  // each verified provider's catalog from models.dev (keyless)
  const modelsDevKey = (name: string) => policy.modelsdev_keys[name] ?? name;
  const providerCatalog = new Map<string, CatalogModel[]>();
  for (const { data } of verified) {
    const key = modelsDevKey(data.name);
    const models = catalog.get(key);
    if (models) providerCatalog.set(data.name, [...models.values()]);
    console.error(`  ${data.name} (models.dev:${key}, ${providerOrg(data)}): ${models ? `${models.size} models` : "no catalog — skipped"}`);
  }

  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  // the models.dev model a verified provider serves for canonical `id`, or null
  const servesModel = (data: ProviderFile, providerName: string, id: string): CatalogModel | null => {
    if (providerOrg(data) !== id.split("/")[0]) return null;
    const needle = norm(id.split("/")[1]!);
    const models = providerCatalog.get(providerName) ?? [];
    // prefer an exact id match (e.g. `o4-mini`) over a dated snapshot
    return models.find((m) => norm(m.id) === needle) ?? models.find((m) => norm(m.id).includes(needle)) ?? null;
  };

  // build the change set
  const canonicalAdds: Array<z.infer<typeof CanonicalModel>> = [];
  const crosswalkAdds: Array<{ uuid: string; slug: string; id: string }> = [];
  const attaches = new Map<string, ProviderModel[]>();
  let onboarded = 0;
  for (const t of targets) {
    if (onboarded >= policy.max_onboard_per_run) break;
    const servers = verified
      .map((p) => ({ name: p.data.name, model: servesModel(p.data, p.data.name, t.id) }))
      .filter((s): s is { name: string; model: CatalogModel } => s.model !== null);
    if (servers.length === 0) continue; // only onboard models a verified provider actually serves
    canonicalAdds.push(canonicalFromOR(orCatalog.get(t.id)!));
    crosswalkAdds.push({ uuid: t.uuid, slug: t.slug, id: t.id });
    for (const s of servers) {
      attaches.set(s.name, [
        ...(attaches.get(s.name) ?? []),
        ProviderModel.parse({ id: t.id, provider_model_id: s.model.id, pricing: pricingFromCost(s.model.cost) }),
      ]);
    }
    onboarded++;
  }

  // deprecation staging for verified providers
  const deprecations: Array<{ provider: string; id: string }> = [];
  for (const { data } of verified) {
    for (const m of data.models) {
      if (keptCanonical.has(m.id) || isProtected(m.id) || m.deprecation_date) continue;
      // only deprecate something the provider org owns and AA ranks out
      deprecations.push({ provider: data.name, id: m.id });
    }
  }

  const depDate = new Date(`${opts.asOf}T00:00:00Z`);
  depDate.setUTCDate(depDate.getUTCDate() + policy.deprecation.grace_days);
  const depIso = depDate.toISOString().slice(0, 10);

  // report
  console.log(`\ncurate apply — as-of ${opts.asOf} — ${opts.write ? "WRITE" : "dry-run"} — verified providers only`);
  console.log(`onboard ${canonicalAdds.length} | attach ${[...attaches.values()].flat().length} | deprecate ${deprecations.length}`);
  for (const c of canonicalAdds) console.log(`  + canonical ${c.id}`);
  for (const [prov, ms] of attaches) for (const m of ms) console.log(`  + attach   ${prov} ← ${m.id} (${m.provider_model_id})`);
  for (const d of deprecations) console.log(`  ~ deprecate ${d.provider}/${d.id} → ${depIso}`);
  if (!canonicalAdds.length && !deprecations.length) console.log("  (nothing to do)");

  if (!opts.write) {
    console.log("\n(dry run — pass --write to apply)");
    return;
  }

  // apply: canonical (append) + crosswalk (append, preserve comments) + providers
  if (canonicalAdds.length) await writeCanonicalFile([...canon, ...canonicalAdds]);
  if (crosswalkAdds.length) {
    const doc = parseDocument(await readFile(AA_CROSSWALK, "utf8"));
    for (const e of crosswalkAdds)
      doc.setIn(["entries", e.uuid], { slug: e.slug, canonical: e.id, by: "automation", date: opts.asOf });
    await writeFile(AA_CROSSWALK, doc.toString());
  }
  const depByProvider = new Map<string, Set<string>>();
  for (const d of deprecations) depByProvider.set(d.provider, (depByProvider.get(d.provider) ?? new Set()).add(d.id));
  for (const { data } of verified) {
    const adds = attaches.get(data.name);
    const deps = depByProvider.get(data.name);
    if (!adds && !deps) continue;
    const doc = parseDocument(await readFile(providerPath(data.name), "utf8"));
    if (adds) for (const m of adds) doc.addIn(["models"], m);
    if (deps) {
      const seq = doc.getIn(["models"]) as { items: Array<{ get: (k: string) => unknown; set: (k: string, v: unknown) => void }> };
      for (const item of seq.items) if (deps.has(item.get("id") as string)) item.set("deprecation_date", depIso);
    }
    ProviderFile.parse(doc.toJSON()); // validate before writing
    await writeFile(providerPath(data.name), doc.toString());
  }
  console.log("\n✓ applied. Run `bun run validate` to confirm.");
}

// ── dispatch ────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv.find((a) => !a.startsWith("-")) ?? "resolve";
  const asOfArg = argv.find((a) => a.startsWith("--as-of="))?.split("=")[1];
  const asOf = asOfArg ?? new Date().toISOString().slice(0, 10);
  const topNArg = argv.find((a) => a.startsWith("--top-n="))?.split("=")[1];
  const topN = topNArg ? Number(topNArg) : undefined;
  if (cmd === "suggest") {
    await cmdSuggest({ all: argv.includes("--all"), pin: argv.includes("--pin") });
  } else if (cmd === "apply") {
    await cmdApply({ asOf, write: argv.includes("--write"), topN });
  } else {
    await cmdResolve({ asOf, check: argv.includes("--check"), topN });
  }
}

await main();
