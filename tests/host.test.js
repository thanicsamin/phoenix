import test from 'node:test';
import assert from 'node:assert/strict';
import { Chat as Host, lifecycle } from '../src/host.js';
import { sendTool } from '../extensions/channel.js';

test('host serializes channels, returns their own replies and recovers after failures', async () => {
  const host = new Host({}, '/tmp', '/tmp');
  const messages = [];
  let active = 0;
  host.attach({ messages, subscribe: () => () => {}, waitForIdle: async () => {},
    prompt: async text => {
      assert.equal(++active, 1);
      await new Promise(resolve => setTimeout(resolve, 10));
      active--;
      if (text === 'fail') throw new Error('test failure');
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] });
    },
  });
  const replies = await Promise.all([host.submit('one'), host.submit('two', 'Telegram')]);
  assert.deepEqual(replies, ['one', '[Telegram]\ntwo']);
  await assert.rejects(host.submit('fail'), /test failure/);
  assert.equal(await host.submit('three'), 'three');
  await host.queue;
  assert.equal(host.pending, 0);
  assert.equal(host.error, '');
});
test('queue bounds and validation prevent unbounded work', async () => {
  const host = new Host({}, '/tmp', '/tmp');
  await assert.rejects(host.submit(''), /1–32000/);
  await assert.rejects(host.submit('x'.repeat(32001)), /1–32000/);
  host.pending = 10;
  await assert.rejects(host.submit('hi'), /queue is full/);
  host.pending = 0; host.closing = true;
  await assert.rejects(host.submit('hi'), /shutting down/);
});
test('send tools enforce recipient allowlists', async () => {
  let tool; const sent = [];
  sendTool({ registerTool: definition => { tool = definition; } }, 'telegram', ['123'], async (...args) => sent.push(args));
  await assert.rejects(tool.execute('id', { recipient: 'evil', text: 'secret' }), /not allowed/);
  assert.deepEqual(sent, []);
  await tool.execute('id', { recipient: '123', text: 'hello' });
  assert.deepEqual(sent, [['123', 'hello']]);
});
test('extensions start once across new conversations and cleanup is idempotent', async () => {
  const handlers = {}; const host = new Host({}, '/tmp', '/tmp');
  let starts = 0, stops = 0;
  lifecycle({ on: (event, handler) => { handlers[event] = handler; } }, host, 'test', () => starts++, () => stops++);
  await handlers.session_start(); await handlers.session_start();
  await handlers.session_shutdown(); await host.cleanups[0]();
  assert.equal(starts, 1); assert.equal(stops, 1);
});

test('cancellation discards queued prompts and allows a fresh request', async () => {
  const host = new Host({}, '/tmp', '/tmp');
  let release;
  const runs = [];
  host.attach({messages:[],subscribe:()=>()=>{},waitForIdle:async()=>{},
    prompt:async text=>{ runs.push(text); if(text==='first')await new Promise(resolve=>{release=resolve;}); },
  });
  const first=host.submit('first');const second=host.submit('queued');
  const rejected=assert.rejects(second,/cancelled/);
  await new Promise(resolve=>setImmediate(resolve));host.generation++;release();
  await first;await rejected;await host.queue;
  await host.submit('fresh');await host.queue;
  assert.deepEqual(runs,['first','fresh']); assert.equal(host.pending,0); assert.deepEqual(host.queued,[]);
});

test('steering uses native Pi injection during a run without aborting it', async () => {
  const chat = new Host({ name: 'Phoenix' }, '/tmp', '/tmp');
  const calls = []; let subscription; let release;
  const session = { model: { provider: 'opencode-go', id: 'space-bunny-free' }, messages: [], isStreaming: true, modelRuntime: { hasConfiguredAuth: () => true },
    subscribe: handler => { subscription = handler; return () => {}; }, waitForIdle: async () => {},
    prompt: async (message, options) => {
      calls.push({ message, options });
      if (options.streamingBehavior !== 'steer') await new Promise(resolve => { release = resolve; });
    },
  };
  chat.attach(session);
  await assert.rejects(chat.steer('Too early'), /while the agent/);
  const running = chat.submit('Initial task'); await new Promise(resolve => setImmediate(resolve));
  await chat.steer('/literal owner correction');
  assert.equal(chat.pending, 1); assert.equal(chat.state().messages[0].steered, true);
  assert.equal(calls[1].options.streamingBehavior, 'steer'); assert.equal(calls[1].options.expandPromptTemplates, false);
  subscription({ type: 'message_start', message: { role: 'user', content: '/literal owner correction' } });
  assert.equal(chat.steering.length, 0); assert.equal(chat.source, 'web');
  release(); await running; await chat.queue;
  assert.equal(chat.pending, 0);
});

test('idle side chats unload from RAM and reopen from their persistent session', async t => {
  const { Host: Agent } = await import('../src/host.js'); const { loadConfig } = await import('../src/config.js');
  const { mkdtemp, rm } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-idle-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const host = new Agent(await loadConfig('agent.json'), directory, directory); await host.initialize();
  const histories = new Map(); const closed = [];
  host.createSession = async id => ({ messages: histories.get(id) || [], subscribe: () => () => {}, bindExtensions: async () => {}, abort: async () => {}, dispose() { histories.set(id, this.messages); closed.push(id); } });
  await host.getChat('main'); const sides = await Promise.all(['One','Two','Three'].map(name => host.createChat(name)));
  const first = await host.getChat(sides[0].id); first.session.messages.push({ role: 'user', content: 'Persisted' }); first.lastUsed = 1;
  await host.getChat(sides[1].id); await host.getChat(sides[2].id);
  assert.equal(host.loaded.size, 3); assert.ok(!host.loaded.has(sides[0].id)); assert.ok(closed.includes(sides[0].id));
  assert.equal((await host.getChat(sides[0].id)).session.messages[0].content, 'Persisted');
  await host.close();
});


test('archiving is reversible and persistent without changing jobs, permissions or conversation data', async t => {
  const { Host: Agent } = await import('../src/host.js'); const { loadConfig } = await import('../src/config.js');
  const { mkdtemp, rm, writeFile, readFile } = await import('node:fs/promises'); const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-archive-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig('agent.json'); const host = new Agent(config, directory, directory); await host.initialize();
  const side = await host.createChat('Keep my history'); side.permissions.push('email_send');
  await host.addJob(side.id, { name: 'Keep running', prompt: 'Check', everyMinutes: 5 });
  const jobs = JSON.stringify(side.jobs); const history = join(directory, 'history-fixture.jsonl'); await writeFile(history, 'Original history');
  await host.archiveChat(side.id, true); assert.equal(side.archived, true); assert.equal(JSON.stringify(side.jobs), jobs); assert.deepEqual(side.permissions, ['email_send']);
  await host.close(); const reopened = new Agent(config, directory, directory); await reopened.initialize();
  assert.equal(reopened.record(side.id).archived, true); assert.equal(await readFile(history, 'utf8'), 'Original history');
  await reopened.archiveChat(side.id, false); assert.equal(reopened.record(side.id).archived, false);
  await assert.rejects(reopened.archiveChat('main', true), /main chat stays/);
  await assert.rejects(reopened.archiveChat(undefined, true), /Choose whether/);
  await assert.rejects(reopened.archiveChat(side.id, 'true'), /Choose whether/);
  await assert.rejects(reopened.archiveChat('missing', true), /Chat not found/); await reopened.close();
});
