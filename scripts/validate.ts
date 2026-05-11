// Validate every YAML file in this registry against the shared Zod schema
// and the cross-file invariants in `schema.ts`. Exits non-zero on any
// failure so it can drive a GitHub Actions check.
//
// Usage:
//   bun run validate

import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { existsSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

import {
  CANONICAL_PATH,
  CanonicalFile,
  PROVIDERS_DIR,
  ProviderFile,
  REGISTRY_ROOT,
  crossFileIssues,
  loadRegistry,
} from "./schema";

interface Failure {
  file: string;
  problems: string[];
}

function pretty(err: z.ZodError): string[] {
  return err.issues.map((issue) => {
    const path = issue.path.length ? issue.path.join(".") : "(root)";
    return `${path}: ${issue.message}`;
  });
}

async function validateCanonical(failures: Failure[]): Promise<void> {
  const rel = relative(REGISTRY_ROOT, CANONICAL_PATH);
  if (!existsSync(CANONICAL_PATH)) {
    failures.push({ file: rel, problems: ["canonical.yaml is missing"] });
    return;
  }
  const raw = await readFile(CANONICAL_PATH, "utf8");
  try {
    const parsed = parseYaml(raw);
    CanonicalFile.parse(parsed);
  } catch (err) {
    failures.push({
      file: rel,
      problems:
        err instanceof z.ZodError ? pretty(err) : [(err as Error).message],
    });
  }
}

async function validateProviders(failures: Failure[]): Promise<void> {
  if (!existsSync(PROVIDERS_DIR)) {
    failures.push({
      file: relative(REGISTRY_ROOT, PROVIDERS_DIR),
      problems: ["providers/ directory is missing"],
    });
    return;
  }
  const entries = (await readdir(PROVIDERS_DIR)).filter(
    (f) => f.endsWith(".yaml") || f.endsWith(".yml"),
  );
  if (entries.length === 0) {
    failures.push({
      file: relative(REGISTRY_ROOT, PROVIDERS_DIR),
      problems: ["providers/ has no YAML files"],
    });
    return;
  }
  for (const entry of entries.sort()) {
    const path = join(PROVIDERS_DIR, entry);
    const rel = relative(REGISTRY_ROOT, path);
    const raw = await readFile(path, "utf8");
    try {
      const parsed = parseYaml(raw);
      ProviderFile.parse(parsed);
    } catch (err) {
      failures.push({
        file: rel,
        problems:
          err instanceof z.ZodError ? pretty(err) : [(err as Error).message],
      });
    }
  }
}

async function main(): Promise<void> {
  const failures: Failure[] = [];

  await validateCanonical(failures);
  await validateProviders(failures);

  if (failures.length === 0) {
    // No per-file failures → safe to load and run cross-file invariants.
    const reg = await loadRegistry();
    const issues = crossFileIssues(reg);
    for (const issue of issues) {
      failures.push({
        file: relative(REGISTRY_ROOT, issue.file),
        problems: [issue.message],
      });
    }
  }

  if (failures.length === 0) {
    const reg = await loadRegistry();
    console.log(
      `✓ registry valid — ${reg.canonical.length} canonical models, ${reg.providers.length} providers`,
    );
    process.exit(0);
  }

  console.error(`✗ registry validation failed (${failures.length} file${failures.length === 1 ? "" : "s"})\n`);
  for (const f of failures) {
    console.error(`  ${f.file}`);
    for (const p of f.problems) {
      console.error(`    - ${p}`);
    }
  }
  process.exit(1);
}

await main();
