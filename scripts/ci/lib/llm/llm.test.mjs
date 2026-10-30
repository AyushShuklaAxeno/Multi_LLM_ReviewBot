import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveLlmConfig, LlmConfigError } from './config.mjs';
import { createLlmClient, LlmError } from './index.mjs';

const noSleep = async () => {};
const FINDINGS = '{"findings":[]}';

// ---------- provider detection ----------
const cfg = (env) => resolveLlmConfig(env);

test('detects Anthropic from key prefix', () => {
  const c = cfg({ LLM_API_KEY: 'sk-ant-api03-abc' });
  assert.equal(c.provider, 'anthropic');
  assert.equal(c.protocol, 'anthropic');
});

test('detects OpenRouter, Gemini, Groq, xAI from key prefix', () => {
  assert.equal(cfg({ LLM_API_KEY: 'sk-or-v1-abc' }).provider, 'openrouter');
  assert.equal(cfg({ LLM_API_KEY: 'AIzaSyABC' }).provider, 'gemini');
  assert.equal(cfg({ LLM_API_KEY: 'gsk_abc', LLM_MODEL: 'm' }).provider, 'groq');
  assert.equal(cfg({ LLM_API_KEY: 'xai-abc', LLM_MODEL: 'm' }).provider, 'xai');
});

test('plain sk- key: model name decides, then DeepSeek hex format, then OpenAI', () => {
  assert.equal(cfg({ LLM_API_KEY: 'sk-proj-abc', LLM_MODEL: 'deepseek-chat' }).provider, 'deepseek');
  assert.equal(cfg({ LLM_API_KEY: 'sk-' + 'a1'.repeat(16) }).provider, 'deepseek');
  assert.equal(cfg({ LLM_API_KEY: 'sk-proj-AbC_123' }).provider, 'openai');
});

test('explicit provider wins over detection; aliases work', () => {
  assert.equal(cfg({ LLM_API_KEY: 'sk-ant-x', LLM_PROVIDER: 'openai' }).provider, 'openai');
  assert.equal(cfg({ LLM_API_KEY: 'whatever', LLM_PROVIDER: 'ChatGPT' }).provider, 'openai');
  assert.equal(cfg({ LLM_API_KEY: 'whatever', LLM_PROVIDER: 'claude' }).provider, 'anthropic');
  assert.equal(cfg({ LLM_API_KEY: 'whatever', LLM_PROVIDER: 'auto', LLM_MODEL: 'gemini-x' }).provider, 'gemini');
});

test('vendor-native env var names are recognised', () => {
  const c = cfg({ DEEPSEEK_API_KEY: 'whatever' });
  assert.equal(c.provider, 'deepseek');
  assert.equal(c.keyEnvName, 'DEEPSEEK_API_KEY');
});

test('legacy: an OpenRouter key stored in GEMINI_API_KEY is still OpenRouter', () => {
  assert.equal(cfg({ GEMINI_API_KEY: 'sk-or-v1-abc' }).provider, 'openrouter');
});

test('unknown provider + base-url becomes a generic OpenAI-compatible endpoint', () => {
  const c = cfg({
    LLM_API_KEY: 'k', LLM_PROVIDER: 'perplexity', LLM_MODEL: 'sonar', LLM_BASE_URL: 'https://api.perplexity.ai',
  });
  assert.equal(c.provider, 'perplexity');
  assert.equal(c.protocol, 'openai');
  assert.equal(c.baseUrl, 'https://api.perplexity.ai');
});

test('config errors are clear', () => {
  assert.throws(() => cfg({}), (e) => e instanceof LlmConfigError && /No API key/.test(e.message));
  assert.throws(() => cfg({ LLM_API_KEY: 'mystery' }), /Could not tell which provider/);
  assert.throws(() => cfg({ LLM_API_KEY: 'k', LLM_PROVIDER: 'nope' }), /Unknown provider/);
  assert.throws(() => cfg({ LLM_API_KEY: 'gsk_x' }), /no default model/);
  assert.throws(() => cfg({ LLM_API_KEY: 'k', LLM_PROVIDER: 'custom', LLM_MODEL: 'm' }), /needs a base-url/);
  assert.throws(
    () => cfg({ LLM_API_KEY: 'sk-ant-x', LLM_BASE_URL: 'http://evil.example.com' }),
    /https/,
  );
});

test('model input overrides default; fallback list parsed and de-duplicated', () => {
  const c = cfg({ LLM_API_KEY: 'sk-ant-x', LLM_MODEL: 'm1', LLM_FALLBACK_MODELS: 'm1, m2 ,m3' });
  assert.equal(c.model, 'm1');
  assert.deepEqual(c.fallbackModels, ['m2', 'm3']);
});

