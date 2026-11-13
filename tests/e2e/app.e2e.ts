/**
 * End-to-end tests of the member (mobile) app against a real server.
 * Every test runs with a bug monitor (JS errors, failed requests, 5xx) and the
 * screens it visits are audited for layout problems.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import { startTestServer, Client, FILES } from '../helpers.ts';
import { auditLayout, launch, newPage, shot, sleep, VIEWPORTS } from './harness.ts';

let srv: Awaited<ReturnType<typeof startTestServer>>;
let browser: Browser;
let admin: Client;
const issues: string[] = [];

before(async () => {
  srv = await startTestServer();
  browser = await launch();
  admin = srv.admin;
});
after(async () => {
  await browser?.close();
  await srv?.close();
  if (issues.length) console.log('\nUI issues found:\n' + issues.map((i) => '  • ' + i).join('\n'));
});

const APP = () => srv.base + '/app/';
async function enter(page: Page) {
  await page.goto(APP());
  await page.waitForSelector('#shell:not([hidden]) .tabbar .tab', { timeout: 15000 });
  await page.waitForSelector('#splash', { state: 'detached', timeout: 8000 }).catch(() => {});
}
const settle = (page: Page, ms = 450) => page.waitForTimeout(ms);
async function tab(page: Page, name: string) { await page.click(`.tab[data-go="${name}"]`); await settle(page); }
/** Waits until the toast shows the expected message (older toasts may still be fading). */
async function expectToast(page: Page, want: string | RegExp) {
  const src = typeof want === 'string' ? `^${want.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` : want.source;
  const flags = typeof want === 'string' ? '' : want.flags;
  await page.waitForFunction(([src, flags]) => { const t = document.querySelector('#toast.on'); return !!t && new RegExp(src, flags).test((t.textContent || '').trim()); }, [src, flags], { timeout: 8000 })
    .catch(async () => { throw new Error(`toast never showed ${want}; last was "${(await page.textContent('#toast'))?.trim()}"`); });
}
async function signIn(page: Page, name: string) {
  await page.waitForSelector('#sheet.on [data-signinform]');
  await page.fill('#sheet [name=name]', name);
  await page.fill('#sheet [name=phone]', '+237 650 000 000');
  await page.click('#sheet button[type=submit]');
  await page.waitForSelector('#sheet:not(.on)');
}
/** Taps Back on the top-most page (pages underneath are still in the DOM). */
async function back(page: Page) { await page.locator('.page.in:not(.under) [data-back]').last().click(); await page.waitForTimeout(420); }
/** Synthesises a one-finger swipe with real TouchEvents (start → move → end). */
async function swipe(page: Page, sel: string, x0: number, y0: number, x1: number, y1: number) {
  await page.evaluate(({ sel, x0, y0, x1, y1 }) => {
    const el = document.querySelector(sel)!;
    const t = (x: number, y: number) => new Touch({ identifier: 1, target: el, clientX: x, clientY: y });
    const fire = (type: string, x: number, y: number, ended = false) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: ended ? [] : [t(x, y)], changedTouches: [t(x, y)] }));
    fire('touchstart', x0, y0);
    for (let i = 1; i <= 5; i++) fire('touchmove', x0 + ((x1 - x0) * i) / 5, y0 + ((y1 - y0) * i) / 5);
    fire('touchend', x1, y1, true);
  }, { sel, x0, y0, x1, y1 });
}
function expectClean(label: string, found: string[]) {
  issues.push(...found);
  assert.deepEqual(found, [], `${label}: ${found.join('\n')}`);
}

