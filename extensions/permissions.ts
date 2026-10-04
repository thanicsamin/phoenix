import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import type { ExtensionOptions } from '../src/types.ts';
export default function permissions(pi: ExtensionAPI, host: Host, _options: ExtensionOptions<'permissions'>, chatId = 'main') {
  host.extensions.permissions = 'ready';
  pi.on('tool_call', async event => {
    const chat = await host.getChat(chatId);
    const ownUI = [`http://localhost:${host.port}`, `http://127.0.0.1:${host.port}`].some(origin => {
      try { return new URL(host.browserPages?.get(chatId)?.() ?? 'about:blank').origin === origin; } catch { return false; }
    });
    const externalWrite = /_send$/.test(event.toolName)
      || (event.toolName === 'browser' && !ownUI && ['click', 'fill', 'press'].includes(String(event.input.action)));
    if (externalWrite && event.toolName === 'browser' && await host.browserControls?.get(chatId)?.verificationAllowed?.()) return;
    const emailTriggered = chat.source === 'Incoming email';
    const safeEmailRead = event.toolName === 'email_read'
      || (event.toolName === 'browser' && ['navigate', 'snapshot', 'screenshot', 'resize', 'wait'].includes(String(event.input.action)));
    if (!externalWrite && (!emailTriggered || safeEmailRead)) return;
    const approved = await host.requestApproval(chatId, event.toolName, event.input);
    if (!approved) return { block: true, reason: 'The owner did not approve this action. Keep the work as a draft and report it in chat.' };
  });
}
