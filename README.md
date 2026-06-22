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
  providers.json            # { data: [ <provider>, ... ] }
  canonical.json            # { data: [ <canonical model>, ... ] }
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
| `api_protocol` | ✓ | Wire protocol per model-id glob, e.g. `- "*": openai` (`openai` \| `anthropic` \| `google` \| `responses`). |
| `status` | ✓ | `active` \| `staging` \| `suspended` \| `withdrawn` — only `active` is routable. |
| `models` | ✓ | `{ id (canonical), provider_model_id, pricing?, capabilities?, api_protocol?, rate_limits?, deprecation_date? }`. |
| `community` | — | `true` marks an unaffiliated community reseller; omit for first-party / official upstreams (default). Always public. |
| `byok` | — | Whether callers may bring their own key. **Default `true`** — BYOK is available for every publicly-registerable provider. Set `false` only where a caller cannot obtain a key (a pooled or invite-only provider). |
| `billing` | — | `token` (default, pay-as-you-go) \| `subscription` (flat-rate plan, e.g. a first-party coding plan). Descriptive only; consumers rank provider preference with it alongside `community`. |
| `auto_sync` | — | Upstream catalog feed for the sync bot: `{ feed: models_dev \| v1_models, key?, url?, writes? }`. Omit for manual / source-of-truth providers — *we* are the source; the feed only says where the bot reads. |
| `auth_scheme` | — | `x-api-key` (default) \| `bearer` — the Messages transport only (ignored by OpenAI/Google). |
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
the public, validated snapshot consumers read instead of walking the YAML tree:

- `dist/providers.json` — `{ data: [ <provider>, … ] }`, every provider's
  resolved config (defaults applied), sorted by id.
- `dist/canonical.json` — `{ data: [ <canonical model>, … ] }`, the canonical
  model vocabulary, sorted by id.

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
