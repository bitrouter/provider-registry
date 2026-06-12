# bitrouter provider registry

Public source-of-truth for the providers routable by
[`bitrouter-cloud`](https://github.com/bitrouter/bitrouter-cloud). Each
provider opens a PR against this repo declaring which canonical models
they serve and at what price. **No credentials live here** — those are
held server-side in `bitrouter-cloud`.

## Layout

```
canonical.yaml              # the shared model vocabulary
providers/
  <name>.yaml               # one file per provider (filename == name)
registry.json               # GENERATED — compiled artifact the cloud fetches (never hand-edit)
scripts/
  schema.ts                 # shared Zod schemas + IO helpers
  validate.ts               # `bun run validate`
  build-registry-json.ts    # `bun run build-registry-json` → registry.json
  manage.ts                 # `bun run manage <subcommand>`
.github/workflows/validate.yml
```

## Validation

`bun run validate` checks:

- every YAML file parses against the Zod schema in `scripts/schema.ts`;
- every provider model references a canonical id from `canonical.yaml`;
- filename matches the declared `name` field;
- provider names are unique;
- any `status: active` provider declares at least one model.

The same script runs in CI on every push and pull request, alongside
`bun test`, which regenerates `registry.json` and fails if it drifts from
the YAML (see [How `bitrouter-cloud` consumes this](#how-bitrouter-cloud-consumes-this)).
To run locally:

```bash
bun install
bun run validate
bun run build-registry-json   # regenerate the artifact after editing any YAML
bun test                      # golden-in-sync check
```

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

## How `bitrouter-cloud` consumes this

`bitrouter-cloud` fetches the **compiled `registry.json`** artifact at runtime
from this repo's raw `main` URL
(`https://raw.githubusercontent.com/bitrouter/provider-registry/main/registry.json`)
and hot-swaps its in-memory registry on a fixed poll interval — so a merge here
reaches the running service within one interval, **no redeploy**. The fetch is a
conditional GET (ETag), validate-before-swap, and keep-last-good on any error.

`registry.json` is a **generated artifact, never hand-edited**: the two-layer
registry (`{ schema_version, canonical[], providers[] }`) compiled from the YAML
by `bun run build-registry-json`. CI guards it — editing any YAML without
rebuilding fails the `bun test` golden-in-sync check. The workflow:

1. Provider opens a PR editing `canonical.yaml` / `providers/*.yaml`.
2. Author runs `bun run build-registry-json` and commits the updated
   `registry.json` (CI's `bun test` enforces this).
3. CI runs `bun run validate` + `bun test`; a maintainer reviews and merges.
4. The cloud picks up the new `registry.json` on its next poll — no deploy.

A self-hosted cloud can still read the YAML directory from a filesystem path via
`ROUTER_REGISTRY_PATH`; that remains the bootstrap / offline fallback used when
no fetch URL is configured.

**`schema_version` lock-step.** `registry.json`'s `schema_version` (currently
`1`) must match the cloud's `REGISTRY_SCHEMA_VERSION`. Bump it only on a breaking
change to the artifact shape, and — mirroring the SDK release lock-step — ship a
cloud that understands version *N* **before** publishing version *N* here; the
cloud rejects an unrecognized version and keeps its last-good registry.

Credentials for each provider live in `bitrouter-cloud`'s database
(`provider_registry_keys` table) and are rotated through its admin API,
independent of this repo.
