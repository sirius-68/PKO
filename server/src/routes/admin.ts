import type { Router } from '../http.ts';
import { HttpError, readJson, send } from '../http.ts';
import type { Deps } from '../app.ts';
import { clearCookie, createAdmin, hashPassword, loginAdmin, logoutAdmin, requireAdmin, sessionCookie, validatePassword, verifyPassword } from '../auth.ts';
import { createItem, deleteItem, getItem, getLive, getSettings, listItems, mediaInUse, reorder, saveLive, saveSettings, updateItem, type Status } from '../content.ts';
import { COLLECTIONS, LIVE_FIELDS, SETTINGS_FIELDS } from '../schema.ts';
import { ACCEPT } from '../media.ts';

export function registerAdmin(r: Router, d: Deps): void {
  const { db, media, live, limiter } = d;
  const admin = (req: Parameters<typeof requireAdmin>[1]) => requireAdmin(db, req);

  r.post('/api/admin/login', async ({ req, res, ip }) => {
    // Only failed attempts count, per IP and per account, so a busy team never locks itself out.
    const b = await readJson<{ email?: unknown; password?: unknown }>(req);
    const email = String(b.email || '').trim().toLowerCase();
    limiter.assertNotBlocked(`login:${ip}`, 10);
    limiter.assertNotBlocked(`login-acct:${email}`, 10);
    let result;
    try { result = loginAdmin(db, email, String(b.password || '')); }
    catch (e) { limiter.check(`login:${ip}`, 1e9, 15 * 60_000); limiter.check(`login-acct:${email}`, 1e9, 15 * 60_000); throw e; }
    const { token, admin: a } = result;
    send(res, 200, { admin: a }, { 'Set-Cookie': sessionCookie(token, d.secureCookies) });
  });
  r.post('/api/admin/logout', ({ req, res }) => {
    logoutAdmin(db, req);
    send(res, 200, { ok: true }, { 'Set-Cookie': clearCookie(d.secureCookies) });
  });
  r.get('/api/admin/me', ({ req, res }) => send(res, 200, { admin: admin(req) }));

  r.get('/api/admin/schema', ({ req, res }) => {
    admin(req);
    send(res, 200, { collections: COLLECTIONS, settings: SETTINGS_FIELDS, live: LIVE_FIELDS, accept: ACCEPT, maxUploadBytes: media.maxBytes });
  });

  r.get('/api/admin/stats', ({ req, res }) => {
    admin(req);
    const byColl = Object.fromEntries((db.prepare("SELECT collection, status, COUNT(*) AS n FROM items GROUP BY collection, status").all() as { collection: string; status: string; n: number }[])
      .reduce((m, x) => { const o = m.get(x.collection) || {}; o[x.status] = x.n; m.set(x.collection, o); return m; }, new Map<string, Record<string, number>>()));
    const one = (sql: string, ...a: (string | number)[]) => (db.prepare(sql).get(...a) as { n: number }).n;
    const weekAgo = new Date(Date.now() - 7 * 864e5).toISOString();
    const top = db.prepare(`SELECT a.target, COUNT(*) AS n, i.collection, i.data FROM amens a JOIN items i ON i.id = a.target GROUP BY a.target ORDER BY n DESC LIMIT 5`).all() as { target: string; n: number; collection: string; data: string }[];
    send(res, 200, {
      items: byColl,
      members: one('SELECT COUNT(*) AS n FROM members'),
      membersWeek: one('SELECT COUNT(*) AS n FROM members WHERE created_at > ?', weekAgo),
      amens: one('SELECT COUNT(*) AS n FROM amens'),
      amensWeek: one('SELECT COUNT(*) AS n FROM amens WHERE created_at > ?', weekAgo),
      comments: one('SELECT COUNT(*) AS n FROM comments'),
      commentsWeek: one('SELECT COUNT(*) AS n FROM comments WHERE created_at > ?', weekAgo),
      pendingTestimonies: one("SELECT COUNT(*) AS n FROM items WHERE collection = 'testimonies' AND status = 'pending'"),
      media: db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM media').get(),
      viewers: live.viewers,
      onAir: getLive(db).onAir,
      top: top.map((t) => { const c = COLLECTIONS.find((x) => x.key === t.collection); const data = JSON.parse(t.data); return { id: t.target, collection: t.collection, label: c?.singular, title: data[c?.titleField || 'title'], amens: t.n }; }),
    });
  });

  /* ---------- content ---------- */
  r.get('/api/admin/items/:col', ({ req, res, params, url }) => {
    admin(req);
    const status = (url.searchParams.get('status') || 'all') as Status | 'all';
    const items = listItems(db, params.col, { status, includeMember: true });
    const amens = new Map((db.prepare('SELECT target, COUNT(*) AS n FROM amens GROUP BY target').all() as { target: string; n: number }[]).map((x) => [x.target, x.n]));
    const comments = new Map((db.prepare('SELECT target, COUNT(*) AS n FROM comments GROUP BY target').all() as { target: string; n: number }[]).map((x) => [x.target, x.n]));
    send(res, 200, { items: items.map((i) => ({ ...i, amens: amens.get(i.id) || 0, commentCount: comments.get(i.id) || 0 })) });
  });
  r.post('/api/admin/items/:col', async ({ req, res, params }) => {
    admin(req);
    send(res, 201, { item: createItem(db, params.col, await readJson(req, 5_000_000), media.exists) });
  });
  r.post('/api/admin/items/:col/reorder', async ({ req, res, params }) => {
    admin(req);
    reorder(db, params.col, (await readJson<{ ids?: unknown }>(req)).ids);
    send(res, 200, { ok: true });
  });
  r.get('/api/admin/items/:col/:id', ({ req, res, params }) => {
    admin(req);
    const it = getItem(db, params.col, params.id);
    if (!it) throw new HttpError(404, 'Not found');
    send(res, 200, { item: it });
  });
  r.patch('/api/admin/items/:col/:id', async ({ req, res, params }) => {
    admin(req);
    send(res, 200, { item: updateItem(db, params.col, params.id, await readJson(req, 5_000_000), media.exists) });
  });
  r.delete('/api/admin/items/:col/:id', ({ req, res, params }) => {
    admin(req);
    deleteItem(db, params.col, params.id);
    send(res, 200, { ok: true });
  });

  /* ---------- media library ---------- */
  r.get('/api/admin/media', ({ req, res, url }) => {
    admin(req);
    const kind = url.searchParams.get('kind');
    const rows = kind ? db.prepare('SELECT * FROM media WHERE kind = ? ORDER BY created_at DESC').all(kind) : db.prepare('SELECT * FROM media ORDER BY created_at DESC').all();
    send(res, 200, { media: rows });
  });
  r.put('/api/admin/media', async ({ req, res, url }) => {
    admin(req);
    const row = await media.upload(req, url.searchParams.get('name') || 'upload');
    send(res, 201, { media: row });
  });
  r.get('/api/admin/media/:id/usage', ({ req, res, params }) => {
    admin(req);
    send(res, 200, { usedBy: mediaInUse(db, params.id) });
  });
  r.delete('/api/admin/media/:id', ({ req, res, params, url }) => {
    admin(req);
    if (!media.get(params.id)) throw new HttpError(404, 'File not found');
    const usedBy = mediaInUse(db, params.id);
    if (usedBy.length && url.searchParams.get('force') !== '1') throw new HttpError(409, `This file is still used by: ${usedBy.join('; ')}`, { usedBy });
    media.remove(params.id);
    send(res, 200, { ok: true });
  });

  /* ---------- settings & live ---------- */
  r.get('/api/admin/settings', ({ req, res }) => { admin(req); send(res, 200, { settings: getSettings(db) }); });
  r.put('/api/admin/settings', async ({ req, res }) => { admin(req); send(res, 200, { settings: saveSettings(db, await readJson(req), media.exists) }); });
  r.get('/api/admin/live', ({ req, res }) => { admin(req); send(res, 200, { live: getLive(db), viewers: live.viewers }); });
  r.put('/api/admin/live', async ({ req, res }) => {
    admin(req);
    const next = saveLive(db, await readJson(req), media.exists);
    live.broadcast('live', next);
    send(res, 200, { live: next });
  });

  /* ---------- moderation ---------- */
  r.get('/api/admin/comments', ({ req, res, url }) => {
    admin(req);
    const q = (url.searchParams.get('q') || '').trim();
    const rows = (q
      ? db.prepare(`SELECT c.*, i.collection, i.data FROM comments c LEFT JOIN items i ON i.id = c.target WHERE c.body LIKE ? OR c.name LIKE ? ORDER BY c.created_at DESC LIMIT 300`).all(`%${q}%`, `%${q}%`)
      : db.prepare(`SELECT c.*, i.collection, i.data FROM comments c LEFT JOIN items i ON i.id = c.target ORDER BY c.created_at DESC LIMIT 300`).all()) as
      { id: string; target: string; name: string; body: string; member_id: string; created_at: string; collection: string | null; data: string | null }[];
    send(res, 200, { comments: rows.map((c) => {
      const coll = COLLECTIONS.find((x) => x.key === c.collection);
      return { id: c.id, target: c.target, name: c.name, body: c.body, memberId: c.member_id, createdAt: c.created_at, on: coll && c.data ? `${coll.singular}: ${JSON.parse(c.data)[coll.titleField]}` : c.target };
    }) });
  });
  r.delete('/api/admin/comments/:id', ({ req, res, params }) => {
    admin(req);
    const x = db.prepare('DELETE FROM comments WHERE id = ?').run(params.id);
    if (!x.changes) throw new HttpError(404, 'Comment not found');
    db.prepare('DELETE FROM comments WHERE parent_id = ?').run(params.id);
    send(res, 200, { ok: true });
  });
  r.get('/api/admin/chat', ({ req, res }) => { admin(req); send(res, 200, { messages: live.recent(100), viewers: live.viewers }); });
  r.post('/api/admin/chat', async ({ req, res }) => {
    const a = admin(req);
    const b = await readJson<{ body?: unknown; name?: unknown }>(req);
    const name = typeof b.name === 'string' && b.name.trim() ? b.name.trim().slice(0, 60) : a.name;
    send(res, 201, { message: live.post(name, b.body, { isMod: true }) });
  });
  r.delete('/api/admin/chat/:id', ({ req, res, params }) => { admin(req); live.remove(Number(params.id)); send(res, 200, { ok: true }); });

  r.get('/api/admin/members', ({ req, res }) => {
    admin(req);
    const rows = db.prepare(`SELECT m.id, m.name, m.phone, m.banned, m.created_at,
      (SELECT COUNT(*) FROM comments c WHERE c.member_id = m.id) AS comments
      FROM members m ORDER BY m.created_at DESC LIMIT 1000`).all();
    send(res, 200, { members: rows });
  });
  r.post('/api/admin/members/:id/ban', async ({ req, res, params }) => {
    admin(req);
    const b = await readJson<{ banned?: unknown }>(req);
    const x = db.prepare('UPDATE members SET banned = ? WHERE id = ?').run(b.banned ? 1 : 0, params.id);
    if (!x.changes) throw new HttpError(404, 'Member not found');
    send(res, 200, { ok: true });
  });

  /* ---------- team ---------- */
  r.get('/api/admin/admins', ({ req, res }) => { admin(req); send(res, 200, { admins: db.prepare('SELECT id, email, name, created_at FROM admins ORDER BY created_at').all() }); });
  r.post('/api/admin/admins', async ({ req, res }) => {
    admin(req);
    const b = await readJson<{ email?: unknown; name?: unknown; password?: unknown }>(req);
    const email = String(b.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email');
    const name = String(b.name || '').trim();
    if (!name) throw new HttpError(400, 'Enter a name');
    if (db.prepare('SELECT 1 FROM admins WHERE email = ?').get(email)) throw new HttpError(409, 'That email already has access');
    send(res, 201, { admin: createAdmin(db, email, name, String(b.password || '')) });
  });
  r.delete('/api/admin/admins/:id', ({ req, res, params }) => {
    const a = admin(req);
    if (a.id === params.id) throw new HttpError(400, "You can't remove yourself");
    const x = db.prepare('DELETE FROM admins WHERE id = ?').run(params.id);
    if (!x.changes) throw new HttpError(404, 'Not found');
    send(res, 200, { ok: true });
  });
  r.post('/api/admin/password', async ({ req, res, ip }) => {
    const a = admin(req);
    limiter.check(`pw:${ip}`, 10, 15 * 60_000);
    const b = await readJson<{ current?: unknown; next?: unknown }>(req);
    const row = db.prepare('SELECT password_hash FROM admins WHERE id = ?').get(a.id) as { password_hash: string };
    if (!verifyPassword(String(b.current || ''), row.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    db.prepare('UPDATE admins SET password_hash = ? WHERE id = ?').run(hashPassword(validatePassword(b.next)), a.id);
    send(res, 200, { ok: true });
  });
}
