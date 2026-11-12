import type { Router } from '../http.ts';
import { HttpError, readJson, send, sendFile } from '../http.ts';
import type { Deps } from '../app.ts';
import { actorFromRequest, cleanName, memberFromRequest, newId, nowIso, registerMember, requireMember, signOutMember } from '../auth.ts';
import { chapter, createItem, getItem, getLive, getSettings, itemExists, publicBundle } from '../content.ts';
import { contentVersion } from '../db.ts';

const TARGET_RE = /^[a-zA-Z0-9_:-]{1,80}$/;
const GALLERY_TARGET_RE = /^gallery:[\w '&.-]{1,80}$/;

export function registerPublic(r: Router, d: Deps): void {
  const { db, media, live, limiter } = d;

  r.get('/api/health', ({ res }) => send(res, 200, { ok: true, version: contentVersion(db), time: nowIso() }));

  r.get('/api/bundle', ({ req, res }) => {
    const etag = `W/"v${contentVersion(db)}"`;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return; }
    send(res, 200, publicBundle(db), { ETag: etag, 'Cache-Control': 'no-cache' });
  });

  r.get('/api/books/:id/chapters/:cid', ({ res, params }) => send(res, 200, chapter(db, params.id, params.cid)));

  /** Calendar file so "Add to calendar" works with Apple, Google and Outlook calendars. */
  r.get('/api/events/:file', ({ res, params }) => {
    const id = params.file.replace(/\.ics$/, '');
    const e = getItem(db, 'events', id);
    if (!e || e.status !== 'published' || !params.file.endsWith('.ics')) throw new HttpError(404, 'Event not found');
    const date = String(e.date).replace(/-/g, '');
    const times = [...String(e.time).matchAll(/(\d{1,2}):(\d{2})/g)].map((m) => m[1].padStart(2, '0') + m[2] + '00');
    const icsText = (s: unknown) => String(s ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');
    let start = `DTSTART;VALUE=DATE:${date}`, end = '';
    if (times[0]) {
      start = `DTSTART:${date}T${times[0]}`;
      if (times[1]) {
        const endDay = times[1] < times[0] ? new Date(Date.parse(String(e.date) + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10).replace(/-/g, '') : date;
        end = `DTEND:${endDay}T${times[1]}`;
      }
    }
    const settings = getSettings(db);
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${icsText(settings.appName)}//EN`, 'CALSCALE:GREGORIAN', 'BEGIN:VEVENT',
      `UID:${e.id}@pko`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`, start, end,
      `SUMMARY:${icsText(e.title)}`, `LOCATION:${icsText(e.place)}`, `DESCRIPTION:${icsText(e.description)}`,
      'BEGIN:VALARM', 'TRIGGER:-PT1H', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(e.title)}`, 'END:VALARM',
      'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
    res.writeHead(200, { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.ics"`, 'Cache-Control': 'no-cache' });
    res.end(body);
  });

  /* ---------- members ---------- */
  r.post('/api/members', async ({ req, res, ip }) => {
    // Generous: a whole congregation on church Wi-Fi shares one IP.
    limiter.check(`signup:${ip}`, 60, 10 * 60_000);
    const b = await readJson<{ name?: unknown; phone?: unknown }>(req);
    const { token, member } = registerMember(db, b.name, b.phone);
    send(res, 201, { token, member: { id: member.id, name: member.name } });
  });
  r.get('/api/me', ({ req, res }) => {
    const m = memberFromRequest(db, req);
    if (!m) throw new HttpError(401, 'Not signed in');
    send(res, 200, { member: { id: m.id, name: m.name } });
  });
  r.patch('/api/me', async ({ req, res }) => {
    const m = requireMember(db, req);
    const b = await readJson<{ name?: unknown }>(req);
    const name = cleanName(b.name);
    db.prepare('UPDATE members SET name = ? WHERE id = ?').run(name, m.id);
    send(res, 200, { member: { id: m.id, name } });
  });
  r.delete('/api/me/session', ({ req, res }) => { signOutMember(db, req); send(res, 200, { ok: true }); });

  /* ---------- amens ---------- */
  r.get('/api/amens/mine', ({ req, res }) => {
    const actor = actorFromRequest(db, req);
    const rows = db.prepare('SELECT target FROM amens WHERE actor = ?').all(actor) as { target: string }[];
    send(res, 200, { targets: rows.map((x) => x.target) });
  });
  r.post('/api/amens', async ({ req, res, ip }) => {
    limiter.check(`amen:${ip}`, 120, 60_000);
    const actor = actorFromRequest(db, req);
    const b = await readJson<{ target?: unknown; on?: unknown }>(req);
    const target = String(b.target || '');
    if (!TARGET_RE.test(target) && !GALLERY_TARGET_RE.test(target)) throw new HttpError(400, 'Invalid target');
    const known = target === 'live' || target.startsWith('gallery:')
      || (target.startsWith('c_') ? !!db.prepare('SELECT 1 FROM comments WHERE id = ?').get(target) : itemExists(db, target)?.status === 'published');
    if (!known) throw new HttpError(404, 'Post not found');
    const exists = !!db.prepare('SELECT 1 FROM amens WHERE target = ? AND actor = ?').get(target, actor);
    const want = typeof b.on === 'boolean' ? b.on : !exists;
    if (want && !exists) db.prepare('INSERT INTO amens (target, actor, created_at) VALUES (?, ?, ?)').run(target, actor, nowIso());
    if (!want && exists) db.prepare('DELETE FROM amens WHERE target = ? AND actor = ?').run(target, actor);
    const n = (db.prepare('SELECT COUNT(*) AS n FROM amens WHERE target = ?').get(target) as { n: number }).n;
    send(res, 200, { target, on: want, count: n });
  });

  /* ---------- comments ---------- */
  r.get('/api/comments', ({ res, url }) => {
    const target = url.searchParams.get('target') || '';
    if (!TARGET_RE.test(target)) throw new HttpError(400, 'Invalid target');
    const rows = db.prepare('SELECT id, name, body, parent_id, created_at, member_id FROM comments WHERE target = ? ORDER BY created_at ASC LIMIT 500').all(target) as
      { id: string; name: string; body: string; parent_id: string | null; created_at: string; member_id: string }[];
    const amens = new Map((db.prepare("SELECT target, COUNT(*) AS n FROM amens WHERE target LIKE 'c_%' GROUP BY target").all() as { target: string; n: number }[]).map((x) => [x.target, x.n]));
    send(res, 200, { comments: rows.map((c) => ({ id: c.id, name: c.name, body: c.body, parentId: c.parent_id, createdAt: c.created_at, memberId: c.member_id, amens: amens.get(c.id) || 0 })) });
  });
  r.post('/api/comments', async ({ req, res, ip }) => {
    const m = requireMember(db, req);
    limiter.check(`comment:${m.id}`, 12, 60_000);
    limiter.check(`comment-ip:${ip}`, 90, 60_000);
    const b = await readJson<{ target?: unknown; body?: unknown; parentId?: unknown }>(req);
    const target = String(b.target || '');
    const it = itemExists(db, target);
    if (!it || it.status !== 'published') throw new HttpError(404, 'Post not found');
    const body = typeof b.body === 'string' ? b.body.trim() : '';
    if (!body) throw new HttpError(400, 'Comment is empty');
    if (body.length > 1000) throw new HttpError(400, 'Comments can be up to 1000 characters');
    let parentId: string | null = null;
    if (b.parentId) {
      const p = db.prepare('SELECT id, parent_id FROM comments WHERE id = ? AND target = ?').get(String(b.parentId), target) as { id: string; parent_id: string | null } | undefined;
      if (!p) throw new HttpError(404, 'The comment you replied to was removed');
      parentId = p.parent_id || p.id; // one level of threading
    }
    const c = { id: newId('c_'), name: m.name, body, parentId, createdAt: nowIso(), memberId: m.id, amens: 0 };
    db.prepare('INSERT INTO comments (id, target, member_id, name, body, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(c.id, target, m.id, m.name, body, parentId, c.createdAt);
    send(res, 201, { comment: c });
  });
  r.delete('/api/comments/:id', ({ req, res, params }) => {
    const m = requireMember(db, req);
    const r2 = db.prepare('DELETE FROM comments WHERE id = ? AND member_id = ?').run(params.id, m.id);
    if (!r2.changes) throw new HttpError(404, 'Comment not found');
    db.prepare('DELETE FROM comments WHERE parent_id = ?').run(params.id);
    send(res, 200, { ok: true });
  });

  /* ---------- testimonies (members submit, media team approves) ---------- */
  r.post('/api/testimonies', async ({ req, res }) => {
    const m = requireMember(db, req);
    limiter.check(`testimony:${m.id}`, 5, 3600_000);
    const b = await readJson<Record<string, unknown>>(req);
    if (b.video && typeof b.video === 'string') {
      const row = media.get(b.video);
      if (!row || row.kind !== 'video') throw new HttpError(400, 'Video upload not found');
    }
    const item = createItem(db, 'testimonies', {
      title: b.title, body: b.body, place: b.place, video: b.video || null,
      name: typeof b.name === 'string' && b.name.trim() ? b.name : m.name,
      quote: typeof b.body === 'string' ? b.body.split(/(?<=[.!?])\s/)[0].slice(0, 280) : '',
      status: 'pending',
    }, media.exists, { memberId: m.id, defaultStatus: 'pending' });
    send(res, 201, { id: item.id, status: item.status });
  });

  /** Members may upload one video for a testimony (smaller limit than the dashboard). */
  r.put('/api/uploads', async ({ req, res, url, ip }) => {
    const m = requireMember(db, req);
    limiter.check(`upload:${m.id}`, 6, 3600_000);
    limiter.check(`upload-ip:${ip}`, 40, 3600_000);
    const row = await media.upload(req, url.searchParams.get('name') || 'testimony.mp4', { maxBytes: d.memberUploadMax, kinds: ['video'] });
    send(res, 201, { id: row.id });
  });

  /* ---------- live room ---------- */
  r.get('/api/live/stream', ({ res }) => live.subscribe(res, getLive(db)));
  r.get('/api/live', ({ res }) => send(res, 200, { live: getLive(db), viewers: live.viewers, messages: live.recent() }));
  r.post('/api/live/chat', async ({ req, res }) => {
    const m = requireMember(db, req);
    limiter.check(`chat:${m.id}`, 8, 20_000);
    const b = await readJson<{ body?: unknown }>(req);
    send(res, 201, { message: live.post(m.name, b.body, { memberId: m.id }) });
  });

  /* ---------- media files ---------- */
  r.get('/media/:id', ({ req, res, params }) => {
    const p = media.path(params.id);
    const row = p ? media.get(params.id) : undefined;
    if (!p || !row || !sendFile(req, res, p, { cache: 'public, max-age=31536000, immutable', mime: row.mime })) throw new HttpError(404, 'File not found');
  });
}
