/**
 * Pi extension: Exoscale inference providers.
 *
 * Registers one provider per zone (live zone list) so each shows up in
 * /login as "Exoscale <zone>". Exoscale AI keys are zone-local and pi
 * stores one credential per provider, so each zone keeps its own key and
 * every connected zone stays available at once.
 *
 * Models are discovered live from {endpoint}/models with that zone's
 * credential: the zone's on-demand endpoint plus the Dedicated Inference
 * deployment URLs entered at login. Each model carries the endpoint it came
 * from in its own baseUrl, so one zone can serve on-demand inference and
 * several deployments at the same time.
 *
 * Discovery runs at load for zones that already have a key, on startup
 * refreshes, and after login. A transient failure keeps the last good models
 * for that endpoint and records the error for /exo. Catalogs are persisted,
 * so print mode, RPC, and offline starts reuse the last good list.
 *
 * EXOSCALE_AI_API_KEY works as an environment credential on the default zone
 * (de-fra-1); there EXOSCALE_AI_ENDPOINT adds another endpoint to discover and
 * EXOSCALE_AI_ZONES adds zones the live list misses.
 *
 * Streaming delegates to pi-ai's OpenAI Completions implementation.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  type ApiKeyAuth,
  type ApiKeyCredential,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Constants
// ============================================================================

export const PROVIDER_PREFIX = "exo";
export const DEFAULT_ZONE = "de-fra-1";
export const DEFAULT_ENDPOINT = endpointForZone(DEFAULT_ZONE);
export const ZONE_API = "https://api-ch-gva-2.exoscale.com/v2/zone";

/** Environment API key, honored on the default zone only (keys are zone-local). */
export const ENV_KEY = "EXOSCALE_AI_API_KEY";
/** Extra endpoint discovered on the default zone. */
export const ENV_ENDPOINT = "EXOSCALE_AI_ENDPOINT";
/** Comma-separated zones added to the live zone list. */
export const ENV_ZONES = "EXOSCALE_AI_ZONES";
/** Stored in a credential's env: Dedicated Inference endpoints, comma-separated. */
export const ENV_ENDPOINTS = "EXOSCALE_AI_ENDPOINTS";

const DEFAULT_CONTEXT_WINDOW = 262144;
const DEFAULT_MAX_OUTPUT = 32768;

type ExoModel = Model<"openai-completions">;
type Env = Record<string, string | undefined>;

// ============================================================================
// Endpoints and zones
// ============================================================================

// Normalizes an endpoint pasted into the login prompt: trims whitespace,
// drops trailing slashes, and appends /v1 when the path lacks it.
export function normalizeEndpoint(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, "");
  if (!trimmed) return DEFAULT_ENDPOINT;
  if (/\/v1$/.test(trimmed)) return trimmed;
  return `${trimmed}/v1`;
}

// On-demand inference endpoint for a zone.
export function endpointForZone(zone: string): string {
  return `https://inference.${zone}.exoscale-cloud.com/v1`;
}

// Provider for a zone. Keys are zone-local and pi stores one credential per
// provider, so each zone is its own provider: a zone's key never crosses
// zones, and every connected zone stays available.
export function providerIdForZone(zone: string): string {
  return `${PROVIDER_PREFIX}-${zone}`;
}

export function providerNameForZone(zone: string): string {
  return `Exoscale ${zone}`;
}

// Endpoints from a comma- or whitespace-separated list, normalized and
// deduplicated. Empty entries are dropped.
export function parseEndpoints(raw: string | undefined): string[] {
  if (!raw) return [];
  const endpoints: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    if (!part) continue;
    // Anything without a scheme is a typo, not an endpoint: storing it would
    // turn into a confusing request failure later on.
    if (!/^https?:\/\//i.test(part)) continue;
    const endpoint = normalizeEndpoint(part);
    if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  }
  return endpoints;
}

