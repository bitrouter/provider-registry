// Verify that a provider's declared `capabilities` are actually honoured by the
// live upstream — and discover which ones it supports but hasn't declared.
//
// Unlike `test-provider.ts` (which only checks the route serves traffic), this
// probes each declared capability in the provider's NATIVE wire protocol and
// asserts the upstream truly honours it. This matters because structured-output
// support is a per-channel property: an official API honours the schema, but a
// reseller/subscription proxy often accepts the parameter and silently ignores
// it (returns HTTP 200 + prose). The registry must reflect what the channel
// really does, not what the underlying model is capable of.
//
// Capability → native parameter under test (one inbound protocol each):
//   structured_outputs:
//     openai     → POST /chat/completions  `response_format.json_schema`
//                  <https://platform.openai.com/docs/guides/structured-outputs>
//     anthropic  → POST /messages          `output_config.format`
//                  <https://platform.claude.com/docs/en/build-with-claude/structured-outputs>
//     google     → POST /models/<m>:generateContent  `generationConfig.responseSchema`
//                  <https://ai.google.dev/gemini-api/docs/structured-output>
//   A capability is "honoured" iff the reply is PURE JSON conforming to the
//   probe schema. Prose / markdown-fenced JSON ⇒ not honoured.
//
//   image_input (vision): a real PNG carrying a sentinel token is attached
//     (openai `image_url`, anthropic `image` block, google `inlineData`) and the
//     model must transcribe the token back — honoured iff it does, which proves
//     the channel actually consumed the image instead of dropping it.
//   image_output (generation): an image output modality is requested (google
//     `generationConfig.responseModalities:[IMAGE]`) and the reply must carry an
//     inline image part with non-empty bytes. Chat Completions / Messages have no
//     image-output wire form, so only the google transport is probed.
//
// Credentials come from environment variables, using the conventional
// per-provider scheme:
//   {PROVIDER_NAME_UPPER}_API_KEY    (e.g. OPENAI_API_KEY)
//   {PROVIDER_NAME_UPPER}_API_BASE   (e.g. OPENAI_API_BASE, HTTPS, versioned root)
//
// Usage:
//   OPENAI_API_KEY=... OPENAI_API_BASE=https://api.openai.com/v1 \
//     bun run scripts/verify-capabilities.ts openai [capability]
//
// `capability` defaults to `structured_outputs`. Probe-implemented today:
// `structured_outputs`, `tools`, `image_input`, `image_output`.
// Exit code is non-zero iff a DECLARED capability is not honoured (a CI gate);
// undeclared-but-supported rows are reported as suggestions, not failures.

import {
  Capability,
  loadProviders,
  type ApiProtocol,
  type AuthScheme,
  type ProviderFile,
  type ProviderModel,
} from "./schema";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PROBE_PROMPT =
  "What is the weather like in London right now? Make a reasonable guess for the values.";
// Generous cap: reasoning models (gpt-5.x, o-series) spend completion tokens on
// hidden reasoning before emitting the JSON, so a small cap can starve the
// visible output. Structured-output replies are short, so this ceiling only
// really bounds the unsupported (prose) case.
const PROBE_MAX_TOKENS = 8192;

// A small strict schema; a faithful provider returns exactly these three keys
// and nothing but JSON. Google's `responseSchema` is an OpenAPI subset that
// rejects `additionalProperties`, so the google probe strips it.
const WEATHER_SCHEMA = {
  type: "object",
  properties: {
    location: { type: "string" },
    temperature: { type: "number" },
    conditions: { type: "string" },
  },
  required: ["location", "temperature", "conditions"],
  additionalProperties: false,
} as const;

// Tool-calling probe: force a single tool call. Parameters are a minimal object
// schema with no `additionalProperties` (Gemini's functionDeclarations reject
// it, same as responseSchema).
const TOOL_PARAMS = {
  type: "object",
  properties: { location: { type: "string" } },
  required: ["location"],
} as const;
const TOOL_PROMPT = "What is the weather in London? Use the get_weather tool.";
const TOOL_DESC = "Get the current weather for a location.";

