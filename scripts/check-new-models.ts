// `bun run check-new-models` — find which providers already serve the
// freshly-added canonical models, and (optionally) attach them.
//
// For each canonical id in TARGETS this probes every provider's live
// `/models` catalog and reports whether the upstream serves a matching
// model id. Pricing for a match is resolved as:
//
//   1. the provider's own catalog entry, if it publishes per-token rates
//      (OpenRouter-shaped `pricing.{prompt,completion,input_cache_*}`);
//   2. otherwise OpenRouter's published price for that canonical id, used
//      as the default (per the registry's "OpenRouter is the authority"
//      rule). Resellers may price below list, so review before shipping.
//
// By default this is a dry run: it prints the resolved pricing and the
// equivalent `manage add-model` command. Pass `--write` to actually append
// each not-yet-declared match to the provider yaml (validated on write).
//
// Base-URL resolution (BYOK providers only need a *key*, not a base):
//   1. {NAME}_API_BASE env        2. PROVIDER_BASE_OVERRIDES=name=url
//   3. provider yaml default_api_base   4. PUBLIC_BASES below
//
// Auth uses {NAME}_API_KEY. Providers with neither a key nor a public
// catalog are skipped (so a half-filled .env just probes what it can).
//
// Usage:
//   bun run check-new-models                 # dry run, every provider
//   bun run check-new-models --write         # attach the matches
//   bun run check-new-models anon-a worldrouter   # subset by name

import {
  loadProviders,
  writeProviderFile,
  type ProviderFile,
  type ProviderModel,
} from "./schema";

// ── what we're hunting for ──────────────────────────────────────────────
// `needles` are matched against each live model id after normalisation
// (lowercase, strip every non-alphanumeric).
interface Target {
  id: string;
  needles: string[];
}

const TARGETS: Target[] = [
  { id: "anthropic/claude-opus-4.8", needles: ["opus48"] },
  { id: "minimax/minimax-m3", needles: ["minimaxm3"] },
  { id: "stepfun/step-3.7-flash", needles: ["step37flash"] },
  // Already in canonical (served by alibaba) — kept here so the probe also
  // surfaces any *other* provider that has since started serving it.
  { id: "qwen/qwen3.7-max", needles: ["qwen37max"] },
];

// Documented public catalogs whose base URL is not stored in the yaml
// (these providers are not BYOK, so they carry no `default_api_base`).
const PUBLIC_BASES: Record<string, string> = {
  chutes: "https://llm.chutes.ai/v1",
  ionet: "https://api.intelligence.io.solutions/api/v1",
};

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface Pricing {
  no_cache?: number;
  cache_read?: number;
  cache_write?: number;
  output?: number;
}

function envName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function pickEnv(name: string, suffix: string): string | undefined {
  return process.env[`${envName(name)}_${suffix}`];
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// per-token (OpenRouter convention) → per-1M tokens (registry convention),
// rounded to 6 decimals to shed floating-point noise.
function perMillion(perToken: unknown): number | undefined {
  if (perToken === undefined || perToken === null || perToken === "")
    return undefined;
  const n = Number(perToken);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.round(n * 1e12) / 1e6;
}

function resolveBase(
  data: ProviderFile,
  overrides: Map<string, string>,
): string | undefined {
  return (
    pickEnv(data.name, "API_BASE") ??
    overrides.get(data.name) ??
    data.default_api_base ??
    PUBLIC_BASES[data.name]
  );
}

interface LiveModel {
  id: string;
  raw: Record<string, unknown>;
}

type Protocol = "openai" | "anthropic" | "google";

// The provider's wire protocol determines how `/models` is authenticated.
function defaultProtocol(data: ProviderFile): Protocol {
  for (const entry of data.api_protocol ?? []) {
    const v = entry["*"];
    if (v === "openai" || v === "anthropic" || v === "google") return v;
  }
  return "openai";
}

// Retry transient connection failures (e.g. "socket closed unexpectedly").
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

async function fetchCatalog(
  base: string,
  apiKey: string | undefined,
  protocol: Protocol,
): Promise<{ ok: true; models: LiveModel[] } | { ok: false; reason: string }> {
  let url = `${base.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) {
    if (protocol === "anthropic") {
      // Anthropic wire protocol authenticates with x-api-key + a version
      // header — a Bearer token is rejected (minimax, api.anthropic.com).
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
    } else if (protocol === "google") {
      // Gemini's list endpoint takes the key as a query parameter.
      url += `?key=${encodeURIComponent(apiKey)}`;
    } else {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }
  let response: Response;
  try {
    response = await fetchWithRetry(url, { headers });
  } catch (err) {
    return { ok: false, reason: `network error: ${(err as Error).message}` };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 160)}` : ""}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: false, reason: `body parse error: ${(err as Error).message}` };
  }
  let list: unknown[] = [];
  if (Array.isArray(body)) list = body;
  else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.data)) list = obj.data;
    else if (Array.isArray(obj.models)) list = obj.models;
  }
  const models: LiveModel[] = [];
  for (const entry of list) {
    if (entry && typeof entry === "object") {
      const obj = entry as Record<string, unknown>;
      // OpenAI/Anthropic use `id`; Gemini uses `name` ("models/gemini-…").
      const id =
        typeof obj.id === "string"
          ? obj.id
          : typeof obj.name === "string"
            ? obj.name
            : undefined;
      if (id) models.push({ id, raw: obj });
    } else if (typeof entry === "string") {
      models.push({ id: entry, raw: {} });
    }
  }
  return { ok: true, models };
}

