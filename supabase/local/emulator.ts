/**
 * LOCAL TESTING ONLY — a stand-in for the slice of Supabase the app uses, running
 * over a real Postgres with the real migration applied:
 *
 *   /auth/v1/*            GoTrue: anonymous + email/password sign-in, refresh, user update
 *   /rest/v1/rpc/:fn      PostgREST RPC with role + JWT claims (so RLS & auth.uid() are real)
 *   /storage/v1/*         uploads/deletes checked against the real storage.objects RLS policies
 *   /realtime/v1/websocket  Phoenix channels: postgres_changes (via LISTEN/NOTIFY) + presence
 *   /app/, /admin/        the built web app and dashboard (config.js points here)
 *
 * It is a test double: production uses supabase.co. Keep the surface in sync with
 * src/app/supa.ts and src/admin/supa.ts.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { createHmac, createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Duplex } from 'node:stream';
import { Pg, lit } from './pg.ts';

export interface EmulatorOptions { pg: { host: string; port: number; user: string; database: string }; storageDir: string; maxUploadBytes?: number; webRoot?: string }

const SECRET = 'local-test-jwt-secret-not-for-production';
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
export function signJwt(payload: Record<string, unknown>): string {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  return `${h}.${p}.${b64u(createHmac('sha256', SECRET).update(`${h}.${p}`).digest())}`;
}
function verifyJwt(tok: string): Record<string, unknown> | null {
  const [h, p, s] = tok.split('.');
  if (!h || !p || !s) return null;
  const exp = b64u(createHmac('sha256', SECRET).update(`${h}.${p}`).digest());
  if (exp.length !== s.length || !timingSafeEqual(Buffer.from(exp), Buffer.from(s))) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString()) as Record<string, unknown>;
  if (typeof claims.exp === 'number' && claims.exp * 1000 < Date.now()) return null;
  return claims;
}
export const ANON_KEY = signJwt({ iss: 'supabase-local', role: 'anon', iat: 1700000000, exp: 4102444800 });

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.pdf': 'application/pdf' };

export class Emulator {
  server: Server;
  url = '';
  private pool: Pg[] = [];
  private rr = 0;
  private listener!: Pg;
  private refresh = new Map<string, string>(); // refresh token -> user id
  private sockets = new Set<RtSocket>();
  private opts: EmulatorOptions;

  constructor(opts: EmulatorOptions) {
    this.opts = opts;
    this.server = createServer((req, res) => this.handle(req, res).catch((e) => this.fail(res, e)));
    this.server.on('upgrade', (req, sock) => this.upgrade(req, sock as Duplex));
  }

  async start(port = 0): Promise<string> {
    for (let i = 0; i < 4; i++) { const c = new Pg(this.opts.pg); await c.connect(); this.pool.push(c); }
    this.listener = new Pg(this.opts.pg);
    await this.listener.connect();
    // Realtime stand-in: forward row changes from the publication tables.
    await this.listener.query(`
      create or replace function public._local_notify() returns trigger language plpgsql as $$ begin
        perform pg_notify('pko_changes', json_build_object('table', TG_TABLE_NAME, 'type', TG_OP, 'record', row_to_json(NEW),
          'old_record', case when TG_OP = 'UPDATE' then row_to_json(OLD) end)::text); return NEW; end $$;
      drop trigger if exists chat_notify on public.chat; create trigger chat_notify after insert or update on public.chat for each row execute function public._local_notify();
      drop trigger if exists settings_notify on public.settings; create trigger settings_notify after insert or update on public.settings for each row execute function public._local_notify();
      listen pko_changes;`);
    this.listener.onNotify = (_c, payload) => this.broadcastChange(JSON.parse(payload));
    mkdirSync(this.opts.storageDir, { recursive: true });
    await new Promise<void>((r) => this.server.listen(port, '127.0.0.1', () => r()));
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : port}`;
    return this.url;
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.sock.destroy();
    await new Promise<void>((r) => { this.server.close(() => r()); this.server.closeAllConnections?.(); });
    for (const c of this.pool) c.close();
    this.listener?.close();
  }

  /** Run SQL as the caller (role + JWT claims), like PostgREST does. */
  async asCaller(claims: Record<string, unknown>, sql: string): Promise<Record<string, string | null>[]> {
    const role = claims.role === 'authenticated' ? 'authenticated' : claims.role === 'service_role' ? 'service_role' : 'anon';
    const c = this.pool[this.rr++ % this.pool.length];
    return c.query(`set local role ${role}; select set_config('request.jwt.claims', ${lit(JSON.stringify(claims))}, true); ${sql}`);
  }
  admin(sql: string) { return this.pool[0].query(sql); }

  private claims(req: IncomingMessage): Record<string, unknown> {
    const apikey = String(req.headers.apikey || '');
    if (!apikey || !verifyJwt(apikey)) throw httpErr(401, 'No API key found in request');
    const auth = String(req.headers.authorization || '');
    const tok = auth.startsWith('Bearer ') ? auth.slice(7) : apikey;
    const c = verifyJwt(tok);
    if (!c) throw httpErr(401, 'JWT expired', 'PGRST301');
    return c;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url || '/', 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-upsert, x-client-info, cache-control, range');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const p = url.pathname;

    if (p.startsWith('/auth/v1/')) return this.auth(req, res, url);
    if (p.startsWith('/rest/v1/rpc/') && req.method === 'POST') return this.rpc(req, res, decodeURIComponent(p.slice('/rest/v1/rpc/'.length)));
    if (p.startsWith('/storage/v1/object/public/')) return this.serveObject(req, res, decodeURIComponent(p.slice('/storage/v1/object/public/'.length)));
    if (p.startsWith('/storage/v1/object/')) return this.storage(req, res, decodeURIComponent(p.slice('/storage/v1/object/'.length)));
    if (this.opts.webRoot && (p.startsWith('/app/') || p.startsWith('/admin/') || p === '/app' || p === '/admin')) return this.web(req, res, p);
    throw httpErr(404, 'Not found');
  }

  /* ---------------- auth ---------------- */
  private session(user: { id: string; email: string | null; is_anonymous: boolean }) {
    const now = Math.floor(Date.now() / 1000);
    const access = signJwt({ sub: user.id, role: 'authenticated', aud: 'authenticated', email: user.email, is_anonymous: user.is_anonymous, iat: now, exp: now + 3600 });
    const refresh = randomBytes(24).toString('base64url');
    this.refresh.set(refresh, user.id);
    return { access_token: access, token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, refresh_token: refresh, user: { id: user.id, email: user.email, is_anonymous: user.is_anonymous, role: 'authenticated' } };
  }
  private async auth(req: IncomingMessage, res: ServerResponse, url: URL) {
    this.claims(req); // apikey required
    const p = url.pathname.slice('/auth/v1'.length);
    const body = req.method === 'GET' ? {} : await json(req);
    if (p === '/signup' && req.method === 'POST') {
      if (!body.email) { // anonymous
        const [u] = await this.admin(`insert into auth.users (is_anonymous) values (true) returning id`);
        return send(res, 200, this.session({ id: u.id!, email: null, is_anonymous: true }));
      }
      const email = String(body.email).toLowerCase();
      if (String(body.password || '').length < 6) throw httpErr(422, 'Password should be at least 6 characters.', 'weak_password');
      const exists = await this.admin(`select id from auth.users where email = ${lit(email)}`);
      if (exists.length) throw httpErr(422, 'User already registered', 'user_already_exists');
      const [u] = await this.admin(`insert into auth.users (email, encrypted_password) values (${lit(email)}, ${lit(hash(String(body.password)))}) returning id`);
      return send(res, 200, this.session({ id: u.id!, email, is_anonymous: false }));
    }
    if (p === '/token' && req.method === 'POST') {
      const grant = url.searchParams.get('grant_type');
      if (grant === 'password') {
        const [u] = await this.admin(`select id, email, encrypted_password from auth.users where email = ${lit(String(body.email || '').toLowerCase())}`);
        if (!u || !u.encrypted_password || !checkHash(String(body.password || ''), u.encrypted_password)) throw httpErr(400, 'Invalid login credentials', 'invalid_credentials');
        return send(res, 200, this.session({ id: u.id!, email: u.email, is_anonymous: false }));
      }
      if (grant === 'refresh_token') {
        const uid = this.refresh.get(String(body.refresh_token || ''));
        if (!uid) throw httpErr(400, 'Invalid Refresh Token', 'refresh_token_not_found');
        this.refresh.delete(String(body.refresh_token));
        const [u] = await this.admin(`select id, email, is_anonymous from auth.users where id = ${lit(uid)}`);
        return send(res, 200, this.session({ id: u.id!, email: u.email, is_anonymous: u.is_anonymous === 't' }));
      }
    }
    const c = this.claims(req);
    if (c.role !== 'authenticated') throw httpErr(401, 'Not signed in');
    if (p === '/user' && req.method === 'GET') return send(res, 200, { id: c.sub, email: c.email, is_anonymous: c.is_anonymous });
    if (p === '/user' && req.method === 'PUT') {
      if (body.password) {
        if (String(body.password).length < 6) throw httpErr(422, 'Password should be at least 6 characters.', 'weak_password');
        await this.admin(`update auth.users set encrypted_password = ${lit(hash(String(body.password)))} where id = ${lit(String(c.sub))}`);
      }
      return send(res, 200, { id: c.sub, email: c.email });
    }
    if (p === '/logout' && req.method === 'POST') { res.writeHead(204); res.end(); return; }
    throw httpErr(404, 'Not found');
  }

  /* ---------------- PostgREST RPC ---------------- */
  private async rpc(req: IncomingMessage, res: ServerResponse, fn: string) {
    if (!/^[a-z][a-z0-9_]*$/.test(fn) || fn.startsWith('_')) throw httpErr(404, `Could not find the function public.${fn}`, 'PGRST202');
    const claims = this.claims(req);
    const args = await json(req);
    const named = Object.entries(args).map(([k, v]) => {
      if (!/^[a-z_][a-z0-9_]*$/.test(k)) throw httpErr(400, 'Bad argument');
      const val = v === null || v === undefined ? 'null' : Array.isArray(v) ? `array[${v.map(lit).join(',')}]::text[]` : typeof v === 'object' ? `${lit(v)}::jsonb` : typeof v === 'boolean' ? String(v) : lit(v);
      return `${k} => ${val}`;
    });
    let rows;
    try {
      rows = await this.asCaller(claims, `select to_json(public.${fn}(${named.join(', ')})) as r`);
    } catch (e) {
      const pe = e as { code?: string; message: string; detail?: string; hint?: string };
      const status = pe.code === '42501' ? (claims.role === 'anon' ? 401 : 403)
        : pe.code?.startsWith('PT') ? Number(pe.code.slice(2))
        : pe.code === '23505' || pe.code === '23503' ? 409 : pe.code === '42883' ? 404 : 400;
      return send(res, status, { code: pe.code, message: pe.message, details: pe.detail || null, hint: pe.hint || null });
    }
    const r = rows[rows.length - 1]?.r;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(r ?? 'null');
  }

  /* ---------------- storage ---------------- */
  private async storage(req: IncomingMessage, res: ServerResponse, rest: string) {
    const claims = this.claims(req);
    const [bucket, ...parts] = rest.split('/');
    const name = parts.join('/');
    if (req.method === 'DELETE' && !name) {
      const body = await json(req);
      const prefixes = (body.prefixes as string[]) || [];
      const deleted = await this.asCaller(claims, `delete from storage.objects where bucket_id = ${lit(bucket)} and name = any(array[${prefixes.map(lit).join(',') || "''"}]::text[]) returning name`);
      for (const d of deleted) { try { unlinkSync(this.objPath(bucket, d.name!)); } catch { /* gone */ } }
      return send(res, 200, deleted.map((d) => ({ name: d.name })));
    }
    if ((req.method === 'POST' || req.method === 'PUT') && name) {
      const [b] = await this.admin(`select public, allowed_mime_types, file_size_limit from storage.buckets where id = ${lit(bucket)}`);
      if (!b) throw httpErr(404, 'Bucket not found');
      const mime = String(req.headers['content-type'] || '').split(';')[0];
      const allowed = (b.allowed_mime_types || '').replace(/^\{|\}$/g, '').split(',').filter(Boolean);
      if (allowed.length && !allowed.includes(mime)) return send(res, 415, { statusCode: '415', error: 'invalid_mime_type', message: `mime type ${mime} is not supported` });
      const max = this.opts.maxUploadBytes ?? 50e6;
      if (Number(req.headers['content-length'] || 0) > max) return send(res, 413, { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' });
      const upsert = req.headers['x-upsert'] === 'true';
      try {
        await this.asCaller(claims, `insert into storage.objects (bucket_id, name, owner, metadata) values (${lit(bucket)}, ${lit(name)}, ${claims.sub ? lit(claims.sub) : 'null'}, ${lit({ mimetype: mime })}::jsonb)
          ${upsert ? 'on conflict (bucket_id, name) do update set metadata = excluded.metadata' : ''}`);
      } catch (e) {
        const pe = e as { code?: string; message: string };
        if (pe.code === '23505') return send(res, 409, { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' });
        return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      }
      const file = this.objPath(bucket, name);
      mkdirSync(dirname(file), { recursive: true });
      let size = 0;
      await pipeline(req, async function* (src) { for await (const chunk of src) { size += (chunk as Buffer).length; if (size > max) throw httpErr(413, 'too large'); yield chunk; } }, createWriteStream(file));
      return send(res, 200, { Key: `${bucket}/${name}`, Id: randomUUID() });
    }
    throw httpErr(404, 'Not found');
  }
  private objPath(bucket: string, name: string) {
    const p = normalize(join(this.opts.storageDir, bucket, name));
    if (!p.startsWith(resolve(this.opts.storageDir) + sep)) throw httpErr(400, 'Invalid key');
    return p;
  }
  private async serveObject(req: IncomingMessage, res: ServerResponse, rest: string) {
    const [bucket, ...parts] = rest.split('/');
    const [b] = await this.admin(`select public from storage.buckets where id = ${lit(bucket)}`);
    if (!b || b.public !== 't') throw httpErr(400, 'Bucket not found');
    const [o] = await this.admin(`select metadata->>'mimetype' as mime from storage.objects where bucket_id = ${lit(bucket)} and name = ${lit(parts.join('/'))}`);
    if (!o) throw httpErr(404, 'Object not found');
    sendFile(req, res, this.objPath(bucket, parts.join('/')), o.mime || 'application/octet-stream');
  }

  /* ---------------- static web (app + dashboard) ---------------- */
  private web(req: IncomingMessage, res: ServerResponse, p: string) {
    if (p === '/app' || p === '/admin') { res.writeHead(301, { Location: p + '/' }); res.end(); return; }
    if (p === '/app/config.js' || p === '/admin/config.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' });
      res.end(`window.PKO_CONFIG = ${JSON.stringify({ supabaseUrl: this.url, supabaseAnonKey: ANON_KEY, appUrl: this.url + '/app/' })};`);
      return;
    }
    const root = resolve(this.opts.webRoot!);
    let file = normalize(join(root, decodeURIComponent(p)));
    if (!file.startsWith(root + sep)) throw httpErr(404, 'Not found');
    if (p.endsWith('/') || !existsSync(file)) file = join(root, p.startsWith('/admin') ? 'admin' : 'app', 'index.html');
    sendFile(req, res, file, MIME[extname(file)] || 'application/octet-stream');
  }

  /* ---------------- realtime (Phoenix over WebSocket) ---------------- */
  private upgrade(req: IncomingMessage, sock: Duplex) {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname !== '/realtime/v1/websocket' || !verifyJwt(url.searchParams.get('apikey') || '')) { sock.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    const accept = createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    sock.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const rt = new RtSocket(sock, (msg) => this.onRt(rt, msg), () => this.leave(rt));
    this.sockets.add(rt);
  }
  private onRt(rt: RtSocket, m: { topic: string; event: string; payload: Record<string, unknown>; ref: string; join_ref?: string }) {
    if (m.event === 'heartbeat') return rt.send({ topic: 'phoenix', event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: m.ref });
    if (m.event === 'phx_join') {
      const cfg = (m.payload.config || {}) as { postgres_changes?: { event: string; schema: string; table: string }[]; presence?: { key?: string } };
      const pcs = (cfg.postgres_changes || []).map((c, i) => ({ ...c, id: i + 1, filter: '' }));
      rt.channels.set(m.topic, { joinRef: m.join_ref || m.ref, changes: pcs, presenceKey: cfg.presence?.key || randomUUID(), meta: null });
      rt.send({ topic: m.topic, event: 'phx_reply', payload: { status: 'ok', response: { postgres_changes: pcs } }, ref: m.ref, join_ref: m.join_ref });
      rt.send({ topic: m.topic, event: 'presence_state', payload: this.presenceState(m.topic), ref: null });
      return;
    }
    if (m.event === 'phx_leave') { const ch = rt.channels.get(m.topic); rt.channels.delete(m.topic); if (ch?.meta) this.presenceDiff(m.topic, {}, { [ch.presenceKey]: { metas: [ch.meta] } }); return; }
    if (m.event === 'presence') {
      const ch = rt.channels.get(m.topic);
      const p = m.payload as { event: string; payload: Record<string, unknown> };
      if (ch && p.event === 'track') { ch.meta = { ...p.payload, phx_ref: randomBytes(6).toString('base64url') }; this.presenceDiff(m.topic, { [ch.presenceKey]: { metas: [ch.meta] } }, {}); }
      if (ch && p.event === 'untrack' && ch.meta) { const old = ch.meta; ch.meta = null; this.presenceDiff(m.topic, {}, { [ch.presenceKey]: { metas: [old] } }); }
      return rt.send({ topic: m.topic, event: 'phx_reply', payload: { status: 'ok', response: {} }, ref: m.ref });
    }
    if (m.event === 'access_token') return;
  }
  private leave(rt: RtSocket) {
    this.sockets.delete(rt);
    for (const [topic, ch] of rt.channels) if (ch.meta) this.presenceDiff(topic, {}, { [ch.presenceKey]: { metas: [ch.meta] } });
  }
  private presenceState(topic: string) {
    const st: Record<string, { metas: unknown[] }> = {};
    for (const s of this.sockets) { const ch = s.channels.get(topic); if (ch?.meta) (st[ch.presenceKey] ||= { metas: [] }).metas.push(ch.meta); }
    return st;
  }
  private presenceDiff(topic: string, joins: Record<string, unknown>, leaves: Record<string, unknown>) {
    for (const s of this.sockets) if (s.channels.has(topic)) s.send({ topic, event: 'presence_diff', payload: { joins, leaves }, ref: null });
  }
  private broadcastChange(c: { table: string; type: string; record: unknown; old_record: unknown }) {
    for (const s of this.sockets) for (const [topic, ch] of s.channels) {
      const ids = ch.changes.filter((x) => x.table === c.table && x.schema === 'public' && (x.event === '*' || x.event === c.type)).map((x) => x.id);
      if (ids.length) s.send({ topic, event: 'postgres_changes', payload: { ids, data: { type: c.type, table: c.table, schema: 'public', record: c.record, old_record: c.old_record, commit_timestamp: new Date().toISOString(), errors: null } }, ref: null });
    }
  }

  private fail(res: ServerResponse, e: unknown) {
    const he = e as { status?: number; message: string; code?: string };
    if (!he.status) console.error('[emulator]', e);
    if (!res.headersSent) send(res, he.status || 500, { code: he.code || null, message: he.message, error: he.code, msg: he.message, error_description: he.message });
    else res.end();
  }
}

interface Channel { joinRef: string; changes: { id: number; event: string; schema: string; table: string }[]; presenceKey: string; meta: Record<string, unknown> | null }
class RtSocket {
  sock: Duplex;
  channels = new Map<string, Channel>();
  private buf = Buffer.alloc(0);
  constructor(sock: Duplex, onMsg: (m: never) => void, onClose: () => void) {
    this.sock = sock;
    sock.on('data', (d: Buffer) => {
      this.buf = Buffer.concat([this.buf, d]);
      for (;;) {
        if (this.buf.length < 2) return;
        const op = this.buf[0] & 0x0f, masked = this.buf[1] & 0x80;
        let len = this.buf[1] & 0x7f, o = 2;
        if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); o = 4; }
        else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); o = 10; }
        const need = o + (masked ? 4 : 0) + len;
        if (this.buf.length < need) return;
        let payload = this.buf.subarray(o + (masked ? 4 : 0), need);
        if (masked) { const k = this.buf.subarray(o, o + 4); payload = Buffer.from(payload.map((b, i) => b ^ k[i % 4])); }
        this.buf = this.buf.subarray(need);
        if (op === 8) { sock.end(); return; }
        if (op === 9) { this.frame(payload, 10); continue; }
        if (op === 1) { try { onMsg(JSON.parse(payload.toString()) as never); } catch { /* ignore bad frames */ } }
      }
    });
    sock.on('close', onClose);
    sock.on('error', () => sock.destroy());
  }
  send(obj: unknown) { this.frame(Buffer.from(JSON.stringify(obj)), 1); }
  private frame(payload: Buffer, op: number) {
    if (this.sock.destroyed) return;
    const head = payload.length < 126 ? Buffer.from([0x80 | op, payload.length])
      : payload.length < 65536 ? Buffer.from([0x80 | op, 126, payload.length >> 8, payload.length & 255])
      : (() => { const h = Buffer.alloc(10); h[0] = 0x80 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(payload.length), 2); return h; })();
    this.sock.write(Buffer.concat([head, payload]));
  }
}

/* ---------------- helpers ---------------- */
function httpErr(status: number, message: string, code?: string) { return Object.assign(new Error(message), { status, code }); }
function send(res: ServerResponse, status: number, body: unknown) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString();
  if (!s) return {};
  try { return JSON.parse(s); } catch { throw httpErr(400, 'Invalid JSON'); }
}
const hash = (pw: string) => { const salt = randomBytes(8).toString('hex'); return `${salt}$${scryptSync(pw, salt, 32).toString('hex')}`; };
const checkHash = (pw: string, h: string) => { const [salt, hx] = h.split('$'); return scryptSync(pw, salt, 32).toString('hex') === hx; };
function sendFile(req: IncomingMessage, res: ServerResponse, file: string, mime: string) {
  let st; try { st = statSync(file); } catch { throw httpErr(404, 'Not found'); }
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
    if (start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return; }
    res.writeHead(206, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) });
    createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Content-Length': String(st.size), 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') { res.end(); return; }
  createReadStream(file).pipe(res);
}