describe('first launch', () => {
  test('splash → onboarding swipe → guest entry', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base);
    await page.goto(APP());
    await page.waitForSelector('#onboard:not([hidden])', { timeout: 10000 });
    await page.waitForSelector('#splash', { state: 'detached' });
    await shot(page, 'app-01-onboarding');
    expectClean('onboarding', await auditLayout(page, 'onboarding'));
    // swipe to slide 2, then Next through the rest
    await swipe(page, '#obTrack', 300, 400, 100, 400);
    await page.waitForSelector('#obDots i:nth-child(2).on');
    for (let i = 0; i < 2; i++) { await page.click('#obNext'); await settle(page, 350); }
    assert.equal(await page.isVisible('#obNext'), false, 'Next hides on the last slide');
    await page.click('[data-enter]:not([data-enter="signin"])');
    await page.waitForSelector('#shell:not([hidden]) .livecard');
    assert.equal(await page.evaluate(() => localStorage.getItem('pko.onboarded')), '1');
    // second launch skips onboarding
    await page.reload();
    await page.waitForSelector('#shell:not([hidden]) .tab', { timeout: 10000 });
    assert.equal(await page.isVisible('#onboard'), false);
    expectClean('first launch monitor', mon.take());
    await ctx.close();
  });
});

describe('layout on every screen size', () => {
  for (const device of Object.keys(VIEWPORTS) as (keyof typeof VIEWPORTS)[]) {
    test(device, async () => {
      const { ctx, page, mon } = await newPage(browser, device, srv.base, { onboarded: true });
      await enter(page);
      const found: string[] = [];
      const screens: [string, () => Promise<unknown>][] = [
        ['home', () => tab(page, 'home')],
        ['tv', async () => { await tab(page, 'tv'); await settle(page, 900); }],
        ['library-books', async () => { await tab(page, 'library'); await page.click('[data-libseg="Books"]'); }],
        ['library-songs', async () => { await page.click('[data-libseg="Songs"]'); await settle(page); }],
        ['events', () => tab(page, 'events')],
        ['drawer', async () => { await page.click('[data-drawer]'); await settle(page); }],
        ['blog', async () => { await page.click('.drawer.on [data-chan="blog"]'); await settle(page); }],
        ['gallery', async () => { await page.click('[data-drawer]'); await settle(page, 300); await page.click('.drawer.on [data-chan="gallery"]'); await settle(page); }],
        ['testimonies', async () => { await page.click('[data-drawer]'); await settle(page, 300); await page.click('.drawer.on [data-chan="testimonies"]'); await settle(page); }],
        ['article', async () => { await tab(page, 'home'); await page.click('#feed [data-page^="article:"]'); await settle(page, 700); }],
        ['book', async () => { await page.click('[data-back]'); await settle(page); await tab(page, 'library'); await page.click('[data-libseg="Books"]'); await page.click('.bk'); await settle(page, 600); }],
        ['reader', async () => { await page.click('.page.in [data-page^="reader:"]'); await page.waitForSelector('.page.in [data-chbody] p'); await settle(page); }],
        ['album', async () => { await back(page); await settle(page, 300); await back(page); await settle(page, 300); await page.click('[data-libseg="Songs"]'); await page.click('.alb'); await settle(page, 600); }],
        ['search', async () => { await back(page); await settle(page, 300); await page.click('[data-page="search"]'); await page.fill('#q', 'glory'); await settle(page); }],
        ['profile-sheet', async () => { await back(page); await settle(page, 300); await page.click('[data-sheet="profile"]'); await settle(page); }],
        ['create-sheet', async () => { await page.keyboard.press('Escape'); await settle(page, 300); await page.click('.tab-plus'); await settle(page); }],
        ['event-sheet', async () => { await page.keyboard.press('Escape'); await tab(page, 'events'); await page.click('.evrow'); await settle(page); }],
      ];
      for (const [name, act] of screens) {
        try { await act(); } catch (e) { await shot(page, `FAIL-${device}-${name}`); throw new Error(`step "${name}" failed: ${(e as Error).message.split('\n')[0]}`); }
        found.push(...await auditLayout(page, `${device}/${name}`));
        if (['home', 'tv', 'library-books', 'events', 'article', 'reader', 'event-sheet'].includes(name)) await shot(page, `layout-${device}-${name}`);
      }
      found.push(...mon.take().map((m) => `[${device}] ${m}`));
      expectClean(device, found);
      await ctx.close();
    });
  }
});

