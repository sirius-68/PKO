/**
 * Test stack: a fresh Postgres database with Supabase's built-in schemas stubbed,
 * the real migration applied, and the local Supabase emulator in front of it.
 * Needs a Postgres server with trust auth (PGHOST / PGPORT / PGUSER; defaults suit
 * the local dev box and the CI service container).
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Pg } from '../supabase/local/pg.ts';
import { Emulator, ANON_KEY } from '../supabase/local/emulator.ts';

const ROOT = resolve(import.meta.dirname, '..');
export const ADMIN = { email: 'admin@test.local', password: 'correct-horse-battery', name: 'Media team' };
const PG = { host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 54329), user: process.env.PGUSER || 'postgres' };

export async function startTestServer(opts: { seed?: boolean; claimAdmin?: boolean; maxUploadBytes?: number } = {}) {
  const dbName = 'pko_t_' + Math.random().toString(36).slice(2, 10);
  const root = new Pg({ ...PG, database: 'postgres' });
  await root.connect();
  await root.query(`create database ${dbName}`);
  const db = new Pg({ ...PG, database: dbName });
  await db.connect();
  await db.query(readFileSync(join(ROOT, 'supabase/local/supabase-stubs.sql'), 'utf8'));
  for (const f of ['20261113000000_init.sql']) await db.query(readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8'));
  db.close();
  const storageDir = mkdtempSync(join(tmpdir(), 'pko-storage-'));
  const emu = new Emulator({ pg: { ...PG, database: dbName }, storageDir, webRoot: ROOT, maxUploadBytes: opts.maxUploadBytes });
  const base = await emu.start();
  const admin = new Client(base);
  if (opts.claimAdmin !== false) {
    await admin.signUpEmail(ADMIN.email, ADMIN.password);
    await admin.rpcOk('claim_first_admin', { p_name: ADMIN.name });
    if (opts.seed !== false) await seedContent(admin);
  }
  return {
    base, emu, admin,
    async close() {
      await emu.close();
      await root.query(`drop database if exists ${dbName} with (force)`).catch(() => {});
      root.close();
      rmSync(storageDir, { recursive: true, force: true });
    },
  };
}

export interface Res { status: number; json: any; text: string }

/** Talks to the emulator exactly like the apps talk to Supabase. */
export class Client {
  base: string;
  token = '';
  userId = '';
  constructor(base: string) { this.base = base; }
  private headers(extra: Record<string, string> = {}) { return { apikey: ANON_KEY, Authorization: `Bearer ${this.token || ANON_KEY}`, ...extra }; }
  async http(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const isBin = body instanceof Uint8Array;
    const res = await fetch(this.base + path, { method, headers: this.headers({ ...(body !== undefined && !isBin ? { 'Content-Type': 'application/json' } : {}), ...headers }), body: body === undefined ? undefined : isBin ? (body as unknown as BodyInit) : JSON.stringify(body) });
    const text = await res.text();
    let json: any = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, json, text };
  }
  rpc(fn: string, args: Record<string, unknown> = {}) { return this.http('POST', `/rest/v1/rpc/${fn}`, args); }
  async rpcOk<T = any>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.rpc(fn, args);
    if (r.status !== 200) throw new Error(`${fn} → ${r.status} ${r.text}`);
    return r.json as T;
  }
  async bundle() { return this.rpcOk('get_bundle'); }
  private take(r: Res) { if (r.status !== 200) throw new Error(`auth → ${r.status} ${r.text}`); this.token = r.json.access_token; this.userId = r.json.user.id; return r; }
  async signUpEmail(email: string, password: string) { return this.take(await this.http('POST', '/auth/v1/signup', { email, password })); }
  async signIn(email: string, password: string) { return this.take(await this.http('POST', '/auth/v1/token?grant_type=password', { email, password })); }
  async loginAdmin() { return this.signIn(ADMIN.email, ADMIN.password); }
  async anon() { return this.take(await this.http('POST', '/auth/v1/signup', { data: {} })); }
  /** Anonymous account + display name: how members sign in from the app. */
  async signUp(name = 'Grace Test') { await this.anon(); return this.rpcOk('set_profile', { p_name: name, p_phone: '+237600000000' }); }
  upload(path: string, bytes: Uint8Array, mime: string, upsert = false) { return this.http('POST', `/storage/v1/object/media/${path}`, bytes, { 'Content-Type': mime, 'x-upsert': String(upsert) }); }
  /** Dashboard-style upload: store the file, then register it. Returns the media id. */
  async uploadMedia(name: string, bytes: Uint8Array, mime: string): Promise<string> {
    const path = `uploads/test/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}-${name}`;
    const r = await this.upload(path, bytes, mime);
    if (r.status !== 200) throw new Error(`upload → ${r.status} ${r.text}`);
    await this.rpcOk('admin_register_media', { p_id: path, p_mime: mime, p_size: bytes.length, p_name: name });
    return path;
  }
}

/** Same steps as the dashboard's "Import starter content" button. */
export async function seedContent(admin: Client) {
  const seed = JSON.parse(readFileSync(join(ROOT, 'admin/seed/content.json'), 'utf8'));
  const files = new Set(seed.media.map((m: { file: string }) => m.file));
  const ref = (v: unknown): unknown => typeof v === 'string' && files.has(v) ? `seed/${v}` : Array.isArray(v) ? v.map(ref) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ref(x)])) : v;
  for (const m of seed.media) {
    const bytes = new Uint8Array(readFileSync(join(ROOT, 'admin/seed/media', m.file)));
    const r = await admin.upload(`seed/${m.file}`, bytes, m.mime, true);
    if (r.status !== 200) throw new Error('seed upload failed ' + r.text);
    await admin.rpcOk('admin_register_media', { p_id: `seed/${m.file}`, p_mime: m.mime, p_size: bytes.length, p_name: m.file });
  }
  await admin.rpcOk('admin_save_settings', { p: ref(seed.settings) });
  await admin.rpcOk('admin_save_live', { p: ref(seed.live) });
  for (const it of seed.items) {
    await admin.rpcOk('admin_save', { p_collection: it.collection, p_id: null, p_data: ref(it.data), p_status: 'published', p_published_at: new Date(Date.now() - it.hoursAgo * 3600e3).toISOString() });
  }
}

/** Minimal valid files for upload tests. */
export const FILES = {
  png: new Uint8Array(Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4540000000049454e44ae426082', 'hex')),
  wav(seconds = 1) {
    const rate = 8000, n = rate * seconds, buf = Buffer.alloc(44 + n * 2);
    buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
    buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
    for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((i / rate) * 2 * Math.PI * 440) * 8000), 44 + i * 2);
    return new Uint8Array(buf);
  },
};