// Endpoints to discover for a zone: the zone's on-demand endpoint, the
// Dedicated Inference endpoints stored on the credential, and, on the
// default zone, EXOSCALE_AI_ENDPOINT.
export function endpointsForZone(input: {
  zone: string;
  credential?: Pick<ApiKeyCredential, "env">;
  env?: Env;
}): string[] {
  const endpoints = [endpointForZone(input.zone)];
  const extras = [
    ...parseEndpoints(input.credential?.env?.[ENV_ENDPOINTS]),
    ...(input.zone === DEFAULT_ZONE ? parseEndpoints(input.env?.[ENV_ENDPOINT]) : []),
  ];
  for (const endpoint of extras) if (!endpoints.includes(endpoint)) endpoints.push(endpoint);
  return endpoints;
}

// Maps the zone API response to zone names.
export function zonesFromApi(body: unknown): string[] {
  const zones = body && typeof body === "object" ? (body as { zones?: unknown }).zones : undefined;
  if (!Array.isArray(zones)) return [];
  const names: string[] = [];
  for (const zone of zones) {
    const name = zone && typeof zone === "object" ? (zone as { name?: unknown }).name : undefined;
    if (typeof name !== "string") continue;
    const trimmed = name.trim();
    if (trimmed && !names.includes(trimmed)) names.push(trimmed);
  }
  return names;
}

// Fetches the active zone list. The endpoint is unauthenticated.
export async function fetchZones(input: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<string[]> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const response = await fetcher(ZONE_API, { signal: input.signal });
  if (!response.ok) throw new Error(`zone list failed: ${ZONE_API} responded ${response.status}`);
  return zonesFromApi(await response.json());
}

// Zones to register providers for: the default zone first, then the live
// list, then EXOSCALE_AI_ZONES. A failed zone list still yields the default
// zone, so the extension is never left with no provider.
export function zonesToRegister(input: { apiZones?: readonly string[]; env?: Env } = {}): string[] {
  const zones = [DEFAULT_ZONE];
  const add = (zone: string) => {
    if (zone && !zones.includes(zone)) zones.push(zone);
  };
  for (const zone of [...(input.apiZones ?? [])].sort()) add(zone);
  for (const zone of parseZones(input.env?.[ENV_ZONES])) add(zone);
  return zones;
}

function parseZones(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\s]+/)
    .map((zone) => zone.trim())
    .filter((zone) => zone !== "");
}

// ============================================================================
// Model mapping
// ============================================================================

// Display name for a model ID: the last path segment (vendor prefixes like
// nvidia/ are dropped).
export function displayName(modelID: string): string {
  const parts = modelID.split("/").filter((part) => part !== "");
  return parts[parts.length - 1] || modelID;
}

// Short label for an endpoint, used to keep model IDs unique across the
// endpoints of one zone. Deployment hosts shorten to their leading label,
// matching how Exoscale names Dedicated Inference deployments.
export function endpointSlug(endpoint: string): string {
  const host = hostnameOf(endpoint);
  const label = host.split(".")[0] ?? host;
  const onDemand = host.split(".").includes("inference") && label === "inference";
  if (onDemand) return "ondemand";
  return label.slice(0, 8) || "custom";
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^https?:\/\//, "").split("/")[0];
  }
}

// Maps an OpenAI-compatible /models entry to a pi chat model. Unknown or
// malformed entries return undefined. Limits come from max_model_len /
// max_completion_tokens when the backend reports them, so a model the
// backend does not describe still gets usable defaults.
export function toModel(entry: unknown, input: { provider: string; endpoint: string }): ExoModel | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const record = entry as Record<string, unknown>;
  const id = typeof record.id === "string" ? record.id : undefined;
  if (!id) return undefined;
  const contextWindow = positiveInteger(record.max_model_len) ?? DEFAULT_CONTEXT_WINDOW;
  const maxTokens = Math.min(positiveInteger(record.max_completion_tokens) ?? DEFAULT_MAX_OUTPUT, contextWindow);
  return {
    id,
    name: displayName(id),
    api: "openai-completions",
    provider: input.provider,
    baseUrl: input.endpoint,
    input: ["text"],
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens,
    // vLLM-style backends: no OpenAI-only request fields, and the classic
    // max_tokens field. Verified against Exoscale inference endpoints.
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsReasoningEffort: false,
      supportsUsageInStreaming: true,
      maxTokensField: "max_tokens",
    },
  };
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

