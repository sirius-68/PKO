import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Client, FILES, ADMIN } from '../helpers.ts';

let srv: Awaited<ReturnType<typeof startTestServer>>;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv.close(); });
const client = () => new Client(srv.base);

describe('public content', () => {
  test('health and bundle', async () => {
    const c = client();
    assert.equal((await c.req('GET', '/api/health')).json.ok, true);
    const b = await c.req('GET', '/api/bundle');
    assert.equal(b.status, 200);
    for (const k of ['posts', 'broadcasts', 'books', 'albums', 'events', 'testimonies', 'photos', 'schedule']) assert.ok(Array.isArray(b.json[k]) && b.json[k].length > 0, k);
    assert.equal(b.json.live.onAir, true);
    assert.ok(!('body' in b.json.books[0].chapters[0]), 'chapter bodies are not in the bundle');
    assert.ok(!('status' in b.json.posts[0]), 'internal fields stripped');
  });
  test('bundle ETag revalidation returns 304', async () => {
    const c = client();
    const b = await c.req('GET', '/api/bundle');
    const etag = b.headers.get('etag')!;
    const again = await c.req('GET', '/api/bundle', undefined, { 'If-None-Match': etag });
    assert.equal(again.status, 304);
  });
  test('chapter endpoint returns body; unknown chapter is 404', async () => {
    const c = client();
    const book = (await c.req('GET', '/api/bundle')).json.books[0];
    const ch = await c.req('GET', `/api/books/${book.id}/chapters/${book.chapters[0].id}`);
    assert.equal(ch.status, 200);
    assert.ok(ch.json.body.length > 0);
    assert.equal((await c.req('GET', `/api/books/${book.id}/chapters/nope`)).status, 404);
  });
  test('ics calendar file', async () => {
    const c = client();
    const ev = (await c.req('GET', '/api/bundle')).json.events[0];
    const r = await c.req('GET', `/api/events/${ev.id}.ics`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type')!, /text\/calendar/);
    assert.match(r.text, /BEGIN:VEVENT[\s\S]*DTSTART:20261113T210000[\s\S]*DTEND:20261114T040000/);
  });
  test('media serving supports ranges and blocks traversal', async () => {
    const c = client();
    const full = await fetch(srv.base + '/media/seed_v_rock.mp4', { method: 'HEAD' });
    assert.equal(full.status, 200);
    const part = await fetch(srv.base + '/media/seed_v_rock.mp4', { headers: { Range: 'bytes=0-1023' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 1024);
    assert.equal((await fetch(srv.base + '/media/seed_v_rock.mp4', { headers: { Range: 'bytes=999999999-' } })).status, 416);
    assert.equal((await c.req('GET', '/media/..%2Fpko.db')).status, 404);
    assert.equal((await c.req('GET', '/app/..%2F..%2Fserver%2Fdata%2Fpko.db')).status, 404);
  });
  test('CORS headers on public API, not on admin API', async () => {
    const pub = await fetch(srv.base + '/api/bundle', { headers: { Origin: 'capacitor://localhost' } });
    assert.equal(pub.headers.get('access-control-allow-origin'), '*');
    const adm = await fetch(srv.base + '/api/admin/me', { headers: { Origin: 'https://evil.example' } });
    assert.equal(adm.headers.get('access-control-allow-origin'), null);
    const pre = await fetch(srv.base + '/api/comments', { method: 'OPTIONS', headers: { Origin: 'capacitor://localhost' } });
    assert.equal(pre.status, 204);
  });
  test('unknown routes and wrong methods', async () => {
    const c = client();
    assert.equal((await c.req('GET', '/api/nope')).status, 404);
    assert.equal((await c.req('DELETE', '/api/bundle')).status, 405);
    assert.equal((await fetch(srv.base + '/', { redirect: 'manual' })).status, 302);
  });
  test('app & admin pages are served with a CSP', async () => {
    const r = await fetch(srv.base + '/app/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy')!, /script-src 'self'/);
    assert.equal((await fetch(srv.base + '/admin/')).status, 200);
  });
});

describe('admin auth', () => {
  test('rejects bad credentials and unauthenticated access', async () => {
    const c = client();
    assert.equal((await c.req('POST', '/api/admin/login', { email: ADMIN.email, password: 'wrong-password' })).status, 401);
    assert.equal((await c.req('POST', '/api/admin/login', { email: 'nobody@x.y', password: 'whatever12345' })).status, 401);
    assert.equal((await c.req('GET', '/api/admin/stats')).status, 401);
  });
  test('session cookie is HttpOnly + SameSite=Strict, and writes need the CSRF header', async () => {
    const c = client();
    const r = await c.loginAdmin();
    assert.match(r.headers.get('set-cookie')!, /HttpOnly; SameSite=Strict/);
    assert.equal((await c.req('GET', '/api/admin/stats')).status, 200);
    const noHeader = await c.req('POST', '/api/admin/items/posts', { title: 'x' });
    assert.equal(noHeader.status, 403);
    await c.admin('POST', '/api/admin/logout');
    assert.equal((await c.req('GET', '/api/admin/stats')).status, 401);
  });
  test('login is rate limited', async () => {
    const c = client();
    srv.app.deps.limiter.reset();
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await c.req('POST', '/api/admin/login', { email: 'x@y.z', password: 'nope-nope-nope' })).status;
    assert.equal(last, 429);
    srv.app.deps.limiter.reset();
  });
  test('team: add admin, weak password rejected, change password', async () => {
    const c = client(); await c.loginAdmin();
    assert.equal((await c.admin('POST', '/api/admin/admins', { email: 'new@x.org', name: 'New', password: 'short' })).status, 400);
    assert.equal((await c.admin('POST', '/api/admin/admins', { email: 'new@x.org', name: 'New', password: 'long-enough-pass' })).status, 201);
    assert.equal((await c.admin('POST', '/api/admin/admins', { email: 'NEW@x.org', name: 'Dup', password: 'long-enough-pass' })).status, 409);
    const n = client();
    assert.equal((await n.req('POST', '/api/admin/login', { email: 'new@x.org', password: 'long-enough-pass' })).status, 200);
    assert.equal((await n.admin('POST', '/api/admin/password', { current: 'bad', next: 'another-long-pass' })).status, 400);
    assert.equal((await n.admin('POST', '/api/admin/password', { current: 'long-enough-pass', next: 'another-long-pass' })).status, 200);
  });
});

describe('content management', () => {
  test('create validates against the schema', async () => {
    const c = client(); await c.loginAdmin();
    const bad = await c.admin('POST', '/api/admin/items/posts', { title: '' });
    assert.equal(bad.status, 422);
    assert.ok(bad.json.details.title && bad.json.details.body && bad.json.details.flair);
    const badMedia = await c.admin('POST', '/api/admin/items/posts', { title: 'T', flair: 'Teaching', body: 'x', image: 'does-not-exist.jpg' });
    assert.equal(badMedia.status, 422);
    assert.match(badMedia.json.details.image, /not found/);
    assert.equal((await c.admin('POST', '/api/admin/items/nope', {})).status, 404);
  });
  test('create → appears in bundle; draft and scheduled posts stay hidden', async () => {
    const c = client(); await c.loginAdmin();
    const live = await c.admin('POST', '/api/admin/items/posts', { title: 'Fresh word', flair: 'Teaching', body: 'Para one.\n\nPara two.' });
    assert.equal(live.status, 201);
    assert.deepEqual(live.json.item.body, ['Para one.', 'Para two.']);
    const draft = await c.admin('POST', '/api/admin/items/posts', { title: 'Draft word', flair: 'Teaching', body: 'x', status: 'draft' });
    const later = await c.admin('POST', '/api/admin/items/posts', { title: 'Future word', flair: 'Teaching', body: 'x', publishedAt: new Date(Date.now() + 864e5).toISOString() });
    const titles = (await c.req('GET', '/api/bundle')).json.posts.map((p: any) => p.title);
    assert.equal(titles[0], 'Fresh word');
    assert.ok(!titles.includes('Draft word') && !titles.includes('Future word'));
    // publish the draft
    await c.admin('PATCH', `/api/admin/items/posts/${draft.json.item.id}`, { status: 'published' });
    assert.ok((await c.req('GET', '/api/bundle')).json.posts.some((p: any) => p.title === 'Draft word'));
    await c.admin('DELETE', `/api/admin/items/posts/${later.json.item.id}`);
  });
  test('update merges partial fields; delete removes comments too', async () => {
    const c = client(); await c.loginAdmin();
    const it = (await c.admin('POST', '/api/admin/items/events', { title: 'Picnic', date: '2026-12-01', time: '10:00', place: 'Park', description: 'Bring food' })).json.item;
    const up = await c.admin('PATCH', `/api/admin/items/events/${it.id}`, { place: 'Church grounds' });
    assert.equal(up.json.item.title, 'Picnic');
    assert.equal(up.json.item.place, 'Church grounds');
    assert.equal((await c.admin('PATCH', `/api/admin/items/events/${it.id}`, { date: '13/12/2026' })).status, 422);
    assert.equal((await c.admin('DELETE', `/api/admin/items/events/${it.id}`)).status, 200);
    assert.equal((await c.admin('DELETE', `/api/admin/items/events/${it.id}`)).status, 404);
  });
  test('list rows (album tracks) get stable ids and validate each row', async () => {
    const c = client(); await c.loginAdmin();
    const img = (await c.admin('PUT', '/api/admin/media?name=c.png', FILES.png, { 'Content-Type': 'image/png' })).json.media.id;
    const bad = await c.admin('POST', '/api/admin/items/albums', { title: 'A', artist: 'B', image: img, tracks: [{ title: '' }] });
    assert.equal(bad.status, 422);
    assert.ok(bad.json.details['tracks.0.title']);
    const ok = await c.admin('POST', '/api/admin/items/albums', { title: 'A', artist: 'B', image: img, tracks: [{ title: 'One' }, { title: 'Two' }] });
    const ids = ok.json.item.tracks.map((t: any) => t.id);
    assert.equal(new Set(ids).size, 2);
    const again = await c.admin('PATCH', `/api/admin/items/albums/${ok.json.item.id}`, { tracks: ok.json.item.tracks.reverse() });
    assert.deepEqual(again.json.item.tracks.map((t: any) => t.id), [...ids].reverse(), 'ids survive reordering');
  });
  test('manual reorder (books)', async () => {
    const c = client(); await c.loginAdmin();
    const books = (await c.admin('GET', '/api/admin/items/books')).json.items;
    const ids = books.map((b: any) => b.id).reverse();
    await c.admin('POST', '/api/admin/items/books/reorder', { ids });
    assert.deepEqual((await c.req('GET', '/api/bundle')).json.books.map((b: any) => b.id), ids);
  });
  test('settings and live state', async () => {
    const c = client(); await c.loginAdmin();
    assert.equal((await c.admin('PUT', '/api/admin/settings', { appName: '' })).status, 422);
    assert.equal((await c.admin('PUT', '/api/admin/settings', { leader: 'Prophet K.' })).json.settings.leader, 'Prophet K.');
    await c.admin('PUT', '/api/admin/live', { onAir: false });
    assert.equal((await c.req('GET', '/api/bundle')).json.live.onAir, false);
    await c.admin('PUT', '/api/admin/live', { onAir: true });
    await c.admin('PUT', '/api/admin/settings', { leader: 'Prophet Kevin' });
  });
});

describe('uploads', () => {
  test('accepts real files, rejects spoofed and unsupported types', async () => {
    const c = client(); await c.loginAdmin();
    const ok = await c.admin('PUT', '/api/admin/media?name=pic.png', FILES.png, { 'Content-Type': 'image/png' });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.media.kind, 'image');
    const spoof = await c.admin('PUT', '/api/admin/media?name=x.png', new TextEncoder().encode('<script>alert(1)</script>'), { 'Content-Type': 'image/png' });
    assert.equal(spoof.status, 415);
    const svg = await c.admin('PUT', '/api/admin/media?name=x.svg', new TextEncoder().encode('<svg/>'), { 'Content-Type': 'image/svg+xml' });
    assert.equal(svg.status, 415);
    const empty = await c.admin('PUT', '/api/admin/media?name=x.png', new Uint8Array(0), { 'Content-Type': 'image/png' });
    assert.equal(empty.status, 400);
    const wav = await c.admin('PUT', '/api/admin/media?name=tone.wav', FILES.wav(), { 'Content-Type': 'audio/wav' });
    assert.equal(wav.json.media.kind, 'audio');
  });
  test('size limit enforced', async () => {
    const c = client(); await c.loginAdmin();
    const big = new Uint8Array(6e6); big.set(FILES.png.subarray(0, 8));
    const r = await c.admin('PUT', '/api/admin/media?name=big.png', big, { 'Content-Type': 'image/png' });
    assert.equal(r.status, 413);
  });
  test('deleting in-use media needs force', async () => {
    const c = client(); await c.loginAdmin();
    const usage = await c.admin('GET', '/api/admin/media/seed_p_teal.webp/usage');
    assert.ok(usage.json.usedBy.length > 0);
    assert.equal((await c.admin('DELETE', '/api/admin/media/seed_p_teal.webp')).status, 409);
    const free = (await c.admin('PUT', '/api/admin/media?name=free.png', FILES.png, { 'Content-Type': 'image/png' })).json.media.id;
    assert.equal((await c.admin('DELETE', `/api/admin/media/${free}`)).status, 200);
    assert.equal((await c.req('GET', `/media/${free}`)).status, 404);
  });
  test('members can only upload videos, within their smaller limit', async () => {
    const m = client(); await m.signUp();
    const img = await m.req('PUT', '/api/uploads?name=x.png', FILES.png, { 'Content-Type': 'image/png' });
    assert.equal(img.status, 415);
    const anon = client();
    assert.equal((await anon.req('PUT', '/api/uploads?name=x.mp4', FILES.png, { 'Content-Type': 'video/mp4' })).status, 401);
  });
});

