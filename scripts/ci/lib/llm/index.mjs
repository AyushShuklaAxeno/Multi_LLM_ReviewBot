// scripts/ci/lib/llm/index.mjs
//
// Public face of the LLM layer. The rest of the bot does exactly this:
//
//     const llm = createLlmClient(process.env);
//     const text = await llm.run(prompt);
//
// It never sees the API key, the vendor, or the wire format. The key lives in
// a closure below and is scrubbed from every error message.

import { resolveLlmConfig, LlmConfigError } from './config.mjs';
import { ADAPTERS } from './adapters.mjs';

export { LlmConfigError };
export class LlmError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504, 529]); // 529 = Anthropic "overloaded"
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function errorMessageFromBody(text) {
  try {
    const j = JSON.parse(text);
    const e = Array.isArray(j) ? j[0]?.error ?? j[0] : j.error ?? j;
    if (typeof e === 'string') return e;
    if (e?.message) return e.message;
  } catch {}
  return text.slice(0, 500);
}

export function createLlmClient(
  env = process.env,
  { fetchFn = fetch, sleepFn = defaultSleep, timeoutMs = 120_000, maxRetries = 3 } = {},
) {
  const cfg = resolveLlmConfig(env);
  const adapter = ADAPTERS[cfg.protocol];
  const label = `${cfg.provider}`;

  const redact = (s) => String(s).split(cfg.apiKey).join('***');

  async function callModel(model, prompt) {
    // Options a model/vendor may reject; switched off automatically if the API says so.
    const opts = {
      temperature: cfg.noTemperature?.test(model) ? null : 0.2,
      jsonMode: cfg.jsonMode,
    };
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await sleepFn(2000 * 2 ** (attempt - 1));

      const req = adapter.buildRequest({
        apiKey: cfg.apiKey,
        baseUrl: cfg.baseUrl,
        model,
        prompt,
        extraHeaders: cfg.extraHeaders,
        ...opts,
      });

      let res;
      try {
        res = await fetchFn(req.url, {
          method: 'POST',
          headers: req.headers,
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        lastError = new LlmError(redact(`${label} request failed: ${err.message}`));
        continue;
      }

      if (!res.ok) {
        const msg = redact(errorMessageFromBody(await res.text()));
        lastError = new LlmError(`${label} API error ${res.status}: ${msg}`, { status: res.status });

        // The model/vendor doesn't support an option we sent: drop it and retry now.
        if (res.status === 400 || res.status === 422) {
          if (opts.temperature != null && /temperature/i.test(msg)) {
            console.warn(`[llm] ${model} rejected "temperature"; retrying without it`);
            opts.temperature = null;
            attempt--;
            continue;
          }
          if (opts.jsonMode && /response_format|json|mime/i.test(msg)) {
            console.warn(`[llm] ${model} rejected JSON mode; retrying without it`);
            opts.jsonMode = false;
            attempt--;
            continue;
          }
        }
        if (res.status === 404) throw lastError; // wrong model id -> caller may try a fallback
        if (RETRYABLE_STATUS.has(res.status)) continue;
        throw lastError;
      }

      const parsed = adapter.parseResponse(await res.json());
      if (parsed.blocked) {
        throw new LlmError(`${label} blocked the prompt (${parsed.blocked})`);
      }
      if (!parsed.text || !parsed.text.trim()) {
        throw new LlmError(`${label} returned no text`);
      }
      if (parsed.truncated) {
        throw new LlmError(`${label} output was cut off (length limit); JSON would be incomplete`);
      }
      return parsed.text;
    }
    throw lastError;
  }

  return {
    provider: cfg.provider,
    model: cfg.model,
    detectedFrom: cfg.detectedFrom,
    keySource: cfg.keyEnvName, // the env var NAME only, never its value

    /** Send a prompt, get back the model's raw text. */
    async run(prompt) {
      const models = [cfg.model, ...cfg.fallbackModels];
      let lastError;
      for (const [i, model] of models.entries()) {
        try {
          return await callModel(model, prompt);
        } catch (err) {
          lastError = err;
          const canFallBack = err instanceof LlmError && err.status === 404 && i < models.length - 1;
          if (!canFallBack) break;
          console.warn(`[llm] model "${model}" not available (404), trying "${models[i + 1]}"...`);
        }
      }
      if (lastError instanceof LlmError && lastError.status === 404) {
        throw new LlmError(
          `${lastError.message}. Model IDs change often: set the \`model\` input to one your account can use.`,
          { status: 404 },
        );
      }
      throw lastError instanceof LlmError ? lastError : new LlmError(redact(lastError.message));
    },
  };
}
