import type { ModelRuntime, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import { registerSecret } from './log.ts';
import { localProviders, localProviderNames } from './local-models.ts';
export const openCodeProviders = ['opencode-go', 'opencode'];
// Providers whose native Pi setup needs only an API key.
export const apiKeyProviders = ['opencode-go', 'opencode', 'openrouter', 'openai', 'anthropic', 'google', 'xai', 'groq', 'mistral', 'deepseek', 'moonshotai', 'minimax', 'zai'] as const;
export const modelProviders = [...apiKeyProviders, ...localProviders] as const;

export function providerChoices(runtime: ModelRuntime) {
  return modelProviders.map(id => {
    const local = (localProviders as readonly string[]).includes(id);
    const models = local ? runtime.getModels(id) : [];
    const first = models[0];
    return { id, name: local ? localProviderNames[id as typeof localProviders[number]] : runtime.getProvider(id)?.name || id,
      configured: runtime.hasConfiguredAuth(id), ...(local ? { server: { baseUrl: first?.baseUrl || '', modelIds: models.map(model => model.id), contextWindow: first?.contextWindow || 32768, vision: first?.input.includes('image') || false, reasoning: first?.reasoning || false } } : {}),
    };
  });
}

export async function saveProviderKey(runtime: ModelRuntime, provider: unknown, input: unknown) {
  if (typeof provider !== 'string' || !(apiKeyProviders as readonly string[]).includes(provider)) throw Object.assign(Error('Choose a supported provider.'), { status: 400 });
  if (typeof input !== 'string' || input.trim().length < 8 || input.trim().length > 4096) throw Object.assign(Error('Enter a valid API key.'), { status: 400 });
  const key = input.trim(); registerSecret(key);
  for (const id of openCodeProviders.includes(provider) ? openCodeProviders : [provider]) {
    // Pi serializes and persists credentials in its private auth.json.
    await runtime.login(id, 'api_key', { prompt: async () => key, notify() {} });
    // Drop the legacy in-memory OpenCode override after saving a replacement.
    await runtime.removeRuntimeApiKey(id);
  }
}

// Pi's auxiliary requests can omit its session ID. Apply the conversation ID
// at the HTTP boundary so retries, compaction and model changes share it too.
export function openCodeSessionHeaders(sessionId: string): ExtensionFactory {
  return pi => { pi.on('before_provider_headers', ({ headers }, context) => {
    for (const name of Object.keys(headers)) {
      if (['x-opencode-session', 'user-agent'].includes(name.toLowerCase())) delete headers[name];
    }
    if (openCodeProviders.includes(context.model?.provider || '')) headers['x-opencode-session'] = sessionId;
    headers['User-Agent'] = 'phoenix-agent/0.1.0';
  }); };
}

export function configureOpenCode(runtime: ModelRuntime) {
  // Pi 1.0.0 lists MiniMax M2.7 with the old protocol. OpenCode now requires
  // /v1/messages: https://opencode.ai/v2/docs/console/go#endpoints
  for (const provider of openCodeProviders) {
    const model = runtime.getModel(provider, 'minimax-m2.7');
    if (model?.api === 'openai-completions') {
      runtime.registerProvider(provider, { models: runtime.getModels(provider).map(entry => entry.id === model.id ? {
        ...entry, api: 'anthropic-messages', compat: undefined,
        baseUrl: provider === 'opencode-go' ? 'https://opencode.ai/zen/go' : 'https://opencode.ai/zen',
      } : entry) });
    }
  }
}

export function modelChoices(runtime: ModelRuntime, current?: { provider: string; id: string }) {
  return modelProviders.flatMap(provider => {
    const configured = runtime.hasConfiguredAuth(provider);
    return runtime.getModels(provider).filter(model => configured || (current?.provider === provider && current.id === model.id)).map(({ id, name }) => ({ provider, id, name }));
  });
}