describe('reading & engagement', () => {
  test('Amen, save, share, saved list; Amen persists across reloads', async () => {
    const { ctx, page, mon } = await newPage(browser, 'pixel-7', srv.base, { onboarded: true });
    await enter(page);
    const card = page.locator('#feed article[data-page^="article:"]').first();
    const id = (await card.getAttribute('data-page'))!.split(':')[1];
    const amen = card.locator(`[data-amen="${id}"]`);
    const before = Number((await amen.locator('em').textContent())!.replace('k', '')) || 0;
    const resp = page.waitForResponse((r) => r.url().endsWith('/rpc/toggle_amen'));
    await amen.click();
    await expectToast(page, 'Amen');
    assert.equal(await amen.getAttribute('aria-pressed'), 'true');
    await resp;
    assert.equal(Number(await amen.locator('em').textContent()), before + 1);
    await card.locator(`[data-save="${id}"]`).click();
    await expectToast(page, 'Saved');
    await card.locator(`[data-share="${id}"]`).click();
    await sleep(300);
    // the server agrees
    assert.equal((await admin.bundle()).amens[id], before + 1);
    await page.reload();
    await page.waitForSelector('#shell:not([hidden]) #feed');
    assert.equal(await page.locator(`#feed [data-amen="${id}"]`).first().getAttribute('aria-pressed'), 'true', 'Amen remembered');
    await page.click('[data-sheet="profile"]');
    await page.click('#sheet [data-page="saved"]');
    await page.waitForSelector('.page.in .row');
    assert.equal(await page.locator('.page.in .row').count(), 1);
    await shot(page, 'app-saved');
    // un-Amen
    await page.click('.page.in .row');
    await page.waitForSelector(`.page.in [data-amen="${id}"]`);
    const resp2 = page.waitForResponse((r) => r.url().endsWith('/rpc/toggle_amen'));
    await page.locator(`.page.in [data-amen="${id}"]`).click();
    await resp2;
    assert.equal((await admin.bundle()).amens[id] || 0, before);
    expectClean('engagement monitor', mon.take());
    await ctx.close();
  });

  test('sign in from comments; post, reply, delete; user content is escaped', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await enter(page);
    await page.click('#feed article[data-page^="article:"] [data-open-comments]');
    await page.waitForSelector('.page.in [data-comments]');
    await page.waitForSelector('.page.in [data-comments] .empty, .page.in [data-comments] .cm');
    await page.click('.page.in [data-signin="comment"]');
    await signIn(page, 'Grace Tester');
    await page.waitForSelector('.page.in form.compose input[name=body]');
    const xss = '<img src=x onerror="window.__xss=1"> Amen <b>bold</b>';
    await page.fill('.page.in form.compose input[name=body]', xss);
    await page.press('.page.in form.compose input[name=body]', 'Enter');
    await page.waitForSelector('.page.in .cm');
    assert.equal(await page.locator('.page.in .cm p').first().textContent(), xss, 'shown as text');
    assert.equal(await page.locator('.page.in .cm p img, .page.in .cm p b').count(), 0, 'no HTML injected');
    assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
    // reply
    await page.click('.page.in [data-reply]');
    await page.waitForSelector('.page.in .replying:not([hidden])');
    await page.fill('.page.in form.compose input[name=body]', 'Amen to that');
    await page.click('.page.in button[aria-label="Post comment"]');
    await page.waitForSelector('.page.in .cm.reply');
    assert.equal(await page.textContent('.page.in [data-ccount]'), '2');
    await shot(page, 'app-comments');
    expectClean('comments layout', await auditLayout(page, 'comments'));
    // still signed in after the app restarts (session restored from device storage)
    await page.reload();
    await page.waitForSelector('#shell:not([hidden]) .tab');
    assert.equal((await page.textContent('.topbar .me'))!.trim(), 'G', 'still signed in after restart');
    await page.click('#feed article[data-page^="article:"] [data-open-comments]');
    await page.waitForSelector('.page.in form.compose input[name=body]');
    // delete own top comment removes the thread
    await page.locator('.page.in .cm:not(.reply) [data-delcomment]').click();
    await page.waitForSelector('.page.in [data-comments] .empty');
    // topbar shows the member initial; sign out from profile
    await back(page);
    assert.equal((await page.textContent('.topbar .me'))!.trim(), 'G');
    await page.click('[data-sheet="profile"]');
    await page.click('#sheet [data-signout]');
    await page.waitForSelector('#toast.on:has-text("Signed out")');
    expectClean('comments monitor', mon.take());
    await ctx.close();
  });
});

