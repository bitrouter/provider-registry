# bitrouter provider registry

Public source-of-truth for the providers routable by BitRouter. Each
provider opens a PR against this repo declaring which canonical models
they serve and at what price. **No credentials live here** — API keys are
held server-side by the router, never in this repo. Everything else is
public: each provider's endpoint (`api_base`), prices, capabilities, and
trust signal (`community`).

## Layout

```
canonical.yaml              # the shared model vocabulary
providers/
  <name>.yaml               # one file per provider (filename == name)
dist/                       # generated distribution artifacts (`bun run build`)
  providers.json            # provider view: { data: [ <provider w/ resolved models> ] }
  models.json               # model view:    { data: [ <canonical model + providers> ] }
curation/                   # ranking policy + models.dev→canonical crosswalk
scripts/
  schema.ts                 # shared Zod schemas + IO helpers
  validate.ts               # `bun run validate`
  build-dist.ts             # `bun run build` — regenerate dist/
  manage.ts                 # `bun run manage <subcommand>`
  curate.ts                 # `bun run curate` (auto-sync from models.dev)
.github/workflows/          # validate, curate, release
```

## Provider file (`providers/<name>.yaml`)

| field | required | meaning |
|---|---|---|
| `name` | ✓ | Must equal the filename stem (lowercase, hyphenated). |
| `api_base` | ✓ | The provider's **public** upstream base URL (HTTPS). v2 declares every endpoint openly; the router routes against it (a BYOK caller may override it per-request). |
| `api_protocol` | ✓ | Wire protocol per model-id glob. Value is a single maker name or an ordered **set**, e.g. `- "*": openai` or `- "*": [openai, responses]` (`openai` \| `anthropic` \| `google` \| `responses`). Longest glob wins; `build-dist` resolves it per (provider, model). |
| `status` | ✓ | `active` \| `staging` \| `suspended` \| `withdrawn` — only `active` is routable. |
| `models` | ✓ | `{ id (canonical), provider_model_id, pricing?, capabilities?, api_protocol?, rate_limits?, deprecation_date? }`. May be empty for a provider that declares an `auto_sync` feed (runtime-discovered catalog). |
| `kind` | — | `first_party` \| `gateway` \| `cloud` \| `third_party`. Drives the consumer's routing-priority class + poolability. Omitted ⇒ derived from `community`. |
| `auth` | — | Full outbound auth declaration: `{ kind: bearer\|header\|oauth\|native, env?, header?, extra_headers?, handler?, params? }`. **Public config only** — env/header/handler names + public OAuth params; never a secret. Supersedes `auth_scheme`. |
| `access` | — | How a caller obtains access: `api_key` (default, public self-registration → portable key — the BYOK case) \| `local_oauth` \| `local_pkce` (credentials minted by a local interactive flow — no portable key) \| `private` (no public registration, platform-pooled/invite-only). Drives the BYOK page (api_key only), poolability, and the consumer's auto-enable rule. Replaces the old `byok` boolean (now derived: `byok` iff `api_key`; the dist still emits it). |
| `protocol_endpoints` | — | Per-protocol base-URL override `{ <protocol>: <https url> }` for a provider serving protocols at different paths under one host. |
| `display_name`, `doc_url` | — | Human-readable name; link to the provider's official API docs (HTTPS). |
| `community` | — | `true` marks an unaffiliated community reseller; omit for first-party / official upstreams (default). Always public. A derived alias of `kind: third_party`. |
| `billing` | — | `token` (default, pay-as-you-go) \| `subscription` (flat-rate plan, e.g. a first-party coding plan). Descriptive only; consumers rank provider preference with it alongside `kind`. |
| `auto_sync` | — | Upstream catalog feed: `{ feed: models_dev \| v1_models, key?, url?, writes? }`. Dual role — the curation bot reads it to refresh canonical entries, AND consumers read the same channel at runtime to pull a provider's FULL catalog (beyond canonical). A provider with `auto_sync` but no curated `models` is a pure runtime-discovered catalog (relaxes the active-needs-models rule). Omit for manual / source-of-truth providers. |
| `auth_scheme` | — | *(Deprecated — use `auth`.)* `x-api-key` (default) \| `bearer` — the Messages transport only. |
| `weight`, `rate_limits` | — | Routing weight + declared RPM/TPM. |

