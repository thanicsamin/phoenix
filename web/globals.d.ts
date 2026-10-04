import type { ChatState, Attachment, WorkspaceFile, WorkspaceEntry, GenerationHistory, ChatSummary, PlaidStatus, PlaidLink } from '../src/contracts.ts';
import type MarkdownIt from 'markdown-it';
import type * as KaTeX from 'katex';
import type { DOMPurify } from 'dompurify';

type APIResult<P extends string> =
  P extends `/api/state${string}` ? ChatState :
  P extends `/api/session${string}` ? { authenticated: boolean; csrf: string } :
  P extends '/api/login' ? { csrf: string } :
  P extends '/api/new' ? { id: string; title: string } :
  P extends `/api/workspace/file${string}` ? WorkspaceFile :
  P extends `/api/workspace?${string}` ? { path: string; entries: WorkspaceEntry[] } :
  P extends '/api/generations' | '/api/ui/generations' ? GenerationHistory :
  P extends '/api/plaid/status' | '/api/plaid/configure' | '/api/plaid/complete' | '/api/plaid/disconnect' ? PlaidStatus :
  P extends '/api/plaid/link' ? PlaidLink :
  P extends '/api/internet/pair' ? { client: string } : Record<string, never>;
type API = <P extends string>(path: P, body?: unknown) => Promise<APIResult<P>>;
interface DraftFile extends Attachment { queued?: boolean }
interface QueueEdit { id: string; version: number; message: string; files: DraftFile[] }
interface NotificationController { read: () => void; reset: () => void; update: (chats: ChatSummary[], activeChat: string) => void }
interface Elements {
  '#login': HTMLElement;
  '#login-form': HTMLFormElement;
  '#password': HTMLInputElement;
  '#login-error': HTMLElement;
  '#app': HTMLElement;
  '#chat-backdrop': HTMLButtonElement;
  '#sidebar': HTMLElement;
  '#new-chat': HTMLButtonElement;
  '#chat-list': HTMLElement;
  '#pin-chat': HTMLButtonElement;
  '#archive-chat': HTMLButtonElement;
  '#archived-chats': HTMLButtonElement;
  '#files': HTMLButtonElement;
  '#settings': HTMLButtonElement;
  '#chat-menu': HTMLButtonElement;
  '#agent-name': HTMLElement;
  '#chat-title': HTMLElement;
  '#connection': HTMLElement;
  '#refresh-ui': HTMLButtonElement;
  '#browser': HTMLButtonElement;
  '#jobs': HTMLButtonElement;
  '#mobile-settings': HTMLButtonElement;
  '#chat-scroll': HTMLElement;
  '#welcome': HTMLElement;
  '#key-banner': HTMLElement;
  '#connect-key': HTMLButtonElement;
  '#messages': HTMLElement;
  '#latest-message': HTMLButtonElement;
  '#approvals': HTMLElement;
  '#agent-error': HTMLElement;
  '#activity': HTMLElement;
  '#composer': HTMLFormElement;
  '#queue-edit': HTMLElement;
  '#cancel-queue-edit': HTMLButtonElement;
  '#message': HTMLTextAreaElement;
  '#draft-files': HTMLElement;
  '#attach': HTMLButtonElement;
  '#attachment-files': HTMLInputElement;
  '#microphone': HTMLButtonElement;
  '#model': HTMLSelectElement;
  '#thinking': HTMLSelectElement;
  '#steer': HTMLButtonElement;
  '#stop': HTMLButtonElement;
  '#send': HTMLButtonElement;
  '#browser-dialog': HTMLDialogElement;
  '#browser-status': HTMLElement;
  '#return-browser': HTMLButtonElement;
  '#close-browser': HTMLButtonElement;
  '#browser-address': HTMLFormElement;
  '#browser-back': HTMLButtonElement;
  '#browser-reload': HTMLButtonElement;
  '#browser-url': HTMLInputElement;
  '#browser-view': HTMLElement;
  '#browser-screen': HTMLCanvasElement;
  '#browser-keyboard': HTMLInputElement;
  '#browser-tab': HTMLButtonElement;
  '#browser-enter': HTMLButtonElement;
  '#browser-reconnect': HTMLButtonElement;
  '#settings-dialog': HTMLDialogElement;
  '#key-form': HTMLFormElement;
  '#close-settings': HTMLButtonElement;
  '#api-key': HTMLInputElement;
  '#provider': HTMLSelectElement;
  '#provider-status': HTMLElement;
  '#server-fields': HTMLFieldSetElement;
  '#server-url': HTMLInputElement;
  '#server-models': HTMLInputElement;
  '#server-context': HTMLInputElement;
  '#server-vision': HTMLInputElement;
  '#server-reasoning': HTMLInputElement;
  '#server-key-hint': HTMLElement;
  '#save-provider': HTMLButtonElement;
  '#settings-model': HTMLElement;
  '#key-error': HTMLElement;
  '#theme': HTMLSelectElement;
  '#notifications': HTMLButtonElement;
  '#notification-status': HTMLElement;
  '#prompt-form': HTMLFormElement;
  '#system-prompt': HTMLTextAreaElement;
  '#prompt-status': HTMLElement;
  '#internet-settings': HTMLDetailsElement;
  '#internet-status': HTMLElement;
  '#internet-toggle': HTMLButtonElement;
  '#internet-forget': HTMLButtonElement;
  '#internet-error': HTMLElement;
  '#extensions': HTMLElement;
  '#import-setup': HTMLButtonElement;
  '#setup-file': HTMLInputElement;
  '#logout': HTMLButtonElement;
  '#files-dialog': HTMLDialogElement;
  '#close-files': HTMLButtonElement;
  '#file-back': HTMLButtonElement;
  '#file-directory': HTMLElement;
  '#new-file': HTMLButtonElement;
  '#new-file-form': HTMLFormElement;
  '#new-file-name': HTMLInputElement;
  '#file-list': HTMLElement;
  '#file-editor': HTMLElement;
  '#file-list-back': HTMLButtonElement;
  '#file-name': HTMLElement;
  '#file-download': HTMLAnchorElement;
  '#file-preview': HTMLButtonElement;
  '#file-text': HTMLTextAreaElement;
  '#file-rendered': HTMLElement;
  '#file-save': HTMLButtonElement;
  '#file-dirty': HTMLElement;
  '#file-empty': HTMLElement;
  '#file-status': HTMLElement;
  '#apply-ui': HTMLButtonElement;
  '#reload-agent': HTMLButtonElement;
  '#ui-generation-list': HTMLElement;
  '#generation-list': HTMLElement;
  '#internet-dialog': HTMLDialogElement;
  '#close-internet': HTMLButtonElement;
  '#internet-download': HTMLButtonElement;
  '#internet-pair-status': HTMLElement;
  '#discard-dialog': HTMLDialogElement;
  '#keep-editing': HTMLButtonElement;
  '#discard-file': HTMLButtonElement;
  '#jobs-dialog': HTMLDialogElement;
  '#close-jobs': HTMLButtonElement;
  '#jobs-chat': HTMLElement;
  '#job-list': HTMLElement;
  '#job-form': HTMLFormElement;
  '#job-name': HTMLInputElement;
  '#job-prompt': HTMLTextAreaElement;
  '#job-start': HTMLInputElement;
  '#job-repeat': HTMLSelectElement;
  '#job-error': HTMLElement;
  '#chat-dialog': HTMLDialogElement;
  '#chat-form': HTMLFormElement;
  '#close-chat': HTMLButtonElement;
  '#chat-name': HTMLInputElement;
  '#chat-error': HTMLElement;
  'meta[name="ui-version"]': HTMLMetaElement | null;
}

