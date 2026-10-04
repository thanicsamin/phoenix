import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
import { Type } from 'typebox';

export default function system(pi: ExtensionAPI, host: Host, _options: ExtensionOptions<'system'>, chatId = 'main') {
  host.extensions.system = 'ready';
  for (const restore of [false, true]) pi.registerTool({
    name: restore ? 'rollback_ui' : 'reload_ui', label: restore ? 'Restore interface' : 'Refresh interface',
    description: restore ? 'Restore a previous Nix UI generation and its editable web source. Omit generation for the previous version. Chats and the agent process keep running.' : 'Validate and publish edits in workspace/phoenix/web as a small Nix UI generation, without restarting the agent or signing the owner out. Use browser navigate to the returned URL to inspect the live interface; the browser signs into the local Phoenix UI automatically. Use browser resize and screenshot to check desktop/mobile. Use rollback_ui to undo an experiment. Only change the UI when the owner asks.',
    parameters: Type.Object({ generation: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, { generation }) {
      const history = restore ? await host.ui.switch(generation) : await host.ui.apply(); host.changed();
      return { content: [{ type: 'text', text: `Interface ${restore ? 'restored' : 'published'}. Preview: http://localhost:${host.port}/. Refresh the page; chats keep running.` }], details: history };
    },
  });
  pi.registerTool({
    name: 'reload_agent', label: 'Reload agent',
    description: 'Check syntax, create an immutable Nix generation of the edited source and dependencies, then reload Phoenix. The editable source is in workspace/phoenix. Prior generations can be restored with rollback_agent. Nix tools use a separate persistent profile from workspace/nix/flake.nix. Only apply changes the owner requested, after checking them.',
    parameters: Type.Object({}),
    async execute() {
      if ([...host.loaded.values()].some(chat => chat.pending && chat.chatId !== chatId)) throw new Error('Wait for other chats to finish before reloading.');
      const history = await host.generations.apply(); host.requestRestart();
      return { content: [{ type: 'text', text: 'Generation created. Phoenix is reloading; sign in after the reload.' }], details: history };
    },
  });
  pi.registerTool({
    name: 'rollback_agent', label: 'Roll back agent',
    description: 'Restore a previous Nix agent generation when the owner requests a rollback. Omit generation to choose the previous version. Restores its editable source; keeps memory, chats, credentials and the separate tools profile.',
    parameters: Type.Object({ generation: Type.Optional(Type.Integer({ minimum: 1 })) }),
    async execute(_id, { generation }) {
      if ([...host.loaded.values()].some(chat => chat.pending && chat.chatId !== chatId)) throw new Error('Wait for other chats to finish before rolling back.');
      const history = await host.generations.switch(generation); host.requestRestart();
      return { content: [{ type: 'text', text: 'Generation restored. Phoenix is reloading.' }], details: history };
    },
  });
}
