// Dump each provider's live `/models` catalog. Useful when:
//   - syncing a provider entry against what the upstream actually serves
//   - choosing the correct `provider_model_id` for a new canonical model
//
// Reads credentials from environment variables in the same convention
// the cloud uses: `{NAME}_API_KEY` and `{NAME}_API_BASE`. Either or both
// may be missing — providers with no env vars are queried unauthenticated
// (some upstreams expose `/models` publicly) and the script reports the
// outcome either way.
//
// Usage:
//   bun run fetch-models                          # all providers in the registry
//   bun run fetch-models chutes tinfoil           # subset
//   PROVIDER_BASE_OVERRIDES=chutes=https://...    # one-off base URL override

import { loadProviders } from "./schema";

interface ListedModel {
  id: string;
  raw?: unknown;
}

function envName(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function pickEnv(name: string, suffix: string): string | undefined {
  return process.env[`${envName(name)}_${suffix}`];
}

async function fetchModels(
  provider: string,
  base: string,
  apiKey: string | undefined,
): Promise<{ ok: true; models: ListedModel[] } | { ok: false; reason: string }> {
  const url = `${base.replace(/\/$/, "")}/models`;
  const headers: Record<string, string> = { Accept: "application/json" };
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;
  let response: Response;
  try {
    response = await fetch(url, { headers });
  } catch (err) {
    return { ok: false, reason: `network error: ${(err as Error).message}` };
  }
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    return {
      ok: false,
      reason: `HTTP ${response.status} ${response.statusText}${text ? `: ${text.slice(0, 200)}` : ""}`,
    };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch (err) {
    return { ok: false, reason: `body parse error: ${(err as Error).message}` };
  }

  // Tolerate the three common shapes:
  //   { data: [{id, ...}] }          ← OpenAI standard
  //   { models: [{id, ...}] }        ← some forks
  //   [ {id, ...} ]                  ← rare
  let list: unknown[] = [];
  if (Array.isArray(body)) list = body;
  else if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (Array.isArray(obj.data)) list = obj.data;
    else if (Array.isArray(obj.models)) list = obj.models;
  }

  const models: ListedModel[] = [];
  for (const entry of list) {
    if (entry && typeof entry === "object") {
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string") {
        models.push({ id, raw: entry });
      }
    } else if (typeof entry === "string") {
      models.push({ id: entry });
    }
  }
  return { ok: true, models };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const selected = new Set(args.filter((a) => !a.startsWith("-")));

  const overrides = new Map<string, string>();
  for (const part of (process.env.PROVIDER_BASE_OVERRIDES ?? "").split(",")) {
    const [k, v] = part.split("=", 2);
    if (k && v) overrides.set(k.trim(), v.trim());
  }

  const providers = await loadProviders();
  for (const { data } of providers) {
    if (selected.size > 0 && !selected.has(data.name)) continue;
    const apiKey = pickEnv(data.name, "API_KEY");
    const apiBase =
      overrides.get(data.name) ?? pickEnv(data.name, "API_BASE");
    if (!apiBase) {
      console.log(`## ${data.name}: no API_BASE set; skipping`);
      console.log();
      continue;
    }
    const auth = apiKey ? "authenticated" : "unauthenticated";
    console.log(`## ${data.name}  (${auth}, ${apiBase})`);
    const result = await fetchModels(data.name, apiBase, apiKey);
    if (!result.ok) {
      console.log(`   ✗ ${result.reason}`);
      console.log();
      continue;
    }
    console.log(`   ${result.models.length} model(s):`);
    for (const m of result.models) {
      console.log(`     - ${m.id}`);
    }
    console.log();
  }
}

await main();
