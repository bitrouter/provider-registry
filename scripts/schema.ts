// Shared Zod schemas + file IO helpers for the bitrouter provider registry.
//
// All scripts in this repo (validate, manage, the GitHub Actions check)
// MUST parse YAML through the helpers exported here so the on-disk schema
// stays consistent. Anything the Rust consumer rejects is something the
// validator here must catch first.

import { readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";

// ── Primitive enums ─────────────────────────────────────────────────────

// Wire protocol the consumer uses to dispatch to this provider. The maker-name
// strings map onto spec-named transports (`openai`→Chat Completions,
// `anthropic`→Messages, `google`→Generate Content); `responses` selects the
// OpenAI Responses API for providers that serve it at the same base URL. Kept
// in lock-step with the Rust consumer's protocol mapping so a yaml it accepts
// also validates here.
export const ApiProtocol = z.enum(["openai", "anthropic", "google", "responses"]);
export type ApiProtocol = z.infer<typeof ApiProtocol>;

// Outbound credential scheme for the Messages (`anthropic`) transport:
// `x-api-key` (Anthropic's native scheme, the default) or `bearer`
// (`Authorization: Bearer`). The OpenAI and Google transports use a fixed
// scheme and ignore this. Mirrors the SDK's `AuthScheme` enum
// (bitrouter/bitrouter#516); kept in lock-step with the Rust consumer so a
// yaml the consumer accepts also validates here. Exactly one scheme is sent.
export const AuthScheme = z.enum(["x-api-key", "bearer"]);
export type AuthScheme = z.infer<typeof AuthScheme>;

// An API-agnostic flag for an optional inference feature a (provider, model)
// pair supports. Capabilities are deliberately abstract: the same capability
// maps to a different wire parameter in each inbound API (structured outputs =
// Chat Completions `response_format`, Messages `output_config.format`, Generate
// Content `responseSchema`, Responses `text.format`), so naming them after one
// API's parameter would mislead. Declared per (provider, model) because the same
// canonical model served by different channels can differ — an official API
// honours the schema; a reseller proxy may silently ignore it. Mirrors the SDK's
// `Capability` enum; kept in lock-step with the Rust consumer so a yaml the
// consumer accepts also validates here. A declared capability must be confirmed
// against the live provider by `scripts/verify-capabilities.ts`.
//
// The `*_input` / `*_output` modality capabilities mirror the SDK's multimodal
// support (LanguageModelV3 parity): the SDK derives the capabilities a request
// needs from its file parts (`image_input` for an `image/*` part, `audio_input`,
// `video_input`, else `file_input`) and its requested output modalities
// (`image_output`, `audio_output`), then routes only to providers advertising
// them. Like the other capabilities these are per-channel, not per-model: a
// reseller proxy can strip image parts or refuse an image-output request even
// when the underlying model is multimodal, so they too are verified live.
export const Capability = z.enum([
  "structured_outputs",
  "tools",
  "reasoning",
  "web_search",
  "logprobs",
  "image_input",
  "audio_input",
  "video_input",
  "file_input",
  "image_output",
  "audio_output",
]);
export type Capability = z.infer<typeof Capability>;

export const ProviderStatus = z.enum([
  "active",
  "staging",
  "suspended",
  "withdrawn",
]);

// The upstream catalog feed a provider's models are auto-synced from. We are the
// source of truth; this only tells the sync bot where to read. Omit the whole
// block for manual / source-of-truth providers.
export const AutoSyncFeed = z.enum(["models_dev", "v1_models"]);
export const AutoSyncWrite = z.enum(["models", "pricing"]);

export const AutoSync = z
  .object({
    feed: AutoSyncFeed,
    // models_dev only: their provider id when it differs from ours (default = our name).
    key: z.string().min(1).optional(),
    // v1_models only: catalog base when there's no api_base to reuse. HTTPS.
    url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), { message: "auto_sync.url must be HTTPS" })
      .optional(),
    // What the sync bot may write back. Defaults: [models, pricing] for models_dev,
    // [models] for v1_models (resolved by the sync script, not here).
    writes: z.array(AutoSyncWrite).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if (d.key !== undefined && d.feed !== "models_dev")
      ctx.addIssue({ code: "custom", path: ["key"], message: "`key` is only valid when feed=models_dev" });
    if (d.url !== undefined && d.feed !== "v1_models")
      ctx.addIssue({ code: "custom", path: ["url"], message: "`url` is only valid when feed=v1_models" });
  });
export type AutoSync = z.infer<typeof AutoSync>;
export type ProviderStatus = z.infer<typeof ProviderStatus>;

