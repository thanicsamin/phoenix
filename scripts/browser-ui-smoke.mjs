/* global document, innerWidth */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'patchright-core';

// Run against a live Phoenix with a configured model. Only fixture credentials
// are typed, and the website listens exclusively on the container's loopback.
const base = process.env.PHOENIX_TEST_URL || 'http://127.0.0.1:8085';
const password = 'ownerOnlyFixture_728195'; let signedIn = false;
const website = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/verify') return response.end(`<h1>Verify you are human</h1><script>let attempts = 0;</script><button id="verify" onclick="if (++attempts === 4) document.body.innerHTML='<h1>Verified</h1>'">Verify</button>`);
  if (request.method === 'POST') {
    let text = ''; for await (const bytes of request) text += bytes;
    signedIn = new URLSearchParams(text).get('password') === password;
    response.writeHead(303, { Location: '/account', 'Set-Cookie': 'qa-session=fixture; Path=/; HttpOnly; SameSite=Strict' }); return response.end();
  }
  if (request.url === '/account') return response.end('<h1>Account ready</h1><p>You are signed in.</p>');
  response.end('<h1>Sign in</h1><form method="post"><label>Password <input type="password" name="password" autofocus autocomplete="current-password"></label><button>Sign in</button></form>');
});
website.listen(18086, '127.0.0.1'); await once(website, 'listening');
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/bin/chromium', headless: true, chromiumSandbox: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } }); const errors = [];
page.on('pageerror', error => errors.push(error.message));
let chatId; let headers;
async function api(path, body) {
  const response = await page.request.fetch(base + path, { headers, ...(body === undefined ? {} : { method: 'POST', data: body }) });
  const result = await response.json(); assert.equal(response.ok(), true, result.error); return result;
}
async function until(read, matches, message) {
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) { const result = await read(); if (matches(result)) return result; await new Promise(resolve => setTimeout(resolve, 200)); }
  assert.fail(message);
}
const state = () => api('/api/state?chat=' + chatId);
try {
  await page.goto(base); await page.getByLabel('Password', { exact: true }).fill(process.env.PHOENIX_TEST_PASSWORD || 'phoenix-preview-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('#app').waitFor({ state: 'visible' });
  const { csrf } = await api('/api/session'); headers = { Origin: base, 'X-CSRF-Token': csrf };
  const chat = (await api('/api/state')).chats.find(item => item.title === 'Browser takeover QA') || await api('/api/new', { title: 'Browser takeover QA' }); chatId = chat.id;
  await page.getByRole('button', { name: 'Browser takeover QA', exact: true }).click();
  const before = await state(); assert.equal(before.model.id, 'space-bunny-free');
  await api('/api/prompt', { chatId, message: 'Use the browser tool to navigate http://127.0.0.1:18086/verify. This is a local CAPTCHA test fixture. Try clicking #verify three times, as the owner policy permits. If still blocked, wait for owner approval. After approval, click #verify once more and report the result. Do not use bash or read fixture source.' });
  await page.getByRole('button', { name: 'Try CAPTCHA', exact: true }).waitFor({ state: 'visible', timeout: 120000 });
  await mkdir('/data/ui-checks', { recursive: true }); await page.screenshot({ path: '/data/ui-checks/captcha-approval.png' });
  await page.getByRole('button', { name: 'Try CAPTCHA', exact: true }).click();
  const completed = await until(state, value => !value.busy, 'Model did not finish the approved CAPTCHA attempt');
  assert.ok(!completed.error, completed.error); assert.match(completed.messages.filter(item => item.role === 'assistant').at(-1).text, /verified|success|complete|passed/i);
  await api('/api/prompt', { chatId, message: 'Navigate http://127.0.0.1:18086/verify with the browser. Try clicking #verify three times, then wait for owner permission if still blocked. I may take control to sign in to another fixture page. After I return control, inspect the current page and report its heading without navigating anywhere. Do not use bash or read fixture source.' });
  await page.getByRole('button', { name: 'Take control', exact: true }).waitFor({ state: 'visible', timeout: 120000 });
  await page.getByRole('button', { name: 'Take control', exact: true }).click();
  await page.getByText('You’re in control', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.locator('#browser-url').fill('http://127.0.0.1:18086/'); await page.locator('#browser-url').press('Enter');
  await page.locator('#browser-keyboard').fill(password); await page.getByRole('button', { name: 'Enter', exact: true }).click();
  await until(async () => signedIn, value => value, 'Direct owner keyboard did not sign in');
  await page.screenshot({ path: '/data/ui-checks/browser-desktop.png' });
  await page.getByRole('button', { name: 'Close browser view', exact: true }).click();
  await until(state, value => value.browser.controlled && !value.browser.connected, 'Disconnect did not hold the model paused');
  for (const width of [320, 390, 620]) {
    await page.setViewportSize({ width, height: 844 });
    await page.getByRole('button', { name: 'Resume browser', exact: true }).click();
    await page.getByText('You’re in control', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    for (const selector of ['#browser-keyboard', '#return-browser', '#browser-url', '#browser-screen']) {
      const bounds = await page.locator(selector).boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1, `${selector} extends past ${width}px`);
    }
    if (width === 390) await page.screenshot({ path: '/data/ui-checks/browser-mobile.png' });
    await page.getByRole('button', { name: 'Close browser view', exact: true }).click();
    await until(state, value => !value.browser.connected, 'Viewer did not disconnect');
  }
  await page.getByRole('button', { name: 'Resume browser', exact: true }).click();
  await page.getByText('You’re in control', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: 'Return to agent', exact: true }).click();
  await until(state, value => !value.browser.controlled && !value.busy && value.messages.some(item => /Account ready/.test(item.text)), 'Handback did not resume the model on the signed-in page');
  assert.ok(!JSON.stringify(await state()).includes(password), 'Fixture password reached the chat history');
  assert.deepEqual(errors, []);
  console.log('Live Pi/UI passed: model waits for consent, approved CAPTCHA interaction, takeover during approval, direct private keyboard login, desktop/mobile 320/390/620px, reconnect, explicit model resumption, no password in chat or UI errors.');
} finally {
  if (chatId) { const current = await state().catch(() => undefined); if (current?.browser.controlled) await api('/api/browser/release', { chatId }).catch(() => {}); }
  await browser.close(); website.closeAllConnections(); await new Promise(resolve => website.close(resolve));
}
