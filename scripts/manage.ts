// `bun run manage <subcommand>` — registry maintenance CLI.
//
// Subcommands:
//   list                             — list every provider and the canonical
//                                       models it serves.
//   show <provider>                  — print one provider's YAML.
//   add <provider>                   — create or replace a provider file.
//                                       All fields can be supplied via flags;
//                                       missing fields are prompted for.
//   delete <provider>                — delete a provider file.
//   add-model <provider> <id> <pmid> — attach a canonical model entry to
//                                       an existing provider.
//   remove-model <provider> <id>     — drop a canonical model from a
//                                       provider's model list.
//   canonical list                   — list canonical model ids.
//   canonical add <id>               — append a canonical model.
//   canonical remove <id>            — delete a canonical model entry.
//
// Every mutation re-validates the resulting YAML through the shared Zod
// schema before writing, so the on-disk files are always loadable by
// the router.

import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import readline from "node:readline/promises";
import { parseArgs } from "node:util";
import { z } from "zod";

import {
  ApiProtocol,
  CanonicalModel,
  ProviderFile,
  ProviderModel,
  ProviderStatus,
  loadCanonical,
  loadProviders,
  loadRegistry,
  providerPath,
  writeCanonicalFile,
  writeProviderFile,
} from "./schema";

// ── prompt helpers ──────────────────────────────────────────────────────
//
// Interactive prompts run only when stdin is a TTY. In CI / piped runs the
// fallback value is used immediately so a missing flag never blocks.

const interactive = process.stdin.isTTY === true;
let rl: readline.Interface | null = null;
function ioPair(): readline.Interface {
  if (!rl) {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
    });
  }
  return rl;
}
function closeIo(): void {
  rl?.close();
  rl = null;
}

async function ask(question: string, fallback?: string): Promise<string> {
  if (!interactive) return fallback ?? "";
  const suffix = fallback ? ` [${fallback}]` : "";
  const ans = await ioPair().question(`${question}${suffix}: `);
  const value = ans.trim();
  return value.length > 0 ? value : (fallback ?? "");
}

async function askEnum<T extends string>(
  question: string,
  options: readonly T[],
  fallback?: T,
): Promise<T> {
  if (!interactive) {
    if (fallback === undefined) {
      fail(`${question} required (no TTY — pass via flag)`);
    }
    return fallback;
  }
  while (true) {
    const value = await ask(`${question} (${options.join("|")})`, fallback);
    if (options.includes(value as T)) return value as T;
    console.error(`  must be one of: ${options.join(", ")}`);
  }
}