declare global {
  interface Window {
    markdownit: typeof MarkdownIt; katex: typeof KaTeX; DOMPurify: DOMPurify;
    renderMarkdown: (text: string) => DocumentFragment | HTMLElement;
    previewPDF: (image: HTMLImageElement, url: string) => void;
    resetPreviews: (clear?: boolean) => void;
    initPlaid: (options: { api: API }) => { refresh: () => Promise<void>; resume: () => Promise<void>; reset: () => void; active: () => boolean };
    Plaid?: { create: (options: { token: string; receivedRedirectUri?: string; onSuccess: (publicToken: string | null, metadata: { institution?: { name?: string } | null }) => void; onExit: (error: { error_code?: string } | null) => void }) => { open: () => void; destroy: () => void } };
    initBrowserControl: (options: { api: API; chat: () => string; csrf: () => string; refresh: () => Promise<void> }) => void;
    openBrowser: (take?: boolean) => void;
    initNotifications: (options: { selectChat: (id: string) => void }) => NotificationController;
    stopDictation?: () => void; stopVoice?: () => void;
    addReadAloud?: (label: HTMLElement, body: HTMLElement) => void;
    SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition;
  }
  const texmath: import('markdown-it').PluginWithOptions<unknown>;
}
export type { API, APIResult, DraftFile, QueueEdit, Elements, NotificationController };
