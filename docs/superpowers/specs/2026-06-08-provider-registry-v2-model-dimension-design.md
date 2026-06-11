# Provider Registry v2 — Model Dimension Design

**Date:** 2026-06-08
**Status:** Approved design, pending implementation plan
**Scope:** The *model* dimension of the registry only. The *agent* dimension of
the planned model × agent matrix is explicitly out of scope here.
**Baseline:** Current `origin/main`. The per-model `capabilities` feature is
merged (#22/#23) with the vocabulary already expanded to
`[structured_outputs, tools, reasoning, web_search, logprobs]` (`tools`/`reasoning`
seeded from models.dev), and context-tier ("staged") pricing is merged (#27,
`ModelPricing.context_tiers`). v2 preserves both and builds on them.
**Revised:** reconciled against `main` after the capabilities + context-tier-pricing merge.

---

## 1. Background & goals

The registry is the public source-of-truth for the providers and canonical
models that `bitrouter-cloud` routes. v1 (current) has:

- `canonical.yaml` — the shared `<org>/<model>` model vocabulary (the join key
  and our differentiator).
- `providers/<name>.yaml` — one flat file per provider declaring which canonical
  models it serves (`id → provider_model_id`), pricing, rate limits,
  `capabilities` (verified, routing-gating), `status`, `weight`, `byok_only` +
  `default_api_base`, `auth_scheme`, and `verified`.
- Automation: AA-ranked admission/deprecation (`curate.ts` + `curation/policy.yaml`),
  a keyless models.dev catalog client (`catalog.ts`), live `/models` probes
  (`check-new-models.ts`, `fetch-provider-models.ts`), and capability
  verification (`verify-capabilities.ts`).

v2 makes four changes to the model dimension:

1. **Onboard models.dev data.** models.dev's source repo now has the same
   two-layer split we do — provider-agnostic model facts plus per-provider
   serving entries — so the migration maps cleanly. We import only what we need
   and keep our own additions.
2. **Remove the anonymous-provider design entirely.** Product research found it
   unnecessary. All providers are public with real names; no anonymized id.
3. **Add a per-provider auto-sync feed** so a provider's catalog can be
   auto-updated from a declared upstream feed (`models_dev` or `v1_models`). We
   remain the source of truth; the feed only tells the sync bot where to read
   upstream catalog data. Providers with no feed are manual-only.
4. **Keep the storage format and our special fields.** Canonical + flat
   per-provider YAML is retained; we enrich, not rewrite.

### Non-goals (deferred)

- **Plan + API "same provider" routing/measurement grouping.** Treating, e.g.,
  `zai` (pay-as-you-go API) and `zai-coding-plan` (subscription) as one logical
  provider for measurement and routing is a *cloud routing* concern, not a
  registry-structure concern (see §6). The flat registry stays compatible with a
  later grouping hint; no grouping is built now.
- **The agent dimension** of the model × agent matrix.

---

## 2. Key finding: models.dev treats plans as flat, separate providers

This settles the biggest structural question. models.dev does **not** group
plans under a logical parent. Each `(company × region × billing-form)` is its
own top-level provider id. Observed in their `providers/` directory:

- Alibaba/Qwen → `alibaba`, `alibaba-cn`, `alibaba-coding-plan`,
  `alibaba-coding-plan-cn`, `alibaba-token-plan`
- z.ai / Zhipu → `zai`, `zai-coding-plan`, `zhipuai`, `zhipuai-coding-plan`
- MiniMax → `minimax`, `minimax-cn`, `minimax-coding-plan`, `minimax-cn-coding-plan`
- Xiaomi → `xiaomi`, `xiaomi-token-plan-ams`, `xiaomi-token-plan-cn`, `xiaomi-token-plan-sgp`
- Google → `google`, `google-vertex`, `google-vertex-anthropic`

Our existing split (`zai.yaml` + `zai-coding-plan.yaml` as two flat, independent
providers) **is already this convention.** v2 keeps the flat, one-file-per-entry
structure, named `<company>[-<region>][-coding-plan|-token-plan]`. No `channels`
sub-structure, no provider folders.

models.dev's source layout (for the migration):

- `models/<org>/<model>.toml` — provider-agnostic model facts ≈ our `canonical.yaml` entry.
- `providers/<id>/models/<model>.toml` — serving entry, references the canonical
  model via `base_model = "<org>/<model>"` ≈ our `(id → provider_model_id)` attachment.

So `base_model` ≡ our canonical `id`; their provider model id ≡ our
`provider_model_id`. This is the same join `curate apply` already performs.

---

## 3. Schema changes

### 3.1 Canonical model — enrich with descriptive facts

Add the following optional, **descriptive** fields to `CanonicalModel`, sourced
from models.dev. They are catalog/UX metadata, never routing gates:

```yaml
- id: anthropic/claude-sonnet-4.6
  name: "Anthropic: Claude Sonnet 4.6"
  description: ...
  input_modalities: [text, image]
  output_modalities: [text]
  max_input_tokens: 1000000
  max_output_tokens: 128000
  # --- new in v2 (all optional) ---
  release_date: 2026-02-19      # ISO YYYY-MM-DD
  knowledge_cutoff: 2025-08     # ISO YYYY-MM or YYYY-MM-DD
  open_weights: false
  family: claude                # optional grouping/UX hint
```

**No canonical capability flags.** models.dev's per-model capability flags
(`reasoning`, `tool_call`, `structured_output`) are *not* mirrored onto the
canonical model. The merged capabilities feature already treats these as
**verified, per-(provider, model)** `capabilities` — seeded from models.dev (#23)
and confirmed against the live upstream by `verify-capabilities.ts`. So a model's
capability truth lives in exactly one place (the provider attachment) and the
canonical layer stays purely descriptive. The two layers:

| Layer | Where | Holds | Routing gate? | Source of truth |
|---|---|---|---|---|
| descriptive | canonical | dates, modalities, token limits, `open_weights`, `family` | No (catalog/UX) | models.dev |
| `capabilities` | provider model | the subset of `[structured_outputs, tools, reasoning, web_search, logprobs]` it actually honours | **Yes (hard gate)** | models.dev seed → `verify-capabilities.ts` |

This keeps the core insight behind the capabilities feature intact: a reseller
may accept `response_format`/`output_config` and silently return prose, so a model
being capable *in principle* never implies a given channel honours it — only the
verified per-provider capability routes capability-requiring traffic.

### 3.2 Provider file — `auto_sync` block (new, optional)

We are the source of truth; this block does **not** declare an external "source",
it only tells the sync bot which upstream catalog *feed* to pull this provider's
attachments from. It is **optional** — omitting it means manual / source-of-truth
only, which is the default and the role `verified` played in gating a provider
out of the curation pipeline.

```yaml
auto_sync:                  # OPTIONAL. Omit → manual only; automation never touches this provider.
  feed: models_dev          # models_dev | v1_models — the upstream the sync bot reads from
  key: stepfun-ai           # OPTIONAL, feed=models_dev only: their provider id when it differs from ours
  url: https://...          # OPTIONAL, feed=v1_models only: catalog base when there's no default_api_base to reuse
  writes: [models, pricing] # OPTIONAL: what the sync bot may write back into this file
```

Semantics:

- `feed: models_dev` — pull the provider's catalog, pricing, and the canonical
  metadata fields from models.dev under `key` (default `key` = provider `name`).
  Default `writes: [models, pricing]`.
- `feed: v1_models` — probe the live `/models` endpoint at
  `url ?? default_api_base`. Default `writes: [models]`; `/models` rarely carries
  pricing, so new attachments take pricing from the models.dev/OpenRouter default
  (today's `check-new-models` behaviour) or manual review.
- **No `auto_sync` block** — never touched by automation; manual PRs only.

Why inline rather than a separate sync-script config: the feed, `key`, and `url`
are per-provider facts, so co-locating them keeps a provider's whole configuration
in one file. This is the same reason we move the `modelsdev_keys` map out of
`curation/policy.yaml` and onto each provider's `auto_sync.key`.

### 3.3 Provider file — `verified` → `community` flag (trust signal)

Anonymity is removed. The `verified` boolean is replaced by a single optional
flag that marks unaffiliated community resellers; it is **always surfaced
publicly**:

```yaml
community: true   # OPTIONAL. Marks an unaffiliated community reseller. Omit for first-party / official providers (the default).
```

Only the community case is flagged — first-party and official providers are the
unmarked default. This has concrete value: a prior anonymous Claude provider was
withdrawn for serving relabeled fake Claude models. A public `community` flag lets
discovery clients tell a vetted upstream from an arbitrary reseller, without us
having to adjudicate a finer first-party/official split.

### 3.4 Removed

- The `verified` boolean field.
- The `p_xxxx` provider-id anonymization path (in the cloud consumer; see §6).
- `providers/anon-b.yaml` (the last anonymous provider; `anon-a` is already gone).

### 3.5 Unchanged

`capabilities` (per-model, verified), `byok_only` + `default_api_base`
(orthogonal to `community`: it means "no platform key, BYOK-only" — true for
subscription/coding-plan entries), `auth_scheme`, `status`, `weight`,
`rate_limits`, `api_protocol`, all cross-file invariants.

### 3.6 The `bitrouter` provider (BitRouter Cloud as Provider)

`providers/bitrouter.yaml` (added in #25) is our own first-party pooled upstream —
the "BitRouter Cloud as Provider" supply that re-exports registry providers'
API-form offerings under a single `bitrouter` provider. v2 keeps it as-is:

- **Unmarked** by `community` (it is first-party — the default).
- **No `auto_sync` block** — its catalog is curated by hand, so the importer and
  `curate apply` must leave it manual.

---

## 4. models.dev migration

- **Source = the models.dev repo TOMLs, not the compiled `api.json`.** `api.json`
  is denormalized (models duplicated per provider, no canonical layer); the
  source repo's `models/` + `providers/<id>/models/` split with `base_model` is
  what we map from.
- **Curated subset, not a mirror.** Canonical admission stays governed by the
  AA-ranked policy (`top_n`, `protected` globs, grace-day deprecation). models.dev
  supplies catalog + pricing + the new metadata fields for the models we admit;
  it does not flood every model in. We keep our own additions (canonical ids,
  pricing overrides, capabilities, `community` flags, `auto_sync` blocks).
- **Field mapping (models.dev → ours):**
  - `cost.{input,output,cache_read,cache_write}` → `pricing.input_tokens.*` /
    `pricing.output_tokens.text` (per-1M, same convention — `pricingFromCost` already does this).
  - **Tiered/staged pricing** (Qwen/Gemini, where a steeper bracket applies above a
    context threshold) → `pricing.context_tiers` (the merged #27 step-function
    schema). The importer/sync must populate these and never clobber a hand-set
    `context_tiers`; a flat models.dev rate just sets the base bracket.
  - `limit.{context,output}` → canonical `max_input_tokens` / `max_output_tokens`.
  - `modalities.{input,output}` → canonical `input_modalities` / `output_modalities`.
  - `reasoning`/`tool_call`/`structured_output` → **seed the provider attachment's
    `capabilities`** (then verified), *not* the canonical model — see §3.1.
  - `knowledge`/`release_date`/`open_weights`/`family` → canonical fields of the same name.
  - `base_model` → canonical `id`; provider model key → `provider_model_id`.

---

## 5. Automation

- **Generalize `curate apply` to be driven by each provider's `auto_sync.feed`**
  rather than the hardcoded `verified`-only + models.dev path:
  - `models_dev` → sync from models.dev under `auto_sync.key`.
  - `v1_models` → probe `/models` at `auto_sync.url ?? default_api_base`
    (fold in today's `check-new-models` / `fetch-provider-models` logic).
  - no `auto_sync` block → skip.
- **AA ranking policy** (admission/deprecation) is unchanged and orthogonal:
  it decides *which canonical ids* are admitted/deprecated; `auto_sync.feed`
  decides *how each provider's attachments* are refreshed.
- **`verify-capabilities.ts`** (proving the routing-gating layer) is unchanged.
- The scheduled GitHub Action (`curate.yml`) keeps running the apply pass; it now
  iterates providers by the presence of `auto_sync` instead of `verified`.

---

## 6. bitrouter-cloud coordination (lock-step)

The Zod schema (`scripts/schema.ts`) and the Rust consumer's `ProviderFile` are
kept in lock-step — anything the consumer rejects, the validator must catch
first. v2 is therefore a coordinated multi-repo change. At the interface level
the consumer must:

- **Drop anonymization.** Remove the anonymized `p_xxxx` id and the
  `verified`-based name hiding; `/v1/providers` always returns the real `name`,
  and now also surfaces the `community` flag.
- **Replace `verified` with the optional `community` flag** in the loaded struct.
- **Accept the `auto_sync` block.** It is registry-tooling-only and irrelevant to
  routing, but a strict deserializer rejects unknown fields, so the struct must
  include/skip it.
- **Leave unchanged:** the capability routing gate, the `/v1/models` capability
  union, the BYOK overlay, and `byok_only` placeholder targets.

**Plan + API grouping** lives here, not in the registry. models.dev never groups
plans because it only catalogs; the router is the only component that needs a
"same provider for measurement and routing" notion. If/when built, it is a thin
layer over the flat registry — a `provider_group` hint or a suffix convention
(`-coding-plan`/`-token-plan`/`-cn`) — and does not change the file structure
defined here. Deferred.

---

## 7. Execution: one-shot importer, then drift

1. **One-shot importer (new script).** Reads models.dev source TOMLs for the
   in-scope providers, produces the enriched `canonical.yaml` + updated provider
   files in a single reviewable PR. This is the auditable v2 starting state.
2. **Ongoing drift** is handled by the `auto_sync.feed`-driven `curate apply` on
   the existing schedule.

In-scope repos: `bitrouter/bitrouter` (governs the SDK enums kept in lock-step),
`bitrouter/bitrouter-cloud` (the consumer, §6), `bitrouter/provider-registry`
(this repo). Per workspace convention, work from the `repos/<name>/` clones.

---

## 8. Landing checklist

**Schema (`scripts/schema.ts`)**
- [ ] Add optional descriptive canonical fields: `release_date`,
      `knowledge_cutoff`, `open_weights`, `family`. (No canonical capability
      flags — capability truth stays in the provider `capabilities`; see §3.1.)
- [ ] Add the optional provider `auto_sync` block schema (`feed` enum + optional
      `key`, `url`, `writes`), with refinements: `key` only meaningful for
      `feed=models_dev`, `url` only for `feed=v1_models`.
- [ ] Replace `verified: boolean` with an optional `community: boolean` flag.
- [ ] Remove `verified` and any anonymization-related validation.

**Data / migration**
- [ ] Write the one-shot importer (models.dev source TOMLs → canonical + provider files);
      map tiered pricing → `pricing.context_tiers` and seed provider `capabilities`
      from models.dev flags (then verify).
- [ ] Run it for in-scope providers; enrich `canonical.yaml`; mark `community`
      where applicable and add `auto_sync` blocks to auto-synced providers. Leave
      `providers/bitrouter.yaml` manual (no `auto_sync`).
- [ ] Delete `providers/anon-b.yaml`.
- [ ] Migrate `curation/policy.yaml` `modelsdev_keys` → per-provider `auto_sync.key`.

**Automation**
- [ ] Generalize `curate apply` to dispatch on `auto_sync.feed`
      (`models_dev` / `v1_models` / absent); fold in `check-new-models` logic for `v1_models`.
- [ ] Update `curate.yml` to gate on the presence of `auto_sync` instead of `verified`.
- [ ] Confirm `verify-capabilities.ts` still passes on enriched files.

**Consumer (bitrouter-cloud, coordinated PR)**
- [ ] Drop `p_xxxx` anonymization + `verified` name hiding; always return real
      `name` + the `community` flag on `/v1/providers`.
- [ ] Swap `verified` → optional `community` in the loader; accept/skip the `auto_sync` block.
- [ ] Verify capability gating, `/v1/models` union, and BYOK overlay are unaffected.

**Validation / docs**
- [ ] `bun run validate` passes on the full migrated registry.
- [ ] Update `README.md` (new fields, `community`, `auto_sync`, anonymity removed).
- [ ] Final independent sub-agent review against these requirements
      (per workspace `CLAUDE.md` rule 4).

---

## 9. Open items for review

- Whether the `community` flag should default the *other* way (mark vetted
  providers, treat unmarked as community). Current design marks only community
  and treats unmarked as first-party/official.
- Whether to capture models.dev's `temperature` flag anywhere — it is neither a
  descriptive canonical fact nor a routing-gating capability, so likely dropped as niche.
- Whether `auto_sync.writes` needs finer granularity than `[models, pricing]`
  (e.g. a `metadata` channel).
