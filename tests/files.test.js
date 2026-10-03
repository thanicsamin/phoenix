import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, symlink, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Files, MAX_FILE_BYTES } from '../src/files.js';
import { Workspace } from '../src/workspace.js';
import fileExtension from '../extensions/files.js';
import memory from '../extensions/memory.js';

async function fixture(t) {
  const data = await mkdtemp(join(tmpdir(), 'phoenix-files-')); t.after(() => rm(data, { recursive: true, force: true }));
  const root = join(data, 'workspace'); await mkdir(root);
  const files = new Files(data, root); await files.initialize();
  const workspace = new Workspace(root); await workspace.initialize({ name: 'Phoenix', instructions: 'Help the owner.' });
  return { data, root, files, workspace };
}
test('attachments persist, isolate chats, retain exact bytes and pass images to compatible models', async t => {
  const { data, root, files } = await fixture(t);
  const file = await files.add('main', '../report.txt', [Buffer.from('a\n'), Buffer.from('b\n')]);
  assert.equal(file.name, 'report.txt'); assert.equal(await readFile(files.path(file), 'utf8'), 'a\nb\n');
  const png = Buffer.from([137,80,78,71,13,10,26,10,0]);
  const image = await files.add('main', 'picture.png', [png]); assert.equal(image.mime, 'image/png');
  const prepared = await files.prepare('Please read', [file.id, image.id], 'main', { input: ['text', 'image'] });
  assert.deepEqual(prepared.images, [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }]);
  assert.deepEqual(files.display(prepared.message, 'main'), { text: 'Please read', attachments: [file, image] });
  assert.match(prepared.message, /uploads/);
  assert.equal((await files.prepare('read', [image.id], 'main', { input: ['text'] })).images.length, 0);
  assert.throws(() => files.get(file.id, 'different-chat'), /not found/);
  await assert.rejects(files.remove(file.id, 'main'), /part of a conversation/);
  await assert.rejects(files.prepare('read', [file.id, file.id], 'main', {}), /eight/);
  const restored = new Files(data, root); await restored.initialize(); assert.deepEqual(restored.public(restored.get(file.id, 'main')), file);
});
test('draft removal, oversized uploads and outside artifacts cannot leak or leave metadata', async t => {
  const { data, root, files } = await fixture(t);
  const draft = await files.add('main', 'empty.txt', []); await files.remove(draft.id, 'main'); assert.equal(files.items.length, 0);
  await assert.rejects(files.add('main', '.', []), /file name/);
  await assert.rejects(files.add('main', 'large', [Buffer.alloc(MAX_FILE_BYTES + 1)]), /20 MB/); assert.equal(files.uploading, 0); assert.equal(files.items.length, 0);
  await writeFile(join(data, 'private'), 'secret'); await symlink(join(data, 'private'), join(root, 'link'));
  await assert.rejects(files.attach('main', 'link'), /workspace/);
  await assert.rejects(files.attach('main', '../private'), /workspace/);
  await writeFile(join(root, 'output.csv'), 'x,y\n1,2');
  let tool; fileExtension({ registerTool: value => { tool = value; } }, { files, extensions: {}, changed() {} }, {}, 'main');
  const artifact = await tool.execute('output', { path: 'output.csv' });
  assert.equal(artifact.details.attachment.name, 'output.csv'); assert.equal(await readFile(files.path(artifact.details.attachment), 'utf8'), 'x,y\n1,2');
});
test('workspace edits survive restart, private notes stay out of exports, and traversal and symlinks are blocked', async t => {
  const { data, root, workspace } = await fixture(t);
  await workspace.write('AGENTS.md', 'My system prompt.'); await workspace.write('USER.md', 'Private preference');
  await workspace.write('MEMORY.md', 'Private memory'); await workspace.write('memory/2026-10-03.md', 'Daily note');
  const restored = new Workspace(root); await restored.initialize({ name: 'Other', instructions: 'Changed default' });
  assert.equal((await restored.read('AGENTS.md')).text, 'My system prompt.');
  assert.match(await restored.context(), /Private preference/); assert.doesNotMatch(await restored.context({ private: false }), /Private preference/);
  const exported = await restored.export(); assert.equal(exported['AGENTS.md'], 'My system prompt.'); assert.ok(!Object.hasOwn(exported, 'MEMORY.md')); assert.ok(!Object.hasOwn(exported, 'USER.md'));
  await writeFile(join(data, 'secret'), 'secret'); await symlink(data, join(root, 'escape'));
  await assert.rejects(workspace.read('../secret'), /inside/); await assert.rejects(workspace.read('escape/secret'), /inside/);
  await assert.rejects(workspace.write('escape/new', 'bad'), /inside/);
  await assert.rejects(workspace.import({ 'USER.md': 'bad' }), /setup files/);
  await assert.rejects(workspace.write('large', 'x'.repeat(200001)), /200 KB/);
  await writeFile(join(root, 'binary'), Buffer.from([0,1,2])); assert.equal((await workspace.read('binary')).editable, false);
});
test('editable instructions and daily notes reach owner prompts; inbox runs exclude private memory', async t => {
  const { root, workspace } = await fixture(t);
  await workspace.write('MEMORY.md', 'Owner secret preference'); await workspace.write('AGENTS.md', 'Use short sentences.');
  const date = new Date(); const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  await workspace.write(`memory/${day}.md`, 'Remember today');
  const chat = { source: 'web' }; const host = { workspace: root, workspaceFiles: workspace, extensions: {}, loaded: new Map([['main', chat]]) };
  let hook; memory({ on: (_name, value) => { hook = value; }, registerTool() {} }, host);
  const owner = await hook({ systemPrompt: 'Base' }); assert.match(owner.systemPrompt, /Use short sentences/); assert.match(owner.systemPrompt, /Owner secret preference/); assert.match(owner.systemPrompt, /Remember today/);
  chat.source = 'email'; const inbox = await hook({ systemPrompt: 'Base' }); assert.doesNotMatch(inbox.systemPrompt, /Owner secret preference|Remember today/); assert.match(inbox.systemPrompt, /Use short sentences/);
});
