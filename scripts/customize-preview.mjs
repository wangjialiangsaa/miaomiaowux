// Run with playwright-core + Chromium; credentials and backups stay outside Git.
// Native settings API contract verified against upstream mmwx-v0.5.4.
import { chromium } from 'playwright-core';
import { readFileSync, writeFileSync } from 'node:fs';
const base = process.env.MMWX_PREVIEW_URL || 'http://127.0.0.1:12889';
const out = process.env.MMWX_QA_DIR || '/out';
const credentials = JSON.parse(readFileSync(`${out}/preview-credentials.json`, 'utf8'));
const css = readFileSync(new URL('../ui/minimal.css', import.meta.url), 'utf8').trim();
const apply = process.argv.includes('--apply');
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', headless: true,
  env: { ...process.env, XDG_CONFIG_HOME: '/tmp/chromium-config', XDG_CACHE_HOME: '/tmp/chromium-cache' },
  args: ['--no-sandbox', '--disable-dev-shm-usage'] });
const errors = [];
async function login(page) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[name="username"]').fill(credentials.username);
  await page.locator('input[name="password"]').fill(credentials.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL(url => url.pathname !== '/login', { timeout: 60000 });
}
async function settings(page, value) {
  return page.evaluate(async value => {
    const src = [...document.scripts].find(s => /\/assets\/index-[^/]+\.js/.test(s.src))?.src;
    if (!src) throw new Error('Cannot locate app API module');
    const { a: api } = await import(src);
    if (!api?.get || !api?.put) throw new Error('Unsupported app API module');
    if (value !== null) await api.put('§5d046c3c6edd3567', { custom_css: value });
    return (await api.get('§5f07d10c0b736867')).data;
  }, value ?? null);
}
async function assertHidden(page, label) {
  await page.waitForTimeout(1800); // Include the upstream 400ms welcome timer.
  const result = await page.evaluate(() => ({
    injected: document.getElementById('mmwx-custom-css')?.textContent.includes('BEGIN MMWX MINIMAL UI'),
    badgeVisible: [...document.querySelectorAll('.license-nameplate')].some(e => e.getClientRects().length > 0),
    welcomeVisible: [...document.querySelectorAll('.mmwx-welcome-mask')].some(e => e.getClientRects().length > 0),
  }));
  if (!result.injected || result.badgeVisible || result.welcomeVisible) throw new Error(`${label}: ${JSON.stringify(result)}`);
  await page.screenshot({ path: `${out}/${label}.png`, fullPage: true });
  console.log(JSON.stringify({ check: label, ...result }));
}
try {
  const context = await browser.newContext({ viewport: { width: 613, height: 1244 } });
  const page = await context.newPage();
  await login(page);
  const before = await settings(page);
  if (before.disabled_by_env) throw new Error('Custom CSS disabled by environment');
  const previous = before.custom_css || '';
  const begin = '/* BEGIN MMWX MINIMAL UI */';
  const end = '/* END MMWX MINIMAL UI */';
  const start = previous.indexOf(begin);
  const finish = previous.indexOf(end);
  if ((start < 0) !== (finish < 0) || (start >= 0 && finish < start)) throw new Error('Malformed managed CSS block');
  const next = start < 0 ? `${previous.trimEnd()}\n\n${css}\n`.trimStart()
    : previous.slice(0, start) + css + previous.slice(finish + end.length);
  if (Buffer.byteLength(next) > (before.max_bytes ?? 65536)) throw new Error('Custom CSS exceeds server limit');
  if (apply && next !== previous) {
    writeFileSync(`${out}/custom-css-before-${Date.now()}.json`, JSON.stringify({ custom_css: previous }), { mode: 0o600 });
    const after = await settings(page, next);
    if (after.custom_css !== next) throw new Error('Saved CSS readback mismatch');
    console.log('Native custom CSS saved and read back; previous CSS backed up privately.');
  } else if (next !== previous) throw new Error('Customization missing; pass --apply to save it');
  await context.close();
  for (const colorScheme of ['light', 'dark']) {
    const fresh = await browser.newContext({ viewport: { width: 613, height: 1244 }, colorScheme });
    const view = await fresh.newPage();
    view.on('pageerror', error => errors.push(error.message));
    await view.goto(`${base}/login`, { waitUntil: 'networkidle' });
    await view.locator('input[name="username"]').waitFor();
    await assertHidden(view, `minimal-login-${colorScheme}`);
    await login(view);
    await assertHidden(view, `minimal-dashboard-${colorScheme}`);
    await view.reload({ waitUntil: 'networkidle' });
    await assertHidden(view, `minimal-reload-${colorScheme}`);
    await view.goto(`${base}/system-settings`, { waitUntil: 'networkidle' });
    await view.getByText(/^(系统设置|System Settings)$/).last().waitFor();
    if (!(await settings(view)).custom_css?.includes(css)) throw new Error('Settings page cannot read saved CSS');
    await assertHidden(view, `minimal-settings-${colorScheme}`);
    await fresh.close();
  }
  if (errors.length) throw new Error(`Browser errors: ${errors.join('; ')}`);
  console.log('PASS: fresh login, dashboard, reload and system settings in light/dark contexts.');
} finally { await browser.close(); }
