# Provider Registry v2 — Model Dimension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approved v2 model-dimension spec into code: replace `verified` with a `community` flag, add the optional `auto_sync` feed block and descriptive canonical fields, migrate the existing curated data + automation to that shape, and regenerate the fetchable `registry.json` golden — all on a valid, CI-green registry.

**Architecture:** Schema-first (Zod in `scripts/schema.ts`, validated by `bun run validate` + `bun test`), then a one-shot **transform-and-enrich** migration over the *existing* curated YAML (not a from-scratch models.dev re-import — preserves the AA-curated 48-model subset), then generalize `curate apply` to dispatch on `auto_sync.feed`, then regenerate the golden. The cloud consumer + the periodic-fetch/hot-swap work already exist on retained branches (`feat/registry-v2-compat`, `feat/registry-fetch`) and are re-landed on top of v2 in a **separate follow-on plan** (Phase 5 is an outline only).

**Tech Stack:** Bun + TypeScript, Zod v4, the `yaml` lib (`parseDocument` for comment-preserving edits), the existing `scripts/catalog.ts` models.dev client. Repo: `bitrouter/provider-registry`, branch `feat/registry-v2-impl` off `main`.

**Scope note:** Phases 1–4 (this plan) produce a self-contained, testable deliverable — a valid v2 registry + v2 golden. Phase 5 (cloud re-land) is a follow-on plan because it lives in another repo and is mostly rebasing two tested branches.

**Open decisions resolved here:** `community` marks resellers only, first-party/official is the unmarked default (spec §9 default). `auto_sync.writes` keeps the spec defaults (`[models,pricing]` for models_dev, `[models]` for v1_models) — no finer granularity. Migration is transform-and-enrich, not re-import.

---

## Per-provider v2 mapping (the migration's source of truth)

Applied in Phase 2. `community: true` = mark; `–` = omit (default). `auto_sync` = the feed block, or `none` = omit the block (manual).

| provider | community | auto_sync |
|---|---|---|
| anthropic, openai, google, deepseek, alibaba, moonshotai, zai, minimax, xai, xiaomi | – | `feed: models_dev` |
| stepfun | – | `feed: models_dev`, `key: stepfun-ai` |
| chutes | `true` | `feed: v1_models`, `url: https://llm.chutes.ai/v1` |
| ionet | `true` | `feed: v1_models`, `url: https://api.intelligence.io.solutions/api/v1` |
| akashml, redpill, tinfoil, worldrouter | `true` | none |
| tencent | – | none |
| bitrouter, alibaba-coding-plan, moonshotai-coding-plan, zai-coding-plan | – | none |
| **anon-b** | **DELETE the file** | — |

---

## Phase 1 — Schema (`scripts/schema.ts`)

### Task 1: `verified` → `community`

**Files:**
- Modify: `scripts/schema.ts` (the `ProviderFile` object)
- Test: `scripts/schema.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

```ts
// scripts/schema.test.ts
import { expect, test } from "bun:test";
import { ProviderFile } from "./schema";

const base = { name: "p", status: "active", models: [] as unknown[] };

