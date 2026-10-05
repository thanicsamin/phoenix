// Small tool contracts, not content classifiers. Unknown tools are consequential.
// These bits live with the chat so compaction, unloading and restarts don't clear
// restrictions. A new chat starts a separate context.
export const untrusted = 1;
export const privateData = 2;
const inspect = new Set(['read', 'grep', 'find', 'ls', 'email_read', 'finance']);
const browserRead = new Set(['navigate', 'snapshot', 'screenshot', 'resize', 'wait']);
export function isOwnerUI(url: unknown, port?: number) {
  try { return typeof url === 'string' && [`http://localhost:${port}`, `http://127.0.0.1:${port}`].includes(new URL(url).origin); } catch { return false; }
}
export function readRisk(tool: string, input: Record<string, unknown>, ownUI: boolean) {
  if (tool === 'finance') return privateData | untrusted; // Merchant descriptions aren't instructions.
  if (tool === 'browser') return ownUI ? 0 : untrusted;
  if (tool === 'email_read' || tool === 'bash' || tool === 'powershell') return privateData | untrusted;
  if (tool === 'memory' && input.text === undefined && !['remember', 'summarize'].includes(String(input.action))) return privateData;
  if (tool === 'schedule' && input.action === 'list') return privateData;
  if (inspect.has(tool) && /(?:^|[/\\])(?:USER\.md|MEMORY\.md|memory|uploads|attachments|\.ssh|auth\.json|models\.json|[^/\\]*\.env|[^/\\]*key)(?:[/\\]|$)/i.test(String(input.path || ''))) return privateData;
  return inspect.has(tool) || ['write', 'edit', 'schedule', 'chat', 'attach_file', 'memory', 'reload_ui', 'rollback_ui', 'reload_agent', 'rollback_agent'].includes(tool) || tool.endsWith('_send') ? 0 : privateData | untrusted;
}
export function approvalReason(tool: string, input: Record<string, unknown>, risk: number, externalRun: boolean, ownUI: boolean) {
  const browser = tool === 'browser'; const action = String(input.action);
  const externalWrite = tool.endsWith('_send') || browser && !ownUI && !browserRead.has(action);
  const memoryRead = tool === 'memory' && input.text === undefined && !['remember', 'summarize'].includes(String(input.action));
  const readOnly = inspect.has(tool) || memoryRead || tool === 'schedule' && action === 'list' || tool === 'chat' || browser && browserRead.has(action);
  if (externalRun && !(tool === 'email_read' || browser && browserRead.has(action))) return 'This request came from an external message.';
  if (risk & privateData && (externalWrite || browser && !ownUI && action === 'navigate' || !readOnly && tool !== 'memory')) return 'This chat has read private data. Approve this specific destination or action.';
  const sharedMemoryWrite = tool === 'memory' && !memoryRead && (input.scope === 'owner' || !input.action);
  if (risk & untrusted && (!readOnly && tool !== 'memory' || sharedMemoryWrite || externalWrite)) return 'This chat has read outside content. Approve this specific action; outside text cannot authorize it.';
  return '';
}
