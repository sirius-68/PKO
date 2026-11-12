import type { DB } from './db.ts';
import { bumpVersion, contentVersion, getSetting, setSetting, tx } from './db.ts';
import { COLLECTION_MAP, LIVE_FIELDS, SETTINGS_FIELDS, mediaRefs, validate, type Collection } from './schema.ts';
import { HttpError } from './http.ts';
import { newId, nowIso } from './auth.ts';

export type Status = 'published' | 'draft' | 'pending' | 'rejected';
const STATUSES: Status[] = ['published', 'draft', 'pending', 'rejected'];

export interface ItemRow { id: string; collection: string; status: Status; data: string; sort: number; member_id: string | null; published_at: string; created_at: string; updated_at: string }
export interface Item { id: string; status: Status; sort: number; publishedAt: string; createdAt: string; updatedAt: string; memberId?: string | null; [k: string]: unknown }

export const DEFAULT_SETTINGS = {
  appName: 'Prophet Kevin Online', ministry: 'Apostolic Gospel Mission', tvName: 'Transfiguration TV',
  recordsName: 'Transfiguration Records', leader: 'Prophet Kevin',
  aboutText: 'The ministry of Prophet Kevin. Home of Transfiguration TV and Transfiguration Records.',
  aboutVerse: '', aboutVerseRef: '', logo: null as string | null, leaderPhoto: null as string | null,
};
export const DEFAULT_LIVE = { onAir: false, title: 'Live service', ref: '', video: null as string | null, url: '', poster: null as string | null };

export function collection(key: string): Collection {
  const c = COLLECTION_MAP.get(key);
  if (!c) throw new HttpError(404, 'Unknown content type');
  return c;
}

export function toItem(r: ItemRow, includeMember = false): Item {
  const it: Item = { ...(JSON.parse(r.data) as Record<string, unknown>), id: r.id, status: r.status, sort: r.sort, publishedAt: r.published_at, createdAt: r.created_at, updatedAt: r.updated_at };
  if (includeMember) it.memberId = r.member_id;
  return it;
}

function orderSql(c: Collection): string {
  if (c.sort === 'date_asc') return "json_extract(data, '$.date') ASC, sort ASC";
  if (c.sort === 'manual') return 'sort ASC, created_at ASC';
  return 'published_at DESC';
}

export function listItems(db: DB, key: string, opts: { status?: Status | 'all'; includeMember?: boolean } = {}): Item[] {
  const c = collection(key);
  const status = opts.status || 'published';
  const rows = (status === 'all'
    ? db.prepare(`SELECT * FROM items WHERE collection = ? ORDER BY ${orderSql(c)}`).all(key)
    : db.prepare(`SELECT * FROM items WHERE collection = ? AND status = ? ORDER BY ${orderSql(c)}`).all(key, status)) as unknown as ItemRow[];
  return rows.map((r) => toItem(r, opts.includeMember));
}

export function getItem(db: DB, key: string, id: string): Item | null {
  const r = db.prepare('SELECT * FROM items WHERE collection = ? AND id = ?').get(key, id) as ItemRow | undefined;
  return r ? toItem(r, true) : null;
}

export function itemExists(db: DB, id: string): { collection: string; status: Status } | null {
  const r = db.prepare('SELECT collection, status FROM items WHERE id = ?').get(id) as { collection: string; status: Status } | undefined;
  return r || null;
}

interface WriteMeta { status?: unknown; publishedAt?: unknown; sort?: unknown }

function cleanStatus(v: unknown, fallback: Status): Status {
  if (v === undefined) return fallback;
  if (typeof v !== 'string' || !STATUSES.includes(v as Status)) throw new HttpError(400, 'Invalid status');
  return v as Status;
}
function cleanPublishedAt(v: unknown, fallback: string): string {
  if (v === undefined || v === null || v === '') return fallback;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw new HttpError(400, 'Invalid publish date');
  return new Date(v).toISOString();
}

