// models.dev catalog client — the KEYLESS source of truth for what each
// first-party provider serves, plus pricing and metadata. Replaces probing
// each provider's live `/models` with per-provider API keys: one public fetch,
// no secrets, no per-provider auth quirks, and it even covers providers that
// expose no `/models` endpoint (minimax) or gate it behind credits (xai).
//
// This is the same source the first-party provider YAMLs already cite
// ("Catalog source: https://models.dev/api.json"), so pricing stays consistent.

export interface CatalogModel {
  id: string; // the provider's model id (i.e. a provider_model_id)
  name?: string;
  release_date?: string;
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; output?: number };
}

// providerKey (models.dev's key, e.g. "openai", "stepfun-ai") → modelId → model
export type Catalog = Map<string, Map<string, CatalogModel>>;

const MODELS_DEV_URL = "https://models.dev/api.json";

export async function loadCatalog(url = MODELS_DEV_URL): Promise<Catalog> {
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    try {
      response = await fetch(url, { headers: { Accept: "application/json" } });
      break;
    } catch (err) {
      if (attempt >= 2) throw err;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  if (!response.ok) throw new Error(`models.dev HTTP ${response.status}`);
  const data = (await response.json()) as Record<string, { models?: Record<string, CatalogModel> }>;

  const out: Catalog = new Map();
  for (const [providerKey, provider] of Object.entries(data)) {
    const models = provider?.models;
    if (!models || typeof models !== "object") continue;
    const byId = new Map<string, CatalogModel>();
    for (const [modelId, model] of Object.entries(models)) byId.set(modelId, model);
    out.set(providerKey, byId);
  }
  return out;
}
