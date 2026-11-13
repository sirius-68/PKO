/** The demo build (no backend): bundled content, on-device activity. Mirrors the preview APK. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { execSync } from 'node:child_process';
import type { Browser } from 'playwright';
import { auditLayout, launch, newPage, shot } from './harness.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const APP = join(ROOT, 'app');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.mp4': 'video/mp4', '.webmanifest': 'application/manifest+json' };
let server: Server, base = '', browser: Browser;

before(async () => {
  execSync('node scripts/build-demo.mjs', { cwd: ROOT });
  server = createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('window.PKO_CONFIG = { demo: true, supabaseUrl: "", supabaseAnonKey: "", appUrl: "" };'); return; }
    let file = normalize(join(APP, decodeURIComponent(url.pathname)));
    if (!file.startsWith(APP + sep) && file !== APP) { res.writeHead(404); res.end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(APP, 'index.html');
    const size = statSync(file).size;
    const range = /bytes=(\d+)-(\d*)/.exec(String(req.headers.range || ''));
    if (range) {
      const start = Number(range[1]), end = range[2] ? Number(range[2]) : size - 1;
      res.writeHead(206, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${size}`, 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) });
      createReadStream(file, { start, end }).pipe(res); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': String(size) });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await launch();
});
after(async () => { await browser?.close(); server?.close(); });

test('demo build: full tour with no backend', async () => {
  const { ctx, page, mon } = await newPage(browser, 'pixel-7', base);
  await page.goto(base + '/');
  await page.waitForSelector('#onboard:not([hidden])', { timeout: 15000 });
  await page.click('#obSkip');
  await page.click('[data-enter]:not([data-enter="signin"])');
  await page.waitForSelector('#shell:not([hidden]) #feed article');
  assert.ok(await page.locator('#feed article').count() >= 8, 'feed filled from bundled content');
  assert.ok(await page.locator('.livecard .live-pill').count(), 'live card shows');
  await shot(page, 'demo-home');
  const found = await auditLayout(page, 'demo-home');

  // Amen + comment (sign in with a name, stored on the device)
  const card = page.locator('#feed article[data-page^="article:"]').first();
  await card.locator('[data-amen]').click();
  assert.equal(await card.locator('[data-amen]').getAttribute('aria-pressed'), 'true');
  await card.locator('[data-open-comments]').click();
  await page.click('.page.in [data-signin="comment"]');
  await page.fill('#sheet [name=name]', 'Demo Tester');
  await page.click('#sheet button[type=submit]');
  await page.waitForSelector('.page.in form.compose input[name=body]');
  await page.fill('.page.in form.compose input[name=body]', 'Amen from the demo');
  await page.press('.page.in form.compose input[name=body]', 'Enter');
  await page.waitForSelector('.page.in .cm:has-text("Amen from the demo")');
  await page.locator('.page.in:not(.under) [data-back]').last().click();
  await page.waitForTimeout(450);

  // TV: bundled video plays, simulated chat flows, our message appears
  await page.click('.tab[data-go="tv"]');
  await page.waitForFunction(() => { const v = document.querySelector<HTMLVideoElement>('#tvv'); return !!v && v.readyState >= 2 && !v.paused; }, null, { timeout: 15000 });
  await page.waitForSelector('#chat .cmsg b.mod');
  await page.fill('#chatIn', 'Hello from the demo');
  await page.press('#chatIn', 'Enter');
  await page.waitForSelector('#chat .cmsg.mine:has-text("Hello from the demo")');
  await page.waitForFunction(() => Number(document.querySelector('[data-viewers]')?.textContent?.replace(/,/g, '')) > 1000);
  await shot(page, 'demo-tv');
  found.push(...await auditLayout(page, 'demo-tv'));

  // Library reader
  await page.click('.tab[data-go="library"]');
  await page.click('[data-libseg="Books"]');
  await page.click('.bk');
  await page.click('.page.in [data-page^="reader:"]');
  await page.waitForSelector('.page.in [data-chbody] p');
  await page.locator('.page.in:not(.under) [data-back]').last().click(); await page.waitForTimeout(420);
  await page.locator('.page.in:not(.under) [data-back]').last().click(); await page.waitForTimeout(420);

  // Events, gallery, profile shows the demo note
  await page.click('.tab[data-go="events"]');
  await page.click('.evrow');
  await page.waitForSelector('#sheet.on .evmeta');
  await page.keyboard.press('Escape');
  await page.click('[data-drawer]');
  await page.click('.drawer.on [data-chan="gallery"]');
  await page.locator('.masonry [data-photo]').first().click();
  await page.waitForSelector('#lb.on .stage img');
  await page.keyboard.press('Escape');
  await page.click('[data-sheet="profile"]');
  await page.waitForSelector('#sheet.on :text("Demo build")');

  // Activity survives an app restart
  await page.reload();
  await page.waitForSelector('#shell:not([hidden]) #feed article');
  assert.equal((await page.textContent('.topbar .me'))!.trim(), 'D', 'still signed in');
  const issues = [...found, ...mon.take()];
  assert.deepEqual(issues, [], issues.join('\n'));
  await ctx.close();
});