// Maps an OpenAI-compatible /models response body to models for one
// endpoint. Duplicate IDs inside one body collapse to the first entry.
export function mapModels(body: unknown, input: { provider: string; endpoint: string }): ExoModel[] {
  const data = body && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  if (!Array.isArray(data)) return [];
  const models: ExoModel[] = [];
  for (const entry of data) {
    const model = toModel(entry, input);
    if (!model) continue;
    if (models.some((known) => known.id === model.id)) continue;
    models.push(model);
  }
  return models;
}

// ============================================================================
// Discovery
// ============================================================================

// Fetches the model list of one endpoint.
export async function fetchModels(input: {
  endpoint: string;
  key: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<unknown> {
  const fetcher = input.fetch ?? globalThis.fetch;
  const url = `${input.endpoint.replace(/\/+$/, "")}/models`;
  const response = await fetcher(url, {
    headers: { authorization: `Bearer ${input.key}` },
    signal: input.signal,
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).trim().slice(0, 300);
    throw new Error(`model discovery failed: ${url} responded ${response.status}${detail ? ` ${detail}` : ""}`);
  }
  return await response.json();
}

// Discovers every endpoint of one provider. Models of an endpoint that fails
// are reused from `previous`, so one broken endpoint does not drop the
// models of the others; the failures come back as messages for /exo.
// Model IDs must be unique within a provider, so a model offered by several
// endpoints of a zone keeps its ID on the first endpoint and gets the
// endpoint's slug as a prefix on the others.
export async function discoverModels(input: {
  provider: string;
  endpoints: readonly string[];
  key: string;
  previous?: readonly ExoModel[];
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<{ models: ExoModel[]; errors: string[] }> {
  const models: ExoModel[] = [];
  const errors: string[] = [];
  for (const endpoint of input.endpoints) {
    if (input.signal?.aborted) break;
    let discovered: ExoModel[];
    try {
      const body = await fetchModels({
        endpoint,
        key: input.key,
        fetch: input.fetch,
        signal: input.signal,
      });
      discovered = mapModels(body, { provider: input.provider, endpoint });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      const kept = (input.previous ?? []).filter((model) => model.baseUrl === endpoint);
      for (const model of kept) if (!models.some((known) => known.id === model.id)) models.push(model);
      continue;
    }
    const slug = endpointSlug(endpoint);
    for (const model of discovered) {
      if (models.some((known) => known.id === model.id)) {
        const prefixed = { ...model, id: `${slug}/${model.id}` };
        if (models.some((known) => known.id === prefixed.id)) continue;
        models.push(prefixed);
        continue;
      }
      models.push(model);
    }
  }
  return { models, errors };
}

// Last discovery errors per provider, reported by /exo. Discovery keeps the
// previous list on failure, so an error here is a status, not a crash.
const lastErrors = new Map<string, string[]>();

export function discoveryErrors(providerId: string): readonly string[] {
  return lastErrors.get(providerId) ?? [];
}

// Whether this process already refreshed the Exoscale model lists.
let refreshedAtLeastOnce = false;
// Problems that only matter for status: the zone list or the first discovery.
let startupError: string | undefined;

// ============================================================================
// Model cache
// ============================================================================

// pi restores a published catalog asynchronously, after extensions have been
// asked for their models, so a single-shot `pi -p --provider exo-<zone>
// --model <id>` would see an empty list. The extension keeps its own small
// JSON snapshot and reads it synchronously at startup. Refreshes still go
// through pi, so the catalog also lands in pi's own store.

export function cachePath(env: Env = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "pi-exoscale-models.json");
}

type CacheFile = {
  version: 1;
  providers: Record<string, { updatedAt: string; models: ExoModel[] }>;
};

function readCacheFile(path: string): CacheFile | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return undefined;
    const providers = (parsed as CacheFile).providers;
    return providers && typeof providers === "object" ? { version: 1, providers } : undefined;
  } catch {
    return undefined; // missing or unreadable: no cache, discovery fills it in
  }
}

// Cached models of one provider. Entries that no longer look like Exoscale
// chat models are dropped rather than handed to pi half-valid.
export function readCachedModels(providerId: string, path = cachePath()): ExoModel[] {
  const entry = readCacheFile(path)?.providers[providerId];
  if (!Array.isArray(entry?.models)) return [];
  return entry.models.filter((model) => isCachedModel(model, providerId));
}

function isCachedModel(value: unknown, providerId: string): value is ExoModel {
  if (!value || typeof value !== "object") return false;
  const model = value as Partial<ExoModel>;
  return (
    model.id !== undefined &&
    model.api === "openai-completions" &&
    model.provider === providerId &&
    typeof model.baseUrl === "string" &&
    typeof model.contextWindow === "number" &&
    typeof model.maxTokens === "number"
  );
}

// Replaces one provider's entry. Writes are best effort: a read-only agent
// directory loses the cache, not the session.
export function writeCachedModels(providerId: string, models: readonly ExoModel[], path = cachePath()): void {
  try {
    const file: CacheFile = readCacheFile(path) ?? { version: 1, providers: {} };
    file.providers[providerId] = { updatedAt: new Date().toISOString(), models: [...models] };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(file, null, 2));
  } catch {
    // Ignored on purpose: the cache is an optimization.
  }
}

