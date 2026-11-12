/** End-to-end tests of the creator dashboard, including its effect on the member app. */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { startTestServer, Client, FILES, ADMIN } from '../helpers.ts';
import { auditLayout, launch, newPage, shot } from './harness.ts';

let srv: Awaited<ReturnType<typeof startTestServer>>;
let browser: Browser;
const tmp = mkdtempSync(join(tmpdir(), 'pko-files-'));
const PNG = join(tmp, 'cover.png'); writeFileSync(PNG, FILES.png);
const WAV = join(tmp, 'song.wav'); writeFileSync(WAV, FILES.wav(3));
const TXT = join(tmp, 'notes.txt'); writeFileSync(TXT, 'not media');

before(async () => { srv = await startTestServer(); browser = await launch(); });
after(async () => { await browser?.close(); await srv?.close(); });

const STUDIO = () => srv.base + '/admin/';
async function login(page: Page) {
  await page.goto(STUDIO());
  await page.fill('[name=email]', ADMIN.email);
  await page.fill('[name=password]', ADMIN.password);
  await page.click('#loginForm button[type=submit]');
  await page.waitForSelector('.shell .stats');
}
/** Clears the current toast so the next expectation can't match a stale one. */
const clearToast = (page: Page) => page.evaluate(() => document.querySelector('#toast')?.classList.remove('on'));
async function toast(page: Page, re: RegExp) {
  await page.waitForFunction((src) => { const t = document.querySelector('#toast.on'); return !!t && new RegExp(src).test(t.textContent || ''); }, re.source, { timeout: 8000 });
}

