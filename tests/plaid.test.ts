import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { Plaid } from '../src/plaid.ts';
import { configSchema } from '../src/config.ts';
import extension from '../extensions/plaid.ts';
import { createAuth } from '../extensions/auth.ts';
import { createWebServer } from '../extensions/web.ts';

const options = configSchema.parse({ model: { provider: 'opencode-go', id: 'space-bunny-free' }, extensions: {} }).extensions.plaid;
const credentials = { clientId: 'test-client', secret: 'private-test-secret', environment: 'sandbox' };
const account = { account_id: 'account1', name: 'Checking', official_name: null, mask: '1234', type: 'depository', subtype: 'checking', balances: { available: 50, current: 75, limit: null, iso_currency_code: 'USD', unofficial_currency_code: null }, account_number: 'NEVER_RETURN_THIS', routing_number: 'NEVER_RETURN_ROUTING' };
async function fixture(t, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'phoenix-plaid-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const calls = []; let failure; let sequence = 0; let cancelCount = 0;
  const request = async (url, init) => {
    const body = JSON.parse(init.body); const path = new URL(url).pathname; calls.push({ url, path, body, headers: init.headers });
    assert.ok(init.signal instanceof AbortSignal); assert.equal(init.headers['Plaid-Version'], '2020-09-14');
    if (failure) { const result = failure(path); if (result) return result; }
    let result;
    if (path === '/link/token/create') result = { link_token: `link-${++sequence}`, expiration: new Date(Date.now() + 3600000).toISOString() };
    else if (path === '/item/public_token/exchange') result = { access_token: `access-private-${sequence}`, item_id: `item-${sequence}` };
    else if (path === '/accounts/get' || path === '/accounts/balance/get') result = { accounts: [account], item: { access_token: 'NEVER_RETURN_TOKEN' } };
    else if (path === '/transactions/get') result = { accounts: [account], total_transactions: 102, transactions: [{ transaction_id: `transaction-${body.options.offset}`, account_id: 'account1', date: '2026-10-01', name: 'Grocery', amount: 12.5, iso_currency_code: 'USD', unofficial_currency_code: null, pending: false, merchant_name: 'Shop', personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_GROCERIES' }, location: { address: 'NEVER_RETURN_ADDRESS' } }] };
    else if (path === '/investments/holdings/get') result = { accounts: [account], holdings: [{ account_id: 'account1', security_id: 'security1', quantity: 3, institution_price: 10, institution_value: 30, cost_basis: null, iso_currency_code: 'USD' }], securities: [{ security_id: 'security1', name: 'Test fund', ticker_symbol: 'TEST', type: 'etf', close_price: 10, iso_currency_code: 'USD' }], item: { secret: 'NEVER_RETURN_ITEM' } };
    else if (path === '/liabilities/get') result = { accounts: [account], liabilities: { credit: [{ account_id: 'account1', last_payment_amount: 50, last_statement_balance: 75, minimum_payment_amount: 20, next_payment_due_date: '2026-10-15', account_number: 'NEVER_RETURN_LIABILITY', aprs: [{ apr_percentage: 15, apr_type: 'purchase_apr', balance_subject_to_apr: 75, interest_charge_amount: 1 }] }], mortgage: null, student: null } };
    else if (path === '/item/remove') result = {};
    else throw Error(`Unexpected endpoint: ${path}`);
    return Response.json(result);
  };
  const plaid = await Plaid.open(directory, { ...options, ...extra }, request);
  const connect = async (name = 'My bank') => { const link = await plaid.link(); await plaid.complete({ token: link.token, publicToken: 'public-private', name }); return plaid.status().items.at(-1); };
  return { directory, plaid, calls, request, connect, setFailure: value => { failure = value; }, oversized: () => new Response(new ReadableStream({ start(controller) { for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelCount++; } })), cancelled: () => cancelCount };
}

test('Plaid credentials and tokens persist encrypted, private and outside setup; API replies omit secrets', async t => {
  const f = await fixture(t); assert.equal(f.plaid.status().configured, false);
  await assert.rejects(f.plaid.link(), /Configure Plaid/);
  await f.plaid.configure(credentials); const item = await f.connect('<script>My bank</script>');
  const vault = await readFile(join(f.directory, 'plaid/vault'));
  for (const value of ['private-test-secret', 'access-private', 'test-client', 'My bank']) assert.equal(vault.includes(Buffer.from(value)), false);
  assert.equal((await stat(join(f.directory, 'plaid/key'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.directory, 'plaid/vault'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(f.directory, 'plaid'))).mode & 0o777, 0o700);
  const reopened = await Plaid.open(f.directory, options, f.request); assert.deepEqual(reopened.status(), f.plaid.status());
  assert.ok(!JSON.stringify(reopened.status()).includes('private')); assert.equal(reopened.status().clientId, credentials.clientId);
  const reply = await reopened.read({ action: 'accounts', itemId: item.id });
  assert.equal(reply.data.accounts[0].mask, '1234'); assert.ok(!JSON.stringify(reply).includes('NEVER_RETURN'));
  assert.deepEqual((await reopened.read({ action: 'connections' })).items, reopened.status().items);
  assert.ok(!('clientId' in await reopened.read({ action: 'connections' })));
  assert.ok(f.calls.every(call => call.url.startsWith('https://sandbox.plaid.com/') && call.body.secret === credentials.secret));
  assert.ok(!JSON.stringify(configSchema.parse({ model: { provider: 'opencode-go', id: 'space-bunny-free' }, extensions: {} })).includes(credentials.secret));
});

test('bank reconnect uses update mode without another token exchange; repeated completion is idempotent', async t => {
  const f = await fixture(t); await f.plaid.configure(credentials); const item = await f.connect();
  const link = await f.plaid.link(item.id); const request = f.calls.at(-1);
  assert.equal(request.body.access_token, 'access-private-1'); assert.ok(!('products' in request.body));
  await f.plaid.complete({ token: link.token }); await f.plaid.complete({ token: link.token });
  assert.equal(f.plaid.status().items.length, 1); assert.equal(f.calls.filter(call => call.path === '/item/public_token/exchange').length, 1);
  await assert.rejects(f.plaid.complete({ token: 'invented-link', publicToken: 'public-private' }), /expired/);
  await assert.rejects(f.plaid.configure({ ...credentials, environment: 'production' }), /Disconnect/);
  await assert.rejects(f.plaid.configure({ ...credentials, clientId: 'another-client' }), /Disconnect/);
  await f.plaid.configure({ ...credentials, secret: 'rotated-secret' }); assert.equal(f.plaid.status().items.length, 1);
});

test('transaction dates and pagination are bounded; currency and pending state survive; products are explicit', async t => {
  const f = await fixture(t); await f.plaid.configure(credentials); await f.connect();
  const reply = await f.plaid.read({ action: 'transactions', startDate: '2026-09-01', endDate: '2026-10-01', count: 1, offset: 100 });
  assert.equal(reply.data.nextOffset, 101); assert.equal(reply.data.hasMore, true);
  assert.equal(reply.data.transactions[0].iso_currency_code, 'USD'); assert.equal(reply.data.transactions[0].pending, false);
  assert.match(reply.data.amountConvention, /Positive amounts/); assert.ok(!JSON.stringify(reply).includes('NEVER_RETURN'));
  assert.deepEqual(f.calls.at(-1).body.options, { count: 1, offset: 100 });
  for (const input of [{ count: 101 }, { offset: -1 }, { startDate: 'not-a-date' }, { startDate: '2026-10-02', endDate: '2026-10-01' }, { startDate: '2020-01-01', endDate: '2026-10-01' }, { endDate: '2099-01-01' }]) await assert.rejects(f.plaid.read({ action: 'transactions', ...input }), /Invalid|Choose/);
  await assert.rejects(f.plaid.read({ action: 'holdings' }), /not enabled/);
  await assert.rejects(f.plaid.read({ action: 'liabilities' }), /not enabled/);
  await f.connect('Second bank'); await assert.rejects(f.plaid.read({ action: 'balances' }), /Choose an itemId/);
});

test('failed disconnection retains its token for retry; reconnect and unfinished data errors are actionable and redacted', async t => {
  const f = await fixture(t); await f.plaid.configure(credentials); const item = await f.connect();
  f.setFailure(() => Response.json({ error_code: 'ITEM_LOGIN_REQUIRED', error_message: 'access-private-1 private-test-secret' }, { status: 400 }));
  await assert.rejects(f.plaid.read({ action: 'accounts' }), error => /Reconnect/.test(error.message) && !/private/.test(error.message));
  await assert.rejects(f.plaid.disconnect(item.id), /Reconnect/); assert.equal(f.plaid.status().items.length, 1);
  f.setFailure(() => Response.json({ error_code: 'PRODUCT_NOT_READY' }, { status: 400 })); await assert.rejects(f.plaid.read({ action: 'transactions' }), /preparing/);
  f.setFailure(() => f.oversized()); await assert.rejects(f.plaid.read({ action: 'accounts' }), /too large/); assert.equal(f.cancelled(), 1);
  f.setFailure(undefined); await f.plaid.disconnect(item.id); assert.equal(f.plaid.status().items.length, 0);
  const reopened = await Plaid.open(f.directory, options, f.request); assert.equal(reopened.status().items.length, 0);
});

test('environment credentials bind banks to the right Plaid client and API; redirects must match Phoenix', async t => {
  const original = { client: process.env.PLAID_TEST_CLIENT, secret: process.env.PLAID_TEST_SECRET };
  t.after(() => { for (const [key, value] of [['PLAID_TEST_CLIENT', original.client], ['PLAID_TEST_SECRET', original.secret]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  process.env.PLAID_TEST_CLIENT = 'environment-client'; process.env.PLAID_TEST_SECRET = 'environment-secret';
  const opts = { clientIdEnv: 'PLAID_TEST_CLIENT', secretEnv: 'PLAID_TEST_SECRET', environment: 'production', redirectUri: 'https://phoenix.example/' };
  const f = await fixture(t, opts); assert.equal(f.plaid.status().managedByEnvironment, true);
  await assert.rejects(f.plaid.configure(credentials), /environment/);
  await assert.rejects(f.plaid.link(undefined, 'https://evil.example'), /match the Phoenix/);
  const link = await f.plaid.link(undefined, 'https://phoenix.example'); assert.equal(f.calls.at(-1).body.redirect_uri, 'https://phoenix.example/');
  assert.match(f.calls.at(-1).url, /^https:\/\/production.plaid.com/);
  await f.plaid.complete({ token: link.token, publicToken: 'public-private' });
  process.env.PLAID_TEST_CLIENT = 'wrong-client'; await assert.rejects(Plaid.open(f.directory, { ...options, ...opts }, f.request), /Disconnect/);
  delete process.env.PLAID_TEST_SECRET; await assert.rejects(Plaid.open(f.directory, { ...options, ...opts }, f.request), /both/);
});

test('finance tool fails closed in external/channel chats and accepts owner chats and scheduled tasks', async t => {
  const f = await fixture(t); const record = {}; const chat = { source: 'web' }; let tool;
  const host = { plaid: f.plaid, dataDir: f.directory, extensions: {}, loaded: new Map([['main', chat]]), record: () => record };
  await extension({ registerTool: value => { tool = value; } }, host, options, 'main');
  assert.equal((await tool.execute('id', { action: 'connections' })).details.constructor, Object);
  chat.source = 'Incoming email'; await assert.rejects(tool.execute('id', { action: 'connections' }), /owner/);
  chat.source = 'Scheduled task: Budget'; await tool.execute('id', { action: 'connections' });
  record.route = 'email:test'; await assert.rejects(tool.execute('id', { action: 'connections' }), /owner/);
  delete record.route; host.loaded.clear(); await assert.rejects(tool.execute('id', { action: 'connections' }), /owner/);
});

test('Plaid HTTP endpoints require owner login, origin and CSRF; preview sessions cannot access keys or Link', async t => {
  const f = await fixture(t); const host = { plaid: f.plaid, auth: await createAuth(f.directory, { password: 'plaid-test-password' }), changed() {} };
  const server = createWebServer(host); server.listen(0, '127.0.0.1'); await once(server, 'listening'); host.port = server.address().port;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${host.port}`;
  const post = (path, body, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body) });
  assert.equal((await fetch(base + '/api/plaid/status')).status, 401);
  const login = await post('/api/login', { password: 'plaid-test-password' }); const cookie = login.headers.get('set-cookie').split(';')[0]; const { csrf } = await login.json(); const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
  const preview = host.auth.preview();
  assert.equal((await fetch(base + '/api/plaid/status', { headers: { Cookie: `phoenix=${preview.token}` } })).status, 403);
  for (const path of ['configure', 'link', 'complete', 'disconnect']) assert.equal((await post('/api/plaid/' + path, {}, { Cookie: `phoenix=${preview.token}`, 'X-CSRF-Token': preview.csrf })).status, 403);
  assert.equal((await post('/api/plaid/configure', credentials, { Cookie: cookie })).status, 403);
  assert.equal((await post('/api/plaid/configure', credentials, { ...headers, Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/plaid/configure', credentials, headers)).status, 200);
  const link = await (await post('/api/plaid/link', {}, headers)).json();
  const completed = await post('/api/plaid/complete', { token: link.token, publicToken: 'public-private' }, headers); assert.equal(completed.status, 200);
  const status = await (await fetch(base + '/api/plaid/status', { headers: { Cookie: cookie } })).json(); assert.equal(status.items.length, 1); assert.ok(!JSON.stringify(status).includes('private'));
  const home = await fetch(base); const csp = home.headers.get('Content-Security-Policy'); const html = await home.text();
  assert.match(csp, /script-src[^;]*'nonce-/); assert.match(csp, /frame-src https:\/\/cdn.plaid.com/); assert.match(html, /name="plaid-nonce"/); assert.ok(!csp.match(/script-src[^;]*'unsafe-inline'/));
  assert.equal((await post('/api/plaid/disconnect', { itemId: status.items[0].id }, headers)).status, 200);
});


test('explicit investment and liability products return financial data without full account numbers or Item metadata', async t => {
  const f = await fixture(t, { products: ['transactions', 'investments', 'liabilities'] }); await f.plaid.configure(credentials); await f.connect();
  assert.deepEqual(f.calls.find(call => call.path === '/link/token/create').body.products, ['transactions', 'investments', 'liabilities']);
  const holdings = await f.plaid.read({ action: 'holdings' }); assert.equal(holdings.data.holdings[0].quantity, 3); assert.equal(holdings.data.securities[0].ticker_symbol, 'TEST');
  const liabilities = await f.plaid.read({ action: 'liabilities' }); assert.equal(liabilities.data.liabilities.credit[0].minimum_payment_amount, 20); assert.equal(liabilities.data.liabilities.credit[0].aprs[0].apr_percentage, 15);
  assert.ok(!JSON.stringify([holdings, liabilities]).includes('NEVER_RETURN'));
});


test('cancelled Link dialogs do not prevent later connections; pending state stays bounded', async t => {
  const f = await fixture(t); await f.plaid.configure(credentials); const oldest = await f.plaid.link(); let newest;
  for (let i = 0; i < 12; i++) newest = await f.plaid.link();
  await assert.rejects(f.plaid.complete({ token: oldest.token, publicToken: 'public-private' }), /expired/);
  await f.plaid.complete({ token: newest.token, publicToken: 'public-private' }); assert.equal(f.plaid.status().items.length, 1);
  const bad = await fixture(t, { redirectUri: 'https://name:password@phoenix.example/' }); await bad.plaid.configure(credentials);
  await assert.rejects(bad.plaid.link(undefined, 'https://phoenix.example'), /match the Phoenix/);
});

test('overlapping bank sign-ins cannot exceed the persisted connection limit', async t => {
  const f = await fixture(t); await f.plaid.configure(credentials);
  for (let i = 0; i < 19; i++) await f.connect();
  const first = await f.plaid.link(); const second = await f.plaid.link();
  let exchanges = 0;
  f.setFailure(path => path === '/item/public_token/exchange' ? Response.json({ item_id: `overlap-${++exchanges}`, access_token: `overlap-private-${exchanges}` }) : undefined);
  await f.plaid.complete({ token: first.token, publicToken: 'public-first' });
  await assert.rejects(f.plaid.complete({ token: second.token, publicToken: 'public-second' }), /Disconnect a bank/);
  assert.equal(exchanges, 1, 'Do not exchange a token that cannot be saved');
  const reopened = await Plaid.open(f.directory, options, f.request);
  assert.equal(reopened.status().items.length, 20);
});

test('interrupted response streams report a safe retryable error', async t => {
  const f = await fixture(t); await f.plaid.configure(credentials); await f.connect();
  f.setFailure(() => new Response(new ReadableStream({ start(controller) { controller.error(Error('access-private-1 transport failed')); } })));
  await assert.rejects(f.plaid.read({ action: 'accounts' }), error => error.status === 502 && /interrupted|timed out/.test(error.message) && !/private/.test(error.message));
});
