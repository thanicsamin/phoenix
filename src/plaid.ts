import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { secret } from './config.ts';
import { registerSecret } from './log.ts';
import type { ExtensionOptions } from './types.ts';
import type { PlaidStatus, PlaidLink } from './contracts.ts';

const credentialsSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(100), secret: z.string().trim().min(8).max(200),
  environment: z.enum(['sandbox', 'production']),
});
const itemSchema = z.strictObject({ id: z.string(), accessToken: z.string(), name: z.string().max(200), connectedAt: z.iso.datetime() });
const bindingSchema = z.strictObject({ clientId: z.string(), environment: z.enum(['sandbox', 'production']) });
const vaultSchema = z.strictObject({ userId: z.uuid(), credentials: credentialsSchema.optional(), binding: bindingSchema.optional(), items: z.array(itemSchema).max(20) });
const stringValue = z.string().max(1000);
const balanceSchema = z.object({ available: z.number().nullable(), current: z.number().nullable(), limit: z.number().nullable(), iso_currency_code: z.string().nullable(), unofficial_currency_code: z.string().nullable() });
const accountSchema = z.object({ account_id: stringValue, name: stringValue, official_name: stringValue.nullable(), mask: z.string().nullable(), type: stringValue, subtype: stringValue.nullable(), balances: balanceSchema });
const accountsSchema = z.object({ accounts: z.array(accountSchema).max(200) });
const transactionSchema = z.object({ transaction_id: stringValue, account_id: stringValue, date: z.iso.date(), name: stringValue, amount: z.number(), iso_currency_code: z.string().nullable(), unofficial_currency_code: z.string().nullable(), pending: z.boolean(), merchant_name: stringValue.nullable(), personal_finance_category: z.object({ primary: stringValue, detailed: stringValue }).nullable().optional() });
const transactionsSchema = accountsSchema.extend({ total_transactions: z.number().int().nonnegative(), transactions: z.array(transactionSchema).max(100) });
const financeSchema = z.strictObject({
  action: z.enum(['connections', 'accounts', 'balances', 'transactions', 'holdings', 'liabilities']),
  itemId: z.string().max(100).optional(), startDate: z.iso.date().optional(), endDate: z.iso.date().optional(),
  offset: z.number().int().min(0).max(1000000).default(0), count: z.number().int().min(1).max(100).default(100),
});
export type FinanceInput = z.input<typeof financeSchema>;
const fail = (message: string, status = 400) => Object.assign(Error(message), { status });

