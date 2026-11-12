import { createServer, type Server } from 'node:http';
import { join, normalize, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { openDb, type DB } from './db.ts';
import { HttpError, RateLimiter, Router, clientIp, send, sendFile, type Ctx } from './http.ts';
import { MediaStore } from './media.ts';
import { LiveHub } from './live.ts';
import { registerPublic } from './routes/public.ts';
import { registerAdmin } from './routes/admin.ts';

export interface Config {
  dbFile: string;
  mediaDir: string;
  appDir: string;          // built member app (served at /app)
  adminDir: string;        // built creator dashboard (served at /admin)
  maxUploadBytes: number;
  memberUploadMax: number;
  corsOrigins: string[];   // '*' allowed for the public API (auth is bearer-token, never cookies)
  trustProxy: boolean;
  secureCookies: boolean;
  log: boolean;
}

export interface Deps {
  db: DB;
  media: MediaStore;
  live: LiveHub;
  limiter: RateLimiter;
  secureCookies: boolean;
  memberUploadMax: number;
}

const ROOT = resolve(import.meta.dirname, '../..');

export function defaultConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const data = resolve(env.DATA_DIR || join(ROOT, 'server/data'));
  return {
    dbFile: join(data, 'pko.db'),
    mediaDir: join(data, 'media'),
    appDir: resolve(env.APP_DIR || join(ROOT, 'app')),
    adminDir: resolve(env.ADMIN_DIR || join(ROOT, 'admin')),
    maxUploadBytes: Number(env.MAX_UPLOAD_MB || 1024) * 1e6,
    memberUploadMax: Number(env.MEMBER_UPLOAD_MB || 300) * 1e6,
    corsOrigins: (env.CORS_ORIGINS || '*').split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === '1',
    secureCookies: env.SECURE_COOKIES ? env.SECURE_COOKIES === '1' : env.NODE_ENV === 'production',
    log: env.LOG !== '0',
  };
}

const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: https:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
};

/** Serve a static SPA folder; unknown paths fall back to index.html. */
function serveStatic(ctx: Ctx, dir: string, prefix: string): boolean {
  const rel = ctx.url.pathname.slice(prefix.length) || '/';
  let file: string;
  try { file = normalize(join(dir, decodeURIComponent(rel))); } catch { return false; }
  if (file !== dir && !file.startsWith(dir + sep)) return false; // traversal guard
  if (rel.endsWith('/') || !existsSync(file)) {
    const looksLikeAsset = /\.[a-z0-9]{2,6}$/i.test(rel);
    if (looksLikeAsset && !rel.endsWith('/')) return false;
    file = join(dir, 'index.html');
  }
  const isHtml = file.endsWith('.html');
  for (const [k, v] of Object.entries(SEC_HEADERS)) ctx.res.setHeader(k, v);
  if (isHtml) ctx.res.setHeader('Content-Security-Policy', PAGE_CSP);
  // sw.js must never be cached so updates roll out; hashed assets are not used, so revalidate.
  return sendFile(ctx.req, ctx.res, file, { cache: 'no-cache' });
}

export function createApp(cfg: Config): { server: Server; deps: Deps; close: () => Promise<void> } {
  const db = openDb(cfg.dbFile);
  const deps: Deps = {
    db,
    media: new MediaStore(db, cfg.mediaDir, cfg.maxUploadBytes),
    live: new LiveHub(db),
    limiter: new RateLimiter(),
    secureCookies: cfg.secureCookies,
    memberUploadMax: cfg.memberUploadMax,
  };
  const router = new Router();
  registerPublic(router, deps);
  registerAdmin(router, deps);

  const server = createServer(async (req, res) => {
    const started = Date.now();
    let url: URL;
    try { url = new URL(req.url || '/', 'http://localhost'); } catch { res.writeHead(400); res.end(); return; }
    const ctx: Ctx = { req, res, url, params: {}, ip: clientIp(req, cfg.trustProxy) };
    if (cfg.log && !url.pathname.startsWith('/api/live/stream')) {
      res.once('finish', () => console.log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`));
    }
    const isApi = url.pathname.startsWith('/api/');
    const isPublicApi = isApi && !url.pathname.startsWith('/api/admin/');

    // CORS for the public API only (native apps load from capacitor:// or https://localhost).
    if (isPublicApi || url.pathname.startsWith('/media/')) {
      const origin = req.headers.origin;
      if (origin && (cfg.corsOrigins.includes('*') || cfg.corsOrigins.includes(origin))) {
        res.setHeader('Access-Control-Allow-Origin', cfg.corsOrigins.includes('*') ? '*' : origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Device-Id, If-None-Match');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Expose-Headers', 'ETag');
        res.setHeader('Access-Control-Max-Age', '600');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    }

    try {
      const m = isApi || url.pathname.startsWith('/media/') ? router.match(req.method || 'GET', url.pathname) : null;
      if (m === 'method') throw new HttpError(405, 'Method not allowed');
      if (m) {
        ctx.params = m.params;
        await m.handler(ctx);
      } else if (isApi) {
        throw new HttpError(404, 'Not found');
      } else if (url.pathname === '/' || url.pathname === '') {
        res.writeHead(302, { Location: '/app/' }); res.end();
      } else if (url.pathname === '/app' || url.pathname === '/admin') {
        res.writeHead(301, { Location: url.pathname + '/' }); res.end();
      } else if (url.pathname.startsWith('/app/')) {
        if (!serveStatic(ctx, cfg.appDir, '/app')) throw new HttpError(404, 'Not found');
      } else if (url.pathname.startsWith('/admin/')) {
        if (!serveStatic(ctx, cfg.adminDir, '/admin')) throw new HttpError(404, 'Not found');
      } else {
        throw new HttpError(404, 'Not found');
      }
    } catch (e) {
      const err = e instanceof HttpError ? e : null;
      if (!err) console.error('[error]', req.method, url.pathname, e);
      if (!res.headersSent) send(res, err?.status || 500, { error: err?.message || 'Something went wrong on our side', details: err?.details });
      else res.end();
    }
  });
  server.requestTimeout = 0; // uploads and SSE can be long; per-socket idle timeout below
  server.keepAliveTimeout = 65_000;

  return {
    server,
    deps,
    close: () => new Promise<void>((done) => {
      deps.live.close();
      server.close(() => { db.close(); done(); });
      server.closeAllConnections?.();
    }),
  };
}
