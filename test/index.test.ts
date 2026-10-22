import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import extension, {
  DEFAULT_ENDPOINT,
  DEFAULT_ZONE,
  ENV_ENDPOINT,
  ENV_ENDPOINTS,
  ENV_KEY,
  ENV_ZONES,
  ZONE_API,
  bootstrapModels,
  createZoneProvider,
  credentialZones,
  discoverModels,
  displayName,
  endpointForZone,
  endpointSlug,
  endpointsForZone,
  fetchModels,
  fetchZones,
  mapModels,
  normalizeEndpoint,
  parseEndpoints,
  providerIdForZone,
  providerNameForZone,
  readCachedModels,
  toModel,
  writeCachedModels,
  zonesFromApi,
  zonesToRegister,
} from "../index.ts";

// Path to a cache file that does not exist, so tests neither read nor write
// the real one.
function noCache(): string {
  return join(mkdtempSync(join(tmpdir(), "pi-exoscale-test-")), "models.json");
}

// ============================================================================
// Endpoint resolution
// ============================================================================

test("normalizeEndpoint keeps a bare /v1 URL", () => {
  assert.equal(normalizeEndpoint("https://inference.de-fra-1.exoscale-cloud.com/v1"), DEFAULT_ENDPOINT);
});

test("normalizeEndpoint appends /v1 when missing", () => {
  assert.equal(
    normalizeEndpoint("https://e72addb9.inference.de-fra-1.exoscale-cloud.com"),
    "https://e72addb9.inference.de-fra-1.exoscale-cloud.com/v1",
  );
});

test("normalizeEndpoint drops trailing slashes and trims whitespace", () => {
  assert.equal(normalizeEndpoint("https://example.com/v1/"), "https://example.com/v1");
  assert.equal(normalizeEndpoint("  https://example.com/v1  "), "https://example.com/v1");
});

test("normalizeEndpoint falls back to the default on empty input", () => {
  assert.equal(normalizeEndpoint(""), DEFAULT_ENDPOINT);
  assert.equal(normalizeEndpoint("   "), DEFAULT_ENDPOINT);
});

test("endpointForZone builds the on-demand endpoint", () => {
  assert.equal(endpointForZone(DEFAULT_ZONE), DEFAULT_ENDPOINT);
  assert.equal(endpointForZone("at-vie-1"), "https://inference.at-vie-1.exoscale-cloud.com/v1");
});

test("provider identity is derived from the zone", () => {
  assert.equal(providerIdForZone("de-fra-1"), "exo-de-fra-1");
  assert.equal(providerNameForZone("ch-gva-2"), "Exoscale ch-gva-2");
});

test("parseEndpoints splits, normalizes, and deduplicates", () => {
  assert.deepEqual(
    parseEndpoints(" https://a.example.com/v1/ , https://b.example.com https://a.example.com/v1 "),
    ["https://a.example.com/v1", "https://b.example.com/v1"],
  );
  assert.deepEqual(parseEndpoints(undefined), []);
  assert.deepEqual(parseEndpoints("  ,, "), []);
});

const credential = (endpoints?: string) => (endpoints ? { env: { [ENV_ENDPOINTS]: endpoints } } : undefined);

test("endpointsForZone always includes the zone's on-demand endpoint", () => {
  assert.deepEqual(endpointsForZone({ zone: "ch-gva-2" }), ["https://inference.ch-gva-2.exoscale-cloud.com/v1"]);
});

test("endpointsForZone adds the Dedicated Inference endpoints stored on the credential", () => {
  assert.deepEqual(
    endpointsForZone({
      zone: "de-fra-1",
      credential: credential("https://e72addb9.inference.de-fra-1.exoscale-cloud.com/v1"),
    }),
    [DEFAULT_ENDPOINT, "https://e72addb9.inference.de-fra-1.exoscale-cloud.com/v1"],
  );
});

