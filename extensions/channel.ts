import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import { Type } from 'typebox';
import { privateData } from '../src/policy.ts';
import { log } from '../src/log.ts';

export const chunks = (text: string, size: number) => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
export const allowed = (list: readonly string[], user: unknown) => list.includes(String(user));

export function sendTool(pi: ExtensionAPI, name: string, recipients: string[], send: (recipient: string, text: string) => Promise<unknown>, host?: Host) {
  const parameters = Type.Object({ recipient: Type.String(), text: Type.String({ minLength: 1, maxLength: 32000 }) });
  const tool: ToolDefinition<typeof parameters> = {
    name: `${name}_send`, label: `Send via ${name}`,
    description: `Send a private message via ${name}. Only explicitly allowed owners can receive messages. Requires the user's authorization.`,
    parameters,
    async execute(_id, { recipient, text }, signal) {
      signal?.throwIfAborted();
      if (!allowed(recipients, recipient)) throw new Error('Recipient is not allowed in agent.json.');
      await send(recipient, text);
      return { content: [{ type: 'text', text: 'Message sent.' }], details: {} };
    },
  };
  pi.registerTool(tool);
  host?.sessionExtensions.push(pi => pi.registerTool(tool));
}

export async function reply(host: Host, source: string, text: string, send: (text: string) => Promise<unknown>, route: string) {
  try {
    const chat = await host.routeChat(route, source);
    const answer = await host.submit(text, source, chat.id);
    // Automatic transport replies are outside Pi's tool hooks. Check this sink too.
    if ((host.record(chat.id).readRisk || 0) & privateData) {
      const approved = await host.requestApproval(chat.id, `${source.toLowerCase()}_reply`, { route, text: answer }, undefined, 'This chat has read private data. Approve this specific reply to its external channel.');
      log.info(approved ? 'policy.allowed' : 'policy.denied', { chatId: chat.id, tool: 'channel_reply', rule: 'private-reply' });
      if (!approved) return;
    }
    await send(answer);
  }
  catch { await send('Phoenix could not complete this request. Check the browser interface for details.').catch(() => {}); }
}
