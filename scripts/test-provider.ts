// Probe a registered provider end-to-end using its env-var credentials.
//
// Reads the provider's YAML from this registry (the source of truth — we
// don't trust the upstream's /models response) and, for every declared
// canonical_id → provider_model_id pair, sends a minimal chat-completions
// probe to confirm the route actually serves traffic. Reports HTTP status,
// latency, token accounting, and the reply preview.
//
// Credentials come from environment variables, matching bitrouter-cloud's
// resolution convention exactly:
//
//   {PROVIDER_NAME_UPPER}_API_KEY    (e.g. TENCENT_API_KEY)
//   {PROVIDER_NAME_UPPER}_API_BASE   (e.g. TENCENT_API_BASE)
//
// where the provider name is uppercased and non-alphanumerics → "_".
// The script never logs the key in full; it shows a prefix/suffix mask.
//
// Usage:
//   TENCENT_API_KEY=... TENCENT_API_BASE=https://… \
//     bun run scripts/test-provider.ts tencent
//
// Exit code is 0 only when every declared model returned HTTP 2xx.

import { loadProviders, type ProviderFile, type ProviderModel } from "./schema";

const PROBE_PROMPT = "reply with the single word: pong";
const PROBE_MAX_TOKENS = 16;

function envSegment(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)} (len=${key.length})`;
}

interface ProbeResult {
  pmid: string;
  canonicalId: string;
  status: number;
  ok: boolean;
  latencyMs: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reply?: string;
  error?: string;
}

async function chatProbe(
  base: string,
  key: string,
  model: ProviderModel,
): Promise<ProbeResult> {
  const url = `${base.replace(/\/$/, "")}/chat/completions`;
  const body = {
    model: model.provider_model_id,
    max_tokens: PROBE_MAX_TOKENS,
    messages: [{ role: "user", content: PROBE_PROMPT }],
  };
  const t0 = performance.now();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      pmid: model.provider_model_id,
      canonicalId: model.id,
      status: 0,
      ok: false,
      latencyMs: Math.round(performance.now() - t0),
      error: `network: ${(err as Error).message}`,
    };
  }
  const latencyMs = Math.round(performance.now() - t0);
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Leave parsed empty; raw text becomes the error.
  }

  if (!response.ok) {
    const errObj = parsed.error as Record<string, unknown> | undefined;
    const msg =
      (errObj?.message as string) ?? text.slice(0, 200) ?? "(no body)";
    return {
      pmid: model.provider_model_id,
      canonicalId: model.id,
      status: response.status,
      ok: false,
      latencyMs,
      error: msg,
    };
  }

  const choices = parsed.choices as
    | Array<{ message?: { content?: unknown } }>
    | undefined;
  const content = choices?.[0]?.message?.content;
  const reply =
    typeof content === "string"
      ? content
      : content != null
        ? JSON.stringify(content)
        : "";
  const usage = (parsed.usage as Record<string, number> | undefined) ?? {};
  return {
    pmid: model.provider_model_id,
    canonicalId: model.id,
    status: response.status,
    ok: true,
    latencyMs,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    reply: reply.slice(0, 60),
  };
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

async function main(): Promise<void> {
  const providerName = process.argv[2];
  if (!providerName) {
    console.error("usage: bun run scripts/test-provider.ts <provider-name>");
    process.exit(2);
  }

  const env = envSegment(providerName);
  const key = process.env[`${env}_API_KEY`];
  const base = process.env[`${env}_API_BASE`];
  if (!key || !base) {
    console.error(`✗ ${env}_API_KEY and ${env}_API_BASE must both be set`);
    console.error(
      `  e.g. export ${env}_API_KEY=...; export ${env}_API_BASE=https://...`,
    );
    process.exit(2);
  }
  if (!base.startsWith("https://")) {
    console.error(
      `✗ ${env}_API_BASE must be HTTPS — bitrouter-cloud's url_validator rejects non-HTTPS upstreams`,
    );
    process.exit(2);
  }

  const providers = await loadProviders();
  const found = providers.find((p) => p.data.name === providerName);
  if (!found) {
    console.error(`✗ provider '${providerName}' is not in this registry`);
    process.exit(2);
  }
  const provider: ProviderFile = found.data;
  if (provider.models.length === 0) {
    console.error(`✗ provider '${providerName}' declares no models`);
    process.exit(2);
  }

  const bar = "─".repeat(78);
  console.log(`provider: ${providerName}`);
  console.log(`base:     ${base}`);
  console.log(`key:      ${maskKey(key)}`);
  console.log(`status:   ${provider.status}, models: ${provider.models.length}`);
  console.log(bar);

  const pmidWidth = Math.max(...provider.models.map((m) => m.provider_model_id.length));
  const canonWidth = Math.max(...provider.models.map((m) => m.id.length));

  const results: ProbeResult[] = [];
  for (const m of provider.models) {
    process.stdout.write(
      `${pad(m.id, canonWidth)} → ${pad(m.provider_model_id, pmidWidth)}  `,
    );
    const r = await chatProbe(base, key, m);
    results.push(r);
    if (r.ok) {
      const usage =
        r.promptTokens != null && r.completionTokens != null
          ? `prompt=${r.promptTokens} completion=${r.completionTokens}`
          : "usage?";
      console.log(
        `HTTP ${r.status}  ${pad(`${r.latencyMs}ms`, 7)}  ${pad(usage, 26)}  reply="${r.reply}"`,
      );
    } else {
      console.log(
        `HTTP ${r.status}  ${pad(`${r.latencyMs}ms`, 7)}  error: ${r.error}`,
      );
    }
  }

  console.log(bar);
  const ok = results.filter((r) => r.ok).length;
  const failed = results.length - ok;
  console.log(
    `summary: ${ok}/${results.length} probes succeeded${failed ? ` — ${failed} failed` : ""}`,
  );

  process.exit(ok === results.length ? 0 : 1);
}

await main();