A model's `capabilities` is the **verified per-channel** subset of
`[structured_outputs, tools, reasoning, web_search, logprobs, image_input,
audio_input, video_input, file_input, image_output, audio_output]` — declared
only after `bun run verify-capabilities` confirms the live upstream honours it.
Pricing supports context-tier ("staged") brackets via `pricing.context_tiers`.

## Canonical model (`canonical.yaml`)

The shared `<org>/<model>` vocabulary every provider attaches to. Per model:
`id`, `name?`, `description?`, `input_modalities?`, `output_modalities?`,
`max_input_tokens?`, `max_output_tokens?`, plus descriptive facts `release_date?`,
`knowledge_cutoff?`, `open_weights?`, `family?`. Purely descriptive — capability
truth lives per-provider (above), never on the canonical model.

## Validation

`bun run validate` checks:

- every YAML file parses against the Zod schema in `scripts/schema.ts`;
- every provider model references a canonical id from `canonical.yaml`;
- filename matches the declared `name` field;
- provider names are unique;
- any `status: active` provider declares at least one model.

The same script runs in CI on every push and pull request. To run
locally:

```bash
bun install
bun run validate
```

## Distribution (`dist/`)

`bun run build` compiles the registry into two deterministic JSON artifacts —
the public, validated snapshot consumers read instead of walking the YAML tree.
Both are **fully resolved**: the source authors `api_protocol` / `rate_limits`
as glob → value pattern lists, but the dist expands them to the concrete value
per (provider, model), so a consumer reads a value and never runs a glob engine.

- `dist/providers.json` — **provider view**: `{ data: [ <provider>, … ] }`,
  sorted by id. Each provider carries its top-level config (`api_base`, `access`,
  `byok` (derived), `community`, `billing`, `auth`, …) and a `models[]` list
  where every entry has the resolved `api_protocol` + `rate_limits`. A provider
  with a runtime-discovered catalog (an `auto_sync` feed, no curated models)
  keeps its provider-level `api_protocol` globs for the consumer to apply.
- `dist/models.json` — **model view**: `{ data: [ <canonical model>, … ] }`,
  sorted by id — the canonical model vocabulary with, per model, a `providers[]`
  list naming every provider that serves it and that pair's resolved config.
  Consumers needing the authoritative model set read `data[].id`.

Both are byte-deterministic (sorted keys, no timestamps), so an unchanged
registry regenerates identical bytes. The `release` workflow keeps them current
on `main` and tags each release `reg-<timestamp>`. Consumers fetch them either
from a pinned tag or from the raw files on `main`, e.g.
`https://raw.githubusercontent.com/bitrouter/provider-registry/main/dist/providers.json`.

## Management

`bun run manage` mutates the registry while preserving the schema.
Every command re-validates the new YAML before writing.

```bash
bun run manage list                       # one-line summary per provider
bun run manage show redpill               # dump one provider's YAML

# Create or update a provider's top-level metadata
bun run manage add redpill \
    --status active \
    --protocol openai \
    --weight 1.0 \
    --rpm 60 \
    --contact ops@example.com

# Attach a canonical model to an existing provider
bun run manage add-model redpill deepseek/deepseek-v3.2 deepseek/deepseek-v3.2 \
    --no-cache 0.27 --cache-read 0.054 --output 0.41

bun run manage remove-model redpill anthropic/claude-sonnet-4.6
bun run manage delete some-provider

# Canonical model list
bun run manage canonical list
bun run manage canonical add openai/gpt-4o \
    --name "OpenAI: GPT-4o" \
    --input-modalities text,image \
    --output-modalities text \
    --max-input-tokens 128000 --max-output-tokens 16384
bun run manage canonical remove openai/gpt-4o   # blocked while any provider references it
```

`add` without all flags will prompt for missing fields when stdin is a
TTY. In CI / scripted contexts pass everything via flags; missing
required values cause the script to exit non-zero rather than hang.
