import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Host} from '../src/host.js';
import {loadConfig, configSchema} from '../src/config.js';
import {saveSetup} from '../src/setup.js';

test('setup import validates before writing and restores exported chat models/jobs without secrets', async t => {
  const directory=await mkdtemp(join(tmpdir(),'phoenix-setup-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const config=await loadConfig('agent.json');
  const host=new Host(config,directory,directory); await host.initialize();
  host.modelRuntime={getModel:(provider,id)=>provider==='opencode-go' && id==='space-bunny-free' ? {provider,id}:undefined};
  await assert.rejects(saveSetup(host,{...config,apiKey:'secret'}),/Invalid setup/);
  await assert.rejects(readFile(join(directory,'setup.json')),/ENOENT/);
  await assert.rejects(saveSetup(host,{...config,model:{provider:'opencode',id:'missing'}}),/unknown OpenCode/);
  host.loaded.set('main',{pending:1});
  await assert.rejects(saveSetup(host,config),/active chats/); host.loaded.clear();
  const side=await host.createChat('Research');
  const input={...config,name:'My agent',chats:[{name:'Research',model:config.model,thinking:'high',jobs:[{name:'Inbox',prompt:'Read email',everyMinutes:60}]}]};
  await saveSetup(host,input);
  assert.equal(host.records.length,2);
  assert.equal(host.record(side.id).jobs.length,1);
  assert.equal(host.record(side.id).thinking,'high');
  assert.equal((await stat(join(directory,'setup.json'))).mode & 0o777,0o600);
  const loaded=await loadConfig(join(directory,'setup.json'));
  assert.equal(loaded.name,'My agent');
  const restored=new Host(loaded,directory,directory); await restored.initialize();
  assert.deepEqual(configSchema.parse(await restored.exportSetup()).chats.find(chat=>chat.name==='Research').model,config.model);
});

test('model and thinking selections stay in their chat, reject active changes, and persist', async t => {
  const directory=await mkdtemp(join(tmpdir(),'phoenix-picker-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const config=await loadConfig('agent.json');
  const host=new Host(config,directory,directory); await host.initialize();
  const side=await host.createChat('Side');
  host.modelRuntime={getModel:(provider,id)=>id==='space-bunny-free'?{provider,id}:undefined,hasConfiguredAuth:()=>true};
  host.createSession=async()=>({model:config.model,thinkingLevel:'low',messages:[],subscribe:()=>()=>{},bindExtensions:async()=>{},setModel:async function(model){this.model=model;},setThinkingLevel(level){this.thinkingLevel=level;}});
  await host.setModel(side.id,{model:config.model,thinking:'high'});
  assert.equal((await host.getChat(side.id)).session.thinkingLevel,'high');
  assert.equal((await host.getChat('main')).session.thinkingLevel,'low');
  await assert.rejects(host.setModel(side.id,{model:{provider:'openai',id:'gpt-5'},thinking:'high'}),/valid model/);
  await assert.rejects(host.setModel(side.id,{model:{provider:'opencode-go',id:'missing'},thinking:'high'}),/Unknown OpenCode/);
  (await host.getChat(side.id)).pending=1;
  await assert.rejects(host.setModel(side.id,{model:config.model,thinking:'low'}),/finish/);
  const restored=new Host(config,directory,directory); await restored.initialize();
  assert.equal(restored.record(side.id).thinking,'high');
});

test('failed setup writes roll back instructions, flake files and chat metadata', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-setup-rollback-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig('agent.json'); const host = new Host(config, directory, directory); await host.initialize();
  host.modelRuntime = { getModel: () => config.model };
  await host.workspaceFiles.write('AGENTS.md', 'Previous prompt.');
  const original = host.save.bind(host); let fail = true;
  host.save = async () => { if (fail) { fail = false; throw new Error('Storage failure'); } return original(); };
  await assert.rejects(saveSetup(host, { ...config, instructions: 'New prompt.', workspace: { 'nix/flake.nix': '{description="New";}' } }), /Storage failure/);
  assert.equal((await host.workspaceFiles.read('AGENTS.md')).text, 'Previous prompt.');
  await assert.rejects(host.workspaceFiles.read('nix/flake.nix'), /not found/);
  await assert.rejects(readFile(join(directory, 'setup.json')), /ENOENT/); assert.equal(host.restarting, false);
});