export const InputModality = z.enum(["text", "image", "audio"]);
export const OutputModality = z.enum(["text", "audio"]);

// ── Pattern entries ─────────────────────────────────────────────────────
// The YAML pattern shape is `- "<pattern>": <value>` — a one-key map per
// list entry. The Rust loader normalises this; we mirror it exactly so the
// validator catches drift (e.g. `- foo: bar\n  baz: qux` is rejected).

function patternEntry<T extends z.ZodTypeAny>(value: T) {
  return z
    .record(z.string(), value)
    .refine((m) => Object.keys(m).length === 1, {
      message: "pattern entry must have exactly one key",
    });
}

// ── Rate limits ─────────────────────────────────────────────────────────

export const RateLimits = z
  .object({
    requests_per_minute: z.number().int().positive().optional(),
    tokens_per_minute: z.number().int().positive().optional(),
  })
  .strict();
export type RateLimits = z.infer<typeof RateLimits>;

// ── Pricing ─────────────────────────────────────────────────────────────

const Price = z.number().nonnegative();

export const InputTokenPricing = z
  .object({
    no_cache: Price.optional(),
    cache_read: Price.optional(),
    cache_write: Price.optional(),
  })
  .strict();

export const OutputTokenPricing = z
  .object({
    text: Price.optional(),
    reasoning: Price.optional(),
  })
  .strict();

// A higher context-pricing bracket: a steeper per-token rate that applies
// once the prompt crosses a context-length threshold. The selected bracket's
// rates apply to the whole request (a step function, not graduated marginal
// brackets), chosen by the request's total input-token count. Mirrors the
// Rust consumer's `ContextTier`; kept in lock-step so a yaml the consumer
// accepts also validates here.
//
// Upstreams that publish such tiers: Alibaba Qwen Model Studio
// (https://help.aliyun.com/en/model-studio/models) and the Gemini API
// (https://ai.google.dev/gemini-api/docs/pricing).
export const ContextTier = z
  .object({
    // Exclusive lower bound on total input tokens. A request whose input size
    // is strictly greater than this enters the bracket; a request exactly at
    // the bound stays in the lower bracket (a base bracket documented as
    // "≤ 128k" is written as a tier with `above_input_tokens: 128000`).
    above_input_tokens: z.number().int().positive(),
    input_tokens: InputTokenPricing.optional(),
    output_tokens: OutputTokenPricing.optional(),
  })
  .strict();
export type ContextTier = z.infer<typeof ContextTier>;

export const ModelPricing = z
  .object({
    input_tokens: InputTokenPricing.optional(),
    output_tokens: OutputTokenPricing.optional(),
    // Optional higher context brackets. Empty/omitted ⇒ flat pricing. Kept in
    // lock-step with the Rust consumer's `ModelPricing.context_tiers` so a
    // yaml the consumer accepts also validates here. The consumer's
    // per-request bracket pick is order-independent, but the validator
    // additionally enforces the invariants below so malformed pricing is
    // caught here first.
    context_tiers: z.array(ContextTier).optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const tiers = data.context_tiers;
    if (!tiers || tiers.length === 0) return;

    // A tiered model must declare a complete base bracket — it is the
    // fallback for requests at or below the lowest threshold.
    if (
      data.input_tokens?.no_cache === undefined ||
      data.output_tokens?.text === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["context_tiers"],
        message:
          "context_tiers requires a complete base bracket (input_tokens.no_cache and output_tokens.text)",
      });
    }

    let prev: number | undefined;
    tiers.forEach((tier, i) => {
      // Each bracket must be billable on its own.
      if (
        tier.input_tokens?.no_cache === undefined ||
        tier.output_tokens?.text === undefined
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["context_tiers", i],
          message:
            "each context tier must set input_tokens.no_cache and output_tokens.text",
        });
      }
      // Thresholds strictly ascending (implies unique) so the ladder reads
      // unambiguously and the consumer's bracket pick is deterministic.
      if (prev !== undefined && tier.above_input_tokens <= prev) {
        ctx.addIssue({
          code: "custom",
          path: ["context_tiers", i, "above_input_tokens"],
          message: `above_input_tokens must strictly increase (got ${tier.above_input_tokens} after ${prev})`,
        });
      }
      prev = tier.above_input_tokens;
    });
  });
export type ModelPricing = z.infer<typeof ModelPricing>;

// ── Canonical model file ────────────────────────────────────────────────

