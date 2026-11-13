/**
 * Backend tests: the real Supabase migration (tables, RLS, storage policies, RPCs)
 * running on Postgres behind the local Supabase emulator.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, Client, FILES, ADMIN } from './helpers.ts';

let srv: Awaited<ReturnType<typeof startTestServer>>;
before(async () => { srv = await startTestServer(); });
after(async () => { await srv?.close(); });
const client = () => new Client(srv.base);

describe('public content', () => {
  test('bundle: everything published, chapter bodies left out', async () => {
    const b = await client().bundle();
    for (const k of ['posts', 'broadcasts', 'books', 'albums', 'events', 'testimonies', 'photos', 'schedule']) assert.ok(b[k].length > 0, k);
    assert.equal(b.live.onAir, true);
    assert.ok(!('body' in b.books[0].chapters[0]));
    assert.ok(!('status' in b.posts[0]), 'internal fields stripped');
    assert.ok(b.events.every((e: { date: string }, i: number, a: { date: string }[]) => i === 0 || a[i - 1].date <= e.date), 'events in date order');
  });
  test('chapter text by id; unknown chapter → 404', async () => {
    const c = client();
    const book = (await c.bundle()).books[0];
    assert.ok((await c.rpcOk('get_chapter', { p_book: book.id, p_chapter: book.chapters[0].id })).body.length > 0);
    assert.equal((await c.rpc('get_chapter', { p_book: book.id, p_chapter: 'nope' })).status, 404);
  });
  test('guests cannot read tables they should not (RLS)', async () => {
    const rows = await srv.emu.asCaller({ role: 'anon' }, 'select count(*) as n from public.media');
    assert.equal(rows[rows.length - 1].n, '0', 'media registry hidden');
    const prof = await srv.emu.asCaller({ role: 'anon' }, 'select count(*) as n from public.profiles');
    assert.equal(prof[prof.length - 1].n, '0');
    await assert.rejects(srv.emu.asCaller({ role: 'anon' }, `insert into public.items (id, collection, data) values ('x', 'posts', '{}')`), /row-level security/);
  });
  test('signed-in members cannot write content directly either', async () => {
    const m = client(); await m.signUp('Direct Writer');
    await assert.rejects(srv.emu.asCaller({ role: 'authenticated', sub: m.userId }, `insert into public.items (id, collection, data) values ('x', 'posts', '{}')`), /row-level security/);
    await assert.rejects(srv.emu.asCaller({ role: 'authenticated', sub: m.userId }, `insert into public.admins (user_id, email, name) values ('${m.userId}', 'x@y', 'x')`), /row-level security/);
    const upd = await srv.emu.asCaller({ role: 'authenticated', sub: m.userId }, `update public.settings set value = '{}' returning key`);
    assert.equal(upd.filter((r) => 'key' in r).length, 0, 'RLS: no settings rows updated');
  });
  test('internal helper functions are not callable through the API', async () => {
    assert.equal((await client().rpc('_settings')).status, 404);
    await assert.rejects(srv.emu.asCaller({ role: 'anon' }, `select public._rate_limit('x', 1, '1 minute')`), /permission denied/);
  });
  test('scheduled and draft posts stay hidden until published', async () => {
    const a = srv.admin;
    const future = await a.rpcOk('admin_save', { p_collection: 'posts', p_id: null, p_data: { title: 'Tomorrow', flair: 'Teaching', body: ['x'] }, p_published_at: new Date(Date.now() + 864e5).toISOString() });
    const draft = await a.rpcOk('admin_save', { p_collection: 'posts', p_id: null, p_data: { title: 'Draft one', flair: 'Teaching', body: ['x'] }, p_status: 'draft' });
    const titles = () => client().bundle().then((b) => b.posts.map((p: { title: string }) => p.title));
    assert.ok(!(await titles()).includes('Tomorrow') && !(await titles()).includes('Draft one'));
    await a.rpcOk('admin_save', { p_collection: 'posts', p_id: draft.id, p_data: {}, p_status: 'published' });
    assert.ok((await titles()).includes('Draft one'));
    await a.rpcOk('admin_delete', { p_collection: 'posts', p_id: future.id });
  });
});

describe('dashboard functions', () => {
  test('only admins: guests 401, members 403', async () => {
    const m = client(); await m.signUp('Not Admin');
    for (const fn of ['admin_stats', 'admin_members', 'admin_team', 'admin_list_media']) {
      assert.equal((await client().rpc(fn)).status, 401, fn);
      assert.equal((await m.rpc(fn)).status, 403, fn);
    }
    assert.equal((await m.rpc('admin_save', { p_collection: 'posts', p_id: null, p_data: { title: 'x', flair: 'x', body: ['x'] } })).status, 403);
  });
  test('first-owner claim only works once', async () => {
    const x = client(); await x.signUpEmail('second@test.local', 'long-enough-password');
    const r = await x.rpc('claim_first_admin', { p_name: 'Sneaky' });
    assert.equal(r.status, 403);
    assert.match(r.json.message, /already has an owner/);
    const anonUser = client(); await anonUser.anon();
    assert.equal((await anonUser.rpc('claim_first_admin', { p_name: 'Anon' })).status, 403);
  });
  test('team: grant access by email, revoke; cannot revoke yourself', async () => {
    const a = srv.admin;
    assert.equal((await a.rpc('admin_grant', { p_email: 'nobody@x.org', p_name: 'N' })).status, 404);
    const n = client(); await n.signUpEmail('deacon@test.local', 'long-enough-password');
    assert.equal((await n.rpc('admin_stats')).status, 403);
    await a.rpcOk('admin_grant', { p_email: 'DEACON@test.local', p_name: 'Deacon' });
    assert.equal((await n.rpc('admin_stats')).status, 200);
    assert.equal((await a.rpc('admin_grant', { p_email: 'deacon@test.local', p_name: 'Deacon' })).status, 409);
    assert.equal((await a.rpc('admin_revoke', { p_user: a.userId })).status, 400);
    await a.rpcOk('admin_revoke', { p_user: n.userId });
    assert.equal((await n.rpc('admin_stats')).status, 403);
  });
  test('validation: required fields, unknown files, list rows, dates', async () => {
    const a = srv.admin;
    const bad = await a.rpc('admin_save', { p_collection: 'posts', p_id: null, p_data: { title: '' } });
    assert.equal(bad.status, 400);
    const d = JSON.parse(bad.json.details);
    assert.ok(d.title && d.flair && d.body);
    const ghost = await a.rpc('admin_save', { p_collection: 'posts', p_id: null, p_data: { title: 'T', flair: 'Teaching', body: ['x'], image: 'uploads/nope.jpg' } });
    assert.match(JSON.parse(ghost.json.details).image, /not found/);
    const img = await a.uploadMedia('c.png', FILES.png, 'image/png');
    const rows = await a.rpc('admin_save', { p_collection: 'albums', p_id: null, p_data: { title: 'A', artist: 'B', image: img, tracks: [{ title: '' }] } });
    assert.ok(JSON.parse(rows.json.details)['tracks.0.title']);
    const date = await a.rpc('admin_save', { p_collection: 'events', p_id: null, p_data: { title: 'E', date: '13/12/2026', time: '10:00', place: 'P', description: 'D' } });
    assert.ok(JSON.parse(date.json.details).date);
    assert.equal((await a.rpc('admin_save', { p_collection: 'nope', p_id: null, p_data: {} })).status, 404);
  });
  test('list rows get stable ids that survive reordering; partial updates merge', async () => {
    const a = srv.admin;
    const img = await a.uploadMedia('c2.png', FILES.png, 'image/png');
    const alb = await a.rpcOk('admin_save', { p_collection: 'albums', p_id: null, p_data: { title: 'A', artist: 'B', image: img, tracks: [{ title: 'One' }, { title: 'Two' }] } });
    const ids = alb.tracks.map((t: { id: string }) => t.id);
    assert.equal(new Set(ids).size, 2);
    const again = await a.rpcOk('admin_save', { p_collection: 'albums', p_id: alb.id, p_data: { tracks: [...alb.tracks].reverse() } });
    assert.deepEqual(again.tracks.map((t: { id: string }) => t.id), [...ids].reverse());
    assert.equal(again.title, 'A', 'other fields kept');
  });
  test('manual order for books', async () => {
    const a = srv.admin;
    const books = await a.rpcOk('admin_list', { p_collection: 'books' });
    const ids = books.map((b: { id: string }) => b.id).reverse();
    await a.rpcOk('admin_reorder', { p_collection: 'books', p_ids: ids });
    assert.deepEqual((await client().bundle()).books.map((b: { id: string }) => b.id), ids);
  });
  test('settings and live validation', async () => {
    const a = srv.admin;
    assert.equal((await a.rpc('admin_save_settings', { p: { appName: '' } })).status, 400);
    assert.equal((await a.rpcOk('admin_save_settings', { p: { leader: 'Prophet K.' } })).leader, 'Prophet K.');
    await a.rpcOk('admin_save_settings', { p: { leader: 'Prophet Kevin' } });
    assert.equal((await a.rpc('admin_save_live', { p: { url: 'http://insecure.example/live.m3u8' } })).status, 400);
    assert.equal((await a.rpc('admin_save_live', { p: { onAir: true, video: null, url: '' } })).status, 400, "can't go live with nothing to show");
  });
  test('media in use cannot be deleted without force', async () => {
    const a = srv.admin;
    const used = await a.rpcOk('admin_media_usage', { p_id: 'seed/p_teal.webp' });
    assert.ok(used.length > 0);
    assert.equal((await a.rpc('admin_delete_media', { p_id: 'seed/p_teal.webp', p_force: false })).status, 409);
    const free = await a.uploadMedia('free.png', FILES.png, 'image/png');
    await a.rpcOk('admin_delete_media', { p_id: free, p_force: false });
  });
  test('stats', async () => {
    const s = await srv.admin.rpcOk('admin_stats');
    assert.equal(s.items.posts.published >= 6, true);
    assert.equal(typeof s.media.bytes, 'number');
  });
});

describe('storage policies', () => {
  test('guests cannot upload; members only into their own folder; admins anywhere', async () => {
    const g = client();
    assert.equal((await g.upload('uploads/x.png', FILES.png, 'image/png')).status, 403);
    const m = client(); await m.signUp('Uploader');
    assert.equal((await m.upload('uploads/x.png', FILES.png, 'image/png')).status, 403);
    const other = client(); await other.signUp('Other');
    assert.equal((await m.upload(`members/${other.userId}/v.mp4`, FILES.png, 'video/mp4')).status, 403, "not someone else's folder");
    assert.equal((await m.upload(`members/${m.userId}/v.mp4`, FILES.png, 'video/mp4')).status, 200);
    assert.equal((await srv.admin.upload('uploads/ok.png', FILES.png, 'image/png')).status, 200);
  });
  test('unsupported types are refused by the bucket', async () => {
    assert.equal((await srv.admin.upload('uploads/x.svg', new TextEncoder().encode('<svg/>'), 'image/svg+xml')).status, 415);
    assert.equal((await srv.admin.upload('uploads/x.html', new TextEncoder().encode('<script>'), 'text/html')).status, 415);
  });
  test('members can only delete nothing; admins can delete', async () => {
    const m = client(); await m.signUp('Deleter');
    const r = await m.http('DELETE', '/storage/v1/object/media', { prefixes: ['seed/p_teal.webp'] });
    assert.deepEqual(r.json, [], 'RLS: nothing deleted');
    assert.equal((await fetch(srv.base + '/storage/v1/object/public/media/seed/p_teal.webp')).status, 200);
  });
  test('public files support ranged reads (video seeking)', async () => {
    const part = await fetch(srv.base + '/storage/v1/object/public/media/seed/v_rock.mp4', { headers: { Range: 'bytes=0-1023' } });
    assert.equal(part.status, 206);
    assert.equal((await part.arrayBuffer()).byteLength, 1024);
  });
});

describe('members: profile, Amens, comments, testimonies, chat', () => {
  test('profile validation', async () => {
    const c = client(); await c.anon();
    assert.equal((await c.rpc('set_profile', { p_name: 'A' })).status, 400);
    assert.equal((await c.rpc('set_profile', { p_name: 'Ann', p_phone: 'abc' })).status, 400);
    assert.equal((await c.rpcOk('set_profile', { p_name: '  Ann   Member ' })).name, 'Ann Member');
    assert.equal((await client().rpc('set_profile', { p_name: 'No Session' })).status, 401);
  });
  test('Amens toggle per person and are counted', async () => {
    const a = client(), b = client(); await a.anon(); await b.anon();
    const post = (await a.bundle()).posts[1];
    assert.equal((await a.rpcOk('toggle_amen', { p_target: post.id })).count, 1);
    assert.equal((await a.rpcOk('toggle_amen', { p_target: post.id, p_on: true })).count, 1, 'idempotent');
    assert.equal((await b.rpcOk('toggle_amen', { p_target: post.id })).count, 2);
    assert.equal((await a.rpcOk('toggle_amen', { p_target: post.id })).on, false);
    assert.equal((await b.bundle()).amens[post.id], 1);
    assert.deepEqual(await b.rpcOk('my_amens'), [post.id]);
    assert.equal((await a.rpc('toggle_amen', { p_target: 'gallery:Services' })).status, 200);
    assert.equal((await a.rpc('toggle_amen', { p_target: 'ghost-item' })).status, 404);
    assert.equal((await client().rpc('toggle_amen', { p_target: post.id })).status, 401, 'needs a session');
  });
  test('comments: validation, threading, delete own only, escaped by the app', async () => {
    const post = (await client().bundle()).posts[0];
    const anonOnly = client(); await anonOnly.anon();
    assert.equal((await anonOnly.rpc('post_comment', { p_target: post.id, p_body: 'hi' })).status, 403, 'needs a name first');
    const a = client(); await a.signUp('Alice');
    const b = client(); await b.signUp('Bob');
    assert.equal((await a.rpc('post_comment', { p_target: post.id, p_body: '   ' })).status, 400);
    assert.equal((await a.rpc('post_comment', { p_target: post.id, p_body: 'x'.repeat(1001) })).status, 400);
    assert.equal((await a.rpc('post_comment', { p_target: 'nope', p_body: 'hi' })).status, 404);
    const top = await a.rpcOk('post_comment', { p_target: post.id, p_body: '<img src=x onerror=alert(1)> Amen' });
    const reply = await b.rpcOk('post_comment', { p_target: post.id, p_body: 'Amen too', p_parent: top.id });
    const nested = await a.rpcOk('post_comment', { p_target: post.id, p_body: 'nested', p_parent: reply.id });
    assert.equal(nested.parentId, top.id, 'one level of threading');
    assert.equal((await client().rpcOk('get_comments', { p_target: post.id })).length, 3);
    assert.equal((await b.rpc('delete_comment', { p_id: top.id })).status, 404);
    await a.rpcOk('delete_comment', { p_id: top.id });
    assert.equal((await client().rpcOk('get_comments', { p_target: post.id })).length, 0, 'replies go with it');
  });
  test('comment rate limit', async () => {
    const post = (await client().bundle()).posts[2];
    const a = client(); await a.signUp('Fast Typer');
    let last = 0;
    for (let i = 0; i < 13; i++) last = (await a.rpc('post_comment', { p_target: post.id, p_body: 'Amen ' + i })).status;
    assert.equal(last, 429);
  });
  test('testimony → pending → approved → visible', async () => {
    const m = client(); await m.signUp('Joy');
    assert.equal((await m.rpc('submit_testimony', { p_title: 'x', p_body: 'too short' })).status, 400);
    const r = await m.rpcOk('submit_testimony', { p_title: 'God provided', p_body: 'I lost my job. Two weeks later a better one came.', p_place: 'Kumba' });
    assert.equal(r.status, 'pending');
    assert.ok(!(await client().bundle()).testimonies.some((t: { title: string }) => t.title === 'God provided'));
    assert.equal((await srv.admin.rpcOk('admin_stats')).pendingTestimonies, 1);
    await srv.admin.rpcOk('admin_save', { p_collection: 'testimonies', p_id: r.id, p_data: {}, p_status: 'published' });
    const t = (await client().bundle()).testimonies.find((x: { title: string }) => x.title === 'God provided');
    assert.equal(t.name, 'Joy');
    assert.equal(t.quote, 'I lost my job.');
  });
  test('testimony video must be the member’s own upload', async () => {
    const m = client(); await m.signUp('Video Person');
    assert.equal((await m.rpc('register_member_upload', { p_path: 'uploads/hack.mp4', p_mime: 'video/mp4', p_size: 1, p_name: 'x' })).status, 400);
    await m.upload(`members/${m.userId}/clip.mp4`, FILES.png, 'video/mp4');
    const id = (await m.rpcOk('register_member_upload', { p_path: `members/${m.userId}/clip.mp4`, p_mime: 'video/mp4', p_size: 10, p_name: 'clip.mp4' })).id;
    const other = client(); await other.signUp('Thief');
    assert.equal((await other.rpc('submit_testimony', { p_title: 'Mine', p_body: 'This is my testimony and it is long enough.', p_video: id })).status, 400);
    assert.equal((await m.rpc('submit_testimony', { p_title: 'Mine', p_body: 'This is my testimony and it is long enough.', p_video: id })).status, 200);
  });
  test('blocked members cannot post', async () => {
    const m = client(); await m.signUp('Spammer');
    await srv.admin.rpcOk('admin_ban', { p_user: m.userId, p_banned: true });
    const post = (await m.bundle()).posts[0];
    assert.equal((await m.rpc('post_comment', { p_target: post.id, p_body: 'buy now' })).status, 403);
    assert.equal((await m.rpc('post_chat', { p_body: 'buy now' })).status, 403);
  });
  test('chat: validation, moderator posts, soft delete wipes text', async () => {
    const m = client(); await m.signUp('Chatter');
    assert.equal((await m.rpc('post_chat', { p_body: '' })).status, 400);
    assert.equal((await m.rpc('post_chat', { p_body: 'x'.repeat(301) })).status, 400);
    const msg = await m.rpcOk('post_chat', { p_body: 'Amen from Douala' });
    const mod = await srv.admin.rpcOk('admin_chat_post', { p_body: 'Welcome family', p_name: 'Pastor Ruth' });
    assert.equal(mod.isMod, true);
    await srv.admin.rpcOk('admin_chat_delete', { p_id: msg.id });
    const live = await client().rpcOk('get_live');
    assert.ok(!live.messages.some((x: { id: number }) => x.id === msg.id));
    const raw = await srv.emu.asCaller({ role: 'anon' }, `select body from public.chat where id = ${msg.id}`);
    assert.equal(raw[raw.length - 1].body, '', 'removed text is gone, even for direct reads');
  });
});

describe('realtime (live room)', () => {
  test('chat inserts, deletes and live changes arrive over the websocket; presence counts viewers', async () => {
    const ws = new WebSocket(srv.base.replace('http', 'ws') + `/realtime/v1/websocket?apikey=${encodeURIComponent((await import('../supabase/local/emulator.ts')).ANON_KEY)}&vsn=1.0.0`);
    const inbox: { event: string; payload: any }[] = [];
    ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
    await new Promise((r) => { ws.onopen = r; });
    const waitFor = async (pred: (m: { event: string; payload: any }) => boolean) => {
      const end = Date.now() + 4000;
      while (Date.now() < end) { const i = inbox.findIndex(pred); if (i >= 0) return inbox.splice(i, 1)[0]; await new Promise((r) => setTimeout(r, 25)); }
      throw new Error('timeout');
    };
    ws.send(JSON.stringify({ topic: 'realtime:live-room', event: 'phx_join', ref: '1', join_ref: '1', payload: { config: { presence: { key: 'me' }, postgres_changes: [{ event: '*', schema: 'public', table: 'chat' }, { event: '*', schema: 'public', table: 'settings' }] } } }));
    assert.equal((await waitFor((m) => m.event === 'phx_reply')).payload.status, 'ok');
    ws.send(JSON.stringify({ topic: 'realtime:live-room', event: 'presence', ref: '2', payload: { type: 'presence', event: 'track', payload: { at: 1 } } }));
    assert.ok((await waitFor((m) => m.event === 'presence_diff')).payload.joins.me);
    const m = client(); await m.signUp('RT');
    await m.rpcOk('post_chat', { p_body: 'Hallelujah' });
    const ins = await waitFor((x) => x.event === 'postgres_changes' && x.payload.data.type === 'INSERT');
    assert.equal(ins.payload.data.record.body, 'Hallelujah');
    await srv.admin.rpcOk('admin_chat_delete', { p_id: ins.payload.data.record.id });
    const del = await waitFor((x) => x.event === 'postgres_changes' && x.payload.data.type === 'UPDATE' && x.payload.data.table === 'chat');
    assert.equal(del.payload.data.record.deleted, true);
    await srv.admin.rpcOk('admin_save_live', { p: { onAir: false } });
    const live = await waitFor((x) => x.event === 'postgres_changes' && x.payload.data.table === 'settings');
    assert.equal(live.payload.data.record.value.onAir, false);
    await srv.admin.rpcOk('admin_save_live', { p: { onAir: true } });
    ws.close();
  });
});

describe('auth', () => {
  test('wrong password rejected; password change works', async () => {
    const c = client();
    const bad = await c.http('POST', '/auth/v1/token?grant_type=password', { email: ADMIN.email, password: 'wrong' });
    assert.equal(bad.status, 400);
    const u = client(); await u.signUpEmail('pw@test.local', 'first-password-1');
    assert.equal((await u.http('PUT', '/auth/v1/user', { password: 'second-password-2' })).status, 200);
    assert.equal((await client().http('POST', '/auth/v1/token?grant_type=password', { email: 'pw@test.local', password: 'second-password-2' })).status, 200);
  });
  test('requests without the API key are refused', async () => {
    const r = await fetch(srv.base + '/rest/v1/rpc/get_bundle', { method: 'POST', body: '{}' });
    assert.equal(r.status, 401);
  });
});
