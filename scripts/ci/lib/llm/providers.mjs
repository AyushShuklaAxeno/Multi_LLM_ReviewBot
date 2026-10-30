// scripts/ci/lib/llm/providers.mjs
//
// The ONLY place that knows about specific vendors. To support a new
// OpenAI-compatible vendor, add one entry to PROVIDERS. Nothing else changes.
//
// protocol:
//   'openai'     -> POST {baseUrl}/chat/completions   (OpenAI, DeepSeek, Groq, ...)
//   'anthropic'  -> POST {baseUrl}/messages           (Claude)
//   'gemini'     -> POST {baseUrl}/models/{m}:generateContent (Google)
//
// defaultModel: used only when the caller supplies no model. Model IDs change
// often, so treat these as best-effort and prefer passing `model` explicitly
// in production. Providers with no defaultModel REQUIRE a model.

export const PROVIDERS = {
  anthropic: {
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    defaultModel: 'claude-sonnet-5-5',
  },
  openai: {
    protocol: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.6-terra',
    // Reasoning-style models reject a custom temperature.
    noTemperature: /^(o\d|gpt-5|gpt-6)/i,
  },
  gemini: {
    protocol: 'gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-3.5-flash',
  },
  deepseek: {
    protocol: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    defaultModel: 'deepseek-chat',
  },
  openrouter: {
    protocol: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    // Kept from the previous version of this bot for backward compatibility.
    defaultModel: 'anthropic/claude-3.5-sonnet',
    extraHeaders: {
      'HTTP-Referer': 'https://github.com/ai-code-review-bot',
      'X-Title': 'AI Code Review Bot',
    },
  },
  // No default model: the caller must say which one.
  groq: { protocol: 'openai', baseUrl: 'https://api.groq.com/openai/v1' },
  mistral: { protocol: 'openai', baseUrl: 'https://api.mistral.ai/v1' },
  xai: { protocol: 'openai', baseUrl: 'https://api.x.ai/v1' },
  together: { protocol: 'openai', baseUrl: 'https://api.together.xyz/v1' },
  // Anything else that speaks the OpenAI chat-completions format
  // (Azure OpenAI proxy, Ollama, vLLM, LM Studio, LiteLLM, ...). Needs base-url.
  'openai-compatible': { protocol: 'openai', baseUrl: null },
};

// Friendly names people will type in the `provider` input.
export const ALIASES = {
  claude: 'anthropic',
  chatgpt: 'openai',
  gpt: 'openai',
  google: 'gemini',
  'google-gemini': 'gemini',
  grok: 'xai',
  custom: 'openai-compatible',
  openai_compatible: 'openai-compatible',
};

// Key formats that are unique to one vendor. Safe to trust.
export const STRONG_KEY_PREFIXES = [
  [/^sk-ant-/, 'anthropic'],
  [/^sk-or-/, 'openrouter'],
  [/^AIza/, 'gemini'],
  [/^gsk_/, 'groq'],
  [/^xai-/, 'xai'],
];

// Native env var names -> provider. Lets people reuse the variable names the
// vendors' own SDKs use (useful outside GitHub Actions, e.g. Bitbucket).
export const VENDOR_KEY_ENV = [
  ['ANTHROPIC_API_KEY', 'anthropic'],
  ['OPENAI_API_KEY', 'openai'],
  ['GEMINI_API_KEY', 'gemini'],
  ['GOOGLE_API_KEY', 'gemini'],
  ['DEEPSEEK_API_KEY', 'deepseek'],
  ['OPENROUTER_API_KEY', 'openrouter'],
  ['GROQ_API_KEY', 'groq'],
  ['MISTRAL_API_KEY', 'mistral'],
  ['XAI_API_KEY', 'xai'],
  ['TOGETHER_API_KEY', 'together'],
];

// Model-name hints. Only used when the key itself doesn't identify the vendor.
export const MODEL_HINTS = [
  [/^claude/i, 'anthropic'],
  [/^gemini/i, 'gemini'],
  [/^(gpt|chatgpt|o\d)/i, 'openai'],
  [/^deepseek/i, 'deepseek'],
  [/^grok/i, 'xai'],
  [/^(mistral|codestral|ministral)/i, 'mistral'],
];

// Weaker heuristics: both OpenAI and DeepSeek keys start with "sk-".
// DeepSeek keys are "sk-" + 32 hex chars; every other "sk-" key is assumed OpenAI.
export const WEAK_KEY_PREFIXES = [
  [/^sk-[0-9a-f]{32}$/, 'deepseek'],
  [/^sk-/, 'openai'],
];
