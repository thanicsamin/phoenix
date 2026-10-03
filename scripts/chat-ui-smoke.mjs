import assert from 'node:assert/strict';
import { chromium } from 'patchright-core';

const base = process.env.PHOENIX_TEST_URL || 'http://127.0.0.1:8085';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/bin/chromium', headless: true, chromiumSandbox: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
try {
  await page.goto(base); await page.locator('#password').fill(process.env.PHOENIX_TEST_PASSWORD || 'phoenix-preview-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await page.locator('#app').waitFor({ state: 'visible' });
  const { csrf } = await (await page.request.get(base + '/api/session')).json();
  const headers = { Origin: base, 'X-CSRF-Token': csrf };
  const chat = await (await page.request.post(base + '/api/new', { headers, data: { title: 'Archive UI QA' } })).json();
  await page.locator('#chat-list').getByRole('button', { name: 'Archive UI QA', exact: true }).click();
  await page.locator('#message').fill('Unsent draft survives archiving.');
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await page.locator('#chat-list').getByRole('button', { name: 'Archive UI QA', exact: true }).click();
  assert.equal(await page.locator('#message').inputValue(), 'Unsent draft survives archiving.');
  await page.getByRole('button', { name: 'Restore chat', exact: true }).click();
  await page.getByRole('button', { name: 'Archive chat', exact: true }).waitFor({ state: 'visible' });
  assert.equal((await (await page.request.get(`${base}/api/state?chat=${chat.id}`)).json()).archived, false);
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#message').inputValue(), 'Unsent draft survives archiving.');
  await page.getByRole('button', { name: 'Archive chat', exact: true }).click();
  console.log('Chat UI passed: archive, find archived chat, restore, preserve draft through archive/reload, and return to Main chat. QA chat left archived.');
} finally { await browser.close(); }