// OpenRouter's per-token price for each target → per-1M default.
async function fetchOpenRouterPricing(
  ids: Set<string>,
): Promise<Map<string, Pricing>> {
  const map = new Map<string, Pricing>();
  let body: { data?: Array<Record<string, unknown>> };
  try {
    const r = await fetchWithRetry(OPENROUTER_MODELS_URL, {
      headers: { Accept: "application/json" },
    });
    if (!r.ok) {
      console.log(`! OpenRouter pricing unavailable (HTTP ${r.status}) — defaults skipped`);
      return map;
    }
    body = (await r.json()) as typeof body;
  } catch (err) {
    console.log(`! OpenRouter pricing unavailable (${(err as Error).message}) — defaults skipped`);
    return map;
  }
  for (const m of body.data ?? []) {
    const id = m.id as string;
    if (!ids.has(id)) continue;
    const p = (m.pricing ?? {}) as Record<string, unknown>;
    map.set(id, {
      no_cache: perMillion(p.prompt),
      cache_read: perMillion(p.input_cache_read),
      cache_write: perMillion(p.input_cache_write),
      output: perMillion(p.completion),
    });
  }
  return map;
}

// A provider catalog entry that carries OpenRouter-shaped per-token rates.
function providerPricing(raw: Record<string, unknown>): Pricing | null {
  const p = raw.pricing;
  if (!p || typeof p !== "object") return null;
  const o = p as Record<string, unknown>;
  const no_cache = perMillion(o.prompt);
  const output = perMillion(o.completion);
  if (no_cache === undefined && output === undefined) return null;
  return {
    no_cache,
    cache_read: perMillion(o.input_cache_read),
    cache_write: perMillion(o.input_cache_write),
    output,
  };
}

function toModelPricing(pr: Pricing): ProviderModel["pricing"] {
  const input: Record<string, number> = {};
  if (pr.no_cache !== undefined) input.no_cache = pr.no_cache;
  if (pr.cache_read !== undefined) input.cache_read = pr.cache_read;
  if (pr.cache_write !== undefined) input.cache_write = pr.cache_write;
  const output: Record<string, number> = {};
  if (pr.output !== undefined) output.text = pr.output;
  const pricing: Record<string, unknown> = {};
  if (Object.keys(input).length) pricing.input_tokens = input;
  if (Object.keys(output).length) pricing.output_tokens = output;
  return Object.keys(pricing).length
    ? (pricing as ProviderModel["pricing"])
    : undefined;
}

