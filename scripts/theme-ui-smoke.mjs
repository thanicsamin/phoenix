/* global document, innerWidth */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'patchright-core';

const base = process.env.PHOENIX_TEST_URL || 'http://127.0.0.1:8085';
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/bin/chromium', headless: true, chromiumSandbox: false });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, colorScheme: 'dark' });
const errors = []; page.on('pageerror', error => errors.push(error.message));
const theme = expected => page.waitForFunction(value => document.documentElement.dataset.theme === value, expected);
async function settings() {
  await page.locator(page.viewportSize().width <= 620 ? '#mobile-settings' : '#settings').click();
  await page.locator('#settings-dialog').waitFor({ state: 'visible' });
}
try {
  await mkdir('/data/ui-checks', { recursive: true });
  await page.goto(base); await theme('dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('phoenix-theme')), null);
  await page.locator('#password').fill(process.env.PHOENIX_TEST_PASSWORD || 'phoenix-preview-password');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.locator('#app').waitFor({ state: 'visible' });
  await page.locator('#message').fill('Keep this unsent draft through theme changes.');
  await settings(); assert.equal(await page.locator('#theme').inputValue(), 'system');
  await page.locator('#theme').selectOption('light'); await theme('light');
  await page.emulateMedia({ colorScheme: 'dark' }); await theme('light');
  await page.locator('#theme').selectOption('dark'); await theme('dark');
  await page.emulateMedia({ colorScheme: 'light' }); await theme('dark');
  assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#181c19');
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' }); await theme('dark');
  assert.equal(await page.locator('#message').inputValue(), 'Keep this unsent draft through theme changes.');
  await settings(); assert.equal(await page.locator('#theme').inputValue(), 'dark');
  await page.screenshot({ path: '/data/ui-checks/theme-desktop-settings.png' });
  await page.locator('#theme').selectOption('system'); await theme('light');
  await page.emulateMedia({ colorScheme: 'dark' }); await theme('dark');
  await page.locator('#close-settings').click();
  await page.screenshot({ path: '/data/ui-checks/theme-desktop.png' });
  await page.locator('#chat-menu').click(); await page.locator('#sidebar').waitFor({ state: 'hidden' });
  await page.reload(); await page.locator('#app').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#sidebar').isVisible(), false);
  await page.locator('#chat-menu').click(); await page.locator('#sidebar').waitFor({ state: 'visible' });
  for (const width of [320, 390, 620]) {
    await page.setViewportSize({ width, height: 844 }); await settings();
    await theme('dark');
    const fits = await page.evaluate(() => {
      const rect = document.querySelector('#settings-dialog').getBoundingClientRect();
      return document.documentElement.scrollWidth <= innerWidth && rect.left >= 0 && rect.right <= innerWidth;
    });
    assert.equal(fits, true, `Settings fit ${width}px`);
    await page.locator('#theme').selectOption('light'); await theme('light');
    await page.locator('#theme').selectOption('dark'); await theme('dark');
    if (width === 390) await page.screenshot({ path: '/data/ui-checks/theme-mobile-settings.png' });
    await page.locator('#close-settings').click();
    if (width === 390) await page.screenshot({ path: '/data/ui-checks/theme-mobile.png' });
    assert.equal(await page.locator('#message').inputValue(), 'Keep this unsent draft through theme changes.');
  }
  assert.deepEqual(errors, []);
  console.log('Theme UI passed: device default, live System changes, explicit overrides, reload persistence, unsent drafts, collapsible sidebar, and 320/390/620px settings.');
} finally { await browser.close(); }