describe('Transfiguration TV', () => {
  test('live video plays, viewers count, chat both ways, replays, off-air via SSE', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await enter(page);
    await tab(page, 'tv');
    await page.waitForFunction(() => { const v = document.querySelector<HTMLVideoElement>('#tvv'); return !!v && v.readyState >= 2 && !v.paused; }, null, { timeout: 15000 });
    assert.equal(await page.locator('#tvv').evaluate((v: HTMLVideoElement) => v.muted), true, 'autoplays muted');
    await page.click('#unmute');
    assert.equal(await page.locator('#tvv').evaluate((v: HTMLVideoElement) => v.muted), false);
    await page.waitForFunction(() => Number(document.querySelector('[data-viewers]')?.textContent) >= 1);
    // chat needs an account
    await page.click('[data-signin="chat"]');
    await signIn(page, 'Kwame A.');
    await page.waitForSelector('#chatIn');
    await page.fill('#chatIn', 'Watching from Kumasi');
    await page.press('#chatIn', 'Enter');
    await page.waitForSelector('#chat .cmsg.mine:has-text("Watching from Kumasi")');
    await admin.rpcOk('admin_chat_post', { p_body: 'Welcome, family!', p_name: 'Pastor Ruth' });
    await page.waitForSelector('#chat .cmsg b.mod:has-text("Pastor Ruth")');
    await shot(page, 'app-tv-live-chat');
    // moderator deletes a message → disappears for everyone
    const msgs = (await admin.rpcOk('get_live')).messages;
    await admin.rpcOk('admin_chat_delete', { p_id: msgs.find((m: { body: string }) => m.body === 'Watching from Kumasi').id });
    await page.waitForSelector('#chat .cmsg:has-text("Watching from Kumasi")', { state: 'detached' });
    // replays
    await page.click('[data-tvpane="past"]');
    await page.click('#tvpane [data-watch]');
    await page.waitForSelector('[data-golive]');
    await page.waitForFunction(() => { const v = document.querySelector<HTMLVideoElement>('#tvv'); return !!v && v.readyState >= 1 && v.duration > 0; });
    await page.click('[data-tvplay]');
    await page.locator('[data-seek]').click({ position: { x: 60, y: 7 } });
    await page.waitForFunction(() => (document.querySelector<HTMLVideoElement>('#tvv')?.currentTime || 0) > 1);
    assert.match((await page.textContent('#tvdur')) || '', /^\d+:\d\d$/);
    // schedule reminder
    await page.click('[data-tvpane="next"]');
    await page.click('#tvpane [data-remind]');
    await expectToast(page, 'Reminder set');
    await page.click('[data-golive]');
    await page.waitForSelector('.player .live-pill');
    // the media team ends the service: the app updates without a reload
    await admin.rpcOk('admin_save_live', { p: { onAir: false } });
    // 24/7: the channel carries on with replays instead of going dark
    await page.waitForSelector('.player .ch-pill', { timeout: 8000 });
    assert.equal(await page.isVisible('.tab .dot'), false, 'live dot removed');
    await page.waitForFunction(() => { const v = document.querySelector<HTMLVideoElement>('#tvv'); return !!v && !!v.getAttribute('src') && v.readyState >= 1; });
    assert.equal(await page.locator('[data-seek]').count(), 0, 'no seeking on the channel, like TV');
    assert.match((await page.textContent('#topbar')) || '', /On TV now/);
    await page.click('[data-tvpane="next"]');
    await page.waitForSelector('#tvpane .sched .tm.now');
    assert.ok((await page.locator('#tvpane .sched').count()) >= 4, 'now + coming programmes');
    assert.ok((await page.locator('#tvpane .tag').count()) >= 3, 'each programme says live / replay / rotation');
    await shot(page, 'app-tv-channel');
    // with the 24/7 channel switched off, it goes off air between programmes
    await admin.rpcOk('admin_save_live', { p: { channel24: false } });
    await page.waitForSelector('.offair', { timeout: 8000 });
    assert.match((await page.textContent('.offair')) || '', /Next: /);
    await shot(page, 'app-tv-offair');
    await admin.rpcOk('admin_save_live', { p: { channel24: true } });
    await page.waitForSelector('.player .ch-pill', { timeout: 8000 });
    await admin.rpcOk('admin_save_live', { p: { onAir: true } });
    await page.waitForSelector('.player .live-pill', { timeout: 8000 });
    expectClean('tv monitor', mon.take());
    await ctx.close();
  });
});

