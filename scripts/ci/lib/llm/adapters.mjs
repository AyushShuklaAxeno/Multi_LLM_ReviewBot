// scripts/ci/lib/llm/adapters.mjs
//
// One adapter per wire protocol (not per vendor). Each adapter does two things:
//   buildRequest(ctx)  -> { url, headers, body }
//   parseResponse(json)-> { text, truncated, blocked? }
// ctx = { apiKey, baseUrl, model, prompt, temperature, jsonMode, extraHeaders }
// `temperature` / `jsonMode` may be null/false; adapters then leave them out.

const JSON_HEADERS = { 'Content-Type': 'application/json' };

function textFromParts(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (typeof p === 'string' ? p : p?.text ?? ''))
      .join('');
  }
  return '';
}

// OpenAI-style /chat/completions: OpenAI, DeepSeek, OpenRouter, Groq, Mistral, xAI, Together, ...
const openai = {
  buildRequest({ apiKey, baseUrl, model, prompt, temperature, jsonMode, extraHeaders }) {
    return {
      url: `${baseUrl}/chat/completions`,
      headers: { ...JSON_HEADERS, Authorization: `Bearer ${apiKey}`, ...extraHeaders },
      body: {
        model,
        messages: [{ role: 'user', content: prompt }],
        ...(temperature != null && { temperature }),
        ...(jsonMode && { response_format: { type: 'json_object' } }),
      },
    };
  },
  parseResponse(data) {
    const choice = data?.choices?.[0];
    return {
      text: textFromParts(choice?.message?.content),
      truncated: choice?.finish_reason === 'length',
    };
  },
};

// Anthropic Messages API (Claude). No JSON mode; the findings parser tolerates fences/prose.
const anthropic = {
  buildRequest({ apiKey, baseUrl, model, prompt, temperature }) {
    return {
      url: `${baseUrl}/messages`,
      headers: { ...JSON_HEADERS, 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: {
        model,
        max_tokens: 8192, // required by this API
        messages: [{ role: 'user', content: prompt }],
        ...(temperature != null && { temperature }),
      },
    };
  },
  parseResponse(data) {
    const text = (data?.content ?? [])
      .filter((b) => b?.type === 'text')
      .map((b) => b.text)
      .join('');
    return { text, truncated: data?.stop_reason === 'max_tokens' };
  },
};

// Google Gemini generateContent API.
const gemini = {
  buildRequest({ apiKey, baseUrl, model, prompt, temperature, jsonMode }) {
    const id = model.replace(/^models\//, '');
    const generationConfig = {
      ...(temperature != null && { temperature }),
      ...(jsonMode && { responseMimeType: 'application/json' }),
    };
    return {
      url: `${baseUrl}/models/${encodeURIComponent(id)}:generateContent`,
      // Header (not ?key=) so the key never appears in a URL.
      headers: { ...JSON_HEADERS, 'x-goog-api-key': apiKey },
      body: {
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        ...(Object.keys(generationConfig).length > 0 && { generationConfig }),
      },
    };
  },
  parseResponse(data) {
    if (data?.promptFeedback?.blockReason) {
      return { text: '', truncated: false, blocked: data.promptFeedback.blockReason };
    }
    const cand = data?.candidates?.[0];
    const text = (cand?.content?.parts ?? [])
      .filter((p) => typeof p?.text === 'string' && !p.thought)
      .map((p) => p.text)
      .join('');
    return { text, truncated: cand?.finishReason === 'MAX_TOKENS' };
  },
};

export const ADAPTERS = { openai, anthropic, gemini };
