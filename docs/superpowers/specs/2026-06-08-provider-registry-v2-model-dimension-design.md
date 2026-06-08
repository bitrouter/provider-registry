# Provider Registry v2 — Model Dimension Design

**Date:** 2026-06-08
**Status:** Approved design, pending implementation plan
**Scope:** The *model* dimension of the registry only. The *agent* dimension of
the planned model × agent matrix is explicitly out of scope here.
**Baseline:** Assumes the per-model `capabilities` feature (branch
`feat/capabilities`) is implemented and merged. v2 preserves it unchanged.

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
3. **Add a per-provider catalog data source** so the catalog can be auto-updated
   per provider from a declared source (`models_dev`, `v1_models`, or `none`).
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

### 3.1 Canonical model — enrich with advisory facts (the "two-layer" model)

Add the following optional fields to `CanonicalModel`, sourced from models.dev.
These are **advisory** ("the model is capable in principle") and are **never**
used as routing gates:

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
  supports:                     # advisory capability HINTS — not routing gates
    reasoning: true
    tool_call: true
    structured_output: true
```

**Naming discipline:** the advisory hint is `supports.structured_output`
(singular). The verified, routing-gating, per-(provider, model) flag stays
`capabilities: [structured_outputs]` (plural, existing enum). The two must never
be conflated:

| Layer | Where | Meaning | Used for routing? | Source of truth |
|---|---|---|---|---|
| `supports.*` | canonical | model is capable in principle | No (advisory/UX) | models.dev |
| `capabilities` | provider model | this channel actually honours it | **Yes (hard gate)** | `verify-capabilities.ts` against the live upstream |

This preserves the core insight behind the capabilities feature: a reseller may
accept `response_format`/`output_config` and silently return prose. The advisory
hint says the model *can*; only the verified per-provider capability lets the
router send capability-requiring traffic there.

### 3.2 Provider file — `catalog` block (new)

Replaces the hardcoded "models.dev for `verified` providers" automation path and
absorbs the curation-gating role `verified` used to play.

```yaml
catalog:
  source: models_dev      # models_dev | v1_models | none
  key: stepfun-ai         # OPTIONAL, models_dev only: their provider id when it differs from ours
  url: https://...        # OPTIONAL, v1_models only: catalog base when there's no default_api_base to reuse
  sync: [models, pricing] # OPTIONAL: what auto-sync may write
