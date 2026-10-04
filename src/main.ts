import type { Extension } from './types.ts';
import { errorOf } from './errors.ts';
import { mkdir, readFile, writeFile, rm, lstat, symlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { loadConfig, secret } from './config.ts';
import { Host } from './host.ts';
import { configureOpenCode, openCodeSessionHeaders, apiKeyProviders } from './models.ts';
import { saveSetup } from './setup.ts';
import { Generations } from './generations.ts';
import { Interface } from './interface.ts';
import { fileURLToPath } from 'node:url';
import { log, installProcessLogging, registerSecret } from './log.ts';

installProcessLogging('agent');

process.umask(0o077);
const dataDir = resolve(process.env.PHOENIX_DATA || '.phoenix');
const workspace = join(dataDir, 'workspace');
const agentDir = join(dataDir, 'pi');
const corePrompt = process.env.PHOENIX_CORE_PROMPT || await readFile(new URL('../PHOENIX.md', import.meta.url), 'utf8');
await mkdir(workspace, { recursive: true });
await mkdir(agentDir, { recursive: true });
let currentHost: Host;
async function start() {
  let config;
  try { config = await loadConfig(join(dataDir, 'setup.json')); }
  catch (caught) { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; config = await loadConfig(resolve(process.env.PHOENIX_CONFIG || 'agent.json')); }
  const host = new Host(config, dataDir, workspace);
  await host.initialize();
  host.generations = new Generations(dataDir, process.env.PHOENIX_APP);
  await host.generations.initialize();
  // Repair the flattened npm launcher in existing installations. New seeds
  // and generation restores preserve package symlinks. Leave custom wrappers alone.
  const piBin = join(host.generations.app, 'node_modules', '.bin', 'pi');
  try {
    if (!(await lstat(piBin)).isSymbolicLink() && (await readFile(piBin)).equals(await readFile(join(host.generations.app, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'bundle', 'cli.js')))) {
      await rm(piBin); await symlink('../@earendil-works/pi-coding-agent/dist/bundle/cli.js', piBin);
    }
  } catch (caught) { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; }
  process.env.PATH = `${join(host.generations.app, 'node_modules', '.bin')}:${process.env.PATH || ''}`;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  host.ui = new Interface(dataDir, host.generations.app);
  await host.ui.initialize(fileURLToPath(new URL('../web/', import.meta.url)));
  const modules = new Map<string, Extension>();
  for (const name of Object.keys(config.extensions)) modules.set(name, (await import(`../extensions/${name}.ts`)).default);
  const processExtensions = new Set(['auth', 'web', 'tunnel', 'telegram', 'slack', 'discord', 'email']);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });
  configureOpenCode(modelRuntime);
  const key = await secret('OPENCODE_API_KEY', false)
    || await readFile(join(dataDir, 'opencode-key'), 'utf8').catch(caught => { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; return ''; });
  registerSecret(key.trim());
  const storedProviders = new Set((await modelRuntime.listCredentials()).map(entry => entry.providerId));
  if (key) for (const provider of ['opencode', 'opencode-go']) if (!storedProviders.has(provider)) await modelRuntime.setRuntimeApiKey(provider, key.trim());
  for (const provider of apiKeyProviders) registerSecret((await modelRuntime.getAuth(provider))?.auth.apiKey || '');
  const model = modelRuntime.getModel(config.model.provider, config.model.id);
  if (!model) throw new Error(`Unknown model: ${config.model.provider}/${config.model.id}. Choose a model supported by the pinned Pi version.`);
  host.modelRuntime = modelRuntime;
  host.createSession = async id => {
    const sessionManager = SessionManager.continueRecent(workspace, join(agentDir, 'sessions', id));
    const factories = [...host.sessionExtensions];
    for (const [name, options] of Object.entries(config.extensions)) {
      if (id !== 'main' && processExtensions.has(name)) continue;
      factories.push(pi => modules.get(name)!(pi, host, options as never, id));
    }
    factories.push(openCodeSessionHeaders(sessionManager.getSessionId()));
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: true, maxRetries: 2 } });
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspace, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: config.pi.extensions.map(path => /^(npm:|git:|github:|https?:\/\/)/.test(path) ? path : resolve(path)),
      additionalSkillPaths: config.pi.skills.map(path => resolve(path)), extensionFactories: factories,
      appendSystemPrompt: [corePrompt, `This is your ${host.record(id).title} chat. Keep its conversation separate from other chats. Scheduled work returns here. Your editable agent instructions and memory live in the persistent workspace.`],
    });
    await resourceLoader.reload();
    if (resourceLoader.getExtensions().errors.length) throw new Error('A configured Pi extension failed to load. Check its path and dependencies.');
    const { session } = await createAgentSession({
      cwd: workspace, agentDir, model: modelRuntime.getModel((host.record(id).model || config.model).provider, (host.record(id).model || config.model).id) || model,
      thinkingLevel: host.record(id).thinking, modelRuntime, resourceLoader, settingsManager,
      sessionManager,
    });
    return session;
  };
  try { await host.getChat('main'); } catch (caught) { const error = errorOf(caught); await host.close(); throw error; }
  if (host.extensions.web !== 'ready') {
    await host.close();
    throw new Error('Browser interface failed to start.');
  }
  host.applySetup = async input => {
    const setupPath = join(dataDir, 'setup.json');
    const previous = await readFile(setupPath, 'utf8').catch(caught => { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; return null; });
    const records = JSON.stringify(host.records);
    const workspace = await host.workspaceFiles.snapshot();
    await saveSetup(host, input);
    host.restarting = true;
    setTimeout(async () => {
      try { await host.close(); currentHost = await start(); }
      catch (caught) { const error = errorOf(caught);
        log.error('setup.import_failed', { error });
        if (previous === null) await rm(setupPath, { force: true }); else await writeFile(setupPath, previous, { mode: 0o600 });
        await writeFile(join(dataDir, 'chats.json'), records, { mode: 0o600 });
        await host.workspaceFiles.restore(workspace);
        currentHost = await start();
        const chat = await currentHost.getChat('main'); chat.error = 'Import failed. Your previous setup was restored.'; currentHost.changed();
      }
    }, 250);
  };
  host.requestRestart = () => {
    if (host.restarting) return;
    host.restarting = true;
    setTimeout(async () => { await host.close(); process.exit(42); }, 1000);
  };
  log.info('agent.ready', { extensions: host.extensions });
  return host;
}
currentHost = await start();
if (process.env.PHOENIX_RECOVERED) {
  const chat = await currentHost.getChat('main'); chat.error = 'The new generation could not start. The previous version is running; your edited source is available in Files for repair.'; currentHost.changed();
}
process.send?.({ ready: true });
process.channel?.unref();
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('agent.stopping', { signal });
  const deadline = setTimeout(() => process.exit(1), 10000);
  deadline.unref();
  await currentHost.close();
});
