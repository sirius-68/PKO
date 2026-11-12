import { getItem, setItem } from './native.js';

/* ---------- content types (mirror server/src/schema.ts) ---------- */
interface Base { id: string; publishedAt: string }
export interface Post extends Base { title: string; flair: string; verse: string | null; ref: string | null; body: string[]; image: string | null; imagePos: string | null }
export interface Broadcast extends Base { title: string; ref: string | null; category: string; video: string | null; url: string | null; poster: string }
export interface Chapter { id: string; title: string; words: number }
export interface Book extends Base { title: string; description: string; year: number | null; pages: number | null; image: string; imagePos: string | null; pdf: string | null; chapters: Chapter[] }
export interface Track { id: string; title: string; audio: string | null; duration: number | null }
export interface Album extends Base { title: string; artist: string; year: number | null; image: string; imagePos: string | null; tracks: Track[] }
export interface EventItem extends Base { title: string; date: string; time: string; place: string; description: string; image: string | null; imagePos: string | null }
export interface Testimony extends Base { title: string; name: string; place: string | null; quote: string | null; body: string[]; video: string | null }
export interface Photo extends Base { image: string; caption: string; album: string }
export interface Slot extends Base { time: string; title: string; subtitle: string | null }
export interface Settings { appName: string; ministry: string; tvName: string; recordsName: string; leader: string; aboutText: string; aboutVerse: string; aboutVerseRef: string; logo: string | null; leaderPhoto: string | null }
export interface Live { onAir: boolean; title: string; ref: string | null; video: string | null; url: string | null; poster: string | null }
export interface Bundle {
  version: number; settings: Settings; live: Live;
  posts: Post[]; broadcasts: Broadcast[]; books: Book[]; albums: Album[]; events: EventItem[]; testimonies: Testimony[]; photos: Photo[]; schedule: Slot[];
  amens: Record<string, number>; comments: Record<string, number>;
}
export interface Comment { id: string; name: string; body: string; parentId: string | null; createdAt: string; memberId: string; amens: number }
export interface ChatMsg { id: number; name: string; body: string; isMod: boolean; createdAt: string }
export interface Member { id: string; name: string }

/* ---------- client ---------- */
const cfg = (window as unknown as { PKO_CONFIG?: { apiBase?: string } }).PKO_CONFIG || {};
export const API_BASE: string = (cfg.apiBase || '').replace(/\/$/, '');
export const mediaUrl = (id: string | null | undefined): string => (id ? `${API_BASE}/media/${encodeURIComponent(id)}` : '');
/** Public link for sharing. Native builds share the hosted web app URL. */
export const shareUrl = (path: string): string => `${API_BASE || location.origin}/app/#${path}`;

export class ApiError extends Error {
  status: number;
  details?: Record<string, string>;
  constructor(status: number, message: string, details?: Record<string, string>) { super(message); this.status = status; this.details = details; }
}

export function deviceId(): string {
  let id = getItem('pko.device');
  if (!id) {
    id = (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
    setItem('pko.device', id);
  }
  return id;
}
export const token = (): string | null => getItem('pko.token');

export async function api<T>(path: string, opts: { method?: string; body?: unknown; timeout?: number; headers?: Record<string, string> } = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), opts.timeout ?? 15000);
  const headers: Record<string, string> = { 'X-Device-Id': deviceId(), ...opts.headers };
  const t = token();
  if (t) headers.Authorization = 'Bearer ' + t;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(API_BASE + path, { method: opts.method || 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: ctl.signal });
  } catch {
    throw new ApiError(0, navigator.onLine ? "Couldn't reach the server. Please try again." : "You're offline. Check your connection and try again.");
  } finally { clearTimeout(timer); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && t && path !== '/api/members') setItem('pko.token', null);
    throw new ApiError(res.status, (data as { error?: string }).error || 'Something went wrong', (data as { details?: Record<string, string> }).details);
  }
  return data as T;
}

/** Upload with progress (fetch has no upload progress, so XHR it is). */
export function upload(path: string, file: File, onProgress: (p: number) => void): Promise<{ id: string }> {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', `${API_BASE}${path}?name=${encodeURIComponent(file.name)}`);
    x.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    x.setRequestHeader('X-Device-Id', deviceId());
    const t = token();
    if (t) x.setRequestHeader('Authorization', 'Bearer ' + t);
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let d: { id?: string; error?: string } = {};
      try { d = JSON.parse(x.responseText); } catch { /* ignore */ }
      if (x.status >= 200 && x.status < 300 && d.id) resolve({ id: d.id }); else reject(new ApiError(x.status, d.error || 'Upload failed'));
    };
    x.onerror = () => reject(new ApiError(0, 'Upload failed. Check your connection.'));
    x.send(file);
  });
}

/* ---------- content bundle with offline cache + ETag revalidation ---------- */
const CACHE_KEY = 'pko.bundle';
export function cachedBundle(): Bundle | null {
  try { const s = getItem(CACHE_KEY); return s ? (JSON.parse(s) as Bundle) : null; } catch { return null; }
}
export async function fetchBundle(current: Bundle | null): Promise<{ bundle: Bundle; changed: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(API_BASE + '/api/bundle', { headers: current ? { 'If-None-Match': `W/"v${current.version}"` } : {}, signal: ctl.signal, cache: 'no-cache' });
    if (res.status === 304 && current) return { bundle: current, changed: false };
    if (!res.ok) throw new ApiError(res.status, 'Could not load content');
    const b = (await res.json()) as Bundle;
    try { setItem(CACHE_KEY, JSON.stringify(b)); } catch { /* storage full: still usable in memory */ }
    return { bundle: b, changed: !current || current.version !== b.version || JSON.stringify(current.amens) !== JSON.stringify(b.amens) };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw new ApiError(0, 'offline');
  } finally { clearTimeout(timer); }
}