test("endpointsForZone adds EXOSCALE_AI_ENDPOINT on the default zone only", () => {
  assert.deepEqual(endpointsForZone({ zone: DEFAULT_ZONE, env: { [ENV_ENDPOINT]: "https://custom.example" } }), [
    DEFAULT_ENDPOINT,
    "https://custom.example/v1",
  ]);
  assert.deepEqual(endpointsForZone({ zone: "de-muc-1", env: { [ENV_ENDPOINT]: "https://custom.example" } }), [
    "https://inference.de-muc-1.exoscale-cloud.com/v1",
  ]);
});

test("endpointSlug names on-demand and deployment endpoints", () => {
  assert.equal(endpointSlug(DEFAULT_ENDPOINT), "ondemand");
  assert.equal(
    endpointSlug("https://e72addb9-561b-432b-bd80-a654999e1b06.inference.de-fra-1.exoscale-cloud.com/v1"),
    "e72addb9",
  );
});

// ============================================================================
// Zone list
// ============================================================================

test("zonesFromApi maps zone names, skipping malformed entries and duplicates", () => {
  assert.deepEqual(zonesFromApi({ zones: [{ name: "ch-gva-2", id: "1" }, { name: "de-fra-1" }] }), [
    "ch-gva-2",
    "de-fra-1",
  ]);
  assert.deepEqual(zonesFromApi({ zones: [{ name: "de-fra-1" }, null, 42, { name: "de-fra-1" }, { name: "  " }] }), [
    "de-fra-1",
  ]);
  assert.deepEqual(zonesFromApi(undefined), []);
  assert.deepEqual(zonesFromApi({ zones: "nope" }), []);
});

test("fetchZones reads the zone list from the API", async () => {
  const lastCall: LastCall = { url: "" };
  const zones = await fetchZones({ fetch: stubFetch(lastCall, 200, { zones: [{ name: "at-vie-1" }] }) });
  assert.deepEqual(zones, ["at-vie-1"]);
  assert.equal(lastCall.url, ZONE_API);
});

test("fetchZones rejects on a non-OK response", async () => {
  await assert.rejects(
    () => fetchZones({ fetch: stubFetch({ url: "" }, 503, { error: "unavailable" }) }),
    (error: Error) => error.message.includes("503"),
  );
});

test("zonesToRegister keeps the default zone first and adds the live list and EXOSCALE_AI_ZONES", () => {
  assert.deepEqual(zonesToRegister({ apiZones: ["de-muc-1", "ch-gva-2", DEFAULT_ZONE] }), [
    DEFAULT_ZONE,
    "ch-gva-2",
    "de-muc-1",
  ]);
  assert.deepEqual(zonesToRegister({ apiZones: [], env: { [ENV_ZONES]: "bg-sof-1,de-fra-1" } }), [
    DEFAULT_ZONE,
    "bg-sof-1",
  ]);
  // A failed zone list still yields the default zone.
  assert.deepEqual(zonesToRegister({ apiZones: undefined }), [DEFAULT_ZONE]);
  assert.deepEqual(zonesToRegister(), [DEFAULT_ZONE]);
});

// ============================================================================
// Model mapping
// ============================================================================

const vllmBody = {
  object: "list",
  data: [
    {
      id: "nvidia/Qwen3.8-27B-NVFP4",
      object: "model",
      created: 1750000000,
      owned_by: "vllm",
      max_model_len: 32768,
      max_completion_tokens: 8192,
    },
    { id: "Qwen/Qwen3.8-27B", object: "model", created: 1750000001, owned_by: "vllm" },
    { id: "nvidia/Qwen3.8-27B-NVFP4" }, // duplicate, collapsed
    { object: "model" }, // missing id, skipped
    "not-an-object", // skipped
  ],
};

