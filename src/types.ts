import type { Host } from './host.ts';
import type { z } from 'zod';
import type { configSchema, modelSchema } from './config.ts';
import type { ExtensionAPI, ExtensionFactory } from '@earendil-works/pi-coding-agent';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { Job, Thinking, Attachment } from './contracts.ts';
export type * from './contracts.ts';

export type Config = z.infer<typeof configSchema>;
export type ModelSelection = z.infer<typeof modelSchema>;
export type ExtensionOptions<K extends keyof Config['extensions']> = NonNullable<Config['extensions'][K]>;
export type Extension = (pi: ExtensionAPI, host: Host, options: never, chatId: string) => void | Promise<void>;
export type Cleanup = () => void | Promise<void>;
export type NativeExtension = ExtensionFactory;
export interface ChatRecord {
  id: string; title: string; jobs: Job[]; permissions: string[];
  route?: string; model?: ModelSelection; thinking?: Thinking;
  archived?: boolean; pinned?: boolean; lastSentAt?: number; folder?: string; autoTitle?: boolean;
  deleted?: boolean;
  readRisk?: number; autoReview?: boolean;
}
export interface StoredAttachment extends Attachment { role: string; used: boolean }
export interface QueuedMessage {
  id: string; version: number; message: string; source: string; images: ImageContent[]; ownerRequest?: string; steered?: false;
}
export interface SteeringMessage { id?: undefined; version?: undefined; message: string; source: string; steered: true }
