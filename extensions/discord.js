import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { secret } from '../src/config.js';
import { lifecycle } from '../src/host.js';
import { allowed, chunks, sendTool, reply } from './channel.js';
import { log } from '../src/log.js';

export default function discord(pi, host, options) {
  let client;
  async function send(user, text) {
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