// Canonical ids are huggingface-style `<org>/<model>` slugs aligned with
// the OpenRouter catalog (e.g. `anthropic/claude-sonnet-4.6`,
// `moonshotai/kimi-k2.6`, `google/gemini-3.1-pro-preview`). Both halves
// are lowercase alphanumerics plus `.`, `_`, `-`, must start and end with
// an alphanumeric, and are separated by exactly one `/`.
export const CanonicalModel = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?\/[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/,
        "canonical id must be a lowercase '<org>/<model>' slug",
      ),
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    input_modalities: z.array(InputModality).optional(),
    output_modalities: z.array(OutputModality).optional(),
    max_input_tokens: z.number().int().positive().optional(),
    max_output_tokens: z.number().int().positive().optional(),
    // Descriptive metadata from models.dev (never routing gates).
    release_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "release_date must be ISO YYYY-MM-DD")
      .optional(),
    knowledge_cutoff: z
      .string()
      .regex(/^\d{4}-\d{2}(-\d{2})?$/, "knowledge_cutoff must be ISO YYYY-MM or YYYY-MM-DD")
      .optional(),
    open_weights: z.boolean().optional(),
    family: z.string().min(1).optional(),
  })
  .strict();
export type CanonicalModel = z.infer<typeof CanonicalModel>;

export const CanonicalFile = z
  .object({
    models: z.array(CanonicalModel).min(1),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [i, m] of data.models.entries()) {
      if (seen.has(m.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "id"],
          message: `duplicate canonical model id '${m.id}'`,
        });
      }
      seen.add(m.id);
    }
  });

// ── Provider file ───────────────────────────────────────────────────────

export const ProviderModel = z
  .object({
    id: z.string().min(1),
    provider_model_id: z.string().min(1),
    api_protocol: ApiProtocol.optional(),
    pricing: ModelPricing.optional(),
    rate_limits: RateLimits.optional(),
    // Inference capabilities this (provider, model) pair supports beyond plain
    // completion — see `Capability`. Omitted/empty means none declared: the
    // router will not route a request that needs a capability to a
    // provider that doesn't list it, and `/v1/models` surfaces the union across
    // all providers of a canonical model.
    capabilities: z.array(Capability).optional(),
    deprecation_date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "deprecation_date must be ISO YYYY-MM-DD")
      .optional()
      .nullable(),
  })
  .strict();
export type ProviderModel = z.infer<typeof ProviderModel>;

export const ProviderFile = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9-]*$/,
        "provider name must be lowercase alphanumerics + hyphen, starting with a letter",
      ),
    api_protocol: z.array(patternEntry(ApiProtocol)).optional().default([]),
    rate_limits: z.array(patternEntry(RateLimits)).optional().default([]),
    // `models` may be empty in the management workflow ("create a stub,
    // attach models later"). The validator enforces a non-empty list for
    // any provider whose `status` is `active`; staging/suspended/withdrawn
    // entries are allowed to start empty.
    models: z.array(ProviderModel),
    status: ProviderStatus,
    weight: z.number().min(0).max(1).default(1.0),
    contact: z.string().email().optional(),
    submitted_at: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "submitted_at must be ISO YYYY-MM-DD")
      .optional(),
    // Marks an unaffiliated community reseller (vs a first-party / official
    // upstream, which is the unmarked default). Surfaced publicly on the
    // router's /v1/providers. Replaces the former `verified` flag — providers
    // are no longer anonymized, so the real name is always public.
    community: z.boolean().optional().default(false),
    // Whether callers may bring their own key (BYOK) for this provider.
    // Defaults `true` — BYOK is available for every provider that is open to
    // public self-registration. Set `false` only when a caller cannot obtain
    // their own key (e.g. our own pooled `bitrouter` provider, or an invite-only
    // aggregator). The router routes via its platform key when it holds one,
    // builds a BYOK placeholder (dispatched against `api_base`) when `byok` and
    // it holds none, and applies the BYOK overlay only when `byok`.
    byok: z.boolean().optional().default(true),
    // The provider's public upstream base URL — REQUIRED for every provider
    // (v2 transparency: endpoints are public, not held server-side). HTTPS only
    // — matches the router's `validate_upstream_base` guard so a yaml that passes
    // the validator can never be rejected at routing time. A `byok_only` caller
    // may still override it per-request via their own BYOK `api_base`.
    api_base: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), {
        message: "api_base must be an HTTPS URL",
      }),
    // Outbound credential scheme for this provider's Messages (`anthropic`)
    // requests — see `AuthScheme`. Optional; omitted means `x-api-key`
    // (Anthropic's native default), matching the Rust consumer's serde
    // default. Ignored for OpenAI/Google providers.
    auth_scheme: AuthScheme.optional().default("x-api-key"),
    // Optional upstream feed for catalog auto-sync — see `AutoSync`. Omit for
    // manual / source-of-truth providers (the role `verified` played in gating
    // a provider out of the curation pipeline).
    auto_sync: AutoSync.optional(),
  })
  .strict()
  .superRefine((data, ctx) => {
    const seen = new Set<string>();
    for (const [i, m] of data.models.entries()) {
      if (seen.has(m.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["models", i, "id"],
          message: `provider declares canonical id '${m.id}' twice`,
        });
      }
      seen.add(m.id);
    }
  });
