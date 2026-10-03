import { randomBytes, scrypt as derive, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { secret } from '../src/config.js';
import { registerSecret } from '../src/log.js';
const scrypt = promisify(derive);
const lifetime = 12 * 60 * 60 * 1000;

export async function createAuth(dataDir, { password, now = Date.now, log = console.log } = {}) {
  const path = join(dataDir, 'password.json');
  let record;
  let generated;
  if (!password) {
    try { record = JSON.parse(await readFile(path, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!record) {
    if (password && password.length < 12) throw new Error('PHOENIX_PASSWORD must have at least 12 characters.');
    generated = password ? undefined : randomBytes(24).toString('base64url');
    const salt = randomBytes(32).toString('hex');
    record = { salt, hash: (await scrypt(password || generated, salt, 32)).toString('hex') };
    await writeFile(path, JSON.stringify(record), { mode: 0o600 });
    if (generated) log(`Your Phoenix password (save this): ${generated}`);
  }
  if (!/^[a-f0-9]{64}$/.test(record.hash) || !/^[a-f0-9]{64}$/.test(record.salt)) throw new Error('Invalid password record.');
  registerSecret(password || generated);
  const sessions = new Map();
  const createSession = (preview = false) => {
    for (const [token, session] of sessions) if (session.expires <= now()) sessions.delete(token);
    if (sessions.size >= 16) {
      const victim = [...sessions].find(([, session]) => session.preview)?.[0];
      if (preview && !victim) throw new Error('Too many active sessions.');
      sessions.delete(victim || sessions.keys().next().value);
    }
    const token = randomBytes(32).toString('base64url');
    const session = { csrf: randomBytes(32).toString('base64url'), expires: now() + (preview ? 5 * 60000 : lifetime), preview };
    sessions.set(token, session);
    return { status: 200, token, csrf: session.csrf, expires: session.expires };
  };
  let attempts = 0;
  let windowStart = now();
  return {
    async login(password) {
      if (now() - windowStart > 60000) { attempts = 0; windowStart = now(); }
      if (++attempts > 10) return { status: 429 };
      if (typeof password !== 'string' || password.length > 1024) return { status: 401 };
      const candidate = await scrypt(password, record.salt, 32);
      if (!timingSafeEqual(candidate, Buffer.from(record.hash, 'hex'))) return { status: 401 };
      return createSession();
    },
    // Internal browser access only. No HTTP endpoint exposes this method.
    preview() { return createSession(true); },
    get(token) {
      const session = sessions.get(token);
      if (session?.expires > now()) return session;
      sessions.delete(token);
    },
    logout(token) { sessions.delete(token); },
    close() { sessions.clear(); },
  };
}

export default async function auth(pi, host) {
  host.auth = await createAuth(host.dataDir, { password: await secret('PHOENIX_PASSWORD', false) });
  host.extensions.auth = 'ready';
  host.cleanups.push(() => host.auth.close());
  pi.on('session_shutdown', () => host.auth.close());
}
