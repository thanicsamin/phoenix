import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { secret } from '../src/config.js';
import { lifecycle } from '../src/host.js';
import { allowed, chunks, sendTool, reply } from './channel.js';
import { log } from '../src/log.js';

export default function slack(pi, host, options) {
  let socket;
  let client;
  const seen = new Set();
  async function post(channel, text) {
    for (const part of chunks(text, 3500)) await client.chat.postMessage({ channel, text: part, unfurl_links: false, unfurl_media: false });
  }
  sendTool(pi, 'slack', options.allowUsers, async (user, text) => {
    const conversation = await client.conversations.open({ users: user });
    await post(conversation.channel.id, text);
  }, host);
  lifecycle(pi, host, 'slack', async () => {
    client = new WebClient(await secret(options.tokenEnv));
    socket = new SocketModeClient({ appToken: await secret(options.appTokenEnv) });
    socket.on('message', async ({ event, ack }) => {
      await ack();
      if (event.channel_type !== 'im' || event.bot_id || event.subtype || !event.text || !allowed(options.allowUsers, event.user)) return;
      const id = `${event.channel}:${event.ts}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 1000) seen.delete(seen.values().next().value);
      await reply(host, 'Slack', event.text, text => post(event.channel, text), `slack:${event.channel}`);
    });
    socket.on('error', error => log.warn('channel.connection_failed', { extension: 'slack', error }));
    await socket.start();
  }, async () => socket?.disconnect());
}