// ============================================================================
// Providers
// ============================================================================

export function createZoneProvider(input: {
  zone: string;
  env?: Env;
  fetch?: typeof fetch;
  cachePath?: string;
}): Provider<"openai-completions"> {
  const zone = input.zone;
  const id = providerIdForZone(zone);
  const env = input.env ?? process.env;
  const envKey = zone === DEFAULT_ZONE;
  // Catalog of this provider: last known models, replaced on each successful
  // discovery. Read from disk so a single-shot run starts with a real list.
  let models: ExoModel[] = readCachedModels(id, input.cachePath ?? cachePath(env));

  const apiKey: ApiKeyAuth = {
    name: `Exoscale ${zone} API key`,
    login: async (interaction) => {
      interaction.signal.throwIfAborted();
      const key = (await interaction.prompt({ type: "secret", message: `Enter Exoscale ${zone} API key` })).trim();
      if (!key) throw new Error(`No Exoscale ${zone} API key entered.`);
      const endpoints = parseEndpoints(
        await interaction.prompt({
          type: "text",
          message: `Dedicated Inference endpoints in ${zone} (optional, comma-separated)`,
          placeholder: `https://<deployment-id>.inference.${zone}.exoscale-cloud.com/v1`,
        }),
      );
      const credential: ApiKeyCredential = {
        type: "api_key",
        key,
        ...(endpoints.length > 0 ? { env: { [ENV_ENDPOINTS]: endpoints.join(",") } } : {}),
      };
      // pi refreshes the catalog after a login and reports a failing endpoint
      // itself, so the key is stored without a check here.
      return credential;
    },
    check: async ({ ctx, credential }) => {
      if (credential?.key) return { type: "api_key", source: "stored credential" };
      if (envKey && (await ctx.env(ENV_KEY))) return { type: "api_key", source: ENV_KEY };
      return undefined;
    },
    resolve: async ({ ctx, credential }) => {
      if (credential?.key) {
        return { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" };
      }
      // No account connected (fresh install): the environment can still drive
      // the default zone.
      if (envKey) {
        const key = await ctx.env(ENV_KEY);
        if (key) return { auth: { apiKey: key }, env: credential?.env, source: ENV_KEY };
      }
      return undefined;
    },
  };

  const completions = openAICompletionsApi();

  return {
    id,
    name: providerNameForZone(zone),
    baseUrl: endpointForZone(zone),
    auth: { apiKey },
    getModels: () => models,
    refreshModels: async (context) => {
      const stored = (context.stored?.models ?? []).filter(
        (model): model is ExoModel => model.provider === id && model.api === "openai-completions",
      );
      // Start from what pi already knows about this provider.
      if (models.length === 0 && stored.length > 0) models = [...stored];
      const credential = context.credential?.type === "api_key" ? context.credential : undefined;
      const key = credential?.key ?? (envKey ? env[ENV_KEY] : undefined);
      if (!context.allowNetwork || context.signal.aborted || !key) return;
      const { models: discovered, errors } = await discoverModels({
        provider: id,
        endpoints: endpointsForZone({ zone, credential: { env: credential?.env }, env }),
        key,
        previous: models,
        fetch: input.fetch,
        signal: context.signal,
      });
      if (context.signal.aborted) return;
      if (errors.length > 0) lastErrors.set(id, errors);
      else lastErrors.delete(id);
      // An empty discovery result would hide a catalog that worked before.
      const next = discovered.length > 0 ? discovered : models;
      if (next.length === 0) return;
      const published = await context.publish({
        persist: { models: next, checkedAt: Date.now() },
        update: () => {
          models = [...next];
        },
      });
      if (published) writeCachedModels(id, next, input.cachePath ?? cachePath(env));
    },
    stream: (model, context, options) => completions.stream(model, context, options),
    streamSimple: (model, context, options) => completions.streamSimple(model, context, options),
  };
}

// ============================================================================
// Extension
// ============================================================================

// pi hands a provider its stored credential when a session runs, but the CLI
// resolves --provider/--model before that. Reading pi's credential store here
// (the key is never logged) lets the same discovery run at load, so the first
// `pi -p` after a login or a restored config already has a model list. Keys
// are used only against their own provider's endpoints.
function readAuthStore(env: Env = process.env): Record<string, Pick<ApiKeyCredential, "key" | "env">> {
  const path = join(dirname(cachePath(env)), "auth.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return {}; // no store, unreadable, or another credential format
  }
  const credentials: Record<string, Pick<ApiKeyCredential, "key" | "env">> = {};
  if (!parsed || typeof parsed !== "object") return credentials;
  for (const [providerId, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const record = entry as { type?: unknown; key?: unknown; env?: unknown };
    if (record?.type !== "api_key" || typeof record.key !== "string" || record.key.length === 0) continue;
    const envs: Record<string, string> = {};
    if (record.env && typeof record.env === "object") {
      for (const [name, value] of Object.entries(record.env as Record<string, unknown>)) {
        if (typeof value === "string") envs[name] = value;
      }
    }
    credentials[providerId] = { key: record.key, ...(Object.keys(envs).length > 0 ? { env: envs } : {}) };
  }
  return credentials;
}

// Zones that have a stored API key, so a restored config works right away.
export function credentialZones(env: Env = process.env): string[] {
  const prefix = `${PROVIDER_PREFIX}-`;
  const zones: string[] = [];
  for (const providerId of Object.keys(readAuthStore(env))) {
    const zone = providerId.startsWith(prefix) ? providerId.slice(prefix.length) : "";
    if (zone && !zones.includes(zone)) zones.push(zone);
  }
  return zones;
}

// Fetches the model lists of configured zones that have no cache yet, so
// providers register with their real catalog instead of an empty one.
export async function bootstrapModels(input: {
  zones?: string[];
  env?: Env;
  fetch?: typeof fetch;
  cachePath?: string;
  signal?: AbortSignal;
} = {}): Promise<Record<string, ExoModel[]>> {
  const env = input.env ?? process.env;
  const cache = input.cachePath ?? cachePath(env);
  const credentials = readAuthStore(env);
  const discovered: Record<string, ExoModel[]> = {};
  for (const zone of input.zones ?? []) {
    const id = providerIdForZone(zone);
    if (readCachedModels(id, cache).length > 0 || input.signal?.aborted) continue;
    const stored = credentials[id];
    // Keys are zone-local: the environment can only drive the default zone.
    const key = stored?.key ?? (zone === DEFAULT_ZONE ? env[ENV_KEY] : undefined);
    if (!key) continue;
    const { models } = await discoverModels({
      provider: id,
      endpoints: endpointsForZone({ zone, credential: stored, env }),
      key,
      fetch: input.fetch,
      signal: input.signal,
    });
    if (models.length > 0) {
      writeCachedModels(id, models, cache);
      discovered[id] = models;
    }
  }
  return discovered;
}

export default async function (pi: ExtensionAPI) {
  const registered = new Set<string>();
  const registerZone = (zone: string) => {
    if (registered.has(zone)) return;
    registered.add(zone);
    pi.registerProvider(createZoneProvider({ zone }));
  };

  // Zones known without the network: the default zone, EXOSCALE_AI_ZONES, and any
  // zone with a stored key.
  const zones = [...new Set([...zonesToRegister({ env: process.env }), ...credentialZones()])];

  // pi resolves --provider/--model once extensions have loaded, so the model
  // lists of configured zones are fetched and cached here, while the load-time
  // context can still do network calls. Cached zones skip it, which keeps
  // startup offline-fast.
  if (!process.env.PI_OFFLINE) {
    // Bounded: an unreachable endpoint must not hold up startup, and a missing
    // list is filled in by the first refresh.
    await bootstrapModels({ zones, signal: AbortSignal.timeout(5000) }).catch((error) => {
      startupError = `initial model discovery failed: ${error}`;
      return {};
    });
  }
  for (const zone of zones) registerZone(zone);

  // Startup refresh, once per process: adds the zones from the live zone list
  // (network work has to happen while the context is live, which excludes
  // fire-and-forget after load), then refreshes the model lists of all
  // Exoscale providers.
  pi.on("resources_discover", async (_event, ctx) => {
    if (refreshedAtLeastOnce) return;
    refreshedAtLeastOnce = true;
    if (!process.env.PI_OFFLINE) {
      await fetchZones({ signal: AbortSignal.timeout(5000) })
        .then((apiZones) => {
          for (const zone of zonesToRegister({ apiZones, env: process.env })) registerZone(zone);
        })
        .catch((error) => {
          // The default zone and EXOSCALE_AI_ZONES are already registered, so a
          // zone list that cannot be reached costs the extra zones only.
          startupError = `zone list fetch failed: ${error}`;
        });
    }
    // Bounded so an unreachable endpoint delays startup at most this long.
    await ctx.modelRegistry.refresh({
      providers: [...registered].map(providerIdForZone),
      signal: AbortSignal.timeout(8000),
    });
  });

  pi.registerCommand("exo", {
    description: "Exoscale inference status: zones, endpoints, models, discovery errors",
    handler: async (args, ctx) => {
      const providerIds = ctx.modelRegistry
        .getRegisteredProviderIds()
        .filter((providerId) => providerId.startsWith(`${PROVIDER_PREFIX}-`));

      if (args.trim() === "refresh") {
        const result = await ctx.modelRegistry.refresh({ providers: providerIds, force: true });
        const failed = [...result.errors.entries()].map(([provider, error]) => `${provider}: ${error.message}`);
        ctx.ui.notify(failed.length > 0 ? `Refresh failed:\n${failed.join("\n")}` : "Model lists refreshed.", "info");
      }

      const lines: string[] = [];
      for (const providerId of providerIds) {
        const zone = providerId.slice(PROVIDER_PREFIX.length + 1);
        const auth = await ctx.modelRegistry.getProviderAuth(providerId);
        const status = ctx.modelRegistry.getProviderAuthStatus(providerId);
        const models = ctx.modelRegistry.getModelsOfType("chat", providerId);
        const endpoints = endpointsForZone({ zone, credential: { env: auth?.env }, env: process.env });
        lines.push(
          `${zone}: ${models.length} models, ${status.configured ? status.label ?? status.source ?? "configured" : "not connected"}`,
        );
        for (const endpoint of endpoints) lines.push(`  ${endpoint}`);
        for (const error of discoveryErrors(providerId)) lines.push(`  error: ${error}`);
      }
      if (startupError) lines.push(`note: ${startupError}`);
      ctx.ui.notify(lines.length > 0 ? lines.join("\n") : "No Exoscale providers registered.", "info");
    },
  });
}