```

Semantics:

- `source: models_dev` — pull the provider's catalog, pricing, and the canonical
  metadata fields from models.dev under `key` (default `key` = provider `name`).
  Default `sync: [models, pricing]`.
- `source: v1_models` — probe the live `/models` endpoint at
  `url ?? default_api_base`. Default `sync: [models]`; `/models` rarely carries
  pricing, so new attachments take pricing from the models.dev/OpenRouter default
  (today's `check-new-models` behaviour) or manual review.
- `source: none` — never touched by automation; manual PRs only. This is what
  gates a provider out of the curation pipeline (the role `verified` played for
  `curate apply`).

`key` moves the `modelsdev_keys` map out of `curation/policy.yaml` and onto the
provider it describes, so everything about one provider lives in its own file.

### 3.3 Provider file — `verified` → `tier` (trust signal)

Anonymity is removed. The `verified` boolean is replaced by an explicit
origin/trust signal that is **always surfaced publicly**:

```yaml
tier: first_party   # first_party | official | community
```

- `first_party` — the model creator's own endpoint (e.g. `anthropic`, `openai`).
- `official` — an authorized/official reseller or managed cloud endpoint.
- `community` — an unaffiliated reseller.

This has concrete value: a prior anonymous Claude provider was withdrawn for
serving relabeled fake Claude models. A public origin signal lets discovery
clients distinguish an official upstream from an arbitrary reseller.

### 3.4 Removed

- The `verified` boolean field.
- The `p_xxxx` provider-id anonymization path (in the cloud consumer; see §6).
- `providers/anon-b.yaml` (the last anonymous provider; `anon-a` is already gone).

### 3.5 Unchanged

`capabilities` (per-model, verified), `byok_only` + `default_api_base`
(orthogonal to `tier`: it means "no platform key, BYOK-only" — true for
subscription/coding-plan entries), `auth_scheme`, `status`, `weight`,
`rate_limits`, `api_protocol`, all cross-file invariants.

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
  pricing overrides, capabilities, tiers, catalog blocks).
- **Field mapping (models.dev → ours):**
  - `cost.{input,output,cache_read,cache_write}` → `pricing.input_tokens.*` /
    `pricing.output_tokens.text` (per-1M, same convention — `pricingFromCost` already does this).
  - `limit.{context,output}` → canonical `max_input_tokens` / `max_output_tokens`.
  - `modalities.{input,output}` → canonical `input_modalities` / `output_modalities`.
  - `reasoning`/`tool_call`/`structured_output` → canonical `supports.*`.
  - `knowledge`/`release_date`/`open_weights`/`family` → canonical fields of the same name.
  - `base_model` → canonical `id`; provider model key → `provider_model_id`.

---

## 5. Automation

- **Generalize `curate apply` to be driven by each provider's `catalog.source`**
  rather than the hardcoded `verified`-only + models.dev path:
  - `models_dev` → sync from models.dev under `catalog.key`.
  - `v1_models` → probe `/models` at `catalog.url ?? default_api_base`
    (fold in today's `check-new-models` / `fetch-provider-models` logic).
  - `none` → skip.
- **AA ranking policy** (admission/deprecation) is unchanged and orthogonal:
  it decides *which canonical ids* are admitted/deprecated; `catalog.source`
  decides *how each provider's attachments* are refreshed.
- **`verify-capabilities.ts`** (proving the routing-gating layer) is unchanged.
- The scheduled GitHub Action (`curate.yml`) keeps running the apply pass; it now
  iterates providers by `catalog.source` instead of `verified`.

---

## 6. bitrouter-cloud coordination (lock-step)

The Zod schema (`scripts/schema.ts`) and the Rust consumer's `ProviderFile` are
kept in lock-step — anything the consumer rejects, the validator must catch
first. v2 is therefore a coordinated multi-repo change. At the interface level
the consumer must:

- **Drop anonymization.** Remove the anonymized `p_xxxx` id and the
  `verified`-based name hiding; `/v1/providers` always returns the real `name`,
  and now also surfaces `tier`.
- **Replace `verified` with `tier`** in the loaded struct.
- **Accept the `catalog` block.** It is registry-tooling-only and irrelevant to
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
2. **Ongoing drift** is handled by the `catalog.source`-driven `curate apply` on
   the existing schedule.

In-scope repos: `bitrouter/bitrouter` (governs the SDK enums kept in lock-step),
`bitrouter/bitrouter-cloud` (the consumer, §6), `bitrouter/provider-registry`
(this repo). Per workspace convention, work from the `repos/<name>/` clones.

---

## 8. Landing checklist

**Schema (`scripts/schema.ts`)**
- [ ] Add optional canonical fields: `release_date`, `knowledge_cutoff`,
      `open_weights`, `family`, and a `supports` object
      (`reasoning`/`tool_call`/`structured_output`, all optional booleans).
- [ ] Add the provider `catalog` block schema (`source` enum + optional `key`,
      `url`, `sync`), with refinements: `key` only meaningful for `models_dev`,
      `url` only for `v1_models`.
- [ ] Replace `verified: boolean` with `tier: first_party|official|community`.
- [ ] Remove `verified` and any anonymization-related validation.

**Data / migration**
- [ ] Write the one-shot importer (models.dev source TOMLs → canonical + provider files).
- [ ] Run it for in-scope providers; enrich `canonical.yaml`; set `tier` and
      `catalog` on every provider file.
- [ ] Delete `providers/anon-b.yaml`.
- [ ] Migrate `curation/policy.yaml` `modelsdev_keys` → per-provider `catalog.key`.

**Automation**
- [ ] Generalize `curate apply` to dispatch on `catalog.source`
      (`models_dev` / `v1_models` / `none`); fold in `check-new-models` logic for `v1_models`.
- [ ] Update `curate.yml` to gate on `catalog.source` instead of `verified`.
- [ ] Confirm `verify-capabilities.ts` still passes on enriched files.

**Consumer (bitrouter-cloud, coordinated PR)**
- [ ] Drop `p_xxxx` anonymization + `verified` name hiding; always return real
      `name` + `tier` on `/v1/providers`.
- [ ] Swap `verified` → `tier` in the loader; accept/skip the `catalog` block.
- [ ] Verify capability gating, `/v1/models` union, and BYOK overlay are unaffected.

**Validation / docs**
- [ ] `bun run validate` passes on the full migrated registry.
- [ ] Update `README.md` (new fields, `tier`, `catalog`, anonymity removed).
- [ ] Final independent sub-agent review against these requirements
      (per workspace `CLAUDE.md` rule 4).

---

## 9. Open items for review

- Exact value set / definitions for `tier` (`first_party | official | community`)
  — confirm the three-way split is right, or collapse to a boolean `official`.
- Whether `supports` should also carry `temperature` (models.dev tracks it) or
  stay limited to `reasoning`/`tool_call`/`structured_output`.
- Whether `catalog.sync` needs finer granularity than `[models, pricing]`
  (e.g. `metadata`).