// ---------- request shapes (mock fetch) ----------
function mockFetch(responses) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const r = responses.shift();
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
      json: async () => r.body,
    };
  };
  return { fn, calls };
}
const ok = (body) => ({ status: 200, body });

test('OpenAI-protocol request + parse (DeepSeek)', async () => {
  const m = mockFetch([ok({ choices: [{ message: { content: FINDINGS }, finish_reason: 'stop' }] })]);
  const llm = createLlmClient({ LLM_API_KEY: 'sk-' + 'ab'.repeat(16) }, { fetchFn: m.fn, sleepFn: noSleep });
  assert.equal(llm.provider, 'deepseek');
  assert.equal(await llm.run('hi'), FINDINGS);
  const c = m.calls[0];
  assert.equal(c.url, 'https://api.deepseek.com/v1/chat/completions');
  assert.match(c.headers.Authorization, /^Bearer sk-/);
  assert.deepEqual(c.body.response_format, { type: 'json_object' });
  assert.equal(c.body.temperature, 0.2);
});

test('OpenAI reasoning models: no temperature is sent', async () => {
  const m = mockFetch([ok({ choices: [{ message: { content: FINDINGS }, finish_reason: 'stop' }] })]);
  const llm = createLlmClient({ LLM_API_KEY: 'sk-proj-x', LLM_MODEL: 'gpt-5.6-terra' }, { fetchFn: m.fn, sleepFn: noSleep });
  await llm.run('hi');
  assert.equal('temperature' in m.calls[0].body, false);
});

test('Anthropic request + parse', async () => {
  const m = mockFetch([ok({ content: [{ type: 'text', text: FINDINGS }], stop_reason: 'end_turn' })]);
  const llm = createLlmClient({ LLM_API_KEY: 'sk-ant-secret' }, { fetchFn: m.fn, sleepFn: noSleep });
  assert.equal(await llm.run('hi'), FINDINGS);
  const c = m.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.headers['x-api-key'], 'sk-ant-secret');
  assert.equal(c.headers['anthropic-version'], '2023-06-01');
  assert.equal(c.body.max_tokens, 8192);
  assert.equal('response_format' in c.body, false);
});