function addModelCmd(
  provider: string,
  id: string,
  pmid: string,
  pr: Pricing,
): string {
  const parts = [`bun run manage add-model ${provider} ${id} ${pmid}`];
  if (pr.no_cache !== undefined) parts.push(`--no-cache ${pr.no_cache}`);
  if (pr.cache_read !== undefined) parts.push(`--cache-read ${pr.cache_read}`);
  if (pr.cache_write !== undefined) parts.push(`--cache-write ${pr.cache_write}`);
  if (pr.output !== undefined) parts.push(`--output ${pr.output}`);
  return parts.join(" ");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const write = args.includes("--write");
  const selected = new Set(args.filter((a) => !a.startsWith("-")));

  const overrides = new Map<string, string>();
  for (const part of (process.env.PROVIDER_BASE_OVERRIDES ?? "").split(",")) {
    const [k, v] = part.split("=", 2);
    if (k && v) overrides.set(k.trim(), v.trim());
  }

  // Probe an alternate wire protocol without editing the yaml — e.g. point
  // minimax at its OpenAI-compatible endpoint:
  //   PROVIDER_BASE_OVERRIDES=minimax=https://api.minimax.io/v1 \
  //   PROVIDER_PROTOCOL_OVERRIDES=minimax=openai bun run check-new-models minimax
  const protocolOverrides = new Map<string, Protocol>();
  for (const part of (process.env.PROVIDER_PROTOCOL_OVERRIDES ?? "").split(",")) {
    const [k, v] = part.split("=", 2);
    if (k && (v === "openai" || v === "anthropic" || v === "google")) {
      protocolOverrides.set(k.trim(), v.trim() as Protocol);
    }
  }

  const targetIds = new Set(TARGETS.map((t) => t.id));
  const orPricing = await fetchOpenRouterPricing(targetIds);

  const providers = await loadProviders();
  const hits = new Map<string, string[]>();
  for (const t of TARGETS) hits.set(t.id, []);
  // name → models to append, accumulated for a single write per provider.
  const pending = new Map<string, ProviderModel[]>();

  for (const { data } of providers) {
    if (selected.size > 0 && !selected.has(data.name)) continue;

    const apiKey = pickEnv(data.name, "API_KEY");
    const isPublic = data.name in PUBLIC_BASES;
    if (!apiKey && !isPublic) {
      console.log(`## ${data.name}: no API key — skipped`);
      console.log();
      continue;
    }
    const base = resolveBase(data, overrides);
    if (!base) {
      console.log(
        `## ${data.name}: no base URL — set ${envName(data.name)}_API_BASE`,
      );
      console.log();
      continue;
    }

    const protocol = protocolOverrides.get(data.name) ?? defaultProtocol(data);
    const auth = apiKey ? "authenticated" : "unauthenticated";
    console.log(`## ${data.name}  (${auth}, ${protocol}, ${base})`);
    const result = await fetchCatalog(base, apiKey, protocol);
    if (!result.ok) {
      console.log(`   ✗ ${result.reason}`);
      console.log();
      continue;
    }

    const normalized = result.models.map((m) => ({ ...m, n: norm(m.id) }));
    for (const t of TARGETS) {
      const already = data.models.some((m) => m.id === t.id);
      const match = normalized.find((m) =>
        t.needles.some((needle) => m.n.includes(needle)),
      );
      if (!match) continue;

      hits.get(t.id)!.push(`${data.name} (${match.id})`);
      if (already) {
        console.log(`   • ${t.id}: already declared → ${match.id}`);
        continue;
      }

      const fromCatalog = providerPricing(match.raw);
      const pr = fromCatalog ?? orPricing.get(t.id) ?? {};
      const source = fromCatalog
        ? "provider catalog"
        : orPricing.has(t.id)
          ? "OpenRouter default"
          : "none (no pricing found)";
      console.log(`   ✓ ${t.id}: served as '${match.id}'  [pricing: ${source}]`);
      console.log(`       ${addModelCmd(data.name, t.id, match.id, pr)}`);

      if (write) {
        pending.set(data.name, [
          ...(pending.get(data.name) ?? []),
          { id: t.id, provider_model_id: match.id, pricing: toModelPricing(pr) },
        ]);
      }
    }
    console.log();
  }

  if (write && pending.size > 0) {
    console.log("─".repeat(70));
    console.log("writing attachments:");
    for (const { data } of providers) {
      const additions = pending.get(data.name);
      if (!additions) continue;
      const updated: ProviderFile = {
        ...data,
        models: [...data.models, ...additions],
      };
      const path = await writeProviderFile(data.name, updated);
      console.log(`  ✓ ${data.name}: +${additions.map((m) => m.id).join(", ")} → ${path}`);
    }
  }

  console.log("─".repeat(70));
  console.log("summary — providers serving each target model:");
  for (const t of TARGETS) {
    const found = hits.get(t.id)!;
    console.log(`  ${t.id}: ${found.length ? found.join(", ") : "(none found)"}`);
  }
  if (!write && hits.size > 0) {
    console.log("\n(dry run — re-run with --write to attach the matches above)");
  }
}

await main();
