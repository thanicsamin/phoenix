import { Type } from 'typebox';

export const chunks = (text, size) => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));
export const allowed = (list, user) => list.includes(String(user));

export function sendTool(pi, name, recipients, send, host) {
  const tool = {
    name: `${name}_send`, label: `Send via ${name}`,
    description: `Send a private message via ${name}. Only explicitly allowed owners can receive messages. Requires the user's authorization.`,
    parameters: Type.Object({ recipient: Type.String(), text: Type.String({ minLength: 1, maxLength: 32000 }) }),
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

export async function reply(host, source, text, send, route) {
  try {
    const chat = await host.routeChat(route, source);
    await send(await host.submit(text, source, chat.id));
  }
  catch { await send('Phoenix could not complete this request. Check the browser interface for details.').catch(() => {}); }
}
