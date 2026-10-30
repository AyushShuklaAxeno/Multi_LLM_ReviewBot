// scripts/ci/lib/llm/config.mjs
//
// The ONLY file in the bot that reads API keys from the environment.
// Everything it returns stays inside the llm/ folder (see index.mjs, which
// keeps the key in a closure so callers never see it).

import {
  PROVIDERS,
  ALIASES,
  STRONG_KEY_PREFIXES,
  VENDOR_KEY_ENV,
  MODEL_HINTS,
  WEAK_KEY_PREFIXES,
} from './providers.mjs';

export class LlmConfigError extends Error {}

const clean = (v) => (typeof v === 'string' ? v.trim() : '');

function normalizeProviderName(raw) {
  const name = clean(raw).toLowerCase();
  return ALIASES[name] ?? name;
}

function firstMatch(table, value) {
  for (const [re, provider] of table) if (re.test(value)) return provider;
  return null;
}

/** Find the key. Generic LLM_API_KEY wins, then legacy names, then vendor-native names. */
function findKey(env) {
  for (const name of ['LLM_API_KEY', 'OPENROUTER_API_KEY', 'GROQ_API_KEY', 'GEMINI_API_KEY']) {
    const v = clean(env[name]);
    if (v) return { apiKey: v, keyEnvName: name };
  }
  for (const [name] of VENDOR_KEY_ENV) {
    const v = clean(env[name]);
    if (v) return { apiKey: v, keyEnvName: name };
  }
  return { apiKey: '', keyEnvName: '' };
}

/**
 * Decide which vendor a key belongs to.
 * Order: explicit provider > unmistakable key prefix > env var name >
 *        model name > weak key heuristic.
 */
function resolveProvider({ explicit, apiKey, keyEnvName, model, baseUrl }) {
  if (explicit) {
    if (PROVIDERS[explicit]) return { name: explicit, how: 'provider input' };
    // Unknown name + base URL => treat as a generic OpenAI-compatible endpoint.
    if (baseUrl) return { name: explicit, how: 'provider input', generic: true };
    throw new LlmConfigError(
      `Unknown provider "${explicit}". Use one of: ${Object.keys(PROVIDERS).join(', ')} ` +
        `(or give any name together with a base-url for an OpenAI-compatible API).`,
    );
  }

  const strong = firstMatch(STRONG_KEY_PREFIXES, apiKey);
  if (strong) return { name: strong, how: 'key prefix' };

  const fromEnvName = VENDOR_KEY_ENV.find(([n]) => n === keyEnvName)?.[1];
  if (fromEnvName) return { name: fromEnvName, how: `env var ${keyEnvName}` };

  // Slash-style IDs ("deepseek/deepseek-chat") are aggregator IDs; don't guess from them.
  if (model && !model.includes('/')) {
    const fromModel = firstMatch(MODEL_HINTS, model);
    if (fromModel) return { name: fromModel, how: 'model name' };
  }

  const weak = firstMatch(WEAK_KEY_PREFIXES, apiKey);
  if (weak) return { name: weak, how: 'key format (heuristic)' };

  if (baseUrl) return { name: 'openai-compatible', how: 'base-url' };

  throw new LlmConfigError(
    'Could not tell which provider this API key belongs to. Set the `provider` input ' +
      `(${Object.keys(PROVIDERS).join(', ')}), or set \`base-url\` for an OpenAI-compatible API.`,
  );
}

function validateBaseUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new LlmConfigError(`base-url is not a valid URL: ${url}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new LlmConfigError('base-url must use https:// (http:// is only allowed for localhost)');
  }
  return url.replace(/\/+$/, '');
}

export function resolveLlmConfig(env = process.env) {
  const { apiKey, keyEnvName } = findKey(env);
  if (!apiKey) {
    throw new LlmConfigError(
      'No API key found. Pass the `api-key` input (e.g. api-key: ${{ secrets.LLM_API_KEY }}).',
    );
  }

  const explicit = normalizeProviderName(env.LLM_PROVIDER);
  const requestedModel =
    clean(env.LLM_MODEL) ||
    clean(env.OPENROUTER_MODEL) ||
    clean(env.GROQ_MODEL) ||
    clean(env.GEMINI_MODEL);
  const baseUrlInput = clean(env.LLM_BASE_URL);

  const { name, how, generic } = resolveProvider({
    explicit: explicit === 'auto' ? '' : explicit,
    apiKey,
    keyEnvName,
    model: requestedModel,
    baseUrl: baseUrlInput,
  });

  const def = generic ? PROVIDERS['openai-compatible'] : PROVIDERS[name];

  const rawBase = baseUrlInput || def.baseUrl;
  if (!rawBase) {
    throw new LlmConfigError(`Provider "${name}" needs a base-url (e.g. https://my-host/v1).`);
  }
  const baseUrl = validateBaseUrl(rawBase);

  const model = requestedModel || def.defaultModel;
  if (!model) {
    throw new LlmConfigError(`Provider "${name}" has no default model. Set the \`model\` input.`);
  }

  const fallbackModels = clean(env.LLM_FALLBACK_MODELS)
    .split(',')
    .map((m) => m.trim())
    .filter((m) => m && m !== model);

  return {
    apiKey, // never leaves the llm/ folder
    keyEnvName,
    provider: name,
    detectedFrom: how,
    protocol: def.protocol,
    baseUrl,
    model,
    fallbackModels,
    extraHeaders: def.extraHeaders ?? {},
    noTemperature: def.noTemperature ?? null,
    jsonMode: clean(env.LLM_JSON_MODE).toLowerCase() !== 'false',
  };
}
