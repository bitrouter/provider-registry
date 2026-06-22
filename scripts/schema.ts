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

// An ordered set of wire protocols for one pattern or model: a bare string
// (single protocol) or a non-empty array, most-preferred first. Lets a provider
// advertise e.g. `[openai, responses]` so a consumer can route a native
// Responses request without translation. Mirrors the SDK's `ProtocolList`; kept
// in lock-step with the Rust consumers.
export const ProtocolList = z.union([ApiProtocol, z.array(ApiProtocol).min(1)]);
export type ProtocolList = z.infer<typeof ProtocolList>;

// How a consumer places the outbound credential. `bearer` / `header` are
// static-credential schemes (the credential is read from `env`); `oauth` /
// `native` reference a `handler` implemented IN the consumer (device/auth-code
// flow, SigV4, …) — only the handler NAME and public params live here, never a
// secret. Mirrors the SDK's `AuthScheme`; kept in lock-step with the consumers.
export const AuthKind = z.enum(["bearer", "header", "oauth", "native"]);
export type AuthKind = z.infer<typeof AuthKind>;

export const Auth = z
  .object({
    kind: AuthKind,
    // Env var holding the credential (bearer/header). Public config, not a secret.
    env: z.string().min(1).optional(),
    // Header carrying the credential (header kind), e.g. `x-api-key`.
    header: z.string().min(1).optional(),
    // Constant headers sent alongside the credential (e.g. an API-version pin).
    extra_headers: z.record(z.string(), z.string()).optional(),
    // Named handler in the consumer's registry (oauth/native), e.g.
    // `github_copilot_device_code`. The implementation lives in the consumer.
    handler: z.string().min(1).optional(),
    // Handler-specific PUBLIC params (client_id, scopes, endpoints). No secrets.
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((d, ctx) => {
    if ((d.kind === "bearer" || d.kind === "header") && d.env === undefined)
      ctx.addIssue({ code: "custom", path: ["env"], message: `${d.kind} auth requires \`env\`` });
    if (d.kind === "header" && d.header === undefined)
      ctx.addIssue({ code: "custom", path: ["header"], message: "header auth requires `header`" });
    if ((d.kind === "oauth" || d.kind === "native") && d.handler === undefined)
      ctx.addIssue({ code: "custom", path: ["handler"], message: `${d.kind} auth requires \`handler\`` });
  });
export type Auth = z.infer<typeof Auth>;

// What kind of provider this is — drives the consumer's routing-priority class
// and poolability. `first_party` = official upstream; `gateway` = an aggregator
// fronting other makers' models; `cloud` = the bitrouter pool; `third_party` =
// community reseller. A consumer pools only key-auth first/third-party
// providers — never `gateway` / `cloud` / `oauth` / `native`.
export const ProviderKind = z.enum(["first_party", "gateway", "cloud", "third_party"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

// How a caller obtains access to a provider — the registration / credential
// *obtainment* model (orthogonal to `auth.kind`, which is wire placement).
// Replaces the coarse `byok` boolean and lets consumers act on the distinction:
//
//   - `api_key`     public self-registration → a portable API key. The cloud
//                   console BYOK page lists ONLY these; the platform can pool
//                   them with its own key; the OSS auto-enables on the env key.
//   - `local_oauth` public, but credentials are minted by a browser/device
//                   OAuth flow run locally (e.g. GitHub Copilot device flow).
//                   No portable key → the cloud cannot BYOK or pool it; the OSS
//                   obtains it via `bitrouter login <provider>`.
//   - `local_pkce`  public, but credentials come from a local OAuth+PKCE flow
//                   (e.g. OpenAI Codex against a ChatGPT subscription). Same
//                   consumer consequences as `local_oauth`.
//   - `private`     no public registration — platform-pooled / invite-only
//                   (the bitrouter pool, an anonymous aggregator). Never BYOK.
//
// `byok` is now a derived alias: `byok === (access === "api_key")`. The dist
// still emits it for back-compat with consumers that have not migrated.
export const Access = z.enum(["api_key", "local_oauth", "local_pkce", "private"]);
export type Access = z.infer<typeof Access>;

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

// How a caller pays this provider for inference. `token` = pay-as-you-go,
// metered per token against an API key (the common case). `subscription` =
// a flat-rate plan (e.g. a first-party "coding plan") whose key unlocks a
// fixed quota rather than per-token billing. Purely descriptive — it does
// not gate routing — but consumers use it together with `community` to rank
// provider preference (a first-party subscription a caller already pays for
// is cheaper at the margin than the same models billed per token). Defaults
// `token`; set `subscription` only for flat-rate plans.
export const Billing = z.enum(["token", "subscription"]);
export type Billing = z.infer<typeof Billing>;

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
    api_protocol: ProtocolList.optional(),
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
    // Wire protocol per model-id glob. Each value is a `ProtocolList` — a bare
    // string or an ordered set (e.g. `[openai, responses]`) — so a provider can
    // advertise native multi-protocol support. Longest matching glob wins;
    // `build-dist` resolves it per (provider, model).
    api_protocol: z.array(patternEntry(ProtocolList)).optional().default([]),
    rate_limits: z.array(patternEntry(RateLimits)).optional().default([]),
    // Per-protocol base-URL override, keyed by protocol name — for a provider
    // that serves different protocols at different paths under one host (e.g.
    // OpenAI-style under `/v1`, Messages under `/anthropic`). HTTPS only.
    protocol_endpoints: z
      .record(
        z.string(),
        z
          .string()
          .url()
          .refine((u) => u.startsWith("https://"), {
            message: "protocol_endpoints URLs must be HTTPS",
          }),
      )
      .optional(),
    // `models` may be empty in the management workflow ("create a stub,
    // attach models later") and for runtime-discovered providers. The validator
    // enforces a non-empty list for an `active` provider unless it declares an
    // `auto_sync` feed (the catalog comes from that channel — see `auto_sync`
    // below); staging/suspended/withdrawn entries may start empty.
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
    // How a caller obtains access to this provider — see `Access`. Defaults
    // `api_key` (public self-registration → a portable key, the BYOK case).
    // Set `local_oauth` / `local_pkce` for providers whose credentials are
    // minted by a local interactive flow (no portable key), and `private` for
    // platform-pooled / invite-only providers with no public registration.
    // Supersedes the old `byok` boolean (now derived: `byok` iff `api_key`).
    access: Access.optional().default("api_key"),
    // How a caller pays this provider — see `Billing`. Defaults `token`
    // (pay-as-you-go). Set `subscription` for flat-rate plans (e.g. a
    // first-party coding plan). Optional + defaulted, so a consumer that does
    // not read it is unaffected.
    billing: Billing.optional().default("token"),
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
    // (Anthropic's native default). Deprecated in favour of the full `auth`
    // block (a consumer derives the Messages scheme from `auth` when present);
    // retained for back-compat with providers not yet migrated.
    auth_scheme: AuthScheme.optional().default("x-api-key"),
    // Full outbound auth declaration — see `Auth`. When present it is the
    // authoritative credential scheme (bearer/header/oauth/native); only public
    // config lives here (env-var / header names, handler names + public params),
    // never a secret. Optional so unmigrated providers keep working off
    // `auth_scheme` + the host-inferred default.
    auth: Auth.optional(),
    // What kind of provider this is — see `ProviderKind`. Drives the consumer's
    // routing-priority class and poolability. Optional; when omitted a consumer
    // derives it from `community` (`third_party` if community, else
    // `first_party`).
    kind: ProviderKind.optional(),
    // Human-readable display name (UI only). Optional.
    display_name: z.string().min(1).optional(),
    // Link to the provider's official API documentation (auth + endpoint
    // reference). HTTPS. Optional.
    doc_url: z
      .string()
      .url()
      .refine((u) => u.startsWith("https://"), { message: "doc_url must be HTTPS" })
      .optional(),
    // Optional upstream feed for the provider's model catalog — see `AutoSync`.
    // Serves a dual role: the registry's own curation bot reads it to refresh
    // the canonical entries, AND a consumer reads the SAME channel at runtime to
    // pull the provider's FULL catalog (beyond the curated canonical subset) —
    // `v1_models` → GET `{url ?? api_base}/models`, `models_dev` → models.dev
    // keyed by `key`. A provider with `auto_sync` but no curated `models` is a
    // pure runtime-discovered catalog (the former `auto_discover` role); the
    // consumer keeps the canonical list at highest route priority. Omit for
    // manual / source-of-truth providers.
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
  // suspended / withdrawn entries, or providers with an `auto_sync` feed (whose
  // catalog is pulled from that channel at runtime), may sit empty. A
  // `local_oauth` / `local_pkce` provider is also exempt: it carries no public
  // catalog and is reached only by an explicit `provider:model` route after a
  // local login (e.g. the Claude Code subscription forwards the model id
  // straight upstream), so it has no models of its own to declare.
  const explicitRouteAccess = (access: string) =>
    access === "local_oauth" || access === "local_pkce";
  for (const { path, data } of reg.providers) {
    if (
      data.status === "active" &&
      data.models.length === 0 &&
      data.auto_sync === undefined &&
      !explicitRouteAccess(data.access)
    ) {
      issues.push({
        file: path,
        message: `provider '${data.name}' is active but declares no models (add an auto_sync feed for a runtime-discovered catalog)`,
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
