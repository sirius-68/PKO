import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';

const require = createRequire(import.meta.url);
function loadPlaywright(): typeof import('playwright') {
  for (const id of ['playwright', process.env.PLAYWRIGHT_PATH, '/opt/node22/lib/node_modules/playwright'].filter(Boolean) as string[]) {
    try { return require(id); } catch { /* try next */ }
  }
  throw new Error('Playwright not found. Run `npm i -D playwright && npx playwright install chromium`.');
}
export const pw = loadPlaywright();

export const SHOTS = resolve(import.meta.dirname, '../../test-results/screens');
mkdirSync(SHOTS, { recursive: true });

export const VIEWPORTS = {
  'iphone-se': { ...pw.devices['iPhone SE'] },
  'iphone-13': { ...pw.devices['iPhone 13'] },
  'pixel-7': { ...pw.devices['Pixel 7'] },
  'ipad-mini': { ...pw.devices['iPad Mini'] },
  desktop: { viewport: { width: 1280, height: 800 } },
};

export async function launch(): Promise<Browser> {
  return pw.chromium.launch({
    executablePath: process.env.CHROME_PATH || (require('node:fs').existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined),
    args: ['--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream'],
  });
}

/** Records anything that looks like a bug while a page is used. */
export class Monitor {
  issues: string[] = [];
  constructor(page: Page, origin: string) {
    page.on('pageerror', (e) => this.issues.push(`JS error: ${e.message}`));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text();
      if (/fonts\.(googleapis|gstatic)|ERR_BLOCKED_BY_ORB|ERR_FAILED|ERR_ABORTED|status of 4(0[01349]|1[35]|22|29)|net::ERR_INTERNET_DISCONNECTED/.test(t)) return; // expected (blocked fonts, auth/validation flows)
      this.issues.push(`console.error: ${t}`);
    });
    page.on('response', (r) => { if (r.url().startsWith(origin) && r.status() >= 500) this.issues.push(`HTTP ${r.status()} ${r.request().method()} ${r.url()}`); });
    page.on('requestfailed', (r) => {
      const u = r.url(), err = r.failure()?.errorText || '';
      if (!u.startsWith(origin) || /ERR_ABORTED|ERR_INTERNET_DISCONNECTED|ERR_FAILED/.test(err)) return; // aborted streams/media on navigation, offline tests
      this.issues.push(`request failed: ${u} ${err}`);
    });
  }
  take(): string[] { const x = this.issues; this.issues = []; return x; }
}

export async function newPage(browser: Browser, device: keyof typeof VIEWPORTS, origin: string, opts: { onboarded?: boolean } = {}): Promise<{ ctx: BrowserContext; page: Page; mon: Monitor }> {
  const ctx = await browser.newContext({ ...VIEWPORTS[device], permissions: ['clipboard-read', 'clipboard-write'] });
  await ctx.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  if (opts.onboarded) await ctx.addInitScript(() => { try { if (!localStorage.getItem('pko.onboarded')) localStorage.setItem('pko.onboarded', '1'); } catch { /* ignore */ } });
  const page = await ctx.newPage();
  const mon = new Monitor(page, origin);
  return { ctx, page, mon };
}

/**
 * Layout audit of whatever is on screen: horizontal overflow, broken images,
 * nameless buttons and tap targets that are too small for a thumb.
 */
export async function auditLayout(page: Page, label: string): Promise<string[]> {
  const found = await page.evaluate(() => {
    const out: string[] = [];
    const vw = document.documentElement.clientWidth;
    const root = document.querySelector('#phone') || document.body;
    const rootRect = root.getBoundingClientRect();
    const offCanvasSide = (el: Element) => { const sd = el.closest('.side'); return !!sd && getComputedStyle(sd).position === 'fixed' && !document.body.classList.contains('side-open'); };
    const closed = (el: Element) => !!el.closest('.drawer:not(.on), .sheet:not(.on), .lb:not(.on), .page:not(.in), [hidden]') || offCanvasSide(el);
    const visible = (el: Element) => { if (closed(el)) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05; };
    const desc = (el: Element) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''} "${(el.textContent || el.getAttribute('aria-label') || '').trim().slice(0, 30)}"`;
    // horizontal scroll inside scroll containers
    for (const sc of document.querySelectorAll('.main, .page.in, .sheet.on, #view, .content')) {
      if ((sc as HTMLElement).scrollWidth > (sc as HTMLElement).clientWidth + 2) out.push(`horizontal overflow in ${desc(sc)} (${(sc as HTMLElement).scrollWidth} > ${(sc as HTMLElement).clientWidth})`);
    }
    if (document.documentElement.scrollWidth > vw + 2) out.push(`page scrolls sideways (${document.documentElement.scrollWidth} > ${vw})`);
    // which layer is on top? only audit that one
    const top = document.querySelector('.lb.on') || document.querySelector('.sheet.on') || [...document.querySelectorAll('.page.in')].pop() || document.querySelector('.drawer.on') || document.querySelector('#shell:not([hidden])') || document.querySelector('#onboard:not([hidden])') || document.body;
    // elements poking outside the app frame (ignore deliberate horizontal scrollers)
    for (const el of top.querySelectorAll('button, a, input, textarea, h1, h2, h3, p, img, .card, .post')) {
      if (!visible(el) || el.closest('.hscroll, .sortrow, .chips, .ob-track, .seg, .tbl, .mgrid')) continue;
      const r = el.getBoundingClientRect();
      if (r.right > rootRect.right + 2 || r.left < rootRect.left - 2) out.push(`off-screen: ${desc(el)} (${Math.round(r.left)}–${Math.round(r.right)} vs ${Math.round(rootRect.left)}–${Math.round(rootRect.right)})`);
    }
    for (const img of top.querySelectorAll('img')) {
      const i = img as HTMLImageElement;
      if (i.complete && i.naturalWidth === 0 && i.getAttribute('src') && visible(i) && i.loading !== 'lazy') out.push(`broken image: ${i.src}`);
    }
    for (const b of top.querySelectorAll('button, a[href], [role=button]')) {
      if (!visible(b)) continue;
      const name = (b.getAttribute('aria-label') || b.textContent || b.getAttribute('title') || '').trim();
      if (!name) out.push(`button without a label: ${desc(b)}`);
      const r = b.getBoundingClientRect();
      if ((r.width < 24 || r.height < 24) && !b.closest('.cm .a, .lrow-tools, .mv, .cmsg, .tbl')) out.push(`tap target ${Math.round(r.width)}×${Math.round(r.height)}px: ${desc(b)}`);
    }
    return out;
  });
  return found.map((f) => `[${label}] ${f}`);
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOTS, name.replace(/[^\w.-]+/g, '_') + '.png') });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