test("community defaults false and verified is rejected", () => {
  expect(ProviderFile.parse({ ...base }).community).toBe(false);
  expect(ProviderFile.parse({ ...base, community: true }).community).toBe(true);
  // `verified` is gone — strict() must reject it
  expect(() => ProviderFile.parse({ ...base, verified: true })).toThrow();
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cd /tmp/registry-v2 && bun test scripts/schema.test.ts`
Expected: FAIL (`community` undefined / `verified` accepted).

- [ ] **Step 3: Implement** — in `scripts/schema.ts`, in `ProviderFile`, replace the `verified` field block with:

```ts
    // Marks an unaffiliated community reseller (vs a first-party / official
    // upstream, which is the unmarked default). Surfaced publicly on the
    // cloud's /v1/providers. Replaces the former `verified` flag — providers
    // are no longer anonymized, so the real name is always public.
    community: z.boolean().optional().default(false),
```

(Delete the old `verified` field + its comment entirely.)

- [ ] **Step 4: Run test, verify pass**

Run: `bun test scripts/schema.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/schema.ts scripts/schema.test.ts
git commit -m "feat(schema): replace verified with community flag"
```

### Task 2: `auto_sync` block

**Files:** Modify `scripts/schema.ts`; Test `scripts/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("auto_sync: feed enum + key/url feed-gating", () => {
  const p = (auto_sync: unknown) => ProviderFile.parse({ ...base, auto_sync });
  expect(p({ feed: "models_dev", key: "stepfun-ai" }).auto_sync?.feed).toBe("models_dev");
  expect(p({ feed: "v1_models", url: "https://x.test/v1" }).auto_sync?.url).toBe("https://x.test/v1");
  // omitted block is allowed (manual)
  expect(ProviderFile.parse({ ...base }).auto_sync).toBeUndefined();
  // key only valid for models_dev; url only valid for v1_models
  expect(() => p({ feed: "v1_models", key: "x" })).toThrow();
  expect(() => p({ feed: "models_dev", url: "https://x.test/v1" })).toThrow();
  expect(() => p({ feed: "bogus" })).toThrow();
});
```

- [ ] **Step 2: Run, verify fail** — `bun test scripts/schema.test.ts` → FAIL.

- [ ] **Step 3: Implement** — add near the other enums in `scripts/schema.ts`:

```ts
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
    // v1_models only: catalog base when there's no default_api_base to reuse. HTTPS.
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
```

Then add to `ProviderFile` (after `auth_scheme`):

```ts
    // Optional upstream feed for catalog auto-sync — see `AutoSync`. Omit for
    // manual / source-of-truth providers (the role `verified` played in gating
    // a provider out of the curation pipeline).
    auto_sync: AutoSync.optional(),
```

- [ ] **Step 4: Run, verify pass** — `bun test scripts/schema.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(schema): add optional auto_sync feed block"`

### Task 3: Descriptive canonical fields

**Files:** Modify `scripts/schema.ts` (`CanonicalModel`); Test `scripts/schema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { CanonicalModel } from "./schema";
test("canonical accepts descriptive v2 fields and rejects bad dates", () => {
  const m = CanonicalModel.parse({
    id: "anthropic/claude-sonnet-4.6",
    release_date: "2026-02-19", knowledge_cutoff: "2025-08",
    open_weights: false, family: "claude",
  });
  expect(m.release_date).toBe("2026-02-19");
  expect(() => CanonicalModel.parse({ id: "a/b", release_date: "2026-2-9" })).toThrow();
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — add to `CanonicalModel` (after `max_output_tokens`):

```ts
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
```

- [ ] **Step 4: Run, verify pass.**
- [ ] **Step 5: Commit** — `git commit -am "feat(schema): add descriptive canonical fields (release_date, knowledge_cutoff, open_weights, family)"`

> After Phase 1, `bun run validate` will FAIL against the existing YAML (every provider still has `verified`). That is expected and fixed in Phase 2 — do not "fix" it by re-adding `verified`.

---

## Phase 2 — Data migration

### Task 4: Migration script

**Files:** Create `scripts/migrate-v2.ts`

A one-shot transform over `providers/*.yaml` that (a) drops `verified`, (b) sets `community`/`auto_sync` per the mapping table above, using `parseDocument` to preserve comments. (Canonical enrichment is Task 6; anon-b deletion + policy cleanup is Task 5.)

- [ ] **Step 1: Write the script**

```ts
// scripts/migrate-v2.ts — one-shot v1→v2 provider migration. Idempotent.
// Reads the YAML files RAW (not via loadProviders) because the now-strict v2
// schema rejects the on-disk `verified` field this script is migrating away.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { PROVIDERS_DIR } from "./schema";

type Feed = { feed: "models_dev" | "v1_models"; key?: string; url?: string };
const COMMUNITY = new Set(["chutes", "ionet", "akashml", "redpill", "tinfoil", "worldrouter"]);
const AUTO_SYNC: Record<string, Feed> = {
  anthropic: { feed: "models_dev" }, openai: { feed: "models_dev" }, google: { feed: "models_dev" },
  deepseek: { feed: "models_dev" }, alibaba: { feed: "models_dev" }, moonshotai: { feed: "models_dev" },
  zai: { feed: "models_dev" }, minimax: { feed: "models_dev" }, xai: { feed: "models_dev" },
  xiaomi: { feed: "models_dev" }, stepfun: { feed: "models_dev", key: "stepfun-ai" },
  chutes: { feed: "v1_models", url: "https://llm.chutes.ai/v1" },
  ionet: { feed: "v1_models", url: "https://api.intelligence.io.solutions/api/v1" },
};

async function main() {
  const files = (await readdir(PROVIDERS_DIR)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  for (const file of files) {
    const name = file.replace(/\.ya?ml$/, "");
    if (name === "anon-b") continue; // deleted in Task 5
    const path = join(PROVIDERS_DIR, file);
    const doc = parseDocument(await readFile(path, "utf8"));
    doc.delete("verified");
    if (COMMUNITY.has(name)) doc.set("community", true);
    if (AUTO_SYNC[name]) doc.set("auto_sync", AUTO_SYNC[name]);
    await writeFile(path, doc.toString());
    console.log(`migrated ${name}`);
  }
}
await main();
```

- [ ] **Step 2: Run it** — `cd /tmp/registry-v2 && bun run scripts/migrate-v2.ts`
- [ ] **Step 3: Spot-check the diff** — `git diff providers/anthropic.yaml providers/chutes.yaml providers/stepfun.yaml` — confirm `verified` gone, `auto_sync` present, `community: true` only on resellers.
- [ ] **Step 4: Commit** — `git add providers && git commit -m "data(v2): migrate providers to community + auto_sync"`

### Task 5: Delete anon-b + move modelsdev_keys off policy

**Files:** Delete `providers/anon-b.yaml`; Modify `curation/policy.yaml`

- [ ] **Step 1:** `git rm providers/anon-b.yaml`
- [ ] **Step 2:** In `curation/policy.yaml`, delete the `modelsdev_keys:` block (now carried by `stepfun`'s `auto_sync.key`) and its comment.
- [ ] **Step 3: Commit** — `git commit -m "data(v2): drop anon-b; modelsdev_keys now live on auto_sync.key"`

### Task 6: Enrich canonical from models.dev

**Files:** Create `scripts/enrich-canonical.ts`; Modify `canonical.yaml`

Pull `release_date` / `knowledge_cutoff` / `open_weights` / `family` from models.dev for each canonical id, where available, preserving comments + leaving unknowns absent.

- [ ] **Step 1: Write the script**

```ts
// scripts/enrich-canonical.ts — fill descriptive canonical fields from models.dev.
import { readFile, writeFile } from "node:fs/promises";
import { isMap, isSeq, parseDocument } from "yaml";
import { loadCatalog } from "./catalog"; // models.dev client
import { CANONICAL_PATH } from "./schema";

// Match canonical model parts to models.dev ids tolerantly: lowercase + strip
// every non-alphanumeric, so `claude-sonnet-4.6` (ours) == `claude-sonnet-4-6`
// (models.dev). Best-effort — unmatched models keep their fields absent; the
// diff review (Step 2) fills any high-value gaps by hand.
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

async function main() {
  const catalog = await loadCatalog();
  const facts = new Map<string, Record<string, unknown>>();
  for (const models of catalog.values())
    for (const m of models.values())
      facts.set(norm(m.id), m as unknown as Record<string, unknown>);

  const doc = parseDocument(await readFile(CANONICAL_PATH, "utf8"));
  const seq = doc.get("models");
  if (!isSeq(seq)) throw new Error("canonical.yaml: models is not a sequence");
  for (const node of seq.items) {
    if (!isMap(node)) continue;
    const id = String(node.get("id"));
    const f = facts.get(norm(id.split("/")[1] ?? ""));
    if (!f) continue;
    if (f.release_date && !node.has("release_date")) node.set("release_date", f.release_date);
    if (f.knowledge && !node.has("knowledge_cutoff")) node.set("knowledge_cutoff", f.knowledge);
    if (typeof f.open_weights === "boolean" && !node.has("open_weights"))
      node.set("open_weights", f.open_weights);
    if (f.family && !node.has("family")) node.set("family", f.family);
  }
  await writeFile(CANONICAL_PATH, doc.toString());
}
await main();
```

> NOTE: `scripts/catalog.ts`'s `CatalogModel` currently parses `cost/modalities/limit`. Before this task, extend its interface + parse to also surface `release_date`, `knowledge`, `open_weights`, `family` (one-line additions per field). Add that as Step 0 of this task.

- [ ] **Step 0: Extend `CatalogModel`** in `scripts/catalog.ts` to carry `release_date?`, `knowledge?`, `open_weights?`, `family?` (copy them through in `loadCatalog`).
- [ ] **Step 1: Run** — `bun run scripts/enrich-canonical.ts`
- [ ] **Step 2: Review** `git diff canonical.yaml` — fields filled where models.dev has them; no clobbering.
- [ ] **Step 3: Validate** — `bun run validate` → now PASS (Phase 1 schema + Phase 2 data are consistent).
- [ ] **Step 4: Commit** — `git add scripts/catalog.ts scripts/enrich-canonical.ts canonical.yaml && git commit -m "data(v2): enrich canonical with descriptive facts from models.dev"`

---

## Phase 3 — Automation (`curate.ts` + CI)

### Task 7: Drive `curate apply` off `auto_sync.feed`

**Files:** Modify `scripts/curate.ts`; Test `scripts/curate.test.ts` (create)

`cmdApply` currently selects `providers.filter((p) => p.data.verified)` and reads each via `modelsdev_keys`. Replace with: providers whose `auto_sync.feed === "models_dev"` (key = `auto_sync.key ?? name`); add a `v1_models` branch (probe `/models` at `auto_sync.url ?? default_api_base`, folding in `check-new-models` logic); providers with no `auto_sync` are skipped.

- [ ] **Step 1: Write a unit test** for the new selector (pure function — extract `modelsDevProviders(providers)` returning `{name,key}[]` from those with `feed===models_dev`):

```ts
// scripts/curate.test.ts
import { expect, test } from "bun:test";
import { modelsDevProviders } from "./curate";
test("models_dev selector uses auto_sync.key, falls back to name", () => {
  const got = modelsDevProviders([
    { data: { name: "stepfun", auto_sync: { feed: "models_dev", key: "stepfun-ai" }, models: [] } },
    { data: { name: "openai", auto_sync: { feed: "models_dev" }, models: [] } },
    { data: { name: "chutes", auto_sync: { feed: "v1_models", url: "x" }, models: [] } },
    { data: { name: "bitrouter", models: [] } },
  ] as never);
  expect(got).toEqual([{ name: "stepfun", key: "stepfun-ai" }, { name: "openai", key: "openai" }]);
});
```

- [ ] **Step 2: Run, verify fail** (function not exported).
- [ ] **Step 3: Implement** — in `scripts/curate.ts` export:

```ts
export function modelsDevProviders(
  providers: Array<{ data: { name: string; auto_sync?: { feed: string; key?: string } } }>,
): Array<{ name: string; key: string }> {
  return providers
    .filter((p) => p.data.auto_sync?.feed === "models_dev")
    .map((p) => ({ name: p.data.name, key: p.data.auto_sync!.key ?? p.data.name }));
}
```

Then rewrite `cmdApply`'s `verified` filter + `modelsDevKey` to use `modelsDevProviders`. Remove the `policy.modelsdev_keys` read (deleted in Task 5; drop it from the `Policy` zod too). Add the `v1_models` branch as a follow-up TODO comment if the live-probe path is deferred — but at minimum the models_dev path must compile + pass.

- [ ] **Step 4: Run, verify pass** — `bun test scripts/curate.test.ts`. Then `bun run curate resolve` (dry, no network gate) compiles + runs.
- [ ] **Step 5: Commit** — `git commit -am "feat(curate): drive apply off auto_sync.feed instead of verified"`

### Task 8: CI gate

**Files:** Modify `.github/workflows/curate.yml`

- [ ] **Step 1:** Update any `verified`-based step/comment in `curate.yml` to reference `auto_sync`. (If `curate.yml` only runs `curate resolve --check`, this may be comment-only — confirm by reading it.)
- [ ] **Step 2: Commit** — `git commit -am "ci(curate): gate on auto_sync, not verified"`

---

## Phase 4 — Golden artifact on v2

### Task 9: Re-land `build-registry-json` on v2 + regenerate

**Files:** Copy `scripts/build-registry-json.ts` + `scripts/build-registry-json.test.ts` from branch `feat/registry-json-artifact`; Create `registry.json`; Modify `.github/workflows/validate.yml`; add `.gitattributes`

The build script is schema-agnostic; on v2 it emits `community`/`auto_sync`/descriptive-canonical instead of `verified`.

- [ ] **Step 1: Bring the files over** —
```bash
git checkout origin/feat/registry-json-artifact -- scripts/build-registry-json.ts scripts/build-registry-json.test.ts .gitattributes
```
(Also re-apply the README + package.json `build-registry-json` script + the `bun test` CI step from that branch — `git show origin/feat/registry-json-artifact -- package.json README.md .github/workflows/validate.yml` and re-apply.)
- [ ] **Step 2: Generate** — `bun install && bun run build-registry-json`
- [ ] **Step 3: Verify v2 shape** — `grep -c '"community"' registry.json` (should match the 6 reseller marks) and `grep -c '"verified"' registry.json` (must be 0); `grep -c '"auto_sync"' registry.json` (13).
- [ ] **Step 4: Test** — `bun test` (golden-in-sync) + `bun run validate` → all green.
- [ ] **Step 5: Commit** — `git add -A && git commit -m "feat(distribution): regenerate registry.json golden on the v2 schema"`

### Task 10: Final validation + spec sync

- [ ] **Step 1:** `bun run validate && bun test && bunx tsc --noEmit` → all green.
- [ ] **Step 2:** Spawn an independent sub-agent (per workspace CLAUDE.md rule 4) to review the full v2 registry diff against the spec.
- [ ] **Step 3: Open PR** against `main` for `feat/registry-v2-impl`.

---

## Phase 5 — Cloud consumer + distribution re-land (FOLLOW-ON PLAN, outline only)

Not part of this plan's deliverable. Once Phase 1–4 merges, a separate plan re-lands the two retained cloud branches on top of v2 and the v2 golden:

- **`feat/registry-v2-compat`** (closed PR #455): `verified`→`community` in the cloud's `ProviderFile`/`ManagementState`, drop `p_xxxx` anonymization in `discovery.rs`, surface `community`, regenerate the OpenAPI golden, update fixtures. Rebase onto cloud `main`; verify the discovery/openapi tests with the new community fixtures.
- **`feat/registry-fetch`** (closed PR #456): `ProviderRegistry::from_json` + `ArcSwap` hot-swap + `RegistryFetcher` (already reads the two-layer artifact — v2-shape registry.json deserializes unchanged since unknown fields are ignored and `community` has a serde default). Plus the review fixes already applied (HTTP timeouts, WARN-on-transition). Rebase + re-add the warp-loopback HTTP-loop tests the review requested.
- **Ordering:** deploy the cloud `community`/anonymity change with/before the v2 registry data so `community` isn't inert. The fetch/golden carry v2 automatically.