describe('members, comments, amens, testimonies', () => {
  test('sign up validates input; token works; sign out revokes it', async () => {
    const c = client();
    assert.equal((await c.req('POST', '/api/members', { name: 'A' })).status, 400);
    assert.equal((await c.req('POST', '/api/members', { name: 'Ann', phone: 'abc' })).status, 400);
    await c.signUp('Ann Member');
    assert.equal((await c.req('GET', '/api/me')).json.member.name, 'Ann Member');
    assert.equal((await c.req('PATCH', '/api/me', { name: 'Ann M.' })).json.member.name, 'Ann M.');
    await c.req('DELETE', '/api/me/session');
    assert.equal((await c.req('GET', '/api/me')).status, 401);
  });
  test('comments: auth required, validation, threading, delete own only', async () => {
    const pub = client();
    const post = (await pub.req('GET', '/api/bundle')).json.posts[0];
    assert.equal((await pub.req('POST', '/api/comments', { target: post.id, body: 'hi' })).status, 401);
    const a = client(); await a.signUp('Alice');
    const b = client(); await b.signUp('Bob');
    assert.equal((await a.req('POST', '/api/comments', { target: post.id, body: '   ' })).status, 400);
    assert.equal((await a.req('POST', '/api/comments', { target: post.id, body: 'x'.repeat(1001) })).status, 400);
    assert.equal((await a.req('POST', '/api/comments', { target: 'nope', body: 'hi' })).status, 404);
    const top = (await a.req('POST', '/api/comments', { target: post.id, body: '<img src=x onerror=alert(1)> Amen' })).json.comment;
    const reply = (await b.req('POST', '/api/comments', { target: post.id, body: 'Amen too', parentId: top.id })).json.comment;
    const reply2 = (await a.req('POST', '/api/comments', { target: post.id, body: 'nested', parentId: reply.id })).json.comment;
    assert.equal(reply2.parentId, top.id, 'replies flatten to one level');
    const list = (await pub.req('GET', `/api/comments?target=${post.id}`)).json.comments;
    assert.equal(list.length, 3);
    assert.equal(list[0].body, '<img src=x onerror=alert(1)> Amen', 'stored verbatim; the app escapes on render');
    assert.equal((await b.req('DELETE', `/api/comments/${top.id}`)).status, 404, "can't delete someone else's comment");
    assert.equal((await a.req('DELETE', `/api/comments/${top.id}`)).status, 200);
    assert.equal((await pub.req('GET', `/api/comments?target=${post.id}`)).json.comments.length, 0, 'replies removed with parent');
  });
  test('amens toggle per device and are counted in the bundle', async () => {
    const a = client(), b = client();
    const post = (await a.req('GET', '/api/bundle')).json.posts[1];
    assert.equal((await a.req('POST', '/api/amens', { target: post.id })).json.count, 1);
    assert.equal((await a.req('POST', '/api/amens', { target: post.id, on: true })).json.count, 1, 'idempotent');
    assert.equal((await b.req('POST', '/api/amens', { target: post.id })).json.count, 2);
    assert.equal((await a.req('POST', '/api/amens', { target: post.id })).json.on, false);
    assert.equal((await b.req('GET', '/api/bundle')).json.amens[post.id], 1);
    assert.deepEqual((await b.req('GET', '/api/amens/mine')).json.targets, [post.id]);
    assert.equal((await a.req('POST', '/api/amens', { target: 'gallery:Services' })).status, 200);
    assert.equal((await a.req('POST', '/api/amens', { target: 'ghost-item' })).status, 404);
    const noDevice = await fetch(srv.base + '/api/amens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: post.id }) });
    assert.equal(noDevice.status, 400);
  });
  test('testimony goes to moderation, then appears once approved', async () => {
    const m = client(); await m.signUp('Joy');
    const r = await m.req('POST', '/api/testimonies', { title: 'God provided', body: 'I lost my job. Two weeks later a better one came.', place: 'Kumba' });
    assert.equal(r.status, 201);
    assert.equal(r.json.status, 'pending');
    const pub = client();
    assert.ok(!(await pub.req('GET', '/api/bundle')).json.testimonies.some((t: any) => t.title === 'God provided'));
    const adm = client(); await adm.loginAdmin();
    assert.equal((await adm.admin('GET', '/api/admin/stats')).json.pendingTestimonies, 1);
    await adm.admin('PATCH', `/api/admin/items/testimonies/${r.json.id}`, { status: 'published' });
    const t = (await pub.req('GET', '/api/bundle')).json.testimonies.find((x: any) => x.title === 'God provided');
    assert.equal(t.name, 'Joy');
    assert.equal(t.quote, 'I lost my job.');
  });
  test('blocked members cannot post', async () => {
    const m = client(); const me = (await m.signUp('Spammer')).json.member;
    const adm = client(); await adm.loginAdmin();
    await adm.admin('POST', `/api/admin/members/${me.id}/ban`, { banned: true });
    const post = (await m.req('GET', '/api/bundle')).json.posts[0];
    assert.equal((await m.req('POST', '/api/comments', { target: post.id, body: 'buy now' })).status, 403);
  });
});

describe('live room (SSE)', () => {
  test('hello, viewer count, chat message, moderator delete', async () => {
    const ctl = new AbortController();
    const res = await fetch(srv.base + '/api/live/stream', { signal: ctl.signal });
    assert.match(res.headers.get('content-type')!, /text\/event-stream/);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const waitFor = async (event: string) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const i = buf.indexOf(`event: ${event}\n`);
        if (i >= 0) { const end = buf.indexOf('\n\n', i); if (end > 0) { const frame = buf.slice(i, end); buf = buf.slice(end + 2); return JSON.parse(frame.split('\ndata: ')[1]); } }
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value);
      }
      throw new Error('timed out waiting for ' + event);
    };
    const hello = await waitFor('hello');
    assert.equal(hello.viewers, 1);
    assert.equal(hello.live.onAir, true);
    const m = client(); await m.signUp('Chatter');
    assert.equal((await m.req('POST', '/api/live/chat', { body: '' })).status, 400);
    const sent = (await m.req('POST', '/api/live/chat', { body: 'Amen from Douala' })).json.message;
    const got = await waitFor('message');
    assert.equal(got.body, 'Amen from Douala');
    const adm = client(); await adm.loginAdmin();
    await adm.admin('DELETE', `/api/admin/chat/${sent.id}`);
    assert.equal((await waitFor('delete')).id, sent.id);
    await adm.admin('POST', '/api/admin/chat', { body: 'Welcome family', name: 'Pastor Ruth' });
    const mod = await waitFor('message');
    assert.equal(mod.isMod, true);
    ctl.abort();
  });
});
