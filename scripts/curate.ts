// `bun run curate` — DRY-RUN curation reporter (v0 of the automated pipeline).
//
// Read-only. Fetches Artificial Analysis rankings + the OpenRouter catalog,
// applies curation/policy.yaml, and prints what WOULD be:
//   - onboarded   (AA top-N models we don't currently serve)
//   - deprecated  (served models that fell out of AA top-N, minus protected)
//   - saved       (served models a protected rule keeps despite low AA rank)
//   - unmapped    (high-AA models whose slug we couldn't map → alias candidates)
//
// It mutates nothing and opens no PR — this is the report a human (or, later,
// a bot PR) is built from. Ranking/protection math is deterministic here; the
// fuzzy AA-slug → canonical-id mapping is the part a future agent step assists.
//
// Ranking happens in AA space (all scored models, effort/reasoning variants
// collapsed to a base), so "top_n" is a true cut of AA's catalog. Each base is
// then mapped to a canonical id, preferring OUR canonical id over OpenRouter's
// so `-preview`-style drift doesn't show a served model as both deprecate+onboard.
//
// Requires AA_API_KEY (header x-api-key); Bun auto-loads .env.
//   bun run curate                 # full report
//   AA_API_KEY=... bun run curate  # one-off without persisting the key

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { loadCanonical, loadProviders, REGISTRY_ROOT } from "./schema";

const POLICY_PATH = join(REGISTRY_ROOT, "curation", "policy.yaml");
const AA_URL = "https://artificialanalysis.ai/api/v2/data/llms/models";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

// ── policy ──────────────────────────────────────────────────────────────
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
  aliases: z.record(z.string(), z.string()).default({}),
});
type Policy = z.infer<typeof Policy>;

async function loadPolicy(): Promise<Policy> {
  const raw = await readFile(POLICY_PATH, "utf8");
  return Policy.parse(parseYaml(raw) ?? {});
}

// ── http ────────────────────────────────────────────────────────────────
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw lastErr;
}

interface AAModel {
  slug: string;
  name: string;
  release_date?: string;
  model_creator?: { slug?: string; name?: string };
  evaluations?: Record<string, number | null>;
}

async function fetchAA(): Promise<AAModel[]> {
  const key = process.env.AA_API_KEY;
  if (!key) {
    console.error(
      "✗ AA_API_KEY not set. Put it in .env (or pass inline) — get one at https://artificialanalysis.ai/",
    );
    process.exit(2);
  }
  const r = await fetchWithRetry(AA_URL, {
    headers: { "x-api-key": key, Accept: "application/json" },
  });
  if (!r.ok) {
    console.error(`✗ AA API HTTP ${r.status} ${r.statusText}`);
    process.exit(2);
  }
  const body = (await r.json()) as { data?: AAModel[] };
  return body.data ?? [];
}

