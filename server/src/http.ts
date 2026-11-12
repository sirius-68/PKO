import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';

export class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  ip: string;
}

export type Handler = (ctx: Ctx) => Promise<void> | void;

interface Route { method: string; parts: string[]; handler: Handler }

export class Router {
  private routes: Route[] = [];
  on(method: string, path: string, handler: Handler): this {
    this.routes.push({ method, parts: path.split('/').filter(Boolean), handler });
    return this;
  }
  get(p: string, h: Handler) { return this.on('GET', p, h); }
  post(p: string, h: Handler) { return this.on('POST', p, h); }
  put(p: string, h: Handler) { return this.on('PUT', p, h); }
  patch(p: string, h: Handler) { return this.on('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.on('DELETE', p, h); }

  /** Returns the matched handler, or a 405 marker when the path exists for another method. */
  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    const parts = pathname.split('/').filter(Boolean);
    let pathMatched = false;
    for (const r of this.routes) {
      if (r.parts.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const rp = r.parts[i];
        if (rp.startsWith(':')) {
          try { params[rp.slice(1)] = decodeURIComponent(parts[i]); } catch { ok = false; break; }
        } else if (rp !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { handler: r.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

export function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(payload);
}

export async function readBody(req: IncomingMessage, limit = 1_000_000): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export async function readJson<T = Record<string, unknown>>(req: IncomingMessage, limit = 1_000_000): Promise<T> {
  const ct = req.headers['content-type'] || '';
  if (!ct.includes('application/json')) throw new HttpError(415, 'Expected application/json');
  const buf = await readBody(req, limit);
  if (!buf.length) return {} as T;
  try { return JSON.parse(buf.toString('utf8')) as T; } catch { throw new HttpError(400, 'Invalid JSON'); }
}

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* ignore malformed */ }
  }
  return out;
}

/** Fixed-window rate limiter keyed by ip+bucket. In-memory; fine for a single instance. */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  check(key: string, max: number, windowMs: number): void {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) { this.hits.set(key, { n: 1, reset: now + windowMs }); this.gc(now); return; }
    h.n++;
    if (h.n > max) throw new HttpError(429, 'Too many requests — please wait a moment and try again');
  }
  /** Throws if the key already used up its allowance, without counting this call. */
  assertNotBlocked(key: string, max: number): void {
    const h = this.hits.get(key);
    if (h && h.reset >= Date.now() && h.n >= max) throw new HttpError(429, 'Too many attempts — please wait a few minutes and try again');
  }
  reset(): void { this.hits.clear(); }
  private gc(now: number) {
    if (this.hits.size < 5000) return;
    for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
  }
}

export const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};

/** Serve a file with Range support (needed for video seeking and iOS playback). */
export function sendFile(req: IncomingMessage, res: ServerResponse, file: string, opts: { cache?: string; mime?: string } = {}): boolean {
  let st;
  try { st = statSync(file); } catch { return false; }
  if (!st.isFile()) return false;
  const type = opts.mime || MIME[extname(file).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  const base: Record<string, string> = {
    'Content-Type': type, 'Accept-Ranges': 'bytes', ETag: etag,
    'Cache-Control': opts.cache || 'no-cache', 'Last-Modified': st.mtime.toUTCString(),
    'X-Content-Type-Options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, base); res.end(); return true; }
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start = m && m[1] ? Number(m[1]) : NaN;
    let end = m && m[2] ? Number(m[2]) : NaN;
    if (Number.isNaN(start) && !Number.isNaN(end)) { start = Math.max(0, st.size - end); end = st.size - 1; }
    if (Number.isNaN(end) || end >= st.size) end = st.size - 1;
    if (!m || Number.isNaN(start) || start > end || start >= st.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${st.size}` });
      res.end();
      return true;
    }
    res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': String(end - start + 1) });
    if (req.method === 'HEAD') { res.end(); return true; }
    createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...base, 'Content-Length': String(st.size) });
  if (req.method === 'HEAD') { res.end(); return true; }
  createReadStream(file).pipe(res);
  return true;
}

export function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}
