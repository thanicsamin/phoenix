import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { registerSecret } from './log.ts';

const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/);
const users = z.array(z.string().min(1)).min(1);
const tlsServer = z.strictObject({ host: z.string().min(1), port: z.number().int().min(1).max(65535) });
export const jobSchema = z.strictObject({
  name: z.string().min(1).max(100), prompt: z.string().min(1).max(16000),
  everyMinutes: z.number().int().min(0).max(525600).default(0),
  nextRunAt: z.iso.datetime().optional(),
});
export const modelSchema = z.strictObject({ provider: z.enum(['opencode', 'opencode-go']), id: z.string().min(1) });
export const thinkingSchema = z.enum(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const publicWebUrl = z.url().refine(value => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
}, 'Use an HTTPS origin without credentials, a path, query, or fragment.');
export const configSchema = z.strictObject({
  name: z.string().min(1).max(60).default('Phoenix'),
  model: modelSchema,
  instructions: z.string().max(32000).default('You are a helpful personal assistant.'),
  workspace: z.strictObject(Object.fromEntries(['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'TOOLS.md', 'nix/flake.nix', 'nix/flake.lock'].map(name => [name, z.string().max(20000).optional()]))).default({}),
  extensions: z.strictObject({
    auth: z.strictObject({}).default({}),
    web: z.strictObject({ port: z.number().int().min(0).max(65535).default(8080), url: publicWebUrl.optional() }).default({ port: 8080 }),
    plaid: z.strictObject({
      clientIdEnv: envName.default('PLAID_CLIENT_ID'), secretEnv: envName.default('PLAID_SECRET'),
      environment: z.enum(['sandbox', 'production']).default('sandbox'),
      countries: z.array(z.enum(['US', 'CA'])).min(1).max(2).default(['US']),
      products: z.array(z.enum(['transactions', 'investments', 'liabilities'])).min(1).max(3).default(['transactions']),
      redirectUri: z.url().optional(),
    }).prefault({}),
    browser: z.strictObject({ headless: z.boolean().optional() }).optional(),
    internet: z.strictObject({}).default({}),
    memory: z.strictObject({}).default({}),
    files: z.strictObject({}).default({}),
    system: z.strictObject({}).default({}),
    scheduler: z.strictObject({}).default({}),
    permissions: z.strictObject({}).default({}),
    tunnel: z.strictObject({ mode: z.enum(['quick', 'named']), url: z.url().optional() }).optional(),
    telegram: z.strictObject({ tokenEnv: envName.default('TELEGRAM_BOT_TOKEN'), allowUsers: users }).optional(),
    slack: z.strictObject({ appTokenEnv: envName.default('SLACK_APP_TOKEN'), tokenEnv: envName.default('SLACK_BOT_TOKEN'), allowUsers: users }).optional(),
    discord: z.strictObject({ tokenEnv: envName.default('DISCORD_BOT_TOKEN'), allowUsers: users }).optional(),
    email: z.strictObject({
      address: z.email(), passwordEnv: envName.default('EMAIL_PASSWORD'), allowSenders: z.array(z.email()).default([]),
      imap: tlsServer, smtp: tlsServer, pollSeconds: z.number().int().min(15).default(60),
    }).optional(),
  }),
  pi: z.strictObject({ extensions: z.array(z.string()).default([]), skills: z.array(z.string()).default([]) }).default({ extensions: [], skills: [] }),
  chats: z.array(z.strictObject({ name: z.string().min(1).max(100), model: modelSchema.optional(), thinking: thinkingSchema.optional(), jobs: z.array(jobSchema).default([]) })).max(100).default([]),
}).superRefine((config, ctx) => {
  if (config.extensions.web.url && config.extensions.tunnel) {
    ctx.addIssue({ code: 'custom', path: ['extensions', 'web', 'url'], message: 'Choose a direct web URL or a tunnel.' });
  }
  if (config.extensions.tunnel?.mode === 'named' && !config.extensions.tunnel.url?.startsWith('https://')) {
    ctx.addIssue({ code: 'custom', path: ['extensions', 'tunnel', 'url'], message: 'A named tunnel requires its public HTTPS URL.' });
  }
});

export async function loadConfig(path: string) {
  return configSchema.parse(JSON.parse(await readFile(path, 'utf8')));
}

// Secrets are values in the environment or files; never part of the shared setup.
export function secret(name: string, required?: true): Promise<string>;
export function secret(name: string, required: false): Promise<string | undefined>;
export async function secret(name: string, required = true) {
  const value = process.env[`${name}_FILE`]
    ? (await readFile(process.env[`${name}_FILE`]!, 'utf8')).trim()
    : process.env[name];
  if (required && !value) throw new Error(`Set ${name} or ${name}_FILE to enable this extension.`);
  registerSecret(value);
  return value;
}