export function createItem(db: DB, key: string, input: Record<string, unknown>, mediaExists: (id: string) => boolean, opts: { memberId?: string; defaultStatus?: Status; id?: string } = {}): Item {
  const c = collection(key);
  const v = validate(c.fields, input, { mediaExists });
  if (!v.ok) throw new HttpError(422, 'Please fix the highlighted fields', v.errors);
  const meta = input as WriteMeta;
  const now = nowIso();
  const status = cleanStatus(meta.status, opts.defaultStatus || 'published');
  const publishedAt = cleanPublishedAt(meta.publishedAt, now);
  return tx(db, () => {
    const max = db.prepare('SELECT COALESCE(MAX(sort), 0) AS m FROM items WHERE collection = ?').get(key) as { m: number };
    const id = opts.id || newId(key.slice(0, 2) + '_');
    db.prepare('INSERT INTO items (id, collection, status, data, sort, member_id, published_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, key, status, JSON.stringify(v.data), max.m + 1, opts.memberId || null, publishedAt, now, now);
    bumpVersion(db);
    return getItem(db, key, id)!;
  });
}

export function updateItem(db: DB, key: string, id: string, input: Record<string, unknown>, mediaExists: (id: string) => boolean): Item {
  const c = collection(key);
  const cur = getItem(db, key, id);
  if (!cur) throw new HttpError(404, `${c.singular} not found`);
  const v = validate(c.fields, input, { partial: true, mediaExists });
  if (!v.ok) throw new HttpError(422, 'Please fix the highlighted fields', v.errors);
  const curData: Record<string, unknown> = {};
  for (const f of c.fields) curData[f.key] = cur[f.key];
  const merged = { ...curData, ...v.data };
  // Re-check required fields on the merged record.
  const full = validate(c.fields, merged, { mediaExists });
  if (!full.ok) throw new HttpError(422, 'Please fix the highlighted fields', full.errors);
  const meta = input as WriteMeta;
  const status = cleanStatus(meta.status, cur.status);
  const publishedAt = cleanPublishedAt(meta.publishedAt, cur.publishedAt);
  const sort = meta.sort === undefined ? cur.sort : Number(meta.sort);
  if (!Number.isFinite(sort)) throw new HttpError(400, 'Invalid sort');
  return tx(db, () => {
    db.prepare('UPDATE items SET data = ?, status = ?, published_at = ?, sort = ?, updated_at = ? WHERE id = ? AND collection = ?')
      .run(JSON.stringify(full.data), status, publishedAt, sort, nowIso(), id, key);
    bumpVersion(db);
    return getItem(db, key, id)!;
  });
}

export function deleteItem(db: DB, key: string, id: string): void {
  collection(key);
  tx(db, () => {
    const r = db.prepare('DELETE FROM items WHERE collection = ? AND id = ?').run(key, id);
    if (!r.changes) throw new HttpError(404, 'Not found');
    db.prepare('DELETE FROM comments WHERE target = ?').run(id);
    db.prepare('DELETE FROM amens WHERE target = ?').run(id);
    bumpVersion(db);
  });
}

export function reorder(db: DB, key: string, ids: unknown): void {
  collection(key);
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new HttpError(400, 'ids must be a list');
  tx(db, () => {
    const st = db.prepare('UPDATE items SET sort = ? WHERE collection = ? AND id = ?');
    (ids as string[]).forEach((id, i) => st.run(i + 1, key, id));
    bumpVersion(db);
  });
}

/** Is a media file still referenced by any content or setting? */
export function mediaInUse(db: DB, mediaId: string): string[] {
  const where: string[] = [];
  const rows = db.prepare('SELECT id, collection, data FROM items WHERE data LIKE ?').all(`%${mediaId}%`) as { id: string; collection: string; data: string }[];
  for (const r of rows) {
    const c = COLLECTION_MAP.get(r.collection);
    if (c && mediaRefs(c.fields, JSON.parse(r.data)).includes(mediaId)) where.push(`${c.singular}: ${String(JSON.parse(r.data)[c.titleField] || r.id)}`);
  }
  if (mediaRefs(SETTINGS_FIELDS, getSettings(db)).includes(mediaId)) where.push('App settings');
  if (mediaRefs(LIVE_FIELDS, getLive(db)).includes(mediaId)) where.push('Live stream');
  return where;
}

export function getSettings(db: DB): typeof DEFAULT_SETTINGS { return { ...DEFAULT_SETTINGS, ...getSetting(db, 'app', {}) }; }
export function getLive(db: DB): typeof DEFAULT_LIVE { return { ...DEFAULT_LIVE, ...getSetting(db, 'live', {}) }; }

export function saveSettings(db: DB, input: unknown, mediaExists: (id: string) => boolean) {
  const v = validate(SETTINGS_FIELDS, { ...getSettings(db), ...(input as object) }, { mediaExists });
  if (!v.ok) throw new HttpError(422, 'Please fix the highlighted fields', v.errors);
  tx(db, () => { setSetting(db, 'app', v.data); bumpVersion(db); });
  return getSettings(db);
}
export function saveLive(db: DB, input: unknown, mediaExists: (id: string) => boolean) {
  const v = validate(LIVE_FIELDS, { ...getLive(db), ...(input as object) }, { mediaExists });
  if (!v.ok) throw new HttpError(422, 'Please fix the highlighted fields', v.errors);
  tx(db, () => { setSetting(db, 'live', v.data); bumpVersion(db); });
  return getLive(db);
}

/* ---------------- public bundle ---------------- */

function counts(db: DB, table: 'amens' | 'comments'): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of db.prepare(`SELECT target, COUNT(*) AS n FROM ${table} GROUP BY target`).all() as { target: string; n: number }[]) out[r.target] = r.n;
  return out;
}

const PUBLIC_KEYS = ['posts', 'broadcasts', 'books', 'albums', 'events', 'testimonies', 'photos', 'schedule'] as const;

/**
 * Everything the app needs in one cacheable response. Book chapter bodies are left
 * out (fetched per chapter) so the bundle stays small as the library grows.
 */
export function publicBundle(db: DB) {
  const now = nowIso();
  const out: Record<string, unknown> = { version: contentVersion(db), generatedAt: now, settings: getSettings(db), live: getLive(db) };
  for (const k of PUBLIC_KEYS) {
    let items = listItems(db, k).filter((i) => i.publishedAt <= now); // scheduled posts stay hidden until their time
    if (k === 'books') items = items.map((b) => ({ ...b, chapters: ((b.chapters as { id: string; title: string; body: string[] }[]) || []).map((ch) => ({ id: ch.id, title: ch.title, words: ch.body.join(' ').split(/\s+/).length })) }));
    out[k] = items.map(({ status: _s, sort: _o, createdAt: _c, updatedAt: _u, memberId: _m, ...rest }) => rest);
  }
  out.amens = counts(db, 'amens');
  out.comments = counts(db, 'comments');
  return out;
}

export function chapter(db: DB, bookId: string, chapterId: string): { id: string; title: string; body: string[]; index: number } {
  const b = getItem(db, 'books', bookId);
  if (!b || b.status !== 'published') throw new HttpError(404, 'Book not found');
  const chs = (b.chapters as { id: string; title: string; body: string[] }[]) || [];
  const index = chs.findIndex((c) => c.id === chapterId);
  if (index < 0) throw new HttpError(404, 'Chapter not found');
  return { ...chs[index], index };
}
