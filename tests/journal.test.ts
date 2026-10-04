import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, appendFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MemoryJournal } from '../src/memory.ts';
import memory from '../extensions/memory.ts';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'phoenix-journal-')); t.after(() => rm(root, { recursive: true, force: true }));
  return { root, journal: new MemoryJournal(root, 'main') };
}
test('disk journal preserves raw notes, pages history and bounds context independently of log size', async t => {
  const { root, journal } = await fixture(t);
  for (let i = 0; i < 80; i++) await journal.note(`Fact ${i}: ${'a'.repeat(500)}`, new Date('2020-01-02T12:00:00Z'));
  const raw = join(root, 'memory/chats/main/journal/2020/01/02.jsonl'); const before = await readFile(raw, 'utf8');
  await journal.summarize('2020-01-02', 'Daily facts from 2020.'); await journal.summarize('2020-01', 'Monthly facts from 2020.');
  await journal.summarize('2020', 'Yearly facts from 2020.'); await journal.summarize('all', 'Durable historical fact.');
  for (let year = 2021; year <= 2026; year++) await journal.note(`New fact from ${year}`, new Date(`${year}-01-02T12:00:00Z`));
  const context = await journal.context(); assert.ok(context.length < 9000); assert.match(context, /Durable historical fact/); assert.match(context, /New fact from 2026/);
  assert.equal(await readFile(raw, 'utf8'), before);
  const first = await journal.read('2020'); assert.match(first, /Fact 0/); assert.match(first, /offset 16/); assert.doesNotMatch(first, /Fact 16:/);
  assert.match(await journal.read('2020', 16), /Fact 16:/); assert.match(await journal.search('Fact 79:'), /Fact 79:/);
  assert.equal(await journal.search('unrecorded'), '(no matches)');
  const reopened = new MemoryJournal(root, 'main'); assert.match(await reopened.context(), /Durable historical fact/);
});
test('missing summaries and partial failed writes do not prevent reading or appending memory', async t => {
  const { root, journal } = await fixture(t); await journal.note('Acknowledged note.');
  const day = new Date().toISOString().slice(0, 10); const path = join(root, `memory/chats/main/journal/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8)}.jsonl`);
  await appendFile(path, '{"at":"partial'); await journal.note('Recovered note.');
  const context = await journal.context(); assert.match(context, /Acknowledged note/); assert.match(context, /Recovered note/); assert.match(context, /none yet/);
  await assert.rejects(journal.note('two\nlines'), /one memory/); await assert.rejects(journal.note('x'.repeat(1001)), /1000 bytes/);
  await assert.rejects(journal.read('../secret'), /Choose all/); await assert.rejects(journal.summarize('1999', 'No source.'), /raw notes/);
});
test('journals are isolated by chat, bounded in prompts and inaccessible to external runs', async t => {
  const { root } = await fixture(t); const otherId = '00000000-0000-4000-8000-000000000001';
  const chats = new Map([['main', { source: 'web' }], [otherId, { source: 'web' }]]); const host = { workspace: root, extensions: {}, loaded: chats };
  const tools = new Map(); const hooks = new Map();
  for (const id of ['main', otherId]) memory({ on: (_name, hook) => hooks.set(id, hook), registerTool: tool => tools.set(id, tool) }, host, {}, id);
  await Promise.all(Array.from({ length: 25 }, (_, i) => tools.get('main').execute('note', { action: 'remember', text: `Owner fact ${i}` })));
  await tools.get(otherId).execute('note', { action: 'remember', text: 'Side chat fact' });
  assert.match((await hooks.get('main')({ systemPrompt: 'Base' })).systemPrompt, /Owner fact 24/);
  const side = (await hooks.get(otherId)({ systemPrompt: 'Base' })).systemPrompt; assert.match(side, /Side chat fact/); assert.doesNotMatch(side, /Owner fact/);
  chats.get('main').source = 'Incoming email';
  assert.doesNotMatch((await hooks.get('main')({ systemPrompt: 'Base' })).systemPrompt, /Owner fact/);
  await assert.rejects(tools.get('main').execute('read', { action: 'read' }), /Private memory/);
  await assert.rejects(tools.get('main').execute('read', {}), /Private memory/);
  await assert.rejects(tools.get('main').execute('note', { action: 'remember', text: 'Injected instruction' }), /Private memory/);
});
test('journal paths cannot follow links outside the workspace', async t => {
  const { root, journal } = await fixture(t); const outside = await mkdtemp(join(tmpdir(), 'phoenix-journal-outside-')); t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, join(root, 'memory')); await assert.rejects(journal.note('Must stay inside.'), /inside the workspace/);
});

test('recent daily corrections take priority over old summaries within the context budget', async t => {
  const { journal } = await fixture(t);
  await journal.note('A direct correction.', new Date('2026-10-04T12:00:00Z'));
  await journal.summarize('all', 'Old general summary: ' + 'a'.repeat(2880));
  await journal.summarize('2026', 'Older yearly summary: ' + 'b'.repeat(780));
  await journal.summarize('2026-10-04', 'Newest daily correction: ' + 'c'.repeat(580));
  const context = await journal.context();
  assert.match(context, /Newest daily correction/); assert.match(context, /A direct correction/);
  assert.ok(context.length < 9000);
});
