/* global document, innerWidth */
import assert from 'node:assert/strict';
import { chromium } from 'patchright-core';
import { mkdir } from 'node:fs/promises';
const base = process.env.PHOENIX_TEST_URL || 'http://127.0.0.1:8085';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/bin/chromium', headless: true, chromiumSandbox: false });
const page = await browser.newPage(); const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base); await page.locator('#password').fill(process.env.PHOENIX_TEST_PASSWORD || 'phoenix-preview-password'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#app').waitFor({ state: 'visible' }); await page.locator('#model option').first().waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Files', exact: true }).click(); await page.locator('#file-list').getByRole('button', { name: 'AGENTS.md', exact: true }).click();
  await page.locator('#file-text').waitFor({ state: 'visible' }); assert.match(await page.locator('#file-text').inputValue(), /Agent instructions|assistant|instructions/i);
  await page.getByRole('button', { name: 'Preview', exact: true }).click(); await page.locator('#file-rendered').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: 'Close files' }).click();
  // Exercise the actual file-preview UI, including its parser and sanitizer.
  const { csrf } = await (await page.request.get(base + '/api/session')).json();
  const text = '# Heading\n\n**Bold** $x^2$\n\n$$\\frac{1}{2}$$\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n$\\href{javascript:alert(1)}{click}$\n\n|a|b|\n|-|-|\n|1|2|';
  const saved = await page.request.post(base + '/api/workspace/file', { headers: { Origin: base, 'X-CSRF-Token': csrf }, data: { path: 'memory/renderer-check.md', text } }); assert.equal(saved.status(), 200);
  await page.getByRole('button', { name: 'Files', exact: true }).click(); await page.locator('#file-list').getByRole('button', { name: '▸ memory', exact: true }).click();
  await page.locator('#file-list').getByRole('button', { name: 'renderer-check.md', exact: true }).click(); await page.getByRole('button', { name: 'Preview', exact: true }).click();
  const result = await page.evaluate(() => {
    const holder = document.querySelector('#file-rendered');
    return { heading: !!holder.querySelector('h1'), bold: !!holder.querySelector('strong'), math: holder.querySelectorAll('.katex').length, table: !!holder.querySelector('table'), script: !!holder.querySelector('script'), unsafe: !!holder.querySelector('[href^="javascript:"]') };
  });
  assert.equal(result.heading, true); assert.equal(result.bold, true); assert.ok(result.math >= 2); assert.equal(result.table, true); assert.equal(result.script, false); assert.equal(result.unsafe, false);
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  const original = await page.locator('#file-text').inputValue();
  await page.locator('#file-text').fill(original + '\nUnsaved test.');
  assert.equal(await page.locator('#file-save').isEnabled(), true);
  await page.getByRole('button', { name: 'Close files' }).click();
  await page.getByRole('button', { name: 'Keep editing', exact: true }).click();
  assert.equal(await page.locator('#file-text').inputValue(), original + '\nUnsaved test.');
  await page.locator('#file-text').press('Control+s');
  await page.locator('#file-save').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#file-save').disabled && document.querySelector('#file-status').textContent === 'Saved');
  assert.equal((await (await page.request.get(base + '/api/workspace/file?path=memory/renderer-check.md')).json()).text, original + '\nUnsaved test.');
  await page.locator('#file-text').fill(original + '\nDiscard this.');
  await page.locator('#file-text').press('Escape');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await page.locator('#files-dialog').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Diagnostics', exact: true }).click();
  await page.locator('#attachment-files').setInputFiles({ name: 'ui-check.txt', mimeType: 'text/plain', buffer: Buffer.from('Attachment test.') });
  await page.getByLabel('Remove ui-check.txt').waitFor({ state: 'visible' });
  await page.locator('#message').fill('Keep this unsent draft.'); await page.reload();
  await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#message').inputValue(), 'Keep this unsent draft.');
  await page.getByLabel('Remove ui-check.txt').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#chat-title').innerText(), 'Diagnostics');
  // Publishing while a dialog is open defers refresh; closing preserves work.
  const session = await (await page.request.get(base + '/api/session')).json();
  const authHeaders = { Origin: base, 'X-CSRF-Token': session.csrf };
  const baseline = (await (await page.request.get(base + '/api/ui/generations')).json()).generations.find(item => item.current).id;
  const cssFile = await (await page.request.get(base + '/api/workspace/file?path=phoenix/web/style.css')).json();
  const version = await page.locator('meta[name="ui-version"]').getAttribute('content');
  try {
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    assert.equal((await page.request.post(base + '/api/workspace/file', { headers: authHeaders, data: { path: cssFile.path, text: cssFile.text + '\n/* Refresh regression test. */\n' } })).status(), 200);
    assert.equal((await page.request.post(base + '/api/ui/apply', { headers: authHeaders, data: {} })).status(), 200);
    await page.locator('#refresh-ui').waitFor({ state: 'visible' });
    assert.equal(await page.locator('meta[name="ui-version"]').getAttribute('content'), version);
    await Promise.all([page.waitForNavigation(), page.getByRole('button', { name: 'Close files' }).click()]);
    await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#message').inputValue(), 'Keep this unsent draft.');
    await page.getByLabel('Remove ui-check.txt').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#chat-title').innerText(), 'Diagnostics');
    await Promise.all([page.waitForNavigation(), page.request.post(base + '/api/ui/switch', { headers: authHeaders, data: { generation: baseline } })]);
    await page.locator('#app').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#message').inputValue(), 'Keep this unsent draft.');
    assert.equal(await page.locator('meta[name="ui-version"]').getAttribute('content'), version);
    assert.equal((await (await page.request.get(base + '/api/workspace/file?path=phoenix/web/style.css')).json()).text, cssFile.text);
  } finally {
    const current = (await (await page.request.get(base + '/api/ui/generations')).json()).generations.find(item => item.current).id;
    if (current !== baseline) await page.request.post(base + '/api/ui/switch', { headers: authHeaders, data: { generation: baseline } });
  }
  await page.getByLabel('Remove ui-check.txt').click(); await page.locator('#draft-files .file-chip').waitFor({ state: 'detached' });
  await page.locator('#message').fill('');
  await mkdir('/data/ui-checks', { recursive: true });
  await page.screenshot({ path: '/data/ui-checks/desktop.png' });
  for (const width of [320,390,620]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Overflow at ${width}px`);
    await page.getByRole('button', { name: 'Chats', exact: true }).click(); await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('#files-dialog').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'AGENTS.md', exact: true }).click();
    await page.locator('#file-text').waitFor({ state: 'visible' });
    assert.equal(await page.locator('.file-navigation').isVisible(), false);
    assert.equal(await page.locator('#file-text').isVisible(), true);
    await page.getByRole('button', { name: 'Back to files', exact: true }).click();
    assert.equal(await page.locator('.file-navigation').isVisible(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByRole('button', { name: 'Close files' }).click();
  }
  let sent = 0;
  await page.route('**/api/prompt', async route => { sent++; await route.fulfill({ status: 202, contentType: 'application/json', body: '{}' }); });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#message').fill('Desktop keyboard test'); await page.locator('#message').press('Enter');
  await page.waitForFunction(() => document.querySelector('#message').value === ''); assert.equal(sent, 1);
  await page.locator('#message').fill('Line one'); await page.locator('#message').press('Shift+Enter'); assert.equal(await page.locator('#message').inputValue(), 'Line one\n');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#message').fill('Mobile keyboard test'); await page.locator('#message').press('Enter'); assert.equal(await page.locator('#message').inputValue(), 'Mobile keyboard test\n'); assert.equal(sent, 1);
  await page.locator('#message').fill('');
  await page.screenshot({ path: '/data/ui-checks/mobile.png' });
  assert.deepEqual(errors, []); console.log('UI passed: Markdown/LaTeX sanitization, dirty-file guards, drafts/attachments/chat preserved through refresh, mobile file navigation at 320/390/620px, keyboard send/newline and file save, no script errors.');
} finally { await browser.close(); }
