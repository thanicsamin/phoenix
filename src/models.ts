import type { ModelRuntime, ExtensionFactory } from '@earendil-works/pi-coding-agent';
export const openCodeProviders = ['opencode-go', 'opencode'];

// Pi's auxiliary requests can omit its session ID. Apply the conversation ID
// at the HTTP boundary so retries, compaction and model changes share it too.
export function openCodeSessionHeaders(sessionId: string): ExtensionFactory {
  return pi => { pi.on('before_provider_headers', ({ headers }) => {
    for (const name of Object.keys(headers)) {
      if (['x-opencode-session', 'user-agent'].includes(name.toLowerCase())) delete headers[name];
    }
    headers['x-opencode-session'] = sessionId;
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

export function modelChoices(runtime: ModelRuntime) {
  return openCodeProviders.flatMap(provider => runtime.getModels(provider).map(({ id, name }) => ({ provider, id, name })));
}
