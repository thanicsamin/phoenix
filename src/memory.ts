import { errorOf } from './errors.ts';
import { open, mkdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { Workspace } from './workspace.ts';

// Raw notes stay on disk. Calendar summaries are a replaceable cache, not the
// source of truth. No model calls, daemon, embedding index or in-memory history.
export class MemoryJournal {
  workspace: Workspace; root: string;
  constructor(workspace: string | Workspace, chatId: string) {
    if (!/^(owner|main|[0-9a-f-]{36})$/.test(chatId)) throw Error('Choose a valid chat.');
    this.workspace = workspace instanceof Workspace ? workspace : new Workspace(workspace);
    this.root = chatId === 'owner' ? 'memory/owner' : `memory/chats/${chatId}`;
  }
  async folder(relative: string) {
    let prefix = '';
    for (const part of relative.split('/')) {
      prefix += `${prefix ? '/' : ''}${part}`;
      try { await this.workspace.path(prefix); }
      catch (caught) { const error = errorOf(caught); if (error.status !== 404) throw error; await mkdir(await this.workspace.path(prefix, true), { mode: 0o700 }); }
    }
  }
  async note(text: string, now = new Date()) {
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 1000 || /[\r\n\0]/.test(text)) throw Error('Write one memory of up to 1000 bytes, without line breaks.');
    const day = now.toISOString().slice(0, 10); const folder = `${this.root}/journal/${day.slice(0, 4)}/${day.slice(5, 7)}`;
    await this.folder(folder);
    const file = `${folder}/${day.slice(8)}.jsonl`;
    await this.workspace.path(file).catch(caught => { const error = errorOf(caught); if (error.status !== 404) throw error; });
    const handle = await open(await this.workspace.path(file, true), 'a+', 0o600);
    try {
      const { size } = await handle.stat(); const last = Buffer.alloc(1);
      // A retried remember call must not fill the journal with the same note.
      // Only compare the last valid entry today: intervening corrections and
      // repeated events on another day still deserve their own dated records.
      if (size) {
        const tail = Buffer.alloc(Math.min(size, 8192));
        const { bytesRead } = await handle.read(tail, 0, tail.length, size - tail.length);
        for (const line of tail.subarray(0, bytesRead).toString('utf8').split('\n').reverse()) {
          try {
            const note = JSON.parse(line);
            if (typeof note.text !== 'string' || typeof note.at !== 'string') continue;
            if (note.text === text.trim()) return day;
            break;
          } catch { /* Ignore an interrupted append, as notes() does. */ }
        }
      }
      if (size) await handle.read(last, 0, 1, size - 1);
      // Preserve a partial failed append as its own line, so the next note can
      // still be recovered without rewriting any acknowledged journal record.
      await handle.writeFile((size && last[0] !== 10 ? '\n' : '') + JSON.stringify({ at: now.toISOString(), text: text.trim() }) + '\n');
      await handle.sync();
    } finally { await handle.close(); }
    return day;
  }
  async days() {
    const list = (path: string) => this.workspace.list(path).catch(caught => { const error = errorOf(caught); if (error.status !== 404) throw error; return { entries: [] }; });
    const dates: string[] = [];
    for (const year of (await list(`${this.root}/journal`)).entries.filter(item => item.directory && /^\d{4}$/.test(item.name)))
      for (const month of (await list(year.path)).entries.filter(item => item.directory && /^(0[1-9]|1[0-2])$/.test(item.name)))
        for (const day of (await list(month.path)).entries.filter(item => !item.directory && /^(0[1-9]|[12]\d|3[01])\.jsonl$/.test(item.name)))
          dates.push(`${year.name}-${month.name}-${day.name.slice(0, 2)}`);
    return dates.sort();
  }
  async *notes(day: string): AsyncGenerator<{ at: string; text: string }> {
    const file = `${this.root}/journal/${day.slice(0, 4)}/${day.slice(5, 7)}/${day.slice(8)}.jsonl`;
    const stream = createReadStream(await this.workspace.path(file)); const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        try { const note = JSON.parse(line); if (typeof note.text === 'string' && note.text.length <= 1000 && typeof note.at === 'string') yield note; }
        catch { /* A partial final append or an owner's edited line cannot hide other notes. */ }
      }
    } finally { lines.close(); stream.destroy(); }
  }
  period(value: string) {
    if (typeof value !== 'string' || !/^(?:all|\d{4}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?)$/.test(value)) throw Error('Choose all, YYYY, YYYY-MM, or YYYY-MM-DD.');
    return value;
  }
  async summary(period: string) {
    const file = await this.workspace.read(`${this.root}/summaries/${this.period(period)}.md`).catch(caught => { const error = errorOf(caught); if (error.status !== 404) throw error; return { text: undefined }; });
    return file.text?.slice(0, 4000) || '';
  }
  async summarize(period: string, text: string) {
    this.period(period);
    if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 3000) throw Error('Write a summary of up to 3000 bytes.');
    if (!(await this.days()).some(day => period === 'all' || day.startsWith(period))) throw Error('Read the raw notes for this period before summarizing it.');
    await this.folder(`${this.root}/summaries`);
    await this.workspace.write(`${this.root}/summaries/${period}.md`, `# Summary: ${period}\n\nDerived from raw notes; updated ${new Date().toISOString()}.\n\n${text.trim()}\n`);
  }
  async read(period: string, offset = 0) {
    this.period(period); if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Choose a non-negative note offset.');
    const output: string[] = []; let count = 0;
    for (const day of (await this.days()).filter(day => period === 'all' || day.startsWith(period))) for await (const note of this.notes(day)) {
      if (count++ < offset) continue;
      if (output.length === 16) return `${output.join('\n')}\nMore raw notes: read ${period} with offset ${offset + 16}.`;
      output.push(`${note.at} ${note.text}`);
    }
    return `${await this.summary(period) || '(no cached summary)'}\n\nRaw notes:\n${output.join('\n') || '(empty)'}`;
  }
  async search(query: string) {
    if (typeof query !== 'string' || !query.trim() || query.length > 200) throw Error('Search for up to 200 characters.');
    const output: string[] = []; const needle = query.toLowerCase();
    for (const day of (await this.days()).reverse()) for await (const note of this.notes(day)) {
      if (note.text.toLowerCase().includes(needle)) output.push(`${note.at} ${note.text}`);
      if (output.length === 16) return output.join('\n');
    }
    return output.join('\n') || '(no matches)';
  }
  async context() {
    const days = await this.days(); if (!days.length) return '(empty)';
    const recent: string[] = [];
    for (const day of days.slice(-3)) for await (const note of this.notes(day)) { recent.push(`${note.at} ${note.text}`); if (recent.length > 16) recent.shift(); }
    const years = [...new Set(days.map(day => day.slice(0, 4)))].slice(-3).reverse();
    const months = [...new Set(days.map(day => day.slice(0, 7)))].slice(-3).reverse();
    const periods = [...days.slice(-7).reverse(), ...months, ...years, 'all'];
    const summaries: string[] = [];
    let summarySize = 0;
    for (const period of periods) { const text = await this.summary(period); if (text && summarySize + text.length < 4000) { summaries.push(text); summarySize += text.length; } }
    const shown: string[] = []; let size = 0;
    for (const line of recent.reverse()) { if (size + line.length > 4000) break; shown.unshift(line); size += line.length; }
    return `Recent raw notes:\n${shown.join('\n')}\n\nDerived summaries (day → month → year → all):\n${summaries.join('\n\n') || '(none yet)'}\n\nAvailable recent days: ${days.slice(-12).join(', ')}. Read/search older raw notes as needed. Summarize completed days, then months, years and all-time facts when useful; preserve dates, corrections, uncertainty and source references. Prefer newer direct notes over stale summaries. Summaries never replace the journal.`;
  }
}
