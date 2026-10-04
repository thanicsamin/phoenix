import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { registerSecret } from './log.ts';

export const localProviders = ['ollama', 'lmstudio', 'local'] as const;
export const localProviderNames = { ollama: 'Ollama', lmstudio: 'LM Studio', local: 'OpenAI-compatible server' };
const endpointSchema = z.strictObject({
  provider: z.enum(localProviders),
  baseUrl: z.url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
  }, 'Use an HTTP(S) server URL without credentials, query or fragment.'),
  modelIds: z.array(z.string().trim().min(1).max(200).refine(id => [...id].every(char => char.charCodeAt(0) > 32 && char.charCodeAt(0) !== 127))).min(1).max(100),
  contextWindow: z.number().int().min(4096).max(4194304).default(32768),
  vision: z.boolean().default(false), reasoning: z.boolean().default(false),
  apiKey: z.string().trim().max(4096).refine(key => [...key].every(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127)).default(''),
});

export function parseEndpoint(input: unknown) {
  const parsed = endpointSchema.safeParse(input);
  if (!parsed.success) throw Object.assign(Error('Enter a valid server URL, model IDs and context size.'), { status: 400 });
  return { ...parsed.data, baseUrl: parsed.data.baseUrl.replace(/\/+$/, ''), modelIds: [...new Set(parsed.data.modelIds)] };
}

// Pi treats !commands and $variables specially in models.json. UI keys are
// always literal values, including keys containing either character.
function literalKey(key: string) { return key.replaceAll('$', () => '$$').replace(/^!/, '$!'); }

export async function saveEndpoint(runtime: ModelRuntime, dataDir: string, input: ReturnType<typeof parseEndpoint>) {
  const path = join(dataDir, 'pi', 'models.json');
  const previous = await readFile(path, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '{"providers":{}}'; });
  let config;
  try {
    config = JSON.parse(previous);
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw Error();
    config.providers ??= {};
    if (typeof config.providers !== 'object' || Array.isArray(config.providers)) throw Error();
  } catch { throw Object.assign(Error('Pi models.json is invalid. Repair it before saving a server.'), { status: 400 }); }
  const old = config.providers[input.provider];
  const oldAuth = (await runtime.getAuth(input.provider))?.auth.apiKey;
  registerSecret(oldAuth); registerSecret(input.apiKey);
  const key = input.apiKey || (old?.baseUrl?.replace(/\/+$/, '') === input.baseUrl ? oldAuth : '') || 'phoenix-local';
  config.providers[input.provider] = {
    name: localProviderNames[input.provider], baseUrl: input.baseUrl,
    api: 'openai-completions', apiKey: literalKey(key),
    models: input.modelIds.map(id => ({ id, name: id, input: input.vision ? ['text', 'image'] : ['text'], reasoning: input.reasoning,
      contextWindow: input.contextWindow, maxTokens: Math.min(4096, Math.floor(input.contextWindow / 4)),
      compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
    })),
  };
  await mkdir(join(dataDir, 'pi'), { recursive: true, mode: 0o700 });
  const stored = (await runtime.listCredentials()).some(item => item.providerId === input.provider);
  try {
    // This endpoint's URL and key travel together in Pi's private config. Remove
    // CLI overrides so an old server's credentials never follow a changed URL.
    if (stored) await runtime.logout(input.provider);
    await runtime.removeRuntimeApiKey(input.provider);
    await writeFile(`${path}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    await runtime.refresh({ allowNetwork: false });
    if (input.modelIds.some(id => runtime.getModel(input.provider, id)?.baseUrl !== input.baseUrl)) throw Error('Pi could not load these server settings. Check models.json and provider extensions.');
  } catch (error) {
    await writeFile(`${path}.tmp`, previous, { mode: 0o600 }); await rename(`${path}.tmp`, path);
    await runtime.refresh({ allowNetwork: false });
    if (stored && oldAuth) await runtime.login(input.provider, 'api_key', { prompt: async () => oldAuth, notify() {} });
    throw error;
  } finally { await rm(`${path}.tmp`, { force: true }); }
}
