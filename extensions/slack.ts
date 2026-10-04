import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import { secret } from '../src/config.ts';
import { lifecycle } from '../src/host.ts';
import { allowed, chunks, sendTool, reply } from './channel.ts';
import { log } from '../src/log.ts';

export default function slack(pi: ExtensionAPI, host: Host, options: ExtensionOptions<'slack'>) {
  let socket: SocketModeClient | undefined;
  let client: WebClient;
  const seen = new Set<string>();
  async function post(channel: string, text: string) {
    for (const part of chunks(text, 3500)) await client.chat.postMessage({ channel, text: part, unfurl_links: false, unfurl_media: false });
  }
  sendTool(pi, 'slack', options.allowUsers, async (user, text) => {
    const conversation = await client.conversations.open({ users: user });
    if (!conversation.channel?.id) throw Error('Slack did not open a conversation.');
    await post(conversation.channel.id, text);
  }, host);
  lifecycle(pi, host, 'slack', async () => {
    client = new WebClient(await secret(options.tokenEnv));
    socket = new SocketModeClient({ appToken: (await secret(options.appTokenEnv))! });
    socket.on('message', async ({ event, ack }) => {
      await ack();
      if (event.channel_type !== 'im' || event.bot_id || event.subtype || !event.text || !allowed(options.allowUsers, event.user)) return;
      const id = `${event.channel}:${event.ts}`;
      if (seen.has(id)) return;
      seen.add(id);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
      await reply(host, 'Slack', event.text, text => post(event.channel, text), `slack:${event.channel}`);
    });
    socket.on('error', error => log.warn('channel.connection_failed', { extension: 'slack', error }));
    await socket.start();
  }, async () => socket?.disconnect());
}