export type ProviderFile = z.infer<typeof ProviderFile>;

// ── File-system helpers ─────────────────────────────────────────────────

export const REGISTRY_ROOT = resolve(import.meta.dir, "..");
export const CANONICAL_PATH = join(REGISTRY_ROOT, "canonical.yaml");
export const PROVIDERS_DIR = join(REGISTRY_ROOT, "providers");

export interface LoadedRegistry {
  canonical: CanonicalModel[];
  providers: Array<{ path: string; data: ProviderFile }>;
}

export async function loadCanonical(): Promise<CanonicalModel[]> {
  const raw = await readFile(CANONICAL_PATH, "utf8");
  const parsed = CanonicalFile.parse(parseYaml(raw));
  return parsed.models;
}

export async function loadProviders(): Promise<
  Array<{ path: string; data: ProviderFile }>
> {
  if (!existsSync(PROVIDERS_DIR)) return [];
  const entries = (await readdir(PROVIDERS_DIR)).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  const out: Array<{ path: string; data: ProviderFile }> = [];
  for (const entry of entries.sort()) {
    const path = join(PROVIDERS_DIR, entry);
    const raw = await readFile(path, "utf8");
    out.push({ path, data: ProviderFile.parse(parseYaml(raw)) });
  }
  return out;
}

export async function loadRegistry(): Promise<LoadedRegistry> {
  const [canonical, providers] = await Promise.all([
    loadCanonical(),
    loadProviders(),
  ]);
  return { canonical, providers };
}

export function providerPath(name: string): string {
  return join(PROVIDERS_DIR, `${name}.yaml`);
}

export async function writeProviderFile(
  name: string,
  data: ProviderFile,
): Promise<string> {
  // Validate before writing so a typo in the management script can't
  // produce an invalid YAML file on disk.
  const parsed = ProviderFile.parse(data);
  const path = providerPath(name);
  const body = stringifyYaml(parsed, { indent: 2, lineWidth: 100 });
  await writeFile(path, body, "utf8");
  return path;
}

export async function writeCanonicalFile(
  models: CanonicalModel[],
): Promise<string> {
  const parsed = CanonicalFile.parse({ models });
  const body = stringifyYaml(parsed, { indent: 2, lineWidth: 100 });
  await writeFile(CANONICAL_PATH, body, "utf8");
  return CANONICAL_PATH;
}

// ── Cross-file invariants ───────────────────────────────────────────────

export interface RegistryIssue {
  file: string;
  message: string;
}

/** Returns the empty array iff the loaded registry is internally consistent. */
export function crossFileIssues(reg: LoadedRegistry): RegistryIssue[] {
  const issues: RegistryIssue[] = [];
  const canonicalIds = new Set(reg.canonical.map((m) => m.id));

  // Active providers must declare at least one model — only staging /
  // suspended / withdrawn entries may sit empty.
  for (const { path, data } of reg.providers) {
    if (data.status === "active" && data.models.length === 0) {
      issues.push({
        file: path,
        message: `provider '${data.name}' is active but declares no models`,
      });
    }
  }

  // Every provider model must reference a known canonical id.
  for (const { path, data } of reg.providers) {
    for (const m of data.models) {
      if (!canonicalIds.has(m.id)) {
        issues.push({
          file: path,
          message: `model '${m.id}' (provider_model_id=${m.provider_model_id}) is not declared in canonical.yaml`,
        });
      }
    }
  }

  // Filename must match the declared `name` field.
  for (const { path, data } of reg.providers) {
    const expected = `${data.name}.yaml`;
    if (basename(path) !== expected) {
      issues.push({
        file: path,
        message: `filename does not match provider name '${data.name}' (expected ${expected})`,
      });
    }
  }

  // No two provider files may share the same `name`.
  const seenNames = new Map<string, string>();
  for (const { path, data } of reg.providers) {
    const prior = seenNames.get(data.name);
    if (prior !== undefined) {
      issues.push({
        file: path,
        message: `provider name '${data.name}' is also declared in ${prior}`,
      });
    } else {
      seenNames.set(data.name, path);
    }
  }

  return issues;
}