async function askNumber(
  question: string,
  fallback?: number,
): Promise<number | undefined> {
  const value = await ask(question, fallback?.toString());
  if (value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    console.error(`  '${value}' is not a number — ignoring`);
    return undefined;
  }
  return n;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

// ── add / replace a provider ────────────────────────────────────────────

interface AddArgs {
  name?: string;
  status?: string;
  weight?: string;
  protocol?: string;
  rpm?: string;
  contact?: string;
}

async function cmdAdd(rest: string[], flags: AddArgs): Promise<void> {
  const positional = rest[0];
  const name = (flags.name ?? positional)?.trim();
  if (!name) fail("usage: manage add <provider-name> [--status active] …");

  const existingPath = providerPath(name);
  const exists = existsSync(existingPath);
  if (exists) {
    console.error(`· ${name}.yaml exists — editing in place`);
  }
  const prior = exists
    ? (await loadProviders()).find((p) => p.data.name === name)?.data
    : undefined;

  const status =
    (flags.status as z.infer<typeof ProviderStatus>) ??
    (await askEnum(
      "status",
      ProviderStatus.options,
      prior?.status ?? "staging",
    ));

  const protocolDefault = flags.protocol ?? "openai";
  const protocol = ApiProtocol.parse(
    flags.protocol ??
      (await askEnum(
        "default api_protocol for '*'",
        ApiProtocol.options,
        ApiProtocol.options.includes(protocolDefault as ApiProtocol)
          ? (protocolDefault as ApiProtocol)
          : "openai",
      )),
  );

  const weight = flags.weight
    ? Number(flags.weight)
    : ((await askNumber("weight (0..1)", prior?.weight ?? 1.0)) ?? 1.0);

  const rpm = flags.rpm
    ? Number(flags.rpm)
    : await askNumber("default requests_per_minute", 60);

  const contact = flags.contact ?? prior?.contact ?? (await ask("contact email (optional)", ""));

  // Merge new top-level metadata over any existing model list.
  const data: ProviderFile = ProviderFile.parse({
    name,
    api_protocol: [{ "*": protocol }],
    rate_limits: rpm
      ? [{ "*": { requests_per_minute: rpm } }]
      : [],
    models: prior?.models ?? [],
    status,
    weight,
    contact: contact || undefined,
    submitted_at:
      prior?.submitted_at ?? new Date().toISOString().slice(0, 10),
  });

  if (data.models.length === 0) {
    console.error(
      "· no models attached yet — use `manage add-model <provider> <id> <provider_model_id>`",
    );
  }

  const path = await writeProviderFile(name, data);
  console.error(`✓ wrote ${path}`);
}

// ── delete a provider ───────────────────────────────────────────────────

async function cmdDelete(rest: string[]): Promise<void> {
  const name = rest[0];
  if (!name) fail("usage: manage delete <provider-name>");
  const path = providerPath(name);
  if (!existsSync(path)) fail(`${path} does not exist`);
  await unlink(path);
  console.error(`✓ deleted ${path}`);
}

// ── attach / detach a model ─────────────────────────────────────────────

interface ModelFlags {
  protocol?: string;
  "no-cache"?: string;
  "cache-read"?: string;
  "cache-write"?: string;
  output?: string;
  rpm?: string;
  tpm?: string;
}

async function cmdAddModel(rest: string[], flags: ModelFlags): Promise<void> {
  const [providerName, canonicalId, providerModelId] = rest;
  if (!providerName || !canonicalId || !providerModelId) {
    fail("usage: manage add-model <provider> <canonical-id> <provider-model-id> [--protocol …] [--no-cache 0.27] [--cache-read 0.05] [--cache-write 0.34] [--output 0.41] [--rpm 60] [--tpm 100000]");
  }

  const reg = await loadRegistry();
  const provider = reg.providers.find((p) => p.data.name === providerName);
  if (!provider) fail(`provider '${providerName}' not found`);

  if (!reg.canonical.some((m) => m.id === canonicalId)) {
    fail(
      `canonical id '${canonicalId}' is not in canonical.yaml; add it first with \`manage canonical add ${canonicalId}\``,
    );
  }

  if (provider.data.models.some((m) => m.id === canonicalId)) {
    fail(`provider '${providerName}' already declares model '${canonicalId}'`);
  }

  const model = ProviderModel.parse({
    id: canonicalId,
    provider_model_id: providerModelId,
    api_protocol: flags.protocol as ApiProtocol | undefined,
    pricing: {
      input_tokens: {
        no_cache: flags["no-cache"] ? Number(flags["no-cache"]) : undefined,
        cache_read: flags["cache-read"]
          ? Number(flags["cache-read"])
          : undefined,
        cache_write: flags["cache-write"]
          ? Number(flags["cache-write"])
          : undefined,
      },
      output_tokens: flags.output
        ? { text: Number(flags.output) }
        : {},
    },
    rate_limits:
      flags.rpm || flags.tpm
        ? {
            requests_per_minute: flags.rpm ? Number(flags.rpm) : undefined,
            tokens_per_minute: flags.tpm ? Number(flags.tpm) : undefined,
          }
        : undefined,
  });

  const updated: ProviderFile = {
    ...provider.data,
    models: [...provider.data.models, model],
  };
  const path = await writeProviderFile(providerName, updated);
  console.error(`✓ added ${canonicalId} → ${path}`);
}

async function cmdRemoveModel(rest: string[]): Promise<void> {
  const [providerName, canonicalId] = rest;
  if (!providerName || !canonicalId) {
    fail("usage: manage remove-model <provider> <canonical-id>");
  }
  const reg = await loadRegistry();
  const provider = reg.providers.find((p) => p.data.name === providerName);
  if (!provider) fail(`provider '${providerName}' not found`);
  const updatedModels = provider.data.models.filter((m) => m.id !== canonicalId);
  if (updatedModels.length === provider.data.models.length) {
    fail(`provider '${providerName}' does not declare model '${canonicalId}'`);
  }
  if (updatedModels.length === 0) {
    fail(
      `removing '${canonicalId}' would leave provider '${providerName}' with zero models — delete the provider instead`,
    );
  }
  const path = await writeProviderFile(providerName, {
    ...provider.data,
    models: updatedModels,
  });
  console.error(`✓ removed ${canonicalId} from ${path}`);
}

// ── canonical models ────────────────────────────────────────────────────

interface CanonicalFlags {
  name?: string;
  description?: string;
  "input-modalities"?: string;
  "output-modalities"?: string;
  "max-input-tokens"?: string;
  "max-output-tokens"?: string;
}

async function cmdCanonical(rest: string[], flags: CanonicalFlags): Promise<void> {
  const [subcommand, ...args] = rest;
  if (subcommand === "list") {
    const models = await loadCanonical();
    for (const m of models) {
      console.log(`${m.id}${m.name ? `  (${m.name})` : ""}`);
    }
    return;
  }
  if (subcommand === "add") {
    const id = args[0];
    if (!id) fail("usage: manage canonical add <id> [--name …] [--description …]");
    const models = await loadCanonical();
    if (models.some((m) => m.id === id)) fail(`canonical '${id}' already exists`);

    const entry: CanonicalModel = CanonicalModel.parse({
      id,
      name: flags.name,
      description: flags.description,
      input_modalities: flags["input-modalities"]
        ? flags["input-modalities"].split(",").map((s) => s.trim())
        : undefined,
      output_modalities: flags["output-modalities"]
        ? flags["output-modalities"].split(",").map((s) => s.trim())
        : undefined,
      max_input_tokens: flags["max-input-tokens"]
        ? Number(flags["max-input-tokens"])
        : undefined,
      max_output_tokens: flags["max-output-tokens"]
        ? Number(flags["max-output-tokens"])
        : undefined,
    });
    const path = await writeCanonicalFile([...models, entry]);
    console.error(`✓ appended ${id} to ${path}`);
    return;
  }
  if (subcommand === "remove") {
    const id = args[0];
    if (!id) fail("usage: manage canonical remove <id>");
    const models = await loadCanonical();
    const next = models.filter((m) => m.id !== id);
    if (next.length === models.length) fail(`canonical '${id}' not found`);

    const reg = await loadRegistry();
    const referencing = reg.providers.filter((p) =>
      p.data.models.some((m) => m.id === id),
    );
    if (referencing.length > 0) {
      fail(
        `cannot remove '${id}' — still referenced by: ${referencing
          .map((p) => p.data.name)
          .join(", ")}`,
      );
    }
    const path = await writeCanonicalFile(next);
    console.error(`✓ removed ${id} from ${path}`);
    return;
  }
  fail("usage: manage canonical <list|add|remove> …");
}

// ── list / show ─────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  const reg = await loadRegistry();
  console.log(
    `canonical models (${reg.canonical.length}): ${reg.canonical.map((m) => m.id).join(", ")}`,
  );
  console.log("");
  for (const { data } of reg.providers) {
    const models = data.models.map((m) => m.id).join(", ");
    console.log(
      `${data.name}  [${data.status}, weight=${data.weight}]  models: ${models || "—"}`,
    );
  }
}