test('Gemini request + parse (key in header, not URL)', async () => {
  const m = mockFetch([ok({ candidates: [{ content: { parts: [{ text: FINDINGS }] }, finishReason: 'STOP' }] })]);
  const llm = createLlmClient({ LLM_API_KEY: 'AIzaSecret', LLM_MODEL: 'models/gemini-x' }, { fetchFn: m.fn, sleepFn: noSleep });
  assert.equal(await llm.run('hi'), FINDINGS);
  const c = m.calls[0];
  assert.equal(c.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent');
  assert.equal(c.headers['x-goog-api-key'], 'AIzaSecret');
  assert.ok(!c.url.includes('AIzaSecret'));
  assert.equal(c.body.generationConfig.responseMimeType, 'application/json');
});

// ---------- resilience ----------
test('retries on 429 then succeeds', async () => {
  const m = mockFetch([
    { status: 429, body: { error: { message: 'slow down' } } },
    ok({ choices: [{ message: { content: FINDINGS }, finish_reason: 'stop' }] }),
  ]);
  const llm = createLlmClient({ LLM_API_KEY: 'sk-proj-x' }, { fetchFn: m.fn, sleepFn: noSleep });
  assert.equal(await llm.run('hi'), FINDINGS);
  assert.equal(m.calls.length, 2);
});

test('does not retry on 401', async () => {
  const m = mockFetch([{ status: 401, body: { error: { message: 'bad key' } } }]);
  const llm = createLlmClient({ LLM_API_KEY: 'sk-proj-x' }, { fetchFn: m.fn, sleepFn: noSleep });
  await assert.rejects(llm.run('hi'), (e) => e instanceof LlmError && e.status === 401 && /bad key/.test(e.message));
  assert.equal(m.calls.length, 1);
});

test('drops an unsupported temperature / JSON mode and retries immediately', async () => {
  const m = mockFetch([
    { status: 400, body: { error: { message: "Unsupported value: 'temperature' does not support 0.2" } } },
    { status: 400, body: { error: { message: 'response_format json_object is not supported' } } },
    ok({ choices: [{ message: { content: FINDINGS }, finish_reason: 'stop' }] }),
  ]);
  const llm = createLlmClient({ LLM_API_KEY: 'sk-proj-x', LLM_MODEL: 'custom-model', LLM_PROVIDER: 'openai' }, { fetchFn: m.fn, sleepFn: noSleep });
  assert.equal(await llm.run('hi'), FINDINGS);
  assert.equal('temperature' in m.calls[2].body, false);
  assert.equal('response_format' in m.calls[2].body, false);
});

test('falls back to the next model on 404; explains when all 404', async () => {
  const m = mockFetch([
    { status: 404, body: { error: { message: 'model not found' } } },
    ok({ choices: [{ message: { content: FINDINGS }, finish_reason: 'stop' }] }),
  ]);
  const llm = createLlmClient({ LLM_API_KEY: 'sk-proj-x', LLM_MODEL: 'old', LLM_FALLBACK_MODELS: 'new' }, { fetchFn: m.fn, sleepFn: noSleep });
  assert.equal(await llm.run('hi'), FINDINGS);
  assert.equal(m.calls[1].body.model, 'new');

  const m2 = mockFetch([{ status: 404, body: { error: { message: 'model not found' } } }]);
  const llm2 = createLlmClient({ LLM_API_KEY: 'sk-proj-x', LLM_MODEL: 'old' }, { fetchFn: m2.fn, sleepFn: noSleep });
  await assert.rejects(llm2.run('hi'), /set the `model` input/);
});

test('truncated output and empty output are errors', async () => {
  const t = mockFetch([ok({ choices: [{ message: { content: '{"fin' }, finish_reason: 'length' }] })]);
  await assert.rejects(createLlmClient({ LLM_API_KEY: 'sk-proj-x' }, { fetchFn: t.fn, sleepFn: noSleep }).run('x'), /cut off/);
  const e = mockFetch([ok({ content: [], stop_reason: 'end_turn' })]);
  await assert.rejects(createLlmClient({ LLM_API_KEY: 'sk-ant-x' }, { fetchFn: e.fn, sleepFn: noSleep }).run('x'), /no text/);
});

// ---------- secrecy ----------
test('the key is scrubbed from error messages and absent from the client object', async () => {
  const key = 'sk-proj-SUPERSECRET123';
  const m = mockFetch([{ status: 401, body: { error: { message: `Incorrect API key provided: ${key}` } } }]);
  const llm = createLlmClient({ LLM_API_KEY: key }, { fetchFn: m.fn, sleepFn: noSleep });
  await assert.rejects(llm.run('x'), (e) => !e.message.includes(key) && e.message.includes('***'));
  assert.ok(!JSON.stringify(llm).includes(key));
  assert.ok(!Object.values(llm).some((v) => String(v).includes(key)));
});

test('only lib/llm/ reads API keys (no other source file may touch them)', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // scripts/ci
  const llmDir = path.join(root, 'lib', 'llm');
  const offenders = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) { if (full !== llmDir) walk(full); continue; }
      if (!full.endsWith('.mjs') || full.endsWith('.test.mjs')) continue;
      if (/API_KEY|apiKey|x-api-key|x-goog-api-key|LLM_/i.test(readFileSync(full, 'utf8'))) offenders.push(full);
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});

// ---------- real fetch against a local server (all three protocols) ----------
function startServer(handler) {
  return new Promise((resolve) => {
    const seen = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => (body += d));
      req.on('end', () => {
        seen.push({ url: req.url, headers: req.headers, body: JSON.parse(body) });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(handler(req.url)));
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, seen, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

test('end-to-end over real HTTP: openai-compatible, anthropic, gemini', async () => {
  const s = await startServer((url) => {
    if (url.endsWith('/chat/completions')) return { choices: [{ message: { content: 'A' }, finish_reason: 'stop' }] };
    if (url.endsWith('/messages')) return { content: [{ type: 'text', text: 'B' }], stop_reason: 'end_turn' };
    return { candidates: [{ content: { parts: [{ text: 'C' }] }, finishReason: 'STOP' }] };
  });
  try {
    const a = createLlmClient({ LLM_API_KEY: 'k1', LLM_PROVIDER: 'custom', LLM_MODEL: 'local', LLM_BASE_URL: s.base });
    assert.equal(await a.run('p'), 'A');
    const b = createLlmClient({ LLM_API_KEY: 'sk-ant-k2', LLM_BASE_URL: s.base });
    assert.equal(await b.run('p'), 'B');
    const g = createLlmClient({ LLM_API_KEY: 'AIzak3', LLM_BASE_URL: s.base });
    assert.equal(await g.run('p'), 'C');
    assert.equal(s.seen[0].headers.authorization, 'Bearer k1');
    assert.equal(s.seen[1].headers['x-api-key'], 'sk-ant-k2');
    assert.equal(s.seen[2].headers['x-goog-api-key'], 'AIzak3');
  } finally {
    s.server.close();
  }
});
