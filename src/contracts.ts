// Wire contracts contain no SDK or server imports. Browser builds stay small.
export type Thinking = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface Job {
  id: string; name: string; prompt: string; everyMinutes: number; enabled: boolean;
  nextRunAt?: string | null; running?: boolean; lastError: string; lastRunAt?: string;
}
export interface Attachment { id: string; chatId: string; name: string; size: number; mime: string }
export interface DisplayMessage {
  role: string; text: string; attachments?: Attachment[]; queued?: boolean;
  steered?: boolean; queueId?: string; version?: number;
}
export interface Notice { id: string; type: 'reply' | 'error' }
export interface ChatSummary {
  id: string; title: string; archived: boolean; pinned: boolean;
  jobs: number; busy: boolean; notice?: Notice; approval: string | false;
}
export interface GenerationHistory { available: boolean; generations: { id: number; date: string; current: boolean }[] }
export interface WorkspaceFile { path: string; size: number; editable: boolean; text?: string }
export interface WorkspaceEntry { name: string; path: string; directory: boolean; size: number }
export interface BrowserState { available: boolean; controlled: boolean; connected: boolean }
export type BrowserInput = { type: 'click'; x: number; y: number } | { type: 'scroll'; y: number } | { type: 'text'; text: string } | { type: 'key'; key: string } | { type: 'navigate'; url: string } | { type: 'back' | 'reload' };
export interface ChatSnapshot {
  revision: number; name: string; model: { provider: string; id: string };
  thinking: Thinking; thinkingLevels: Thinking[]; configured: boolean;
  extensions: Record<string, string>; busy: boolean; steerable: boolean;
  current: string; tool: string; error: string; messages: DisplayMessage[];
}
export interface ChatState extends ChatSnapshot {
  chatId: string; title: string; archived: boolean; pinned: boolean; uiVersion?: string;
  browser?: BrowserState; internet?: { available: boolean; enabled: boolean; paired: boolean; connected: boolean };
  models: { provider: string; id: string; name: string }[]; chats: ChatSummary[]; jobs: Job[];
  approvals: { id: string; tool: string; args: unknown }[];
}