async function cmdShow(rest: string[]): Promise<void> {
  const name = rest[0];
  if (!name) fail("usage: manage show <provider>");
  const providers = await loadProviders();
  const found = providers.find((p) => p.data.name === name);
  if (!found) fail(`provider '${name}' not found`);
  const { stringify } = await import("yaml");
  process.stdout.write(stringify(found.data, { indent: 2, lineWidth: 100 }));
}

// ── dispatcher ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(
      "usage: bun run manage <list|show|add|delete|add-model|remove-model|canonical> …",
    );
    process.exit(2);
  }

  const [subcommand, ...rest] = argv;
  const { values: flags, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      // add
      name: { type: "string" },
      status: { type: "string" },
      weight: { type: "string" },
      protocol: { type: "string" },
      rpm: { type: "string" },
      tpm: { type: "string" },
      contact: { type: "string" },
      // add-model
      "no-cache": { type: "string" },
      "cache-read": { type: "string" },
      "cache-write": { type: "string" },
      output: { type: "string" },
      // canonical add
      description: { type: "string" },
      "input-modalities": { type: "string" },
      "output-modalities": { type: "string" },
      "max-input-tokens": { type: "string" },
      "max-output-tokens": { type: "string" },
    },
  });

  try {
    switch (subcommand) {
      case "list":
        await cmdList();
        break;
      case "show":
        await cmdShow(positionals);
        break;
      case "add":
        await cmdAdd(positionals, flags as AddArgs);
        break;
      case "delete":
        await cmdDelete(positionals);
        break;
      case "add-model":
        await cmdAddModel(positionals, flags as ModelFlags);
        break;
      case "remove-model":
        await cmdRemoveModel(positionals);
        break;
      case "canonical":
        await cmdCanonical(positionals, flags as CanonicalFlags);
        break;
      default:
        console.error(`unknown subcommand: ${subcommand}`);
        process.exit(2);
    }
  } finally {
    closeIo();
  }
}

await main();
