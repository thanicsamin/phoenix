import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { secret } from '../src/config.js';
import { lifecycle } from '../src/host.js';
import { allowed, chunks, sendTool, reply } from './channel.js';
import { log } from '../src/log.js';

export default function telegram(pi, host, options) {
  let token;
  let controller;
  let loop;
  const offsetFile = join(host.dataDir, 'telegram-offset');
  async function api(method, params, signal) {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(params),
      signal: signal || AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!data.ok) throw new Error(`Telegram ${method} failed (${data.error_code}).`);
    return data.result;
  }
  async function send(recipient, text) {
    for (const part of chunks(text, 4000)) await api('sendMessage', { chat_id: recipient, text: part });
  }
  sendTool(pi, 'telegram', options.allowUsers, send, host);
  lifecycle(pi, host, 'telegram', async () => {
    token = await secret(options.tokenEnv);
    await api('getMe', {});
    controller = new AbortController();
    let offset = Number(await readFile(offsetFile, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; return '0'; }));
    if (!offset) {
      const backlog = await api('getUpdates', { offset: -1 });
      offset = backlog.length ? backlog[0].update_id + 1 : 0;
    }
    loop = (async () => {
      while (!controller.signal.aborted) {
        try {
          const updates = await api('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, AbortSignal.any([controller.signal, AbortSignal.timeout(35000)]));
          for (const update of updates) {
            offset = update.update_id + 1;
            await writeFile(offsetFile, String(offset), { mode: 0o600 });
            const message = update.message;
            if (message?.chat.type !== 'private' || !message.text || !allowed(options.allowUsers, message.from?.id)) continue;
            await reply(host, 'Telegram', message.text, text => send(String(message.chat.id), text), `telegram:${message.from.id}`);
          }
        } catch (error) {
          if (!controller.signal.aborted) { log.warn('channel.reconnecting', { extension: 'telegram', error }); await delay(5000, undefined, { signal: controller.signal }).catch(() => {}); }
        }
      }
    })();
  }, async () => { controller?.abort(); await loop; });
}