// Tokens live outside the editable workspace, encrypted on disk. Root access
// can still read the encryption key; this protects files, not a hostile root.
export class Plaid {
  private directory: string;
  private key!: Buffer;
  private vault!: z.infer<typeof vaultSchema>;
  private environmentCredentials?: z.infer<typeof credentialsSchema>;
  private queue: Promise<unknown> = Promise.resolve();
  private links = new Map<string, { itemId?: string; expires: number }>();
  private completed = new Map<string, number>();
  private options: ExtensionOptions<'plaid'>;
  private request: typeof fetch;
  private constructor(options: ExtensionOptions<'plaid'>, dataDir: string, request: typeof fetch) { this.options = options; this.request = request; this.directory = join(dataDir, 'plaid'); }
  static async open(dataDir: string, options: ExtensionOptions<'plaid'>, request = fetch) {
    const service = new Plaid(options, dataDir, request); await service.initialize(); return service;
  }
  private async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 }); await chmod(this.directory, 0o700);
    const keyPath = join(this.directory, 'key');
    try { this.key = await readFile(keyPath); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      this.key = randomBytes(32); await writeFile(keyPath, this.key, { mode: 0o600, flag: 'wx' });
    }
    if (this.key.length !== 32) throw Error('Invalid Plaid storage key. Restore your private data backup.');
    await chmod(keyPath, 0o600);
    try {
      const content = await readFile(join(this.directory, 'vault'));
      if (content.length > 100000 || content.length < 29) throw Error('Invalid Plaid storage.');
      const decipher = createDecipheriv('aes-256-gcm', this.key, content.subarray(0, 12)); decipher.setAuthTag(content.subarray(12, 28));
      this.vault = vaultSchema.parse(JSON.parse(Buffer.concat([decipher.update(content.subarray(28)), decipher.final()]).toString('utf8')));
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw Error('Could not open Plaid storage. Restore the matching vault and key from your private backup.');
      this.vault = { userId: randomUUID(), items: [] }; await this.persist(this.vault);
    }
    const clientId = await secret(this.options.clientIdEnv, false); const apiSecret = await secret(this.options.secretEnv, false);
    if (!!clientId !== !!apiSecret) throw Error('Set both Plaid client ID and secret, or neither.');
    if (clientId && apiSecret) this.environmentCredentials = credentialsSchema.parse({ clientId, secret: apiSecret, environment: this.options.environment });
    const binding = this.vault.binding || this.vault.credentials;
    if (this.environmentCredentials && binding && (this.environmentCredentials.clientId !== binding.clientId || this.environmentCredentials.environment !== binding.environment) && this.vault.items.length) throw Error('Disconnect your banks before changing Plaid client or environment.');
    registerSecret(this.vault.credentials?.secret);
    for (const item of this.vault.items) registerSecret(item.accessToken);
  }
  private credentials() { return this.environmentCredentials || this.vault.credentials; }
  status(): PlaidStatus {
    return { configured: !!this.credentials(), environment: this.credentials()?.environment || this.options.environment,
      clientId: this.credentials()?.clientId, managedByEnvironment: !!this.environmentCredentials, products: this.options.products,
      items: this.vault.items.map(({ id, name, connectedAt }) => ({ id, name, connectedAt })) };
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation); this.queue = result.catch(() => {}); return result; }
  private async persist(vault: z.infer<typeof vaultSchema>) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(vault), 'utf8'), cipher.final()]);
    await writeFile(join(this.directory, 'vault.tmp'), Buffer.concat([iv, cipher.getAuthTag(), encrypted]), { mode: 0o600 });
    await rename(join(this.directory, 'vault.tmp'), join(this.directory, 'vault')); this.vault = vault;
  }
  configure(input: unknown) {
    return this.serial(async () => {
      if (this.environmentCredentials) throw fail('Plaid credentials are managed by the server environment.');
      const parsed = credentialsSchema.safeParse(input);
      if (!parsed.success) throw fail('Enter a Plaid client ID, secret, and environment.');
      const previous = this.vault.binding || this.credentials(); const next = parsed.data;
      if (this.vault.items.length && previous && (previous.clientId !== next.clientId || previous.environment !== next.environment)) throw fail('Disconnect your banks before changing Plaid client or environment.');
      registerSecret(next.secret); await this.persist({ ...this.vault, credentials: next }); this.links.clear(); return this.status();
    });
  }
  private item(id?: string) {
    if (!this.vault.items.length) throw fail('No banks connected. The owner can connect one in Settings → Finances.');
    if (!id && this.vault.items.length > 1) throw fail('Choose an itemId from the connections action. Read one bank per call.');
    const item = id ? this.vault.items.find(item => item.id === id) : this.vault.items[0];
    if (!item) throw fail('Bank connection not found.'); return item;
  }
  private async call<T>(path: string, body: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal): Promise<T> {
    const credentials = this.credentials(); if (!credentials) throw fail('Configure Plaid in Settings → Finances first.');
    let response: Response;
    try {
      response = await this.request(`https://${credentials.environment}.plaid.com${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Plaid-Version': '2020-09-14', 'User-Agent': 'Phoenix/Plaid' },
        body: JSON.stringify({ ...body, client_id: credentials.clientId, secret: credentials.secret }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
      });
    } catch { throw fail('Plaid request was interrupted or timed out. Try again.', 502); }
    // Bound streaming replies before JSON parsing, even with a missing or false
    // Content-Length, so a large history cannot exhaust a small VPS.
    const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
    if (!reader) throw fail('Plaid returned an empty response.', 502);
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
        if (size > 2 * 1024 * 1024) { await reader.cancel(); throw fail('Plaid response was too large. Request a smaller page.', 502); } chunks.push(value); }
    } catch (error) {
      if (error instanceof Error && 'status' in error && error.status === 502) throw error;
      throw fail('Plaid request was interrupted or timed out. Try again.', 502);
    } finally { reader.releaseLock(); }
    let data: unknown;
    try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('Plaid returned an invalid response.', 502); }
    if (!response.ok) {
      const error = z.object({ error_code: z.string().regex(/^[A-Z0-9_]{1,80}$/) }).safeParse(data);
      const code = error.success ? error.data.error_code : 'REQUEST_FAILED';
      throw fail(code === 'ITEM_LOGIN_REQUIRED' ? 'Reconnect this bank in Settings → Finances (ITEM_LOGIN_REQUIRED).' : code === 'PRODUCT_NOT_READY' ? 'Plaid is still preparing this data. Try again later (PRODUCT_NOT_READY).' : `Plaid request failed (${code}).`, 502);
    }
    const parsed = schema.safeParse(data); if (!parsed.success) throw fail('Plaid returned unexpected data.', 502); return parsed.data;
  }
  link(itemId?: string, origin?: string): Promise<PlaidLink> {
    return this.serial(async () => {
      const now = Date.now(); for (const [token, entry] of this.links) if (entry.expires <= now) this.links.delete(token);
      // Cancelled Link dialogs have no Item to disconnect. Keep only the ten
      // newest flows so repeated cancellations cannot lock the owner out.
      if (this.links.size >= 10) this.links.delete(this.links.keys().next().value!);
      if (!itemId && this.vault.items.length >= 20) throw fail('Disconnect a bank before adding another.');
      const body: Record<string, unknown> = { client_name: 'Phoenix', language: 'en', country_codes: this.options.countries, user: { client_user_id: this.vault.userId } };
      if (itemId) body.access_token = this.item(itemId).accessToken; else body.products = this.options.products;
      if (this.options.redirectUri) {
        const redirect = new URL(this.options.redirectUri);
        if (redirect.username || redirect.password || !origin || redirect.origin !== origin || redirect.pathname !== '/' || redirect.search || redirect.hash || (redirect.protocol !== 'https:' && !(this.status().environment === 'sandbox' && redirect.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(redirect.hostname)))) throw fail('Plaid redirectUri must match the Phoenix origin and use its root path. Register it in your Plaid dashboard.');
        body.redirect_uri = redirect.href;
      }
      const result = await this.call('/link/token/create', body, z.object({ link_token: z.string(), expiration: z.iso.datetime() }));
      registerSecret(result.link_token); this.links.set(result.link_token, { itemId, expires: Math.min(Date.parse(result.expiration), now + 4 * 3600000) });
      return { token: result.link_token, expiresAt: result.expiration, ...(itemId ? { itemId } : {}) };
    });
  }
  complete(input: unknown) {
    return this.serial(async () => {
      const parsed = z.strictObject({ token: z.string().max(300), publicToken: z.string().max(300).optional(), name: z.string().trim().min(1).max(200).default('Connected bank') }).safeParse(input);
      if (!parsed.success) throw fail('Invalid bank connection.'); const { token, publicToken, name } = parsed.data;
      for (const [key, expiry] of this.completed) if (expiry <= Date.now()) this.completed.delete(key);
      if (this.completed.has(token)) return this.status();
      const link = this.links.get(token); if (!link || link.expires <= Date.now()) throw fail('This bank connection expired or the server restarted. Connect again.');
      if (!link.itemId) {
        if (this.vault.items.length >= 20) throw fail('Disconnect a bank before adding another.');
        if (!publicToken) throw fail('Plaid did not supply a public token.'); registerSecret(publicToken);
        const result = await this.call('/item/public_token/exchange', { public_token: publicToken }, z.object({ access_token: z.string(), item_id: z.string() })); registerSecret(result.access_token);
        if (this.vault.items.some(item => item.id === result.item_id)) throw fail('This bank is already connected.');
        try { await this.persist({ ...this.vault, binding: { clientId: this.credentials()!.clientId, environment: this.credentials()!.environment }, items: [...this.vault.items, { id: result.item_id, accessToken: result.access_token, name, connectedAt: new Date().toISOString() }] }); }
        catch {
          await this.call('/item/remove', { access_token: result.access_token }, z.object({})).catch(() => {});
          throw fail('Could not save this bank connection. Check disk space before retrying.', 500);
        }
      } else this.item(link.itemId);
      this.links.delete(token); this.completed.set(token, Date.now() + 300000); if (this.completed.size > 100) this.completed.delete(this.completed.keys().next().value!); return this.status();
    });
  }
  disconnect(id: string) {
    return this.serial(async () => { const item = this.item(id); await this.call('/item/remove', { access_token: item.accessToken }, z.object({}));
      await this.persist({ ...this.vault, items: this.vault.items.filter(item => item.id !== id) });
      for (const [token, link] of this.links) if (link.itemId === id) this.links.delete(token); return this.status(); });
  }
  async read(input: FinanceInput, signal?: AbortSignal) {
    const parsed = financeSchema.safeParse(input); if (!parsed.success) throw fail('Invalid finance request. Use valid dates and a page of 1–100 transactions.');
    const { action, itemId, count, offset } = parsed.data;
    if (action === 'connections') { const { configured, environment, products, items } = this.status(); return { configured, environment, products, items }; }
    const item = this.item(itemId); const body: Record<string, unknown> = { access_token: item.accessToken };
    let result: unknown;
    if (action === 'accounts' || action === 'balances') result = await this.call(action === 'accounts' ? '/accounts/get' : '/accounts/balance/get', body, accountsSchema, signal);
    else if (action === 'transactions') {
      if (!this.options.products.includes('transactions')) throw fail('Transactions are not enabled in this setup.');
      const endDate = parsed.data.endDate || new Date().toISOString().slice(0, 10);
      const startDate = parsed.data.startDate || new Date(Date.parse(endDate) - 30 * 86400000).toISOString().slice(0, 10);
      if (startDate > endDate || Date.parse(endDate) - Date.parse(startDate) > 366 * 86400000 || endDate > new Date().toISOString().slice(0, 10)) throw fail('Choose a date range of up to one year, ending today or earlier.');
      const data = await this.call('/transactions/get', { ...body, start_date: startDate, end_date: endDate, options: { count, offset } }, transactionsSchema, signal);
      const nextOffset = offset + data.transactions.length;
      result = { ...data, startDate, endDate, nextOffset, hasMore: nextOffset < data.total_transactions, amountConvention: 'Positive amounts are money spent; negative amounts are money received. Preserve currency codes. Pending transactions may change.' };
    } else {
      const product = action === 'holdings' ? 'investments' : 'liabilities';
      if (!this.options.products.includes(product)) throw fail(`${product} is not enabled. Disconnect and relink with this product in the declarative setup if needed.`);
      // Select only financial fields: never forward raw Item metadata, tokens,
      // full account numbers, or routing numbers to the model.
      if (action === 'holdings') result = await this.call('/investments/holdings/get', body, accountsSchema.extend({
        holdings: z.array(z.object({ account_id: stringValue, security_id: stringValue, quantity: z.number(), institution_price: z.number(), institution_value: z.number(), cost_basis: z.number().nullable(), iso_currency_code: z.string().nullable() })).max(2000),
        securities: z.array(z.object({ security_id: stringValue, name: stringValue.nullable(), ticker_symbol: stringValue.nullable(), type: stringValue.nullable(), close_price: z.number().nullable(), iso_currency_code: z.string().nullable() })).max(2000),
      }), signal);
      else result = await this.call('/liabilities/get', body, accountsSchema.extend({ liabilities: z.object({
        credit: z.array(z.object({ account_id: stringValue, last_payment_amount: z.number().nullable(), last_statement_balance: z.number().nullable(), minimum_payment_amount: z.number().nullable(), next_payment_due_date: z.string().nullable(), aprs: z.array(z.object({ apr_percentage: z.number(), apr_type: stringValue, balance_subject_to_apr: z.number().nullable(), interest_charge_amount: z.number().nullable() })).max(20).optional() })).nullable(),
        mortgage: z.array(z.object({ account_id: stringValue, current_late_fee: z.number().nullable(), last_payment_amount: z.number().nullable(), next_monthly_payment: z.number().nullable(), next_payment_due_date: z.string().nullable(), origination_date: z.string().nullable(), origination_principal_amount: z.number().nullable(), interest_rate: z.object({ percentage: z.number().nullable(), type: stringValue.nullable() }).optional() })).nullable(),
        student: z.array(z.object({ account_id: stringValue, last_payment_amount: z.number().nullable(), minimum_payment_amount: z.number().nullable(), next_payment_due_date: z.string().nullable(), outstanding_interest_amount: z.number().nullable(), interest_rate_percentage: z.number().nullable().optional() })).nullable(),
      }) }), signal);
    }
    return { bank: item.name, itemId: item.id, fetchedAt: new Date().toISOString(), data: result };
  }
}