describe('creator dashboard', () => {
  test('sign-in: wrong password shows an error; session survives reload; sign out', async () => {
    const { ctx, page, mon } = await newPage(browser, 'desktop', srv.base);
    await page.goto(STUDIO());
    await page.fill('[name=email]', ADMIN.email);
    await page.fill('[name=password]', 'wrong-password-123');
    await page.click('#loginForm button[type=submit]');
    await page.waitForSelector('[data-loginerr]:not([hidden])');
    assert.match((await page.textContent('[data-loginerr]'))!, /incorrect/);
    await login(page);
    await shot(page, 'studio-overview');
    await page.reload();
    await page.waitForSelector('.shell .stats');
    await page.click('[data-logout]');
    await page.waitForSelector('#loginForm');
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });

  test('publish a blog post with a photo upload → it appears in the member app', async () => {
    const { ctx, page, mon } = await newPage(browser, 'desktop', srv.base);
    await login(page);
    await page.click('a.qbtn[href="#/c/posts/new"]');
    await page.waitForSelector('[data-editor]');
    // required fields are enforced before sending
    await clearToast(page);
    await page.click('[data-editor] button[type=submit]');
    await toast(page, /required/);
    assert.ok(await page.locator('[data-err="title"]:not([hidden])').count());
    await page.fill('[data-path="title"]', 'Studio test post');
    await page.fill('[data-path="flair"]', 'Teaching');
    await page.fill('[data-path="ref"]', 'John 1:5');
    await page.fill('[data-path="body"]', 'The light shines in the darkness.\n\nAnd the darkness has not overcome it.');
    assert.match((await page.textContent('[data-wc="body"]'))!, /13 words/);
    // wrong file type for an image field
    await clearToast(page);
    await page.setInputFiles('[data-upload="image"]', WAV);
    await toast(page, /needs an image/);
    await page.setInputFiles('[data-upload="image"]', PNG);
    await page.waitForSelector('.mfield[data-path="image"].has img');
    await shot(page, 'studio-editor');
    expect(await auditLayout(page, 'studio-editor'));
    await clearToast(page);
    await page.click('[data-editor] button[type=submit]');
    await toast(page, /created/);
    await page.waitForFunction(() => /#\/c\/posts\/po_/.test(location.hash));
    // in the app
    const b = await new Client(srv.base).req('GET', '/api/bundle');
    const post = b.json.posts[0];
    assert.equal(post.title, 'Studio test post');
    assert.deepEqual(post.body, ['The light shines in the darkness.', 'And the darkness has not overcome it.']);
    assert.ok(post.image);
    // edit → unsaved-changes guard → save
    await page.fill('[data-path="title"]', 'Studio test post (edited)');
    await page.click('a[data-nav="#/media"]');
    await page.waitForSelector('dialog.dlg[open]');
    await page.click('dialog.dlg button[value=cancel]');
    await page.waitForFunction(() => /#\/c\/posts\/po_/.test(location.hash), null, { timeout: 3000 }).catch(() => assert.fail('stayed on the editor'));
    assert.equal(await page.inputValue('[data-path="title"]'), 'Studio test post (edited)', 'edits kept');
    await clearToast(page);
    await page.click('[data-editor] button[type=submit]');
    await toast(page, /Saved/);
    assert.equal((await new Client(srv.base).req('GET', '/api/bundle')).json.posts[0].title, 'Studio test post (edited)');
    // schedule into the future → disappears from the app until then
    await page.fill('#ed-pub', '2030-01-01T09:00');
    await clearToast(page);
    await page.click('[data-editor] button[type=submit]');
    await toast(page, /Saved/);
    assert.notEqual((await new Client(srv.base).req('GET', '/api/bundle')).json.posts[0].title, 'Studio test post (edited)');
    await page.goto(STUDIO() + '#/c/posts');
    await page.waitForSelector('.irow .pill.scheduled', { timeout: 5000 }).catch(async (e) => { await shot(page, 'FAIL-studio-scheduled'); throw e; });
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });

  test('album with audio: upload fills the duration; song plays in the app', async () => {
    const { ctx, page, mon } = await newPage(browser, 'desktop', srv.base);
    await login(page);
    await page.goto(STUDIO() + '#/c/albums/new');
    await page.waitForSelector('[data-editor]');
    await page.fill('[data-path="title"]', 'Studio Sessions');
    await page.setInputFiles('[data-upload="image"]', PNG);
    await page.waitForSelector('.mfield[data-path="image"].has');
    await page.click('[data-add="tracks"]');
    await page.fill('[data-path="tracks.0.title"]', 'Morning Praise');
    await page.setInputFiles('[data-upload="tracks.0.audio"]', WAV);
    await page.waitForSelector('.mfield[data-path="tracks.0.audio"].has audio');
    assert.equal(await page.inputValue('[data-path="tracks.0.duration"]'), '3');
    await page.click('[data-add="tracks"]');
    await page.fill('[data-path="tracks.1.title"]', 'Evening Hymn');
    await page.click('[data-move="tracks.1"][data-dir="-1"]');
    assert.equal(await page.inputValue('[data-path="tracks.0.title"]'), 'Evening Hymn', 'rows reorder');
    await clearToast(page);
    await page.click('[data-editor] button[type=submit]');
    await toast(page, /created/);
    const alb = (await new Client(srv.base).req('GET', '/api/bundle')).json.albums[0];
    assert.equal(alb.title, 'Studio Sessions');
    assert.deepEqual(alb.tracks.map((t: { title: string }) => t.title), ['Evening Hymn', 'Morning Praise']);
    assert.ok(alb.tracks[1].audio && alb.tracks[1].duration === 3);
    // the member app plays it
    const app = await newPage(browser, 'iphone-13', srv.base, { onboarded: true });
    await app.page.goto(srv.base + '/app/');
    await app.page.waitForSelector('#shell:not([hidden]) .tab');
    await app.page.click('.tab[data-go="library"]');
    await app.page.click('[data-libseg="Songs"]');
    await app.page.click('#songlist .track:has-text("Morning Praise")');
    await app.page.waitForSelector('#mini:not([hidden]) .tx:has-text("Morning Praise")');
    await app.page.waitForFunction(() => Number(document.querySelector<HTMLElement>('#miniProg')?.style.width.replace('%', '')) > 0, null, { timeout: 8000 });
    assert.deepEqual(app.mon.take(), []);
    await app.ctx.close();
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });

  test('testimony moderation: approve from the list', async () => {
    const m = new Client(srv.base); await m.signUp('Esther F.');
    await m.req('POST', '/api/testimonies', { title: 'Exam passed', body: 'I asked for prayer in the chat before my exam. I passed with distinction.' });
    const { ctx, page, mon } = await newPage(browser, 'desktop', srv.base);
    await login(page);
    await page.waitForSelector('a.attn');
    assert.equal((await page.textContent('[data-pending]'))!.trim(), '1');
    await page.click('a.attn');
    await page.waitForSelector('.irow:has-text("Exam passed") .pill.pending');
    await clearToast(page);
    await page.click('.irow:has-text("Exam passed") [data-to="published"]');
    await toast(page, /Published/);
    await page.waitForSelector('[data-pending][hidden]', { state: 'attached' });
    assert.ok((await m.req('GET', '/api/bundle')).json.testimonies.some((t: { title: string }) => t.title === 'Exam passed'));
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });

  test('live control: end and restart the service; moderate chat; members see it live', async () => {
    const { ctx, page, mon } = await newPage(browser, 'desktop', srv.base);
    await login(page);
    const app = await newPage(browser, 'pixel-7', srv.base, { onboarded: true });
    await app.page.goto(srv.base + '/app/');
    await app.page.waitForSelector('#shell:not([hidden]) .tab');
    await app.page.click('.tab[data-go="tv"]');
    await app.page.waitForSelector('.player .live-pill');
    await page.goto(STUDIO() + '#/live');
    await page.waitForSelector('.onair.on');
    await page.fill('[data-modchat] [name=body]', 'Prayer line opens at 21:00');
    await page.press('[data-modchat] [name=body]', 'Enter');
    await page.waitForSelector('[data-chatlog] .cmsg:has-text("Prayer line opens")');
    await app.page.click('[data-tvpane="chat"]');
    await app.page.waitForSelector('#chat .cmsg:has-text("Prayer line opens") b.mod');
    await shot(page, 'studio-live');
    await page.click('[data-onair="0"]');
    await clearToast(page);
    await page.click('dialog.dlg button[value=ok]');
    await toast(page, /ended/);
    await app.page.waitForSelector('.offair');
    await page.waitForSelector('[data-onair="1"]');
    await clearToast(page);
    await page.click('[data-onair="1"]');
    await toast(page, /live/);
    await app.page.waitForSelector('.player .live-pill');
    assert.deepEqual(app.mon.take(), []);
    await app.ctx.close();
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });

  test('media library: bulk upload, reject unsupported, delete warns when in use', async () => {
    const { ctx, page, mon } = await newPage(browser, 'desktop', srv.base);
    await login(page);
    await page.goto(STUDIO() + '#/media');
    await page.waitForSelector('.mgrid .mcard');
    const before = await page.locator('.mgrid .mcard').count();
    await page.setInputFiles('[data-bulk]', [PNG, TXT]);
    await page.waitForSelector('.uprow.bad');
    await toast(page, /1 file uploaded/);
    await page.waitForFunction((n) => document.querySelectorAll('.mgrid .mcard').length === n + 1, before);
    await page.click('[data-kind="audio"]');
    await page.waitForSelector('.seg button.on[data-kind="audio"]');
    await page.click('[data-kind=""]');
    // in-use file: warning names where it's used
    await page.click('.mcard:has-text("p_teal.webp") [data-delmedia]');
    await page.waitForSelector('dialog.dlg[open]');
    assert.match((await page.textContent('dialog.dlg p'))!, /still used by/);
    await page.click('dialog.dlg button[value=cancel]');
    await shot(page, 'studio-media');
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });

  test('settings, comments moderation, members block, team', async () => {
    const m = new Client(srv.base); await m.signUp('Loud Larry');
    const post = (await m.req('GET', '/api/bundle')).json.posts[0];
    await m.req('POST', '/api/comments', { target: post.id, body: 'Spam spam spam' });
    const { ctx, page, mon } = await newPage(browser, 'desktop', srv.base);
    await login(page);
    await page.goto(STUDIO() + '#/settings');
    await page.waitForSelector('[data-settings]');
    await page.fill('[data-path="tvName"]', 'Transfiguration TV+');
    await clearToast(page);
    await page.click('[data-settings] button[type=submit]');
    await toast(page, /Settings saved/);
    assert.equal((await m.req('GET', '/api/bundle')).json.settings.tvName, 'Transfiguration TV+');
    await page.goto(STUDIO() + '#/comments');
    await page.fill('[data-q]', 'spam');
    await page.waitForSelector('.crow:has-text("Spam spam spam")');
    await page.click('.crow [data-delc]');
    await clearToast(page);
    await page.click('dialog.dlg button[value=ok]');
    await toast(page, /removed/);
    await page.goto(STUDIO() + '#/members');
    await page.click('tr:has-text("Loud Larry") [data-ban]');
    await clearToast(page);
    await page.click('dialog.dlg button[value=ok]');
    await toast(page, /blocked/);
    assert.equal((await m.req('POST', '/api/comments', { target: post.id, body: 'again' })).status, 403);
    await page.goto(STUDIO() + '#/team');
    await page.fill('[data-addadmin] [name=name]', 'Deacon Paul');
    await page.fill('[data-addadmin] [name=email]', 'paul@church.org');
    await page.fill('[data-addadmin] [name=password]', 'temporary-pass-1');
    await clearToast(page);
    await page.click('[data-addadmin] button');
    await toast(page, /Access granted/);
    await page.waitForSelector('td:has-text("Deacon Paul")');
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });

  test('works on a phone: menu drawer, list and editor fit the screen', async () => {
    const { ctx, page, mon } = await newPage(browser, 'iphone-13', srv.base);
    await login(page);
    expect(await auditLayout(page, 'studio-phone-overview'));
    await page.click('[data-openside]');
    await page.click('a[data-nav="#/c/events"]');
    await page.waitForSelector('.irow');
    expect(await auditLayout(page, 'studio-phone-list'));
    await page.click('.irow .imain');
    await page.waitForSelector('[data-editor]');
    expect(await auditLayout(page, 'studio-phone-editor'));
    await shot(page, 'studio-phone-editor');
    assert.deepEqual(mon.take(), []);
    await ctx.close();
  });
});

function expect(found: string[]) { assert.deepEqual(found, [], found.join('\n')); }