async function fetchOpenRouterIds(): Promise<Set<string>> {
  try {
    const r = await fetchWithRetry(OPENROUTER_URL, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const body = (await r.json()) as { data?: Array<{ id?: string }> };
    return new Set((body.data ?? []).map((m) => m.id).filter(Boolean) as string[]);
  } catch (err) {
    console.error(
      `! OpenRouter catalog unavailable (${(err as Error).message}) — id confirmation falls back to our canonical only`,
    );
    return new Set();
  }
}

// ── AA slug → base identity → canonical id ──────────────────────────────
// Effort/reasoning/adaptive variants collapse onto the base model; `thinking`
// is NOT stripped (it names distinct models, e.g. moonshotai/kimi-k2-thinking,
// so those stay separate and surface as alias candidates if ambiguous).
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

interface Resolved {
  id: string;
  source: "alias" | "canonical" | "canonical+preview" | "openrouter" | "openrouter+preview";
}

// Map a base slug+creator to a canonical id. Prefer OUR canonical id (incl. a
// soft `-preview` suffix) so a served model maps to itself before OpenRouter's
// possibly-renamed twin; fall back to OpenRouter for genuinely new models.
function mapBase(
  base: string,
  creator: string,
  policy: Policy,
  orIds: Set<string>,
  canonIds: Set<string>,
): Resolved | null {
  const alias = policy.aliases[base];
  if (alias) return { id: alias, source: "alias" };

  const model = base.replace(/(\d)-(\d)/g, "$1.$2"); // version hyphen → dot
  const org = policy.org_aliases[creator] ?? creator;
  if (!org || !model) return null;
  const cand = `${org}/${model}`;

  if (canonIds.has(cand)) return { id: cand, source: "canonical" };
  if (canonIds.has(`${cand}-preview`)) return { id: `${cand}-preview`, source: "canonical+preview" };
  if (orIds.has(cand)) return { id: cand, source: "openrouter" };
  if (orIds.has(`${cand}-preview`)) return { id: `${cand}-preview`, source: "openrouter+preview" };
  return null;
}

function globToRe(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// ── main ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const policy = await loadPolicy();
  const [aa, orIds, canon, providers] = await Promise.all([
    fetchAA(),
    fetchOpenRouterIds(),
    loadCanonical(),
    loadProviders(),
  ]);

  const canonIds = new Set(canon.map((m) => m.id));
  const ourOrgs = new Set([...canonIds].map((id) => id.split("/")[0]));

  const served = new Map<string, string[]>();
  for (const { data } of providers) {
    for (const m of data.models) {
      served.set(m.id, [...(served.get(m.id) ?? []), data.name]);
    }
  }

  const { intelligence_weight: wi, coding_weight: wc, top_n } = policy.ranking;
  const scoreOf = (m: AAModel): number | null => {
    const e = m.evaluations ?? {};
    const i = e.artificial_analysis_intelligence_index;
    const c = e.artificial_analysis_coding_index;
    return typeof i === "number" && typeof c === "number" ? wi * i + wc * c : null;
  };

  // Rank in AA space: collapse variants to a base identity, keep best score.
  interface Base {
    base: string;
    creator: string;
    score: number;
    release?: string;
  }
  const bases = new Map<string, Base>();
  for (const m of aa) {
    const score = scoreOf(m);
    if (score == null) continue;
    const creator = m.model_creator?.slug ?? "?";
    const base = baseSlug(m.slug);
    const key = `${creator}/${base}`;
    const cur = bases.get(key);
    if (!cur || score > cur.score) bases.set(key, { base, creator, score, release: m.release_date });
  }
  const aaRanked = [...bases.values()].sort((a, b) => b.score - a.score);
  const cutoffScore = aaRanked[Math.min(top_n, aaRanked.length) - 1]?.score ?? 0;

  // Map each ranked base → canonical id; keep the best (lowest) rank per id.
  interface CanonRank {
    rank: number;
    score: number;
    base: string;
    creator: string;
    source: Resolved["source"];
    release?: string;
  }
  const canonRank = new Map<string, CanonRank>();
  const unmappedRanked: Array<Base & { rank: number }> = [];
  aaRanked.forEach((b, i) => {
    const rank = i + 1;
    const res = mapBase(b.base, b.creator, policy, orIds, canonIds);
    if (!res) {
      unmappedRanked.push({ ...b, rank });
      return;
    }
    const cur = canonRank.get(res.id);
    if (!cur || rank < cur.rank) {
      canonRank.set(res.id, { rank, score: b.score, base: b.base, creator: b.creator, source: res.source, release: b.release });
    }
  });
  const keptIds = new Set([...canonRank].filter(([, v]) => v.rank <= top_n).map(([id]) => id));

  const protectedRes = policy.protected.map(globToRe);
  const isProtected = (id: string): boolean => protectedRes.some((re) => re.test(id));

  const depDate = new Date(Date.now() + policy.deprecation.grace_days * 86400000)
    .toISOString()
    .slice(0, 10);

  const bar = "─".repeat(80);
  console.log(`curation dry-run — AA top ${top_n} by ${wi}·intelligence + ${wc}·coding`);
  console.log(
    `AA models: ${aa.length} | ${aaRanked.length} base identities, ${canonRank.size} mapped to canonical | cutoff score: ${cutoffScore.toFixed(1)} | grace: ${policy.deprecation.grace_days}d`,
  );
  console.log(bar);

  // ── A. onboarding candidates (kept by AA, not served) ──
  const onboardOurs: CanonRank[] = [];
  const onboardNewOrg: CanonRank[] = [];
  for (const [id, v] of [...canonRank].filter(([, v]) => v.rank <= top_n).sort((a, b) => a[1].rank - b[1].rank)) {
    if (served.has(id)) continue;
    const entry = { ...v };
    (ourOrgs.has(id.split("/")[0]) ? onboardOurs : onboardNewOrg).push(Object.assign(entry, { id } as never));
  }
  console.log(`\n## ONBOARD — AA top ${top_n}, not served, org already in registry: ${onboardOurs.length}`);
  for (const r of onboardOurs as Array<CanonRank & { id: string }>) {
    const where = canonIds.has(r.id) ? "in canonical, unattached" : "NEW canonical";
    console.log(`  #${pad(String(r.rank), 3)} ${pad(r.id, 38)} ${pad(where, 24)} (AA:${r.base}, ${r.release ?? "?"})`);
  }
  const newOrgIds = (onboardNewOrg as Array<CanonRank & { id: string }>).map((r) => r.id);
  console.log(`\n   (+${newOrgIds.length} in AA top ${top_n} from orgs with no provider here: ${newOrgIds.slice(0, 10).join(", ")}${newOrgIds.length > 10 ? ", …" : ""})`);

  // ── B. deprecation candidates (served, fell out, not protected) ──
  const deprecate: Array<{ id: string; provs: string[]; rank?: number }> = [];
  const saved: Array<{ id: string; provs: string[]; rank?: number }> = [];
  for (const [id, provs] of served) {
    if (keptIds.has(id)) continue;
    const rank = canonRank.get(id)?.rank;
    (isProtected(id) ? saved : deprecate).push({ id, provs, rank });
  }
  deprecate.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  console.log(`\n## DEPRECATE — served but outside AA top ${top_n}, not protected: ${deprecate.length}`);
  console.log(`   (would set deprecation_date=${depDate} on these provider attachments)`);
  for (const d of deprecate) {
    const rk = d.rank ? `rank #${d.rank}` : "unranked/unmapped";
    console.log(`  ${pad(rk, 18)} ${pad(d.id, 38)} served by: ${d.provs.join(", ")}`);
  }

  // ── C. protected saves ──
  console.log(`\n## SAVED BY PROTECTED RULE — would deprecate, but kept: ${saved.length}`);
  for (const s of saved.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9))) {
    const rk = s.rank ? `AA rank #${s.rank}` : "not in AA mapped set";
    console.log(`  ${pad(rk, 22)} ${pad(s.id, 38)} (${s.provs.join(", ")})`);
  }

  // ── D. high-scoring unmapped (alias-table candidates) ──
  const aliasCandidates = unmappedRanked
    .filter((u) => u.rank <= top_n && ourOrgs.has(policy.org_aliases[u.creator] ?? u.creator))
    .sort((a, b) => a.rank - b.rank);
  console.log(`\n## UNMAPPED but in AA top ${top_n}, from orgs we serve — add to policy aliases: ${aliasCandidates.length}`);
  for (const u of aliasCandidates.slice(0, 15)) {
    console.log(`  #${pad(String(u.rank), 3)} ${pad(u.creator + "/" + u.base, 42)} score ${u.score.toFixed(1)} (${u.release ?? "?"})`);
  }

  console.log(`\n${bar}`);
  console.log(
    `summary: onboard ${onboardOurs.length} | deprecate ${deprecate.length} | protected-saves ${saved.length} | alias-gaps ${aliasCandidates.length}  — DRY RUN, nothing written`,
  );
}

await main();