test("mapModels maps an OpenAI-compatible list to pi chat models", () => {
  const models = mapModels(vllmBody, { provider: "exo-de-fra-1", endpoint: DEFAULT_ENDPOINT });
  assert.equal(models.length, 2);

  const [first, second] = models;
  assert.equal(first.id, "nvidia/Qwen3.8-27B-NVFP4");
  assert.equal(first.name, "Qwen3.8-27B-NVFP4");
  assert.equal(first.api, "openai-completions");
  assert.equal(first.provider, "exo-de-fra-1");
  assert.equal(first.baseUrl, DEFAULT_ENDPOINT);
  assert.deepEqual(first.input, ["text"]);
  assert.equal(first.reasoning, false);
  assert.equal(first.contextWindow, 32768);
  assert.equal(first.maxTokens, 8192);
  assert.deepEqual(first.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(first.compat?.maxTokensField, "max_tokens");
  assert.equal(first.compat?.supportsDeveloperRole, false);

  // No max_* reported: usable defaults stay in place.
  assert.equal(second.contextWindow > 0, true);
  assert.equal(second.maxTokens > 0, true);
  assert.equal(second.maxTokens <= second.contextWindow, true);
});

test("mapModels returns an empty list for malformed bodies", () => {
  const input = { provider: "exo-de-fra-1", endpoint: DEFAULT_ENDPOINT };
  assert.deepEqual(mapModels(undefined, input), []);
  assert.deepEqual(mapModels("nope", input), []);
  assert.deepEqual(mapModels({}, input), []);
  assert.deepEqual(mapModels({ data: "nope" }, input), []);
  assert.deepEqual(mapModels({ data: [null, 42, { name: "no-id" }] }, input), []);
});

test("toModel clamps the reported output limit to the context window", () => {
  const model = toModel({ id: "m", max_model_len: 4096, max_completion_tokens: 999999 }, {
    provider: "exo-de-fra-1",
    endpoint: DEFAULT_ENDPOINT,
  });
  assert.equal(model?.contextWindow, 4096);
  assert.equal(model?.maxTokens, 4096);
  assert.equal(toModel({ id: "" }, { provider: "p", endpoint: DEFAULT_ENDPOINT }), undefined);
});

test("displayName drops vendor prefixes", () => {
  assert.equal(displayName("nvidia/Qwen3.8-27B-NVFP4"), "Qwen3.8-27B-NVFP4");
  assert.equal(displayName("plain-model"), "plain-model");
  assert.equal(displayName("a/b/"), "b");
});

// ============================================================================
// Discovery fetch
// ============================================================================

type LastCall = { url: string; headers?: Record<string, string> };

function stubFetch(lastCall: LastCall, status: number, body: unknown) {
  return (url: string | URL | Request, init?: RequestInit) => {
    lastCall.url = String(url);
    lastCall.headers = init?.headers as Record<string, string> | undefined;
    return Promise.resolve(
      new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
    );
  };
}

function stubFetchByEndpoint(routes: Record<string, { status: number; body: unknown }>, lastUrls: string[]) {
  return (url: string | URL | Request) => {
    const key = String(url);
    lastUrls.push(key);
    const route = routes[key];
    return Promise.resolve(
      new Response(JSON.stringify(route?.body ?? {}), { status: route?.status ?? 404 }),
    );
  };
}

test("fetchModels calls {endpoint}/models with the bearer key", async () => {
  const lastCall: LastCall = { url: "" };
  const body = { data: [{ id: "a/b" }] };
  const out = await fetchModels({
    endpoint: "https://dedicated.example/v1/",
    key: "sk-test",
    fetch: stubFetch(lastCall, 200, body),
  });
  assert.deepEqual(out, body);
  assert.equal(lastCall.url, "https://dedicated.example/v1/models");
  assert.equal(lastCall.headers?.authorization, "Bearer sk-test");
});

test("fetchModels throws on non-2xx with the status and detail", async () => {
  const lastCall: LastCall = { url: "" };
  await assert.rejects(
    () =>
      fetchModels({
        endpoint: "https://dedicated.example/v1",
        key: "sk-bad",
        fetch: stubFetch(lastCall, 401, { error: { message: "missing or malformed Authorization header" } }),
      }),
    (error: Error) =>
      error.message.includes("401") && error.message.includes("missing or malformed Authorization header"),
  );
});

test("fetchModels throws on a network error", async () => {
  await assert.rejects(
    () =>
      fetchModels({
        endpoint: "https://unreachable.invalid/v1",
        key: "sk-test",
        fetch: (async () => {
          throw new TypeError("fetch failed");
        }) as typeof fetch,
      }),
    /fetch failed/,
  );
});

// ============================================================================
// Discovery across the endpoints of one zone
// ============================================================================

const dedicatedEndpoint = "https://e72addb9-561b-432b-bd80-a654999e1b06.inference.de-fra-1.exoscale-cloud.com/v1";
const onDemandModelsUrl = `${DEFAULT_ENDPOINT}/models`;
const dedicatedModelsUrl = `${dedicatedEndpoint}/models`;

test("discoverModels collects the models of every endpoint", async () => {
  const urls: string[] = [];
  const out = await discoverModels({
    provider: "exo-de-fra-1",
    endpoints: [DEFAULT_ENDPOINT, dedicatedEndpoint],
    key: "sk-test",
    fetch: stubFetchByEndpoint(
      {
        [onDemandModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/A" }] } },
        [dedicatedModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/B" }] } },
      },
      urls,
    ),
  });
  assert.deepEqual(out.errors, []);
  assert.deepEqual(
    out.models.map((model) => [model.id, model.baseUrl]),
    [
      ["nvidia/A", DEFAULT_ENDPOINT],
      ["nvidia/B", dedicatedEndpoint],
    ],
  );
  assert.equal(urls.length, 2);
});

test("discoverModels prefixes model IDs offered by several endpoints", () => {
  const urls: string[] = [];
  return discoverModels({
    provider: "exo-de-fra-1",
    endpoints: [DEFAULT_ENDPOINT, dedicatedEndpoint],
    key: "sk-test",
    fetch: stubFetchByEndpoint(
      {
        [onDemandModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/A" }] } },
        [dedicatedModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/A" }] } },
      },
      urls,
    ),
  }).then((out) => {
    assert.deepEqual(
      out.models.map((model) => model.id),
      ["nvidia/A", "e72addb9/nvidia/A"],
    );
    assert.equal(out.models[1]?.baseUrl, dedicatedEndpoint);
  });
});

test("discoverModels keeps the last good models of an endpoint that fails", async () => {
  const urls: string[] = [];
  const previous = mapModels({ data: [{ id: "nvidia/A" }] }, {
    provider: "exo-de-fra-1",
    endpoint: DEFAULT_ENDPOINT,
  });
  const out = await discoverModels({
    provider: "exo-de-fra-1",
    endpoints: [DEFAULT_ENDPOINT, dedicatedEndpoint],
    key: "sk-test",
    previous,
    fetch: stubFetchByEndpoint(
      { [dedicatedModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/B" }] } } },
      urls,
    ),
  });
  assert.equal(out.errors.length, 1);
  assert.match(out.errors[0] ?? "", /404/);
  assert.deepEqual(
    out.models.map((model) => model.id),
    ["nvidia/A", "nvidia/B"],
  );
});

test("discoverModels stops on abort", async () => {
  const controller = new AbortController();
  controller.abort();
  const urls: string[] = [];
  const out = await discoverModels({
    provider: "exo-de-fra-1",
    endpoints: [DEFAULT_ENDPOINT, dedicatedEndpoint],
    key: "sk-test",
    signal: controller.signal,
    fetch: stubFetchByEndpoint({}, urls),
  });
  assert.deepEqual(out.models, []);
  assert.deepEqual(urls, []);
});

// ============================================================================
// Provider
// ============================================================================

test("createZoneProvider registers an OpenAI-compatible zone provider", () => {
  const provider = createZoneProvider({ zone: "ch-gva-2", env: { [ENV_KEY]: "sk-env" }, cachePath: noCache() });
  assert.equal(provider.id, "exo-ch-gva-2");
  assert.equal(provider.name, "Exoscale ch-gva-2");
  assert.equal(provider.baseUrl, "https://inference.ch-gva-2.exoscale-cloud.com/v1");
  assert.equal(provider.auth.apiKey?.name, "Exoscale ch-gva-2 API key");
  assert.equal(typeof provider.auth.apiKey?.login, "function");
  assert.equal(typeof provider.auth.apiKey?.resolve, "function");
  assert.equal(typeof provider.refreshModels, "function");
  assert.deepEqual(provider.getModels(), []);
});

test("createZoneProvider resolves a stored key before the environment", async () => {
  const provider = createZoneProvider({ zone: DEFAULT_ZONE, cachePath: noCache() });
  const resolve = provider.auth.apiKey?.resolve;
  assert.ok(resolve);
  const ctx = { env: async (name: string) => (name === ENV_KEY ? "sk-env" : undefined), fileExists: async () => false };

  const stored = await resolve({ ctx, credential: { type: "api_key", key: "sk-stored" }, signal: new AbortController().signal });
  assert.deepEqual(stored?.auth, { apiKey: "sk-stored" });
  assert.equal(stored?.source, "stored credential");

  // No account connected: the environment can still drive the default zone.
  const fromEnv = await resolve({ ctx, signal: new AbortController().signal });
  assert.deepEqual(fromEnv?.auth, { apiKey: "sk-env" });
  assert.equal(fromEnv?.source, ENV_KEY);

  // Keys are zone-local, so the environment only drives the default zone.
  const other = createZoneProvider({ zone: "de-muc-1", cachePath: noCache() });
  assert.equal(await other.auth.apiKey?.resolve({ ctx, signal: new AbortController().signal }), undefined);
});

test("login asks for the key, then for Dedicated Inference endpoints", async () => {
  const asked: { type: string; message: string }[] = [];
  const answers = [" sk-test ", `${dedicatedEndpoint}, https://other.inference.de-fra-1.exoscale-cloud.com`];
  const provider = createZoneProvider({ zone: DEFAULT_ZONE, env: {}, cachePath: noCache() });
  const login = provider.auth.apiKey?.login;
  assert.ok(login);
  const credential = await login({
    signal: new AbortController().signal,
    prompt: async (options: { type: string; message: string }) => {
      asked.push({ type: options.type, message: options.message });
      return answers.shift() ?? "";
    },
  } as never);
  assert.equal(asked.length, 2);
  assert.equal(asked[0]?.type, "secret");
  assert.equal(asked[1]?.message.includes("de-fra-1"), true);
  assert.equal((credential as { key: string }).key, "sk-test");
  assert.deepEqual(parseEndpoints((credential as { env: Record<string, string> }).env[ENV_ENDPOINTS]), [
    dedicatedEndpoint,
    "https://other.inference.de-fra-1.exoscale-cloud.com/v1",
  ]);
});

test("login without endpoints stores the key alone, and an empty key fails", async () => {
  const provider = createZoneProvider({ zone: DEFAULT_ZONE, env: {}, cachePath: noCache() });
  const login = provider.auth.apiKey?.login;
  assert.ok(login);
  const credential = await login({
    signal: new AbortController().signal,
    prompt: async (options: { type: string }) => (options.type === "secret" ? "sk-test" : ""),
  } as never);
  assert.equal((credential as { env?: unknown }).env, undefined);

  await assert.rejects(
    () =>
      login({
        signal: new AbortController().signal,
        prompt: async () => "   ",
      } as never),
    /No Exoscale de-fra-1 API key entered/,
  );
});

test("createZoneProvider discovery publishes and caches the models it finds", async () => {
  const urls: string[] = [];
  const cache = noCache();
  const provider = createZoneProvider({
    zone: DEFAULT_ZONE,
    env: {},
    cachePath: cache,
    fetch: stubFetchByEndpoint(
      {
        [onDemandModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/A" }] } },
        [dedicatedModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/B" }] } },
      },
      urls,
    ),
  });
  assert.ok(provider.refreshModels);
  const published: { persist?: { models: readonly { id: string }[] } }[] = [];
  await provider.refreshModels({
    credential: { type: "api_key", key: "sk-test", env: { [ENV_ENDPOINTS]: dedicatedEndpoint } },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => {
      published.push(publication as { persist?: { models: readonly { id: string }[] } });
      publication.update?.();
      return true;
    },
  });
  assert.deepEqual(
    provider.getModels().map((model) => model.id),
    ["nvidia/A", "nvidia/B"],
  );
  assert.deepEqual(
    published[0]?.persist?.models.map((model) => model.id),
    ["nvidia/A", "nvidia/B"],
  );
  assert.equal(urls.length, 2);
  // The next process starts from this list without waiting for the network.
  assert.deepEqual(
    readCachedModels("exo-de-fra-1", cache).map((model) => model.id),
    ["nvidia/A", "nvidia/B"],
  );
});

test("createZoneProvider keeps the known list when discovery returns nothing", async () => {
  const cache = noCache();
  writeCachedModels("exo-de-fra-1", mapModels({ data: [{ id: "nvidia/A" }] }, {
    provider: "exo-de-fra-1",
    endpoint: DEFAULT_ENDPOINT,
  }), cache);
  const provider = createZoneProvider({
    zone: DEFAULT_ZONE,
    env: {},
    cachePath: cache,
    fetch: stubFetchByEndpoint({ [onDemandModelsUrl]: { status: 200, body: { data: [] } } }, []),
  });
  assert.deepEqual(
    provider.getModels().map((model) => model.id),
    ["nvidia/A"],
  );
  let published: readonly string[] | undefined;
  await provider.refreshModels?.({
    credential: { type: "api_key", key: "sk-test" },
    allowNetwork: true,
    signal: new AbortController().signal,
    publish: async (publication) => {
      published = publication.persist?.models.map((model) => model.id);
      publication.update?.();
      return true;
    },
  });
  // An empty discovery result never replaces the catalog: the retained list
  // is republished instead.
  assert.deepEqual(published, ["nvidia/A"]);
  assert.deepEqual(
    provider.getModels().map((model) => model.id),
    ["nvidia/A"],
  );
});

test("createZoneProvider restores pi's stored catalog when it has nothing of its own", async () => {
  const provider = createZoneProvider({ zone: DEFAULT_ZONE, env: {}, cachePath: noCache() });
  const stored = mapModels({ data: [{ id: "nvidia/A" }] }, { provider: "exo-de-fra-1", endpoint: DEFAULT_ENDPOINT });
  await provider.refreshModels?.({
    allowNetwork: false,
    stored: { models: stored },
    signal: new AbortController().signal,
    publish: async () => true,
  });
  assert.deepEqual(
    provider.getModels().map((model) => model.id),
    ["nvidia/A"],
  );
});

// ============================================================================
// Model cache
// ============================================================================

test("the model cache round-trips and tolerates damage", () => {
  const cache = noCache();
  assert.deepEqual(readCachedModels("exo-de-fra-1", cache), []);
  writeCachedModels("exo-de-fra-1", mapModels({ data: [{ id: "nvidia/A" }] }, {
    provider: "exo-de-fra-1",
    endpoint: DEFAULT_ENDPOINT,
  }), cache);
  writeCachedModels("exo-ch-gva-2", mapModels({ data: [{ id: "nvidia/B" }] }, {
    provider: "exo-ch-gva-2",
    endpoint: endpointForZone("ch-gva-2"),
  }), cache);
  assert.deepEqual(
    readCachedModels("exo-de-fra-1", cache).map((model) => model.id),
    ["nvidia/A"],
  );
  assert.deepEqual(
    readCachedModels("exo-ch-gva-2", cache).map((model) => model.id),
    ["nvidia/B"],
  );

  writeFileSync(cache, "not json");
  assert.deepEqual(readCachedModels("exo-de-fra-1", cache), []);
  writeFileSync(cache, JSON.stringify({ providers: { "exo-de-fra-1": { models: [{ id: "a" }, { id: "b", api: "openai-completions", provider: "exo-other", baseUrl: "u", contextWindow: 1, maxTokens: 1 }] } } }));
  // Entries from another provider or missing required fields are dropped.
  assert.deepEqual(readCachedModels("exo-de-fra-1", cache), []);
});

// ============================================================================
// Cold-start bootstrap
// ============================================================================

test("bootstrapModels fills the cache of a zone with a stored key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-exoscale-boot-"));
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({
      "exo-de-fra-1": { type: "api_key", key: "sk-stored", env: { [ENV_ENDPOINTS]: dedicatedEndpoint } },
      "openai": { type: "api_key", key: "sk-other" },
      "anthropic": { type: "oauth", tokens: { access_token: "t" } },
    }),
  );
  assert.deepEqual(credentialZones({ PI_CODING_AGENT_DIR: dir }), ["de-fra-1"]);

  const urls: string[] = [];
  const cache = join(dir, "models.json");
  const discovered = await bootstrapModels({
    zones: ["de-fra-1", "ch-gva-2"],
    env: { PI_CODING_AGENT_DIR: dir },
    cachePath: cache,
    fetch: stubFetchByEndpoint(
      {
        [onDemandModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/A" }] } },
        [dedicatedModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/B" }] } },
      },
      urls,
    ),
    signal: new AbortController().signal,
  });
  assert.deepEqual(Object.keys(discovered), ["exo-de-fra-1"]);
  assert.deepEqual(urls, [onDemandModelsUrl, dedicatedModelsUrl]);
  assert.deepEqual(
    readCachedModels("exo-de-fra-1", cache).map((model) => model.id),
    ["nvidia/A", "nvidia/B"],
  );
  assert.deepEqual(readCachedModels("exo-ch-gva-2", cache), []);
});

test("bootstrapModels uses the environment key on the default zone only, and skips cached zones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-exoscale-boot-"));
  const cache = join(dir, "models.json");
  writeCachedModels(
    "exo-de-fra-1",
    mapModels({ data: [{ id: "nvidia/Cached" }] }, { provider: "exo-de-fra-1", endpoint: DEFAULT_ENDPOINT }),
    cache,
  );
  const urls: string[] = [];
  const discovered = await bootstrapModels({
    zones: ["de-fra-1", "ch-gva-2"],
    env: { PI_CODING_AGENT_DIR: dir, [ENV_KEY]: "sk-env" },
    cachePath: cache,
    fetch: stubFetchByEndpoint({ [onDemandModelsUrl]: { status: 200, body: { data: [{ id: "nvidia/A" }] } } }, urls),
    signal: new AbortController().signal,
  });
  // de-fra-1 already has a cache; ch-gva-2 has no key of its own.
  assert.deepEqual(discovered, {});
  assert.deepEqual(urls, []);
});

// ============================================================================
// Extension wiring
// ============================================================================

type PiMock = {
  providers: string[];
  commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>>;
  refreshCalls: { providers?: string[] }[];
  api: unknown;
};

function mockPi(refreshResult: unknown = { errors: new Map() }): PiMock {
  const mock: PiMock = {
    providers: [],
    commands: {},
    handlers: {},
    refreshCalls: [],
    api: {},
  };
  mock.api = {
    registerProvider: (provider: { id: string }) => {
      mock.providers.push(provider.id);
    },
    registerCommand: (name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      mock.commands[name] = command;
    },
    on: (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => {
      mock.handlers[event] = handler;
    },
    modelRegistry: {
      refresh: async (options: { providers?: string[] }) => {
        mock.refreshCalls.push(options);
        return refreshResult;
      },
    },
  };
  return mock;
}

function mockCtx(pi: PiMock, providerIds: string[]) {
  const notices: string[] = [];
  return {
    notices,
    ctx: {
      ui: { notify: (message: string) => notices.push(message) },
      modelRegistry: {
        getRegisteredProviderIds: () => providerIds,
        getModelsOfType: (_type: string, provider: string) => (provider === "exo-de-fra-1" ? [{ id: "nvidia/A" }] : []),
        getProviderAuth: async (provider: string) =>
          provider === "exo-de-fra-1" ? { type: "api_key", key: "sk", env: { [ENV_ENDPOINTS]: dedicatedEndpoint } } : undefined,
        getProviderAuthStatus: (provider: string) =>
          provider === "exo-de-fra-1" ? { configured: true, source: "stored credential" } : { configured: false },
        refresh: async (options: { providers?: string[] }) => {
          pi.refreshCalls.push(options);
          return { errors: new Map() };
        },
      },
    },
  };
}

test("offline, the extension registers the default zone and EXOSCALE_AI_ZONES without network calls", async () => {
  const fetchCalls: string[] = [];
  await withEnv(envWiring({ PI_OFFLINE: "1", EXOSCALE_AI_ZONES: "de-muc-1" }), async () => {
    stubGlobalFetch({}, fetchCalls);
    const pi = mockPi();
    await extension(pi.api as never);
    assert.deepEqual(pi.providers, ["exo-de-fra-1", "exo-de-muc-1"]);
    assert.deepEqual(fetchCalls, []);
  });
});

test("resource discovery adds the zones of the zone list and refreshes them", async () => {
  const urls: string[] = [];
  await withEnv(envWiring({ PI_OFFLINE: "" }), async () => {
    stubGlobalFetch({ [ZONE_API]: { status: 200, body: { zones: [{ name: "de-fra-1" }, { name: "ch-gva-2" }] } } }, urls);
    const pi = mockPi();
    await extension(pi.api as never);
    assert.deepEqual(pi.providers, ["exo-de-fra-1"]);

    const { ctx } = mockCtx(pi, []);
    await pi.handlers["resources_discover"]?.({ type: "resources_discover", cwd: "/tmp", reason: "startup" }, ctx);
    assert.equal(pi.providers.includes("exo-ch-gva-2"), true);
    assert.equal(pi.refreshCalls.length, 1);
    assert.equal(pi.refreshCalls[0]?.providers?.includes("exo-ch-gva-2"), true);
  });
});

test("/exo lists zones, endpoints, and auth status", async () => {
  await withEnv(envWiring({ PI_OFFLINE: "1" }), async () => {
    const pi = mockPi();
    await extension(pi.api as never);
    const { ctx, notices } = mockCtx(pi, ["exo-de-fra-1", "exo-ch-gva-2"]);
    await pi.commands["exo"]?.handler("", ctx);
    const report = notices.join("\n");
    assert.match(report, /de-fra-1: 1 models, stored credential/);
    assert.match(report, /https:\/\/inference\.de-fra-1\.exoscale-cloud\.com\/v1/);
    assert.match(report, new RegExp(dedicatedEndpoint.replace(/[/.]/g, (c) => `\\${c}`)));
    assert.match(report, /ch-gva-2: 0 models, not connected/);
  });
});

// Wiring tests run against an empty agent directory: no stored credentials
// and no model cache, whatever the machine running the tests has.
function envWiring(values: Record<string, string>): Record<string, string> {
  return { ...values, PI_CODING_AGENT_DIR: mkdtempSync(join(tmpdir(), "pi-exoscale-agent-")), EXOSCALE_AI_API_KEY: "", EXOSCALE_AI_ZONES: values["EXOSCALE_AI_ZONES"] ?? "", EXOSCALE_AI_ENDPOINT: "" };
}

// Runs fn with a temporary environment and a stubbed fetch, restoring both.
function withEnv(values: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === "") delete process.env[key];
    else process.env[key] = value;
  }
  const realFetch = globalThis.fetch;
  return fn().finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    globalThis.fetch = realFetch;
  });
}

// Replaces globalThis.fetch: the extension calls zone discovery without an
// injected fetch, so tests that exercise the wiring stub the global.
function stubGlobalFetch(routes: Record<string, { status: number; body: unknown }>, urls: string[]) {
  globalThis.fetch = (async (url: string, init?: { headers?: Record<string, string> }) => {
    urls.push(String(url));
    const route = routes[String(url)];
    if (!route) {
      return { ok: false, status: 404, statusText: "Not Found", json: async () => ({}) };
    }
    return {
      ok: route.status < 400,
      status: route.status,
      statusText: route.status < 400 ? "OK" : "Error",
      json: async () => route.body,
    };
  }) as unknown as typeof fetch;
}

// ============================================================================
// Extension
// ============================================================================

test("extension is a factory function", () => {
  assert.equal(typeof extension, "function");
});