describe('music', () => {
  test('songs without audio say "coming soon"; uploaded audio plays with mini player, skip and seek', async () => {
    // give the newest album's first two tracks real audio
    const albums = await admin.rpcOk('admin_list', { p_collection: 'albums' });
    const album = albums[0];
    const a1 = await admin.uploadMedia('one.wav', FILES.wav(6), 'audio/wav');
    const a2 = await admin.uploadMedia('two.wav', FILES.wav(4), 'audio/wav');
    album.tracks[0].audio = a1; album.tracks[0].duration = 6;
    album.tracks[1].audio = a2; album.tracks[1].duration = 4;
    await admin.rpcOk('admin_save', { p_collection: 'albums', p_id: album.id, p_data: { tracks: album.tracks } });

    const { ctx, page, mon } = await newPage(browser, 'pixel-7', srv.base, { onboarded: true });
    await enter(page);
    await tab(page, 'library');
    await page.click('[data-libseg="Songs"]');
    await page.locator('#songlist .track.na').first().click();
    await expectToast(page, /coming soon/);
    await page.locator('#songlist .track:not(.na)').first().click();
    await page.waitForSelector('#mini:not([hidden])');
    await page.waitForFunction(() => document.querySelector('#songlist .track.on .d') !== null);
    assert.equal(await page.textContent('#mini .tx b'), album.tracks[0].title);
    await page.waitForFunction(() => Number(document.querySelector<HTMLElement>('#miniProg')?.style.width.replace('%', '')) > 5, null, { timeout: 8000 });
    await page.click('#mini [data-skip="1"]');
    await page.waitForFunction((t) => document.querySelector('#mini .tx b')?.textContent === t, album.tracks[1].title);
    await page.click('#mini .tx');
    await page.waitForSelector('#sheet.on .np');
    await page.locator('[data-scrub]').click({ position: { x: 200, y: 4 } });
    await page.click('#sheet [data-toggleplay]');
    await page.waitForSelector('#sheet [data-toggleplay][aria-label="Play"]');
    await shot(page, 'app-now-playing');
    expectClean('player sheet', await auditLayout(page, 'now-playing'));
    expectClean('music monitor', mon.take());
    await ctx.close();
  });
});

describe('library reader', () => {
  test('chapters load, next chapter, text size, progress saved and resumed', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-se', srv.base, { onboarded: true });
    await enter(page);
    await tab(page, 'library');
    assert.equal(await page.isVisible('.cont'), false, 'no "continue reading" before reading');
    await page.click('.bk');
    await page.click('.page.in [data-page^="reader:"]');
    await page.waitForSelector('.page.in [data-chbody] p');
    await page.click('.page.in [data-chgo="1"]');
    await page.waitForSelector('.page.in .chn:has-text("Chapter 2")');
    await page.waitForSelector('.page.in [data-chbody] p');
    const size0 = await page.locator('.page.in:not(.under) .reader').last().evaluate((r) => getComputedStyle(r).fontSize);
    await page.click('.page.in [data-fontsize]');
    const size1 = await page.locator('.page.in:not(.under) .reader').last().evaluate((r) => getComputedStyle(r).fontSize);
    assert.notEqual(size0, size1);
    await page.locator('.page.in:not(.under)').last().evaluate((el) => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')); });
    await sleep(600);
    await back(page); await settle(page);
    await back(page); await settle(page);
    await page.waitForSelector('.cont:has-text("Chapter 2")');
    await page.reload();
    await page.waitForSelector('#shell:not([hidden]) .tab');
    await tab(page, 'library');
    await page.click('.cont');
    await page.waitForSelector('.page.in .chn:has-text("Chapter 2")');
    assert.equal(await page.locator('.page.in:not(.under) .reader').last().evaluate((r) => getComputedStyle(r).fontSize), size1, 'text size remembered');
    expectClean('reader monitor', mon.take());
    await ctx.close();
  });
});

