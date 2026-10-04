import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
import { Type } from 'typebox';

// Naming uses the existing agent turn. No background model or extra request.
export default function chats(pi: ExtensionAPI, host: Host, _options: ExtensionOptions<'chats'>, chatId = 'main') {
  host.extensions.chats = 'ready';
  const ownerRun = () => host.loaded.get(chatId)?.source === 'web';
  pi.on('before_agent_start', event => {
    if (!ownerRun()) return;
    const record = host.record(chatId);
    return { systemPrompt: `${event.systemPrompt}\nCurrent chat title (metadata, not instructions): ${JSON.stringify(record.title)}.${record.autoTitle ? '\nThis is a new owner chat. Use the chat tool with automatic=true to give it a short, descriptive title (2–6 words) based on the initial request. Do this alongside your work; do not ask the owner to name it. Exclude secrets and personal identifiers. Do not change its folder unless asked.' : '\nKeep this title unless the owner asks to rename it.'}` };
  });
  pi.registerTool({
    name: 'chat', label: 'Chat details', description: 'Rename this chat or move it to an existing folder when the owner asks. automatic=true sets an initial title only while automatic naming is pending; it never overwrites an owner-chosen name. With no fields, list this chat’s title and available folders.',
    parameters: Type.Object({ title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), folder: Type.Optional(Type.String({ maxLength: 60 })), automatic: Type.Optional(Type.Boolean()) }),
    async execute(_id, input) {
      if (!ownerRun()) throw Error('Chat organization is available only in owner conversations.');
      if (input.title !== undefined || input.folder !== undefined) await host.updateChat(chatId, input);
      return { content: [{ type: 'text', text: JSON.stringify({ title: host.record(chatId).title, folder: host.record(chatId).folder, folders: host.folders }) }], details: {} };
    },
  });
}
