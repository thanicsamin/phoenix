import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { Host } from '../src/host.ts';
import { errorOf } from '../src/errors.ts';
import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { secret } from '../src/config.ts';
import { registerSecret } from '../src/log.ts';
const scrypt = promisify(derive) as (password: string, salt: string, length: number) => Promise<Buffer>;
const lifetime = 12 * 60 * 60 * 1000;

export async function createAuth(dataDir: string, { password, now = Date.now, log = console.log }: { password?: string; now?: () => number; log?: (message: string) => void } = {}) {
  const path = join(dataDir, 'password.json');
  let record: { salt: string; hash: string } | undefined;
  let generated: string | undefined;
  if (!password) {
    try { record = JSON.parse(await readFile(path, 'utf8')); }
    catch (caught) { const error = errorOf(caught); if (error.code !== 'ENOENT') throw error; }
  }
  if (!record) {
    if (password && password.length < 12) throw new Error('PHOENIX_PASSWORD must have at least 12 characters.');
    generated = password ? undefined : randomBytes(24).toString('base64url');
    const salt = randomBytes(32).toString('hex');
    record = { salt, hash: (await scrypt(password || generated!, salt, 32)).toString('hex') };
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    if (generated) log(`Your Phoenix password (save this): ${generated}`);
  }
  if (!/^[a-f0-9]{64}$/.test(record!.hash) || !/^[a-f0-9]{64}$/.test(record!.salt)) throw new Error('Invalid password record.');
  registerSecret(password || generated);
  const sessions = new Map<string, { csrf: string; expires: number; preview: boolean }>();
  const createSession = (preview = false) => {
    for (const [token, session] of sessions) if (session.expires <= now()) sessions.delete(token);
    if (sessions.size >= 16) {
      const victim = [...sessions].find(([, session]) => session.preview)?.[0];
      if (preview && !victim) throw new Error('Too many active sessions.');
      sessions.delete(victim || sessions.keys().next().value!);
    }
    const token = randomBytes(32).toString('base64url');
    const session = { csrf: randomBytes(32).toString('base64url'), expires: now() + (preview ? 5 * 60000 : lifetime), preview };
    sessions.set(token, session);
    return { status: 200 as const, token, csrf: session.csrf, expires: session.expires };
  };
  let attempts = 0;
  let windowStart = now();
  return {
    async login(password: unknown) {
      if (now() - windowStart > 60000) { attempts = 0; windowStart = now(); }
      if (++attempts > 10) return { status: 429 as const };
      if (typeof password !== 'string' || password.length > 1024) return { status: 401 as const };
      const candidate = await scrypt(password, record!.salt, 32);
      if (!timingSafeEqual(candidate, Buffer.from(record!.hash, 'hex'))) return { status: 401 as const };
      return createSession();
    },
    // Internal browser access only. No HTTP endpoint exposes this method.
    preview() { return createSession(true); },
    get(token?: string) {
      const session = token ? sessions.get(token) : undefined;
      if (session && session.expires > now()) return session;
      if (token) sessions.delete(token);
    },
    logout(token?: string) { if (token) sessions.delete(token); },
    close() { sessions.clear(); },
  };
}

export default async function auth(pi: ExtensionAPI, host: Host) {
  host.auth = await createAuth(host.dataDir, { password: await secret('PHOENIX_PASSWORD', false) });
  host.extensions.auth = 'ready';
  host.cleanups.push(() => host.auth.close());
  pi.on('session_shutdown', () => host.auth.close());
}