function envSegment(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

function maskKey(key: string): string {
  if (key.length <= 12) return "***";
  return `${key.slice(0, 6)}…${key.slice(-4)} (len=${key.length})`;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

// Resolve the effective wire protocol for one model: an explicit per-model
// override wins, else the provider's pattern list (exact id match, then `*`).
function resolveProtocol(provider: ProviderFile, model: ProviderModel): ApiProtocol {
  if (model.api_protocol) return model.api_protocol;
  let star: ApiProtocol | undefined;
  for (const entry of provider.api_protocol ?? []) {
    const [pattern, proto] = Object.entries(entry)[0]!;
    if (pattern === model.id) return proto;
    if (pattern === "*") star = proto;
  }
  return star ?? "openai";
}

// True iff `content` is pure JSON (no prose / fences) matching WEATHER_SCHEMA.
function isSchemaJson(content: string): boolean {
  const trimmed = content.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const o = parsed as Record<string, unknown>;
  return (
    typeof o.location === "string" &&
    typeof o.temperature === "number" &&
    typeof o.conditions === "string"
  );
}

interface CapResult {
  honored: boolean;
  status: number;
  detail: string;
}

async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<{ status: number; text: string; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* leave empty; raw text becomes the error detail */
  }
  return { status: res.status, text, json };
}

function errOf(
  json: Record<string, unknown>,
  text: string,
): string {
  const e = json.error as Record<string, unknown> | undefined;
  return (e?.message as string) ?? (text.slice(0, 160) || "(no body)");
}

async function probeStructuredOutputs(
  protocol: ApiProtocol,
  base: string,
  key: string,
  pmid: string,
  authScheme: AuthScheme,
): Promise<CapResult> {
  const root = base.replace(/\/$/, "");
  try {
    if (protocol === "openai") {
      const { status, text, json } = await postJson(
        `${root}/chat/completions`,
        { Authorization: `Bearer ${key}` },
        {
          model: pmid,
          // Newer OpenAI models reject `max_tokens` and require this; OpenAI-
          // compatible providers accept or ignore it.
          max_completion_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: PROBE_PROMPT }],
          response_format: {
            type: "json_schema",
            json_schema: { name: "weather", strict: true, schema: WEATHER_SCHEMA },
          },
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const choices = json.choices as Array<{ message?: { content?: unknown } }> | undefined;
      const content = choices?.[0]?.message?.content;
      return { honored: typeof content === "string" && isSchemaJson(content), status, detail: "" };
    }

    if (protocol === "anthropic") {
      // The Messages transport's credential header is provider-declared via
      // `auth_scheme` (x-api-key is Anthropic's native default; resellers on a
      // one-api/new-api stack usually want `Authorization: Bearer`).
      const authHeader: Record<string, string> =
        authScheme === "bearer"
          ? { Authorization: `Bearer ${key}` }
          : { "x-api-key": key };
      const { status, text, json } = await postJson(
        `${root}/messages`,
        { ...authHeader, "anthropic-version": "2023-06-01" },
        {
          model: pmid,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: PROBE_PROMPT }],
          output_config: { format: { type: "json_schema", schema: WEATHER_SCHEMA } },
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const blocks = (json.content as Array<{ type: string; text?: string }> | undefined) ?? [];
      const content = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      return { honored: isSchemaJson(content), status, detail: "" };
    }

    if (protocol === "google") {
      // Gemini's responseSchema is an OpenAPI subset — drop additionalProperties.
      const { additionalProperties, ...googleSchema } = WEATHER_SCHEMA;
      const { status, text, json } = await postJson(
        `${root}/models/${pmid}:generateContent`,
        { "x-goog-api-key": key },
        {
          contents: [{ role: "user", parts: [{ text: PROBE_PROMPT }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: googleSchema,
          },
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const cand = (json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0];
      const content = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return { honored: isSchemaJson(content), status, detail: "" };
    }

    return { honored: false, status: 0, detail: `unsupported protocol '${protocol}'` };
  } catch (err) {
    return { honored: false, status: 0, detail: `network: ${(err as Error).message}` };
  }
}

// Probe tool/function calling by forcing a single tool call and checking the
// reply carries one. Honoured = the model emitted a tool/function call.
// Official tool-calling docs per protocol:
//   openai    <https://platform.openai.com/docs/guides/function-calling>
//   anthropic <https://platform.claude.com/docs/en/build-with-claude/tool-use>
//   google    <https://ai.google.dev/gemini-api/docs/function-calling>
async function probeTools(
  protocol: ApiProtocol,
  base: string,
  key: string,
  pmid: string,
  authScheme: AuthScheme,
): Promise<CapResult> {
  const root = base.replace(/\/$/, "");
  try {
    if (protocol === "openai") {
      const { status, text, json } = await postJson(
        `${root}/chat/completions`,
        { Authorization: `Bearer ${key}` },
        {
          model: pmid,
          max_completion_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: TOOL_PROMPT }],
          tools: [
            {
              type: "function",
              function: { name: "get_weather", description: TOOL_DESC, parameters: TOOL_PARAMS },
            },
          ],
          tool_choice: "required",
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const choices = json.choices as Array<{ message?: { tool_calls?: unknown[] } }> | undefined;
      const calls = choices?.[0]?.message?.tool_calls;
      return { honored: Array.isArray(calls) && calls.length > 0, status, detail: "" };
    }

    if (protocol === "anthropic") {
      const authHeader: Record<string, string> =
        authScheme === "bearer" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
      const { status, text, json } = await postJson(
        `${root}/messages`,
        { ...authHeader, "anthropic-version": "2023-06-01" },
        {
          model: pmid,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [{ role: "user", content: TOOL_PROMPT }],
          tools: [{ name: "get_weather", description: TOOL_DESC, input_schema: TOOL_PARAMS }],
          tool_choice: { type: "any" },
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const blocks = (json.content as Array<{ type: string }> | undefined) ?? [];
      return { honored: blocks.some((b) => b.type === "tool_use"), status, detail: "" };
    }

    if (protocol === "google") {
      const { status, text, json } = await postJson(
        `${root}/models/${pmid}:generateContent`,
        { "x-goog-api-key": key },
        {
          contents: [{ role: "user", parts: [{ text: TOOL_PROMPT }] }],
          tools: [{ functionDeclarations: [{ name: "get_weather", description: TOOL_DESC, parameters: TOOL_PARAMS }] }],
          toolConfig: { functionCallingConfig: { mode: "ANY" } },
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const cand = (json.candidates as Array<{ content?: { parts?: Array<{ functionCall?: unknown }> } }> | undefined)?.[0];
      const parts = cand?.content?.parts ?? [];
      return { honored: parts.some((p) => p.functionCall != null), status, detail: "" };
    }

    return { honored: false, status: 0, detail: `unsupported protocol '${protocol}'` };
  } catch (err) {
    return { honored: false, status: 0, detail: `network: ${(err as Error).message}` };
  }
}

// ── Modality probes ──────────────────────────────────────────────────────
// Official multimodal docs per protocol:
//   image_input  openai    <https://platform.openai.com/docs/guides/vision>
//                anthropic <https://platform.claude.com/docs/en/build-with-claude/vision>
//                google    <https://ai.google.dev/gemini-api/docs/image-understanding>
//   image_output google    <https://ai.google.dev/gemini-api/docs/image-generation>

// A PNG that renders IMAGE_SENTINEL as black text on white. The sentinel is an
// unguessable token, so a model can only echo it back if it truly read the
// image. Regenerate the fixture with:
//   magick -size 480x160 xc:white -gravity center -pointsize 72 -fill black \
//     -annotate 0 'VX7K2Q' scripts/fixtures/probe-image-text.png
const IMAGE_SENTINEL = "VX7K2Q";
const IMAGE_FIXTURE = join(import.meta.dir, "fixtures", "probe-image-text.png");
const IMAGE_INPUT_PROMPT =
  "Transcribe the exact characters shown in this image. Reply with only those characters.";
const IMAGE_OUTPUT_PROMPT =
  "Generate a simple image: a solid red circle centered on a white background.";

function imageFixtureB64(): string {
  return readFileSync(IMAGE_FIXTURE).toString("base64");
}

// Sentinel match is tolerant of case and incidental punctuation/spacing.
function hasSentinel(text: string): boolean {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "").includes(IMAGE_SENTINEL);
}

// True iff any response part is an inline image with non-empty bytes (tolerates
// camelCase `inlineData` and snake_case `inline_data`).
function hasInlineImage(parts: Array<Record<string, unknown>>): boolean {
  return parts.some((p) => {
    const inline = (p.inlineData ?? p.inline_data) as
      | { mimeType?: string; mime_type?: string; data?: string }
      | undefined;
    const mt = inline?.mimeType ?? inline?.mime_type;
    return (
      typeof mt === "string" &&
      mt.startsWith("image/") &&
      typeof inline?.data === "string" &&
      inline.data.length > 0
    );
  });
}

// Probe vision: attach the sentinel PNG and require the model to read it back.
async function probeImageInput(
  protocol: ApiProtocol,
  base: string,
  key: string,
  pmid: string,
  authScheme: AuthScheme,
): Promise<CapResult> {
  const root = base.replace(/\/$/, "");
  const b64 = imageFixtureB64();
  try {
    if (protocol === "openai") {
      const { status, text, json } = await postJson(
        `${root}/chat/completions`,
        { Authorization: `Bearer ${key}` },
        {
          model: pmid,
          max_completion_tokens: PROBE_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: IMAGE_INPUT_PROMPT },
                { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
              ],
            },
          ],
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const choices = json.choices as Array<{ message?: { content?: unknown } }> | undefined;
      const content = choices?.[0]?.message?.content;
      return { honored: typeof content === "string" && hasSentinel(content), status, detail: "" };
    }

    if (protocol === "anthropic") {
      const authHeader: Record<string, string> =
        authScheme === "bearer" ? { Authorization: `Bearer ${key}` } : { "x-api-key": key };
      const { status, text, json } = await postJson(
        `${root}/messages`,
        { ...authHeader, "anthropic-version": "2023-06-01" },
        {
          model: pmid,
          max_tokens: PROBE_MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } },
                { type: "text", text: IMAGE_INPUT_PROMPT },
              ],
            },
          ],
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const blocks = (json.content as Array<{ type: string; text?: string }> | undefined) ?? [];
      const content = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      return { honored: hasSentinel(content), status, detail: "" };
    }

    if (protocol === "google") {
      const { status, text, json } = await postJson(
        `${root}/models/${pmid}:generateContent`,
        { "x-goog-api-key": key },
        {
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/png", data: b64 } },
                { text: IMAGE_INPUT_PROMPT },
              ],
            },
          ],
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const cand = (json.candidates as Array<{ content?: { parts?: Array<{ text?: string }> } }> | undefined)?.[0];
      const content = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("");
      return { honored: hasSentinel(content), status, detail: "" };
    }

    return { honored: false, status: 0, detail: `unsupported protocol '${protocol}'` };
  } catch (err) {
    return { honored: false, status: 0, detail: `network: ${(err as Error).message}` };
  }
}

// Probe image generation: request an image modality and require an inline image
// in the reply. Only the google transport carries image output; Chat Completions
// (OpenAI uses a separate Images/Responses API) and Messages have no wire form.
async function probeImageOutput(
  protocol: ApiProtocol,
  base: string,
  key: string,
  pmid: string,
  _authScheme: AuthScheme,
): Promise<CapResult> {
  const root = base.replace(/\/$/, "");
  try {
    if (protocol === "google") {
      const { status, text, json } = await postJson(
        `${root}/models/${pmid}:generateContent`,
        { "x-goog-api-key": key },
        {
          contents: [{ role: "user", parts: [{ text: IMAGE_OUTPUT_PROMPT }] }],
          generationConfig: { responseModalities: ["TEXT", "IMAGE"] },
        },
      );
      if (status < 200 || status >= 300) return { honored: false, status, detail: errOf(json, text) };
      const cand = (json.candidates as Array<{ content?: { parts?: Array<Record<string, unknown>> } }> | undefined)?.[0];
      const parts = cand?.content?.parts ?? [];
      return { honored: hasInlineImage(parts), status, detail: "" };
    }
    return { honored: false, status: 0, detail: `image_output has no wire form in '${protocol}' transport` };
  } catch (err) {
    return { honored: false, status: 0, detail: `network: ${(err as Error).message}` };
  }
}

// Registry of capability → probe. Add new entries as capabilities land.
const PROBES: Partial<
  Record<
    Capability,
    (proto: ApiProtocol, base: string, key: string, pmid: string, authScheme: AuthScheme) => Promise<CapResult>
  >
> = {
  structured_outputs: probeStructuredOutputs,
  tools: probeTools,
  image_input: probeImageInput,
  image_output: probeImageOutput,
};

async function main(): Promise<void> {
  const providerName = process.argv[2];
  const capArg = process.argv[3] ?? "structured_outputs";
  // Optional 4th arg: only probe models whose canonical id contains this
  // substring (focused re-checks, e.g. one model across several providers).
  const modelFilter = process.argv[4];
  if (!providerName) {
    console.error("usage: bun run scripts/verify-capabilities.ts <provider-name> [capability] [model-id-filter]");
    console.error(`capabilities: ${Capability.options.join(", ")}`);
    process.exit(2);
  }
  const capParse = Capability.safeParse(capArg);
  if (!capParse.success) {
    console.error(`✗ unknown capability '${capArg}' — known: ${Capability.options.join(", ")}`);
    process.exit(2);
  }
  const capability = capParse.data;
  const probe = PROBES[capability];
  if (!probe) {
    console.error(`✗ no probe implemented for capability '${capability}' yet`);
    process.exit(2);
  }

  const env = envSegment(providerName);
  const key = process.env[`${env}_API_KEY`];
  if (!key) {
    console.error(`✗ ${env}_API_KEY must be set`);
    process.exit(2);
  }

  const providers = await loadProviders();
  const found = providers.find((p) => p.data.name === providerName);
  if (!found) {
    console.error(`✗ provider '${providerName}' is not in this registry`);
    process.exit(2);
  }
  const provider = found.data;
  if (provider.models.length === 0) {
    console.error(`✗ provider '${providerName}' declares no models`);
    process.exit(2);
  }
  const models = modelFilter
    ? provider.models.filter((m) => m.id.includes(modelFilter))
    : provider.models;
  if (models.length === 0) {
    console.error(`✗ no model in '${providerName}' matches '${modelFilter}'`);
    process.exit(2);
  }

  // Base URL: an explicit {ENV}_API_BASE wins; otherwise fall back to the
  // provider's yaml `api_base` (set for BYOK providers, so they need
  // only the API key — matching check-new-models / .env.example). Anonymous
  // providers hold the base server-side, so they require the env override.
  const base = process.env[`${env}_API_BASE`] ?? provider.api_base;
  if (!base) {
    console.error(`✗ ${env}_API_BASE must be set ('${providerName}' has no api_base in its yaml)`);
    process.exit(2);
  }
  if (!base.startsWith("https://")) {
    console.error(`✗ base must be HTTPS (non-HTTPS upstreams are rejected)`);
    process.exit(2);
  }

  const bar = "─".repeat(92);
  console.log(`provider:   ${providerName}`);
  console.log(`base:       ${base}`);
  console.log(`key:        ${maskKey(key)}`);
  console.log(`capability: ${capability}`);
  console.log(bar);

  const canonWidth = Math.max(...models.map((m) => m.id.length));
  const pmidWidth = Math.max(...models.map((m) => m.provider_model_id.length));

  let declaredFailures = 0; // declared but not honoured (unsupported or unprobeable) → CI failure
  let suggestions = 0; // honoured but not declared → could add
  let inconclusive = 0; // probe errored (non-2xx) → support undetermined

  for (const m of models) {
    const protocol = resolveProtocol(provider, m);
    const declared = (m.capabilities ?? []).includes(capability);
    process.stdout.write(
      `${pad(m.id, canonWidth)} → ${pad(m.provider_model_id, pmidWidth)}  ${pad(protocol, 9)}  `,
    );
    // A 2xx-but-not-honoured result can be intermittent (e.g. a model that
    // sporadically skips a forced tool call — observed on tencent's minimax-m2.5,
    // which honoured tools on ~1 of 3 tries). Retry a few times before declaring
    // it unsupported. Non-2xx errors stay inconclusive on the first try —
    // retrying an auth / rate-limit / routing failure wouldn't help.
    let r = await probe(protocol, base, key, m.provider_model_id, provider.auth_scheme);
    for (let attempt = 1; attempt < 3 && !r.honored && r.status >= 200 && r.status < 300; attempt++) {
      r = await probe(protocol, base, key, m.provider_model_id, provider.auth_scheme);
    }

    let verdict: string;
    if (r.honored) {
      verdict = declared ? "✓ verified" : "+ supported (undeclared → add it)";
      if (!declared) suggestions++;
    } else if (r.status >= 200 && r.status < 300) {
      // 2xx but not schema-JSON ⇒ the channel accepted the param and ignored it.
      verdict = declared ? "✗ DECLARED-BUT-UNSUPPORTED" : "· unsupported";
      if (declared) declaredFailures++;
    } else {
      // non-2xx ⇒ couldn't probe (auth, rate-limit, route). Support undetermined.
      verdict = "? inconclusive";
      inconclusive++;
      if (declared) declaredFailures++;
    }

    const tail = r.honored ? "" : `  [HTTP ${r.status}${r.detail ? ` ${r.detail.slice(0, 80)}` : ""}]`;
    console.log(`${pad(`honored=${r.honored ? "yes" : "no"}`, 12)} ${verdict}${tail}`);
  }

  console.log(bar);
  console.log(
    `summary: ${declaredFailures} declared-but-unsupported, ${suggestions} undeclared-but-supported, ${inconclusive} inconclusive`,
  );
  if (declaredFailures > 0) {
    console.log(`✗ ${declaredFailures} declared '${capability}' capability(ies) are NOT honoured by the upstream`);
  }
  process.exit(declaredFailures > 0 ? 1 : 0);
}

if (import.meta.main) await main();
