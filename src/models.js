export const openCodeProviders = ['opencode-go', 'opencode'];

export function configureOpenCode(runtime) {
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

export function modelChoices(runtime) {
  return openCodeProviders.flatMap(provider => runtime.getModels(provider).map(({ id, name }) => ({ provider, id, name })));
}
