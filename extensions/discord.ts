import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { secret } from '../src/config.ts';
import { lifecycle } from '../src/host.ts';
import { allowed, chunks, sendTool, reply } from './channel.ts';
import { log } from '../src/log.ts';

export default function discord(pi: ExtensionAPI, host: Host, options: ExtensionOptions<'discord'>) {
  let client: Client;
  async function send(user: string, text: string) {
    const recipient = await client.users.fetch(user);
    for (const part of chunks(text, 1900)) await recipient.send({ content: part, allowedMentions: { parse: [] } });
  }
  sendTool(pi, 'discord', options.allowUsers, send, host);
  lifecycle(pi, host, 'discord', async () => {
    client = new Client({ intents: [GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });
    client.on('messageCreate', async message => {
      if (message.guildId || message.author.bot || !message.content || !allowed(options.allowUsers, message.author.id)) return;
      await reply(host, 'Discord', message.content, text => send(message.author.id, text), `discord:${message.author.id}`);
    });
    client.on('error', error => log.warn('channel.connection_failed', { extension: 'discord', error }));
    await client.login(await secret(options.tokenEnv));
  }, async () => client?.destroy());
}