describe('events & gallery', () => {
  test('calendar navigation, day selection, event sheet, reminder, calendar file', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await enter(page);
    await tab(page, 'events');
    const month = await page.textContent('.cal-h b');
    await page.click('[data-calnav="1"]');
    assert.notEqual(await page.textContent('.cal-h b'), month);
    await page.click('[data-calnav="-1"]');
    await page.click('[data-day="2026-11-15"]');
    await page.waitForSelector('.evrow:has-text("Sunday Encounter Service")');
    await page.locator('.evrow').first().click();
    await page.waitForSelector('#sheet.on .evmeta');
    await page.click('#sheet [data-evremind]');
    await expectToast(page, 'Reminder set');
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.click('#sheet [data-ics]')]);
    assert.match(dl.suggestedFilename(), /\.ics$/);
    const ics = await (await import('node:fs/promises')).readFile((await dl.path())!, 'utf8');
    assert.match(ics, /BEGIN:VEVENT[\s\S]*DTSTART:20261115T090000[\s\S]*SUMMARY:Sunday Encounter Service/);
    for (const p of ctx.pages()) if (p !== page) await p.close();
    await page.keyboard.press('Escape');
    await page.waitForSelector('#sheet:not(.on)');
    assert.ok(await page.locator('.evrow [aria-label="Reminder set"]').count() >= 1, 'bell shows on the event');
    expectClean('events monitor', mon.take());
    await ctx.close();
  });
  test('gallery filter and lightbox with swipe/keys', async () => {
    const { ctx, page, mon } = await newPage(browser, 'pixel-7', srv.base, { onboarded: true });
    await enter(page);
    await page.click('[data-drawer]');
    await page.click('.drawer.on [data-chan="gallery"]');
    await page.click('[data-gal="Portraits"]');
    assert.equal(await page.locator('.masonry [data-photo]').count(), 2);
    await page.click('[data-gal="All"]');
    await page.locator('.masonry [data-photo]').nth(1).click();
    await page.waitForSelector('#lb.on .stage img');
    assert.match((await page.textContent('#lb .lbh span'))!, /^2 of \d+$/);
    await page.click('#lb [data-lb="1"]');
    assert.match((await page.textContent('#lb .lbh span'))!, /^3 of/);
    await page.keyboard.press('ArrowLeft');
    assert.match((await page.textContent('#lb .lbh span'))!, /^2 of/);
    await shot(page, 'app-lightbox');
    expectClean('lightbox', await auditLayout(page, 'lightbox'));
    await page.goBack(); // hardware/browser back closes the lightbox, stays in the app
    await page.waitForSelector('#lb:not(.on)');
    assert.ok(page.url().includes('/app/'));
    expectClean('gallery monitor', mon.take());
    await ctx.close();
  });
});

describe('testimonies', () => {
  test('member submits → media team approves → visible in the app after pull-to-refresh', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await enter(page);
    await page.click('.tab-plus');
    await page.click('#sheet [data-write]:not([data-write="video"])');
    await page.click('.page.in [data-signin="write"]');
    await signIn(page, 'Mirabel A.');
    await page.waitForSelector('.page.in form[data-testimony]');
    await page.click('.page.in button[type=submit]');
    assert.match((await page.textContent('.page.in [data-ferr]'))!, /Add a title/, 'validation shown');
    await page.fill('.page.in [name=title]', 'A door opened');
    await page.fill('.page.in [name=body]', 'I prayed for a year for work. Last week the call came and I start on Monday.');
    await page.fill('.page.in [name=place]', 'Buea');
    // switching to video requires a file
    await page.click('.page.in [data-wtab="video"]');
    await page.click('.page.in button[type=submit]');
    assert.match((await page.textContent('.page.in [data-ferr]'))!, /Add your video/);
    await page.click('.page.in [data-wtab="text"]');
    await page.click('.page.in button[type=submit]');
    await expectToast(page, /sent for review/);
    const pending = await admin.rpcOk('admin_list', { p_collection: 'testimonies', p_status: 'pending' });
    const mine = pending.find((t: { title: string }) => t.title === 'A door opened');
    assert.ok(mine, 'arrives in moderation');
    await admin.rpcOk('admin_save', { p_collection: 'testimonies', p_id: mine.id, p_data: {}, p_status: 'published' });
    // pull to refresh on the home feed
    await page.evaluate(() => { const m = document.querySelector('#main')!; m.scrollTop = 0; });
    await swipe(page, '#main', 150, 150, 150, 300);
    await expectToast(page, 'Updated');
    await page.click('[data-drawer]');
    await page.click('.drawer.on [data-chan="testimonies"]');
    await page.waitForSelector('.tcard:has-text("A door opened")');
    expectClean('testimony monitor', mon.take());
    await ctx.close();
  });
});

