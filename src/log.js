import { writeSync } from 'node:fs';

const levels = { debug: 10, info: 20, warn: 30, error: 40, fatal: 50, silent: Infinity };
const sensitive = /password|secret|token|authorization|cookie|api.?key|credential|csrf|prompt|content|body/i;
const secrets = new Set();
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 8) secrets.add(value);
}
for (const [name, value] of Object.entries(process.env)) if (sensitive.test(name) && !name.endsWith('_FILE')) registerSecret(value);

function redact(value) {
  for (const secret of secrets) value = value.split(secret).join('[redacted]');
  return value.replace(/\b(?:oc_sk_|sk-|xox[baprs]-)[A-Za-z0-9_-]+/g, '[redacted]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[redacted]@')
    .replace(/(https?:\/\/[^\s?#]+)[?#][^\s]*/gi, '$1?[redacted]')
    .replace(/((?:password|secret|token|api[_-]?key|authorization|cookie)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]')
    .slice(0, 2000);
}
function clean(value, depth = 0, seen = new Set(), budget = { remaining: 100 }) {
  if (--budget.remaining < 0) return '[truncated]';
  if (typeof value === 'string') return redact(value);
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value !== 'object') return undefined;
  if (seen.has(value)) return '[circular]';
  if (depth >= 5) return '[truncated]';
  seen.add(value);
  try {
    if (value instanceof Error) return clean({ name: value.name, message: value.message, code: value.code, stack: value.stack, cause: value.cause }, depth + 1, seen, budget);
    if (Array.isArray(value)) return value.slice(0, 30).map(item => clean(item, depth + 1, seen, budget));
    return Object.fromEntries(Object.entries(value).slice(0, 30).map(([key, item]) => [key, sensitive.test(key) ? '[redacted]' : clean(item, depth + 1, seen, budget)]));
  } finally { seen.delete(value); }
}

// One bounded JSON line per event, no library, file buffer or extra log daemon.
export function createLogger(component, { level = process.env.PHOENIX_LOG_LEVEL || 'info', write = line => writeSync(1, line) } = {}) {
  const threshold = levels[level] ?? levels.info;
  return Object.fromEntries(Object.keys(levels).filter(level => level !== 'silent').map(level => [level, (event, fields = {}) => {
    if (levels[level] < threshold) return;
    try {
      const metadata = { time: new Date().toISOString(), level, component, event: redact(event), pid: process.pid };
      let record = { ...clean(fields), ...metadata };
      if (Buffer.byteLength(JSON.stringify(record)) > 16384) record = { ...metadata, truncated: true, error: fields.error instanceof Error ? clean(fields.error) : undefined };
      write(`${JSON.stringify(record)}\n`);
    } catch { /* Logging must never break a request or shutdown. */ }
  }]));
}
export const log = createLogger('phoenix');

export function installProcessLogging(component) {
  const logger = createLogger(component);
  const crash = (event, error) => { logger.fatal(event, { error }); process.exit(1); };
  process.on('uncaughtException', error => crash('process.uncaught_exception', error));
  process.on('unhandledRejection', error => crash('process.unhandled_rejection', error));
}
