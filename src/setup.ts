import type { Host } from './host.ts';
import { errorOf } from './errors.ts';
import { readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configSchema } from './config.ts';

export async function saveSetup(host: Host, input: unknown) {
  const parsed = configSchema.safeParse(input);
  if (!parsed.success) throw Object.assign(new Error('Invalid setup file. Check its fields and keep secrets outside it.'), { status: 400 });
  const config = parsed.data;
  if (config.extensions.web.port !== host.config.extensions.web.port) throw Object.assign(new Error(`Keep browser port ${host.config.extensions.web.port} in this setup.`), { status: 400 });
  for (const selection of [config.model, ...config.chats.map(chat => chat.model).filter(selection => selection !== undefined)]) {
    if (!host.modelRuntime.getModel(selection.provider, selection.id)) throw Object.assign(new Error('Setup contains an unknown model.'), { status: 400 });
  }
  if (host.restarting || [...host.loaded.values()].some(chat => chat.pending)) throw Object.assign(new Error('Wait for active chats to finish before importing.'), { status: 409 });
  const matches = (template: typeof config.chats[number], records: typeof host.records) => records.find(chat => !chat.route && (template.main === true || template.main === undefined && template.name === 'Main chat' ? chat.id === 'main' : chat.title === template.name));
  const available = [...host.records];
  const newNames = config.chats.filter(template => { const record = matches(template, available); if (!record) return true; available.splice(available.indexOf(record), 1); return false; });
  if (host.records.length + newNames.length > 100) throw Object.assign(new Error('Too many chats in this setup.'), { status: 400 });
  const path = join(host.dataDir, 'setup.json');
  const previous = await readFile(path, 'utf8').catch(caught => { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; return null; });
  const workspace = await host.workspaceFiles.snapshot();
  const records = structuredClone(host.records);
  const folders = [...host.folders];
  const importedFolders = [...host.folders];
  for (const name of [...config.folders, ...config.chats.map(chat => chat.folder).filter(folder => folder !== undefined)]) if (!importedFolders.some(folder => folder.toLowerCase() === name.toLowerCase())) importedFolders.push(name);
  if (importedFolders.length > 32) throw Object.assign(Error('Too many folders in this setup.'), { status: 400 });
  host.restarting = true;
  try {
    await writeFile(`${path}.tmp`, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(`${path}.tmp`, path);
    await host.workspaceFiles.import({ ...config.workspace, 'AGENTS.md': config.workspace['AGENTS.md'] ?? config.instructions });
    host.folders = importedFolders; await host.saveFolders();
    const used = new Set<string>();
    for (const template of config.chats) {
      const record = matches(template, host.records.filter(chat => !used.has(chat.id))) || await host.createChat(template.name);
      used.add(record.id); record.title = template.name; record.autoTitle = false;
      record.jobs = template.jobs.map(job => host.jobRecord(job));
      record.model = template.model; record.thinking = template.thinking; record.folder = importedFolders.find(folder => folder.toLowerCase() === template.folder?.toLowerCase());
    }
    await host.save();
    return config;
  } catch (caught) { const error = errorOf(caught);
    if (previous === null) await rm(path, { force: true }); else await writeFile(path, previous, { mode: 0o600 });
    await host.workspaceFiles.restore(workspace);
    host.records = records; host.folders = folders; await host.saveFolders(); await host.save();
    host.restarting = false; throw error;
  }
}
