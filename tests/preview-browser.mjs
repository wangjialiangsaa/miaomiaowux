// Run in the browser test image, sharing only the preview container's network.
import { chromium } from 'playwright-core';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/chromium-config', XDG_CACHE_HOME: '/tmp/chromium-cache' },
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const response = await page.goto('http://127.0.0.1:12889/login', { waitUntil: 'networkidle', timeout: 60000 });
  await page.locator('input').first().waitFor({ state: 'visible', timeout: 60000 });
  console.log(JSON.stringify({ status: response.status(), url: page.url(), secureContext: await page.evaluate(() => window.isSecureContext),
    title: await page.title(), text: await page.locator('body').innerText(), inputs: await page.locator('input').evaluateAll(inputs => inputs.map(input => ({ type: input.type, placeholder: input.placeholder, name: input.name }))), errors }));
  await page.screenshot({ path: '/out/login.png', fullPage: true });
  if (response.status() !== 200 || errors.length || !await page.evaluate(() => !!crypto.subtle)) throw new Error('Preview browser check failed');
  if (process.env.MMWX_PREVIEW_INIT === '1') {
    const file = '/out/preview-credentials.json';
    const credentials = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { username: 'admin', password: 'Mmwx!' + randomBytes(15).toString('base64url') };
    if ((await page.locator('body').innerText()).includes('This is the first launch')) {
      writeFileSync(file, JSON.stringify(credentials), { mode: 0o600 });
      await page.locator('input[name="username"]').fill(credentials.username);
      await page.locator('input[name="password"]').fill(credentials.password);
      await page.getByRole('button', { name: 'Create Admin Account', exact: true }).click();
      try {
        await page.waitForFunction(() => !document.body.innerText.includes('This is the first launch') && (location.pathname !== '/login' || !!document.querySelector('input[name="username"]')), null, { timeout: 30000 });
      } catch (error) {
        console.error(JSON.stringify({ registrationUrl: page.url(), registrationText: await page.locator('body').innerText() }));
        await page.screenshot({ path: '/out/registration-result.png', fullPage: true });
        throw error;
      }
      console.log('Preview administrator created successfully');
      await page.screenshot({ path: '/out/dashboard.png', fullPage: true });
    } else if (!existsSync(file)) throw new Error('Existing preview has an unknown administrator; refusing to reset it');
    const context = await browser.newContext();
    const login = await context.newPage();
    await login.goto('http://127.0.0.1:12889/login', { waitUntil: 'networkidle' });
    await login.locator('input[name="username"]').fill(credentials.username);
    await login.locator('input[name="password"]').fill(credentials.password);
    await login.locator('button[type="submit"]').first().click();
    await login.waitForURL(url => url.pathname !== '/login', { timeout: 60000 });
    console.log(JSON.stringify({ freshLogin: true, url: login.url(), title: await login.title() }));
    await login.screenshot({ path: '/out/dashboard.png', fullPage: true });
    await context.close();
  }
} finally { await browser.close(); }
