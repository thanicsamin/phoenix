import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, realpath, stat, copyFile, open } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const FILE_MARKER = '\n\n[Phoenix attachments]\n';
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const imageType = data => data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
  : data[0] === 255 && data[1] === 216 && data[2] === 255 ? 'image/jpeg'
    : /^GIF8[79]a/.test(data.subarray(0, 6).toString()) ? 'image/gif'
      : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP' ? 'image/webp' : null;

export class Files {
  constructor(dataDir, workspace) { Object.assign(this, { dataDir, workspace, items: [], writes: Promise.resolve(), uploading: 0 }); }
  async initialize() {
    await mkdir(join(this.dataDir, 'attachments'), { recursive: true, mode: 0o700 });
    try { this.items = JSON.parse(await readFile(join(this.dataDir, 'attachments.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!Array.isArray(this.items) || this.items.some(item => !/^[0-9a-f-]{36}$/.test(item.id)
      || !/^(main|[0-9a-f-]{36})$/.test(item.chatId) || typeof item.name !== 'string' || ['.', '..'].includes(item.name) || item.name.includes('\0') || item.name.includes('/') || item.name.includes('\\'))) throw new Error('Invalid attachment metadata.');
    // Older versions stored PDFs as generic downloads. Verify the signature,
    // rather than trusting a user-controlled file extension or upload MIME.
    for (const file of this.items.filter(file => file.mime === 'application/octet-stream' && /\.pdf$/i.test(file.name))) {
      const handle = await open(this.path(file), 'r');
      try { const data = Buffer.alloc(5); await handle.read(data, 0, 5, 0); if (data.toString() === '%PDF-') file.mime = 'application/pdf'; }
      finally { await handle.close(); }
    }
  }
  save() {
    const body = JSON.stringify(this.items);
    const path = join(this.dataDir, 'attachments.json');
    const save = this.writes.then(async () => { await writeFile(`${path}.tmp`, body, { mode: 0o600 }); await rename(`${path}.tmp`, path); });
    this.writes = save.catch(() => {}); return save;
  }
  get(id, chatId) {
    const file = this.items.find(item => item.id === id && item.chatId === chatId);
    if (!file) throw fail('Attachment not found in this chat.', 404);
    return file;
  }
  public(file) { return { id: file.id, name: file.name, size: file.size, mime: file.mime, chatId: file.chatId }; }
  path(file) { return join(this.dataDir, 'attachments', file.id, file.name); }
  async add(chatId, name, chunks, role = 'user') {
    if (this.uploading >= 4) throw fail('Wait for another upload to finish.', 429);
    if (this.items.filter(file => file.chatId === chatId).length >= 200) throw fail('This chat has reached its attachment limit.', 409);
    name = String(name).split(/[\\/]/).pop().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 160).trim();
    if (!name || name === '.' || name === '..') throw fail('Choose a file name.');
    const id = randomUUID();
    const folder = join(this.dataDir, 'attachments', id);
    this.uploading++;
    let handle;
    try {
      await mkdir(folder, { mode: 0o700 });
      handle = await open(join(folder, name), 'wx', 0o600);
      let size = 0;
      for await (const chunk of chunks) {
        size += chunk.length;
        if (size > MAX_FILE_BYTES) throw fail('Files must be 20 MB or smaller.', 413);
        await handle.writeFile(chunk);
      }
      await handle.close(); handle = undefined;
      const signature = await open(join(folder, name), 'r'); const data = Buffer.alloc(12);
      try { await signature.read(data, 0, data.length, 0); }
      finally { await signature.close(); }
      const file = { id, chatId, name, size, mime: imageType(data) || (data.subarray(0, 5).toString() === '%PDF-' ? 'application/pdf' : 'application/octet-stream'), role, used: role === 'assistant' };
      const inputFolder = join(this.workspace, 'uploads', chatId, id);
      await mkdir(inputFolder, { recursive: true, mode: 0o700 });
      await copyFile(this.path(file), join(inputFolder, name));
      this.items.push(file);
      try { await this.save(); } catch (error) { this.items = this.items.filter(item => item !== file); throw error; }
      return this.public(file);
    } catch (error) {
      await handle?.close(); await rm(folder, { recursive: true, force: true });
      await rm(join(this.workspace, 'uploads', chatId, id), { recursive: true, force: true });
      throw error;
    } finally { this.uploading--; }
  }
  async attach(chatId, path) {
    const root = await realpath(this.workspace);
    const file = await realpath(resolve(root, path));
    if (!file.startsWith(root + sep)) throw fail('Attach a file from your workspace.');
    const info = await stat(file);
    if (!info.isFile()) throw fail('Only regular files can be attached.');
    if (info.size > MAX_FILE_BYTES) throw fail('Files must be 20 MB or smaller.', 413);
    const handle = await open(file, 'r');
    try { return await this.add(chatId, file.split(sep).pop(), handle.createReadStream(), 'assistant'); }
    finally { await handle.close().catch(() => {}); }
  }
  async prepare(message, ids, chatId, model) {
    if (typeof message !== 'string' || message.length > 32000) throw fail('Write a message of up to 32000 characters.');
    if (!Array.isArray(ids) || ids.length > 8 || new Set(ids).size !== ids.length) throw fail('Attach up to eight files.');
    const files = ids.map(id => this.get(id, chatId));
    const images = [];
    if (model?.input?.includes('image') && files.filter(file => file.mime.startsWith('image/')).reduce((total, file) => total + file.size, 0) > MAX_FILE_BYTES) throw fail('Keep images below 20 MB total per message.', 413);
    if (model?.input?.includes('image')) for (const file of files.filter(file => file.mime.startsWith('image/'))) {
      images.push({ type: 'image', mimeType: file.mime, data: (await readFile(this.path(file))).toString('base64') });
    }
    if (files.length) {
      const references = files.map(file => ({ ...this.public(file), path: join('uploads', chatId, file.id, file.name) }));
      message += FILE_MARKER + JSON.stringify(references);
      for (const file of files) file.used = true;
      await this.save();
    }
    return { message, images };
  }
  display(message, chatId) {
    const split = message.lastIndexOf(FILE_MARKER);
    if (split < 0) return { text: message };
    try {
      const files = JSON.parse(message.slice(split + FILE_MARKER.length));
      return { text: message.slice(0, split), attachments: files.map(file => this.public(this.get(file.id, chatId))) };
    } catch { return { text: message }; }
  }
  async remove(id, chatId) {
    const file = this.get(id, chatId);
    if (file.used) throw fail('This attachment is part of a conversation.', 409);
    const previous = this.items; this.items = this.items.filter(item => item !== file);
    try { await this.save(); } catch (error) { this.items = previous; throw error; }
    await rm(join(this.dataDir, 'attachments', id), { recursive: true, force: true });
    await rm(join(this.workspace, 'uploads', chatId, id), { recursive: true, force: true });
  }
}