describe('search, theme, back button, deep links, offline', () => {
  test('search finds content across types and opens it', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await enter(page);
    await page.click('[data-page="search"]');
    await page.fill('#q', 'rock');
    await page.waitForSelector('.sres .row');
    await page.click('.sres .row:has-text("Christ the Rock")');
    await page.waitForSelector('.tvinfo h1:has-text("Christ the Rock")');
    await page.click('[data-page="search"]');
    await page.fill('#q', 'zzzz-nothing');
    await page.waitForSelector('#sres .empty');
    await page.fill('#q', '<script>');
    assert.equal(await page.locator('#sres script').count(), 0);
    expectClean('search monitor', mon.take());
    await ctx.close();
  });
  test('dark/light theme persists', async () => {
    const { ctx, page } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await enter(page);
    await page.click('[data-drawer]');
    await page.click('.drawer.on [data-theme-toggle]');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    await page.keyboard.press('Escape');
    await shot(page, 'app-light-home');
    expectClean('light theme', await auditLayout(page, 'light-home'));
    await page.reload();
    await page.waitForSelector('#shell:not([hidden]) .tab');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    await ctx.close();
  });
  test('back button closes pages, sheets and drawer in order, then returns home', async () => {
    const { ctx, page } = await newPage(browser, 'pixel-7', srv.base, { onboarded: true });
    await enter(page);
    await tab(page, 'events');
    await page.click('[data-drawer]');
    await page.click('.drawer.on [data-page="saved"]');
    await page.waitForSelector('.page.in');
    await page.goBack(); await page.waitForSelector('.page.in', { state: 'detached' });
    await page.click('[data-sheet="profile"]'); await page.waitForSelector('#sheet.on');
    await page.goBack(); await page.waitForSelector('#sheet:not(.on)');
    await page.click('[data-drawer]'); await page.waitForSelector('#drawer.on');
    await page.goBack(); await page.waitForSelector('#drawer:not(.on)');
    await page.goBack(); await page.waitForSelector('.tab.on[data-go="home"]');
    assert.ok(page.url().includes('/app/'), 'still in the app');
    await ctx.close();
  });
  test('shared deep link opens the article directly', async () => {
    const id = (await admin.bundle()).posts[0].id;
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await page.goto(`${APP()}#/article/${id}`);
    await page.waitForSelector(`.page.in [data-amen="${id}"]`, { timeout: 15000 });
    assert.ok(!page.url().includes('#/article'), 'hash cleared after opening');
    expectClean('deep link monitor', mon.take());
    await ctx.close();
  });
  test('works offline from saved content', async () => {
    const { ctx, page } = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await enter(page);
    await ctx.route('**/rest/v1/**', (r) => r.abort('internetdisconnected'));
    await page.reload();
    await page.waitForSelector('#shell:not([hidden]) #feed article', { timeout: 15000 });
    await expectToast(page, /offline/i);
    await ctx.close();
  });
  test('first launch with no connection shows a retry screen', async () => {
    const { ctx, page } = await newPage(browser, 'iphone-13', srv.base);
    await ctx.route('**/rest/v1/**', (r) => r.abort('internetdisconnected'));
    await page.goto(APP());
    await page.waitForSelector('[data-retry]', { timeout: 15000 });
    await shot(page, 'app-no-connection');
    await ctx.unroute('**/rest/v1/**');
    await page.click('[data-retry]');
    await page.waitForSelector('#onboard:not([hidden])', { timeout: 15000 });
    await ctx.close();
  });
});
